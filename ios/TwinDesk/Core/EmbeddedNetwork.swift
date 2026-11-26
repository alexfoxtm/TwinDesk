// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
import Combine
import CTwinDeskNetwork
import Foundation
import UIKit

/// The native node is process-wide. Profile and ABI work run on a serial background queue.
final class EmbeddedNetwork: ObservableObject {
    private static let queue = DispatchQueue(label: "td.embedded-network", qos: .userInitiated)

    struct Peer: Decodable, Equatable {
        let id: String
        let online: Bool
    }

    enum State: String, Decodable {
        case stopped, starting, needsLogin, needsApproval, running, error
    }

    private struct Reply: Decodable {
        var ok = false
        var state: State?
        var peers: [Peer]?
        var selfID: String?
        var authURL: URL?
        var port: UInt16?
        var handle: String?
        var token: String?
        var remoteRevoked: Bool?
    }

    final class Bridge {
        let port: UInt16
        let token: Data
        private let handle: String

        init(port: UInt16, token: Data, handle: String) {
            self.port = port
            self.token = token
            self.handle = handle
        }

        deinit {
            let handle = self.handle
            EmbeddedNetwork.queue.async { _ = EmbeddedNetwork.call(["op": "close", "handle": handle]) }
        }
    }

    // Main queue.
    @Published private(set) var state: State = .stopped
    @Published private(set) var busy = false
    @Published private(set) var statusMessage = ""
    @Published private var peers: [Peer] = []
    private var selfID: String?
    private var generation = 0
    private var active = false
    private var loginUntil: Date?
    private let store = Store.shared

    var onChange: (() -> Void)?
    var onRevoke: (() -> Void)?
    var canSignOut: Bool { store.flag("embeddedNetwork.profile", false) }

    func isOnline(_ node: String) -> Bool {
        state == .running && selfID != nil && peers.contains { $0.id == node && $0.online }
    }

    func restore() {
        if store.flag("embeddedNetwork.logoutPending", false) { stop(signOut: true) }
        else if store.flag("embeddedNetwork.enabled", false) { start(interactive: false) }
    }

    func enable() { start(interactive: false) }
    func signIn() { start(interactive: true) }

    private func start(interactive: Bool) {
        guard !busy, !store.flag("embeddedNetwork.logoutPending", false) else { return }
        statusMessage = ""
        let starting = !active || state == .error || state == .stopped
        if starting {
            generation += 1
            active = true
            state = .starting
        }
        if interactive { loginUntil = nil }
        let generation = self.generation
        let name = store.deviceName
        Self.queue.async { [weak self] in
            let started = !starting || (try? Self.startNode(name)) == true
            let loggedIn = started && (!interactive || Self.call(["op": "login"]).ok)
            DispatchQueue.main.async {
                guard let self, self.generation == generation else { return }
                if !started {
                    self.fail()
                    return
                }
                self.store.setFlag("embeddedNetwork.enabled", true)
                self.store.setFlag("embeddedNetwork.profile", true)
                if interactive && loggedIn { self.loginUntil = Date().addingTimeInterval(120) }
                if !loggedIn {
                    self.loginUntil = nil
                    self.statusMessage = tr("Couldn’t start Tailscale sign-in.")
                }
                if starting { self.poll(generation) }
            }
        }
    }

    func stop(signOut: Bool = false) {
        guard !busy else { return }
        if signOut {
            store.setFlag("embeddedNetwork.logoutPending", true)
            store.setFlag("embeddedNetwork.enabled", false)
        }
        generation += 1
        let generation = self.generation
        active = false
        loginUntil = nil
        statusMessage = ""
        busy = true
        peers = []
        selfID = nil
        state = .stopped
        onRevoke?()
        Self.queue.async { [weak self] in
            let reply: Reply
            if signOut {
                if let dir = try? Self.stateDirectory() {
                    reply = Self.call(["op": "logout", "dir": dir.path, "role": "ipad"])
                } else {
                    _ = Self.call(["op": "stop"])
                    reply = Reply()
                }
            } else {
                reply = Self.call(["op": "stop"])
            }
            DispatchQueue.main.async {
                guard let self, generation == self.generation else { return }
                if signOut && reply.ok {
                    self.store.setFlag("embeddedNetwork.profile", false)
                    self.store.setFlag("embeddedNetwork.logoutPending", false)
                    if reply.remoteRevoked == false {
                        self.statusMessage = tr("Signed out here. Tailscale could not confirm removal of this device.")
                    }
                } else if !reply.ok {
                    self.statusMessage = signOut ? tr("Couldn’t sign out of Tailscale. Try again.") : tr("Couldn’t stop Tailscale.")
                }
                self.busy = false
                self.onChange?()
            }
        }
    }

    private func fail() {
        if state == .running { onRevoke?() }
        active = false
        loginUntil = nil
        selfID = nil
        peers = []
        state = .error
        onChange?()
    }

    private func poll(_ generation: Int) {
        guard active, self.generation == generation else { return }
        Self.queue.async { [weak self] in
            let reply = Self.call(["op": "status"])
            DispatchQueue.main.async {
                guard let self, self.active, self.generation == generation else { return }
                guard reply.ok, let state = reply.state, state != .error else { return self.fail() }
                if self.state == .running && (state != .running || self.selfID != reply.selfID) { self.onRevoke?() }
                let peers = state == .running ? reply.peers ?? [] : []
                let changed = self.state != state || self.peers != peers || self.selfID != reply.selfID
                if self.state != state { self.state = state }
                if self.peers != peers { self.peers = peers }
                self.selfID = reply.selfID
                if changed { self.onChange?() }
                if state == .needsLogin, let deadline = self.loginUntil, Date() < deadline,
                   UIApplication.shared.applicationState == .active,
                   let url = reply.authURL, Self.isLoginURL(url) {
                    self.loginUntil = nil
                    UIApplication.shared.open(url)
                } else if state != .starting && state != .needsLogin {
                    self.loginUntil = nil
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + (state == .running ? 4 : 1)) { [weak self] in
                    self?.poll(generation)
                }
            }
        }
    }

    private static func isLoginURL(_ url: URL) -> Bool {
        url.scheme == "https" && ["login.tailscale.com", "controlplane.tailscale.com"].contains(url.host ?? "") &&
            url.user == nil && url.password == nil && url.port == nil && url.query == nil && url.fragment == nil &&
            url.path.range(of: "^/a/[A-Za-z0-9_-]{1,256}$", options: .regularExpression) != nil
    }

    static func dial(_ node: String, on callback: DispatchQueue, done: @escaping (Bridge?) -> Void) {
        queue.async {
            let reply = call(["op": "dial", "peer": node])
            let bridge: Bridge?
            if reply.ok, let handle = reply.handle, !handle.isEmpty {
                if let port = reply.port, port > 0, let hex = reply.token,
                   Proto.isHex(hex, min: 64, max: 64) {
                    let digits = Array(hex.utf8)
                    let bytes = stride(from: 0, to: digits.count, by: 2).compactMap { index in
                        UInt8(String(decoding: digits[index...index + 1], as: UTF8.self), radix: 16)
                    }
                    bridge = bytes.count == 32 ? Bridge(port: port, token: Data(bytes), handle: handle) : nil
                } else { bridge = nil }
                if bridge == nil { _ = call(["op": "close", "handle": handle]) }
            } else { bridge = nil }
            callback.async { done(bridge) }
        }
    }

    private static func call(_ request: [String: String]) -> Reply {
        guard let data = try? JSONEncoder().encode(request) else { return Reply() }
        let json = String(decoding: data, as: UTF8.self)
        guard let result = json.withCString({ twindesk_net_call($0) }) else { return Reply() }
        defer { twindesk_net_free(result) }
        return (try? JSONDecoder().decode(Reply.self, from: Data(String(cString: result).utf8))) ?? Reply()
    }

    private static func startNode(_ name: String) throws -> Bool {
        let dir = try stateDirectory()
        return call(["op": "start", "dir": dir.path, "role": "ipad", "displayName": name]).ok
    }

    private static func stateDirectory() throws -> URL {
        let files = FileManager.default
        var dir = try files.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                appropriateFor: nil, create: true)
            .appendingPathComponent("TwinDeskTailscale", isDirectory: true)
        try files.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try dir.setResourceValues(values)
        return dir
    }
}
