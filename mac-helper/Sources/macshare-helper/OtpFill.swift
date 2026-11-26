// TwinDesk — GPL-3.0, see LICENSE.
// Verified focused-field OTP insertion for macshare-helper.
// Captures an opaque token for an external, editable focused AXUIElement (metadata only — never
// reads AXValue, AXSelectedText, titles, or text content) and inserts strictly 4–8 ASCII digits
// into that exact element only when focus and target identity still match. Never submits or logs
// code digits.
import AppKit
import ApplicationServices
import Foundation

struct OtpFocusSnapshot: Equatable {
  let pid: Int32
  let frontPid: Int32
  let bundleId: String
  let role: String
  let subrole: String
  let identifier: String
  let enabled: Bool
  let valueSettable: Bool
  let selectedTextSettable: Bool
}

enum OtpFillPolicy {
  static let editableRoles: Set<String> = [
    kAXTextFieldRole as String,
    kAXTextAreaRole as String,
    kAXComboBoxRole as String,
  ]
  static let secureSubrole = kAXSecureTextFieldSubrole as String
  static let blockedExactBundles: Set<String> = [
    "com.apple.notificationcenterui",
    "com.apple.loginwindow",
    "com.apple.SecurityAgent",
    "com.apple.systemuiserver",
  ]
  static let blockedBundlePrefixes: [String] = [
    "com.twindesk.",
    "com.alexfoxtm.twindesk",
    "com.macshare.",
  ]
  static let tokenLifetimeSeconds: TimeInterval = 120
  static let maxStoredTargets = 8

  static func isValidCode(_ code: String) -> Bool {
    guard code.count >= 4 && code.count <= 8 else { return false }
    return code.unicodeScalars.allSatisfy { $0.value >= 48 && $0.value <= 57 }
  }

  static func isBlockedBundle(_ bundleId: String) -> Bool {
    let lower = bundleId.lowercased()
    if lower.isEmpty { return true }
    if blockedExactBundles.contains(where: { $0.lowercased() == lower }) { return true }
    return blockedBundlePrefixes.contains(where: { lower.hasPrefix($0) })
  }

  static func isEditable(_ s: OtpFocusSnapshot) -> Bool {
    let roleMatch = s.subrole == secureSubrole || editableRoles.contains(s.role)
    return roleMatch && s.enabled && s.valueSettable
  }

  /// Validates whether a snapshot represents an eligible external editable target.
  /// Returns nil when valid, or a machine-readable rejection reason.
  static func rejectReason(
    snapshot: OtpFocusSnapshot,
    trusted: Bool,
    remoteOverview: Bool,
    selfPid: Int32,
    parentPid: Int32
  ) -> String? {
    if !trusted { return "accessibility" }
    if remoteOverview { return "overview" }
    if snapshot.pid <= 0 || snapshot.frontPid <= 0 || snapshot.pid != snapshot.frontPid { return "focus-mismatch" }
    if snapshot.pid == selfPid || (parentPid > 1 && snapshot.pid == parentPid) { return "blocked-target" }
    if isBlockedBundle(snapshot.bundleId) { return "blocked-target" }
    if !isEditable(snapshot) { return "not-editable" }
    return nil
  }

  /// Exact target identity match between capture time and fill time.
  static func matches(expected: OtpFocusSnapshot, current: OtpFocusSnapshot) -> Bool {
    return expected.pid == current.pid
      && expected.bundleId == current.bundleId
      && expected.role == current.role
      && expected.subrole == current.subrole
      && expected.identifier == current.identifier
  }
}

final class OtpTargetController {
  static let shared = OtpTargetController()

  private struct StoredTarget {
    let element: AXUIElement
    let snapshot: OtpFocusSnapshot
    let expiresAt: TimeInterval
  }

  private let lock = NSLock()
  private var targets: [String: StoredTarget] = [:]

  private static func stringAttr(_ el: AXUIElement, _ name: String) -> String {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success else { return "" }
    return (value as? String) ?? ""
  }

  private static func boolAttr(_ el: AXUIElement, _ name: String, defaultValue: Bool) -> Bool {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success else { return defaultValue }
    if let b = value as? Bool { return b }
    if let n = value as? NSNumber { return n.boolValue }
    return defaultValue
  }

  private static func isSettable(_ el: AXUIElement, _ name: String) -> Bool {
    var settable = DarwinBoolean(false)
    let err = AXUIElementIsAttributeSettable(el, name as CFString, &settable)
    return err == .success && settable.boolValue
  }

  private static func focusedElement() -> AXUIElement? {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.2)
    var focused: CFTypeRef?
    guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
          let focused, CFGetTypeID(focused) == AXUIElementGetTypeID()
    else { return nil }
    return unsafeBitCast(focused, to: AXUIElement.self)
  }

  private static func readLiveTarget(frontPid: Int32, frontBundleId: String) -> (AXUIElement, OtpFocusSnapshot)? {
    guard let element = focusedElement() else { return nil }
    AXUIElementSetMessagingTimeout(element, 0.2)

    var elemPid: pid_t = 0
    guard AXUIElementGetPid(element, &elemPid) == .success, elemPid > 0 else { return nil }

    let snapshot = OtpFocusSnapshot(
      pid: elemPid,
      frontPid: frontPid,
      bundleId: frontBundleId,
      role: stringAttr(element, kAXRoleAttribute),
      subrole: stringAttr(element, kAXSubroleAttribute),
      identifier: stringAttr(element, kAXIdentifierAttribute),
      enabled: boolAttr(element, kAXEnabledAttribute, defaultValue: true),
      valueSettable: isSettable(element, kAXValueAttribute),
      selectedTextSettable: isSettable(element, kAXSelectedTextAttribute)
    )
    return (element, snapshot)
  }

  private func pruneLocked(now: TimeInterval) {
    targets = targets.filter { $0.value.expiresAt > now }
    while targets.count >= OtpFillPolicy.maxStoredTargets {
      if let oldest = targets.min(by: { $0.value.expiresAt < $1.value.expiresAt })?.key {
        targets.removeValue(forKey: oldest)
      } else {
        break
      }
    }
  }

  func capture(frontPid: Int32, frontBundleId: String, remoteOverview: Bool) -> [String: Any] {
    let trusted = AXIsProcessTrusted()
    guard trusted else { return ["valid": false, "reason": "accessibility"] }
    guard !remoteOverview else { return ["valid": false, "reason": "overview"] }
    guard let (element, snapshot) = Self.readLiveTarget(frontPid: frontPid, frontBundleId: frontBundleId) else {
      return ["valid": false, "reason": "no-focus"]
    }
    if let why = OtpFillPolicy.rejectReason(
      snapshot: snapshot, trusted: trusted, remoteOverview: remoteOverview,
      selfPid: getpid(), parentPid: getppid()
    ) {
      return ["valid": false, "reason": why]
    }
    guard snapshot.selectedTextSettable else {
      return ["valid": false, "reason": "unsupported-target"]
    }
    let token = UUID().uuidString
    let now = ProcessInfo.processInfo.systemUptime
    lock.lock()
    pruneLocked(now: now)
    targets[token] = StoredTarget(element: element, snapshot: snapshot, expiresAt: now + OtpFillPolicy.tokenLifetimeSeconds)
    lock.unlock()
    return ["valid": true, "token": token, "secure": snapshot.subrole == OtpFillPolicy.secureSubrole]
  }

  func fill(
    code: String, token: String, frontPid: Int32, frontBundleId: String, remoteOverview: Bool,
    stillFront: () -> Bool
  ) -> [String: Any] {
    guard OtpFillPolicy.isValidCode(code) else { return ["filled": false, "reason": "invalid-code"] }
    guard !token.isEmpty else { return ["filled": false, "reason": "missing-token"] }
    let trusted = AXIsProcessTrusted()
    guard trusted else { return ["filled": false, "reason": "accessibility"] }
    guard !remoteOverview else { return ["filled": false, "reason": "overview"] }

    let now = ProcessInfo.processInfo.systemUptime
    lock.lock()
    let stored = targets.removeValue(forKey: token)
    pruneLocked(now: now)
    lock.unlock()

    guard let expected = stored, expected.expiresAt > now else {
      return ["filled": false, "reason": "expired-token"]
    }
    guard let (currentElement, currentSnapshot) = Self.readLiveTarget(frontPid: frontPid, frontBundleId: frontBundleId) else {
      return ["filled": false, "reason": "no-focus"]
    }
    if let why = OtpFillPolicy.rejectReason(
      snapshot: currentSnapshot, trusted: trusted, remoteOverview: remoteOverview,
      selfPid: getpid(), parentPid: getppid()
    ) {
      return ["filled": false, "reason": why]
    }
    guard CFEqual(currentElement, expected.element),
          OtpFillPolicy.matches(expected: expected.snapshot, current: currentSnapshot)
    else {
      return ["filled": false, "reason": "target-changed"]
    }
    guard currentSnapshot.selectedTextSettable else {
      return ["filled": false, "reason": "unsupported-target"]
    }

    guard stillFront(), let focused = Self.focusedElement(), CFEqual(focused, currentElement) else {
      return ["filled": false, "reason": "target-changed"]
    }
    let err = AXUIElementSetAttributeValue(currentElement, kAXSelectedTextAttribute as CFString, code as CFString)
    guard err == .success else {
      return ["filled": false, "reason": "unsupported-target"]
    }
    return ["filled": true, "method": "ax"]
  }
}
