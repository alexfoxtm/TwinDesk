// TwinDesk — GPL-3.0, see LICENSE.
// Pure unit tests for mac-helper OtpFillPolicy target validation and matching.
import ApplicationServices

@main
struct OtpFillTest {
  static func main() {
    // Valid & invalid OTP formats (strictly 4–8 ASCII digits, never control chars or newlines).
    precondition(OtpFillPolicy.isValidCode("4829"))
    precondition(OtpFillPolicy.isValidCode("482913"))
    precondition(OtpFillPolicy.isValidCode("12345678"))
    precondition(!OtpFillPolicy.isValidCode("123"))
    precondition(!OtpFillPolicy.isValidCode("123456789"))
    precondition(!OtpFillPolicy.isValidCode("482913\n"))
    precondition(!OtpFillPolicy.isValidCode("48 2913"))
    precondition(!OtpFillPolicy.isValidCode("48a913"))

    let valid = OtpFocusSnapshot(
      pid: 4200, frontPid: 4200, bundleId: "com.apple.Safari",
      role: kAXTextFieldRole as String, subrole: "", identifier: "otp-input",
      enabled: true, valueSettable: true, selectedTextSettable: true
    )
    precondition(OtpFillPolicy.rejectReason(snapshot: valid, trusted: true, remoteOverview: false, selfPid: 100, parentPid: 50) == nil)
    precondition(OtpFillPolicy.rejectReason(snapshot: valid, trusted: false, remoteOverview: false, selfPid: 100, parentPid: 50) == "accessibility")
    precondition(OtpFillPolicy.rejectReason(snapshot: valid, trusted: true, remoteOverview: true, selfPid: 100, parentPid: 50) == "overview")

    // Focus mismatch, self/parent/blocked targets, and non-editable fields are rejected.
    let mismatch = OtpFocusSnapshot(
      pid: 4200, frontPid: 4201, bundleId: "com.apple.Safari",
      role: kAXTextFieldRole as String, subrole: "", identifier: "otp-input",
      enabled: true, valueSettable: true, selectedTextSettable: true
    )
    precondition(OtpFillPolicy.rejectReason(snapshot: mismatch, trusted: true, remoteOverview: false, selfPid: 100, parentPid: 50) == "focus-mismatch")

    let twinDesk = OtpFocusSnapshot(
      pid: 50, frontPid: 50, bundleId: "com.alexfoxtm.twindesk",
      role: kAXTextFieldRole as String, subrole: "", identifier: "reply",
      enabled: true, valueSettable: true, selectedTextSettable: true
    )
    precondition(OtpFillPolicy.rejectReason(snapshot: twinDesk, trusted: true, remoteOverview: false, selfPid: 100, parentPid: 50) == "blocked-target")

    let securityAgent = OtpFocusSnapshot(
      pid: 900, frontPid: 900, bundleId: "com.apple.SecurityAgent",
      role: kAXTextFieldRole as String, subrole: kAXSecureTextFieldSubrole as String, identifier: "",
      enabled: true, valueSettable: true, selectedTextSettable: true
    )
    precondition(OtpFillPolicy.rejectReason(snapshot: securityAgent, trusted: true, remoteOverview: false, selfPid: 100, parentPid: 50) == "blocked-target")

    let readOnly = OtpFocusSnapshot(
      pid: 4200, frontPid: 4200, bundleId: "com.apple.Safari",
      role: kAXTextFieldRole as String, subrole: "", identifier: "otp-input",
      enabled: true, valueSettable: false, selectedTextSettable: false
    )
    precondition(OtpFillPolicy.rejectReason(snapshot: readOnly, trusted: true, remoteOverview: false, selfPid: 100, parentPid: 50) == "not-editable")

    // Exact target matching rejects any change in pid, bundle, role, subrole, or identifier.
    precondition(OtpFillPolicy.matches(expected: valid, current: valid))
    let otherField = OtpFocusSnapshot(
      pid: 4200, frontPid: 4200, bundleId: "com.apple.Safari",
      role: kAXTextFieldRole as String, subrole: "", identifier: "search-input",
      enabled: true, valueSettable: true, selectedTextSettable: true
    )
    precondition(!OtpFillPolicy.matches(expected: valid, current: otherField))

    print("otp fill policy: ok")
  }
}
