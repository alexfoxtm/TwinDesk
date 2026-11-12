// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
import ApplicationServices

// Only control metadata crosses the bridge. Never request AXValue or selected text.
func textFocus() -> [String: Bool] {
  guard AXIsProcessTrusted() else { return ["editable": false, "secure": false] }
  let system = AXUIElementCreateSystemWide()
  AXUIElementSetMessagingTimeout(system, 0.2)
  var focused: CFTypeRef?
  guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
        let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { return ["editable": false, "secure": false] }
  let element = unsafeBitCast(focused, to: AXUIElement.self)
  AXUIElementSetMessagingTimeout(element, 0.2)
  func attribute(_ name: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value as? String
  }
  let role = attribute(kAXRoleAttribute), subrole = attribute(kAXSubroleAttribute)
  let secure = subrole == kAXSecureTextFieldSubrole
  let editable = secure || role == kAXTextFieldRole || role == kAXTextAreaRole || role == kAXComboBoxRole
  return ["editable": editable, "secure": secure]
}
