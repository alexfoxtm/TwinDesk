// TwinDesk — GPL-3.0, see LICENSE at the repository root.
import AppKit
import Security
import WebKit

private let service = "io.github.alexfoxtm.twindesk.google-messages"
private let signInURL = URL(string: "https://accounts.google.com/AccountChooser?continue=https://messages.google.com/web/config")!
private let googleCookies = Set(["SID", "HSID", "SSID", "APISID", "SAPISID"])
private let requiredCookies = googleCookies.union(["OSID"])

private func allowedCookies(_ cookies: [HTTPCookie]) -> [String: String]? {
    var allowed: [String: String] = [:]
    for cookie in cookies where cookieIsAllowed(cookie) {
        if cookie.name == "OSID",
           cookie.domain == "messages.google.com" || cookie.domain == ".messages.google.com" {
            allowed[cookie.name] = cookie.value
        } else if cookie.domain == ".google.com", googleCookies.contains(cookie.name) || cookie.name.hasPrefix("__Secure-") {
            allowed[cookie.name] = cookie.value
        }
    }
    return requiredCookies.isSubset(of: allowed.keys) ? allowed : nil
}

private func cookieNeedsSecure(_ name: String) -> Bool {
    name == "SSID" || name == "SAPISID" || name == "OSID" || name.hasPrefix("__Secure-")
}

private func cookieIsAllowed(_ cookie: HTTPCookie) -> Bool {
    !cookie.value.isEmpty
        && (cookie.expiresDate ?? .distantFuture) > Date()
        && (!cookieNeedsSecure(cookie.name) || cookie.isSecure)
}

private protocol SessionStore {
    func read() throws -> Data?
    func save(_ data: Data) throws
    func wipe() throws
}

private struct Keychain: SessionStore {
    let owner: String

    private var item: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: owner,
         kSecAttrSynchronizable as String: false]
    }

    private struct Failure: Error {}

    func read() throws -> Data? {
        var query = item
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw Failure() }
        return data
    }

    func save(_ data: Data) throws {
        let value = [kSecValueData as String: data]
        let status = SecItemUpdate(item as CFDictionary, value as CFDictionary)
        if status == errSecItemNotFound {
            var create = item.merging(value) { _, new in new }
            create[kSecAttrLabel as String] = "TwinDesk Google Messages"
            guard SecItemAdd(create as CFDictionary, nil) == errSecSuccess else { throw Failure() }
        } else if status != errSecSuccess {
            throw Failure()
        }
    }

    func wipe() throws {
        let status = SecItemDelete(item as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure() }
    }
}

private func decode(_ line: String) -> [String: Any]? {
    try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
}

private func encode(_ object: [String: Any]) -> Data? {
    guard var data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
    data.append(10)
    return data
}

private func emit(_ event: [String: Any]) {
    if let data = encode(event) { try? FileHandle.standardOutput.write(contentsOf: data) }
}

private final class SignIn: NSObject, WKNavigationDelegate, NSWindowDelegate {
    private let store = WKWebsiteDataStore.nonPersistent()
    private let window: NSWindow
    private var web: WKWebView?
    private var finished = false
    private var cleared = false
    private var afterClear: [() -> Void] = []
    private let done: ([String: String]?) -> Void

    init(done: @escaping ([String: String]?) -> Void) {
        self.done = done
        let config = WKWebViewConfiguration()
        config.websiteDataStore = store
        let view = WKWebView(frame: .zero, configuration: config)
        view.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
        web = view
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 690),
                          styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.isReleasedWhenClosed = false
        window.title = "TwinDesk — Connect Google Messages"
        window.delegate = self
        window.contentView = view
        view.navigationDelegate = self
        window.center()
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        view.load(URLRequest(url: signInURL))
    }

    func finish(_ cookies: [String: String]? = nil, completion: (() -> Void)? = nil) {
        if cleared {
            completion?()
            return
        }
        if let completion { afterClear.append(completion) }
        guard !finished else { return }
        finished = true
        web?.stopLoading()
        web?.navigationDelegate = nil
        window.contentView = nil
        web = nil
        window.delegate = nil
        window.close()
        store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
            self.cleared = true
            self.done(cookies)
            self.afterClear.forEach { $0() }
            self.afterClear.removeAll()
        }
    }

    func windowWillClose(_ notification: Notification) {
        DispatchQueue.main.async { self.finish() }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, url.scheme == "https", url.port == nil else {
            decisionHandler(.cancel)
            return
        }
        // Cookie capture is the trust boundary. Subframes (reCAPTCHA, account
        // interstitials) often leave accounts.google.com.
        if action.targetFrame?.isMainFrame == false {
            decisionHandler(.allow)
            return
        }
        let host = url.host ?? ""
        let allowed = host == "accounts.google.com" || host == "accounts.youtube.com"
            || host == "www.google.com" || host == "google.com" || host == "messages.google.com"
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let url = webView.url, url.scheme == "https", url.host == "messages.google.com",
              url.path == "/web/config" else { return }
        store.httpCookieStore.getAllCookies { [weak self] cookies in
            self?.finish(allowedCookies(cookies))
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish()
    }
}

private final class Worker {
    let process = Process()
    let input = Pipe()
    let output = Pipe()
    let writes = DispatchQueue(label: "twindesk.gmessages.worker")

    func send(_ message: [String: Any]) {
        guard let data = encode(message) else { return }
        writes.async { try? self.input.fileHandleForWriting.write(contentsOf: data) }
    }

    func stop() {
        if process.isRunning { process.terminate() }
        writes.async { try? self.input.fileHandleForWriting.close() }
    }
}

private final class Bridge {
    let keychain: SessionStore
    private var worker: Worker?
    private var signIn: SignIn?
    private var generation = 0
    private var connected = false
    private var wiping = false
    private var resumeAttempts = 0

    init(store: SessionStore) { keychain = store }

    func resume() {
        do {
            guard let data = try keychain.read(),
                  let session = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                state("disconnected")
                return
            }
            start(["op": "resume", "session": session])
        } catch { state("keychain-error") }
    }

    func receive(_ command: [String: Any]) {
        switch command["op"] as? String {
        case "connect":
            guard signIn == nil, worker == nil, !wiping else { return }
            generation += 1
            let expected = generation
            do {
                if let data = try keychain.read(),
                   let session = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    start(["op": "resume", "session": session])
                    return
                }
            } catch { state("keychain-error"); return }
            state("signing-in")
            signIn = SignIn { [weak self] cookies in
                guard let self, self.generation == expected else { return }
                self.signIn = nil
                guard let cookies else { self.state("disconnected"); return }
                self.start(["op": "pair", "cookies": cookies])
            }
        case "disconnect":
            disconnect()
        case "history", "earlier", "send", "read", "typing", "photo":
            if connected { worker?.send(command) }
        default: break
        }
    }

    func disconnect() {
        guard !wiping else { return }
        wiping = true
        let view = signIn
        stop()
        let wipe = {
            defer { self.wiping = false }
            do { try self.keychain.wipe(); emit(["type": "state", "state": "disconnected", "wipe": true]) }
            catch { emit(["type": "state", "state": "keychain-error", "wipe": true]) }
        }
        if let view { view.finish(completion: wipe) } else { wipe() }
    }

    func stop() {
        generation += 1
        connected = false
        signIn?.finish()
        signIn = nil
        worker?.stop()
        worker = nil
    }

    private func state(_ value: String) { emit(["type": "state", "state": value]) }

    private func recover(_ reason: String) {
        stop()
        state(reason)
        let expected = generation
        do {
            guard let data = try keychain.read(),
                  let session = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  resumeAttempts < 3 else { return }
            resumeAttempts += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self, self.generation == expected, self.worker == nil,
                      self.signIn == nil, !self.wiping else { return }
                self.start(["op": "resume", "session": session])
            }
        } catch { state("keychain-error") }
    }

    private func start(_ first: [String: Any]) {
        let child = Worker()
        let binary = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
            .appendingPathComponent("twindesk-gmessages-transport")
        child.process.executableURL = binary
        child.process.standardInput = child.input
        child.process.standardOutput = child.output
        child.process.standardError = FileHandle.nullDevice
        do { try child.process.run() }
        catch { state("helper-error"); return }
        worker = child
        state("connecting")
        child.send(first)
        DispatchQueue.global().async {
            var buffer = Data()
            let handle = child.output.fileHandleForReading
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty { break }
                buffer.append(chunk)
                while let newline = buffer.firstIndex(of: 10) {
                    let line = String(decoding: buffer[..<newline], as: UTF8.self)
                    buffer.removeSubrange(...newline)
                    if let event = decode(line) {
                        DispatchQueue.main.async { self.event(event, from: child) }
                    }
                }
                if buffer.count > 10_000_000 { break }
            }
            DispatchQueue.main.async {
                if self.worker === child { self.recover("helper-error") }
            }
        }
    }

    private func event(_ event: [String: Any], from child: Worker) {
        guard worker === child, let type = event["type"] as? String else { return }
        switch type {
        case "session":
            guard let session = event["session"] as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: session) else { return }
            do { try keychain.save(data) }
            catch { stop(); state("keychain-error") }
        case "failed":
            recover("connection-error")
        case "offline":
            connected = false
            state("offline")
        case "conversations":
            resumeAttempts = 0
            connected = true
            emit(event)
        case "emoji", "history", "message", "typing", "photo", "result":
            emit(event)
        default: break
        }
    }
}

private final class MemoryStore: SessionStore {
    var data: Data?
    func read() throws -> Data? { data }
    func save(_ data: Data) throws { self.data = data }
    func wipe() throws { data = nil }
}

private func selfTest() throws -> Bool {
    func cookie(_ name: String, _ domain: String, secure: Bool = true) -> HTTPCookie? {
        var props: [HTTPCookiePropertyKey: Any] = [.name: name, .domain: domain, .path: "/", .value: "fixture"]
        if secure { props[.secure] = "TRUE" }
        return HTTPCookie(properties: props)
    }
    let required = [
        cookie("SID", ".google.com", secure: false),
        cookie("HSID", ".google.com", secure: false),
        cookie("SSID", ".google.com"),
        cookie("APISID", ".google.com", secure: false),
        cookie("SAPISID", ".google.com"),
        cookie("OSID", "messages.google.com"),
    ].compactMap { $0 }
    let extras = [cookie("OTHER", ".google.com"), cookie("__Secure-1PSIDTS", ".google.com"), cookie("OSID", "example.test")].compactMap { $0 }
    guard let captured = allowedCookies(required + extras),
          Set(captured.keys) == requiredCookies.union(["__Secure-1PSIDTS"]),
          allowedCookies(extras) == nil,
          allowedCookies(required.map { $0.name == "SSID" ? cookie("SSID", ".google.com", secure: false)! : $0 }) == nil,
          allowedCookies(required) != nil else { return false }
    let store = MemoryStore()
    guard try store.read() == nil else { return false }
    let fixture = Data([1, 2, 3])
    try store.save(fixture)
    guard try store.read() == fixture else { return false }
    Bridge(store: store).disconnect()
    return try store.read() == nil
}

signal(SIGPIPE, SIG_IGN)
var noCore = rlimit(rlim_cur: 0, rlim_max: 0)
_ = setrlimit(RLIMIT_CORE, &noCore)
if CommandLine.arguments == [CommandLine.arguments[0], "--self-test"] {
    exit((try? selfTest()) == true ? 0 : 1)
}
let args = CommandLine.arguments
guard (args.count == 2 || (args.count == 3 && args[2] == "--idle")), !args[1].isEmpty else { exit(2) }
SecKeychainSetUserInteractionAllowed(false)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
private let bridge = Bridge(store: Keychain(owner: CommandLine.arguments[1]))
if args.count == 2 { DispatchQueue.main.async { bridge.resume() } }
DispatchQueue.global().async {
    while let line = readLine() {
        if let command = decode(line) { DispatchQueue.main.async { bridge.receive(command) } }
    }
    DispatchQueue.main.async {
        bridge.stop()
        exit(0)
    }
}
app.run()
