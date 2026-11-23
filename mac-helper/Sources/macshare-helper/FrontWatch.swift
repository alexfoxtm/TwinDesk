// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume's look at the app in front (mac/activity.js, an osascript a look) only when something there
// changed: another app in front (NSWorkspace), another window in front, or the front window's title
// (a browser's tab, a document) (Accessibility). shared/rezume.js looks on each, at most every 1.5 s,
// and every 15 s anyway.
//
// Command: frontWatch {on} -> {ax} (ax false: no Accessibility, only app switches are told: main
// keeps polling then). Events: {"event":"front"}, at most one every 300 ms.
//
// AX notifications and AXUIElementCopyAttributeValue run on this class's own thread. A hung
// front app (the default AX timeout is 6 s) must not stall the main run loop's HID tap.
import AppKit
import ApplicationServices

final class FrontWatch {
  static let shared = FrontWatch()

  private let lock = NSLock()
  private let ready = DispatchSemaphore(value: 0)
  private var thread: Thread?
  private var runLoop: CFRunLoop?
  private var keepalive: CFRunLoopSource?

  /// What `set` last asked for. Written on the main thread, read under `lock`.
  private var enabled = false
  /// Bumped on every transition so a late block cannot reattach or emit after off.
  private var generation: UInt64 = 0

  private var appObserver: NSObjectProtocol?

  /// AX state. Touched only on `thread`.
  private var loopOn = false
  private var loopGeneration: UInt64 = 0
  private var ax: AXObserver?
  private var axPid: pid_t = 0
  private var app: AXUIElement?
  private var window: AXUIElement?
  private var pending = false

  /// Returns whether Accessibility is trusted. Does not wait on AX IPC.
  /// The observer is attached on `thread`. Call on the main thread.
  func set(on: Bool) -> Bool {
    let trusted = AXIsProcessTrusted()
    lock.lock()
    if on == enabled {
      lock.unlock()
      return trusted
    }
    enabled = on
    generation &+= 1
    let gen = generation
    lock.unlock()
    if !on {
      if let o = appObserver { NSWorkspace.shared.notificationCenter.removeObserver(o) }
      appObserver = nil
      post {
        self.loopGeneration = gen
        self.loopOn = false
        self.pending = false
        self.detach()
      }
      return trusted
    }
    ensureThread()
    let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    if appObserver == nil {
      appObserver = NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
      ) { [weak self] note in
        guard let self else { return }
        self.lock.lock()
        let enabled = self.enabled
        let gen = self.generation
        self.lock.unlock()
        guard enabled else { return }
        let pid = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
          ?? NSWorkspace.shared.frontmostApplication?.processIdentifier
        guard let pid else { return }
        self.post {
          self.lock.lock()
          let still = self.enabled
          let now = self.generation
          self.lock.unlock()
          guard still, now == gen, self.loopOn, self.loopGeneration == gen else { return }
          self.attach(pid: pid)
          self.changed()
        }
      }
    }
    post {
      self.loopGeneration = gen
      self.loopOn = true
      if let pid { self.attach(pid: pid) } else { self.detach() }
    }
    return trusted
  }

  private func ensureThread() {
    lock.lock()
    if thread != nil {
      lock.unlock()
      return
    }
    let spawned = Thread { [weak self] in self?.run() }
    spawned.name = "macshare.frontwatch"
    spawned.qualityOfService = .userInitiated
    thread = spawned
    lock.unlock()
    spawned.start()
    ready.wait()
  }

  private func run() {
    let loop = CFRunLoopGetCurrent()
    var context = CFRunLoopSourceContext()
    let source = CFRunLoopSourceCreate(kCFAllocatorDefault, 0, &context)
    if let source {
      CFRunLoopAddSource(loop, source, .defaultMode)
    }
    lock.lock()
    keepalive = source
    runLoop = loop
    lock.unlock()
    ready.signal()
    // A source is installed above, so this waits instead of returning at once.
    CFRunLoopRun()
  }

  private func post(_ block: @escaping () -> Void) {
    lock.lock()
    let loop = runLoop
    lock.unlock()
    guard let loop else { return }
    CFRunLoopPerformBlock(loop, CFRunLoopMode.defaultMode.rawValue, block)
    CFRunLoopWakeUp(loop)
  }

  private func changed() {
    guard loopOn else { return }
    if pending { return }
    pending = true
    let scheduled = loopGeneration
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.3) { [weak self] in
      self?.post {
        guard let self else { return }
        self.lock.lock()
        let enabled = self.enabled
        let gen = self.generation
        self.lock.unlock()
        guard enabled, self.loopOn, self.loopGeneration == scheduled, gen == scheduled else { return }
        self.pending = false
        emit(["event": "front"])
      }
    }
  }

  private func detach() {
    if let o = ax {
      CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(o), .defaultMode)
    }
    ax = nil
    axPid = 0
    app = nil
    window = nil
  }

  /// Accessibility notifications from the app in front: its focused window changing, and that
  /// window's title. Caller is `thread`.
  private func attach(pid: pid_t) {
    guard loopOn, AXIsProcessTrusted() else { detach(); return }
    if pid == axPid, ax != nil { watchWindow(); return }
    detach()
    var obs: AXObserver?
    let cb: AXObserverCallback = { _, _, note, refcon in
      guard let refcon else { return }
      let me = Unmanaged<FrontWatch>.fromOpaque(refcon).takeUnretainedValue()
      guard me.loopOn else { return }
      let name = note as String
      if name == kAXFocusedWindowChangedNotification || name == kAXMainWindowChangedNotification {
        me.watchWindow()
      }
      me.changed()
    }
    guard AXObserverCreate(pid, cb, &obs) == .success, let o = obs else { return }
    let el = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(el, 0.25)
    let me = Unmanaged.passUnretained(self).toOpaque()
    AXObserverAddNotification(o, el, kAXFocusedWindowChangedNotification as CFString, me)
    AXObserverAddNotification(o, el, kAXMainWindowChangedNotification as CFString, me)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(o), .defaultMode)
    ax = o
    axPid = pid
    app = el
    watchWindow()
  }

  private func watchWindow() {
    guard loopOn, let o = ax, let el = app else { return }
    if let w = window { AXObserverRemoveNotification(o, w, kAXTitleChangedNotification as CFString) }
    window = nil
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXFocusedWindowAttribute as CFString, &v) == .success, let w = v else { return }
    let win = w as! AXUIElement
    AXUIElementSetMessagingTimeout(win, 0.25)
    if AXObserverAddNotification(o, win, kAXTitleChangedNotification as CFString, Unmanaged.passUnretained(self).toOpaque()) == .success {
      window = win
    }
  }
}
