// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
import Foundation

struct NetemRoute {
    let peer: String
    let address: String
    static let controlPort: UInt16 = 43198
    var turnURL: String { "turn:\(address):43199?transport=tcp" }

    static let configured: NetemRoute? = {
        #if DEBUG
        let env = ProcessInfo.processInfo.environment
        return parse(peer: env["TWINDESK_NETEM_PEER"] ?? "", address: env["TWINDESK_NETEM_ADDRESS"] ?? "")
        #else
        return nil
        #endif
    }()

    static func parse(peer: String, address: String) -> NetemRoute? {
        guard peer.range(of: "^[A-Za-z0-9._-]{1,64}$", options: .regularExpression) != nil else { return nil }
        let parts = address.split(separator: ".", omittingEmptySubsequences: false)
        let octets = parts.compactMap { UInt8($0) }
        guard parts.count == 4, octets.count == 4,
              zip(parts, octets).allSatisfy({ $0.0 == String($0.1) }),
              (1...254).contains(octets[3]) else { return nil }
        let (a, b) = (octets[0], octets[1])
        guard a == 10 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168) ||
              (a == 100 && (64...127).contains(b)) else { return nil }
        return NetemRoute(peer: peer, address: address)
    }
}
