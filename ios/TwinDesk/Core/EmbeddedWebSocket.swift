// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
import Foundation
import Network
import Security

/// The bridge consumes a one-use proof before the Mac's ordinary TLS and WebSocket handshakes.
final class EmbeddedWebSocket {
    private let bridge: EmbeddedNetwork.Bridge
    private let connection: NWConnection
    private final class Verification { var rejected = false }
    private let verification = Verification()
    private var closed = false

    init(bridge: EmbeddedNetwork.Bridge, fingerprint: String, queue: DispatchQueue) {
        self.bridge = bridge
        let tls = NWProtocolTLS.Options()
        let websocket = NWProtocolWebSocket.Options()
        websocket.autoReplyPing = true
        websocket.maximumMessageSize = Proto.maxPayload
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { [verification] _, trust, finish in
            let matches = Link.leafFingerprint(sec_trust_copy_ref(trust).takeRetainedValue()) == fingerprint
            verification.rejected = !matches
            finish(matches)
        }, queue)
        let parameters = EmbeddedBridgeFramer.parameters(token: bridge.token, tls: tls, websocket: websocket)
        // Network.framework needs a URL endpoint to generate the WebSocket request path.
        let endpoint = URL(string: "wss://127.0.0.1:\(bridge.port)/")!
        connection = NWConnection(to: .url(endpoint), using: parameters)
    }

    func start(on queue: DispatchQueue, ready: @escaping () -> Void,
               text: @escaping (String) -> Void, failed: @escaping (String?) -> Void) {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self, !self.closed else { return }
            switch state {
            case .ready:
                ready()
                self.receive(text: text, failed: failed)
            case .failed, .waiting:
                failed(self.verification.rejected ? "identity" : tr("Couldn’t connect over Tailscale."))
            case .cancelled:
                failed(nil)
            default: break
            }
        }
        connection.start(queue: queue)
    }

    private func receive(text: @escaping (String) -> Void, failed: @escaping (String?) -> Void) {
        guard !closed else { return }
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self, !self.closed else { return }
            guard error == nil, let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
                    as? NWProtocolWebSocket.Metadata, metadata.opcode != .close else { return failed(nil) }
            if metadata.opcode == .text || metadata.opcode == .binary,
               let data, let value = String(data: data, encoding: .utf8) { text(value) }
            self.receive(text: text, failed: failed)
        }
    }

    func send(_ text: String, complete: @escaping () -> Void) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "twindesk", metadata: [metadata])
        connection.send(content: Data(text.utf8), contentContext: context, isComplete: true,
                        completion: .contentProcessed { _ in complete() })
    }

    func close() {
        closed = true
        connection.stateUpdateHandler = nil
        connection.cancel()
    }
}

private final class EmbeddedBridgeFramer: NWProtocolFramerImplementation {
    static let label = "TwinDesk bridge"
    private static let definition = NWProtocolFramer.Definition(implementation: EmbeddedBridgeFramer.self)
    private static let tokenKey = "token"
    private static let tlsKey = "tls"

    static func parameters(token: Data, tls: NWProtocolTLS.Options, websocket: NWProtocolWebSocket.Options) -> NWParameters {
        let proof = NWProtocolFramer.Options(definition: definition)
        proof[tokenKey] = token
        proof[tlsKey] = tls
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let parameters = NWParameters(tls: nil, tcp: tcp)
        parameters.preferNoProxies = true
        parameters.requiredInterfaceType = .loopback
        parameters.defaultProtocolStack.applicationProtocols = [websocket, proof]
        return parameters
    }

    required init(framer: NWProtocolFramer.Instance) {}

    func start(framer: NWProtocolFramer.Instance) -> NWProtocolFramer.StartResult {
        framer.async {
            guard let token = framer.options[Self.tokenKey] as? Data, token.count == 32,
                  let tls = framer.options[Self.tlsKey] as? NWProtocolTLS.Options else {
                framer.markFailed(error: .posix(.EINVAL))
                return
            }
            do {
                try framer.prependApplicationProtocol(options: tls)
            } catch {
                framer.markFailed(error: .posix(.EPROTO))
                return
            }
            framer.writeOutput(data: token)
            framer.passThroughInput()
            framer.passThroughOutput()
            framer.markReady()
        }
        return .willMarkReady
    }

    func handleInput(framer: NWProtocolFramer.Instance) -> Int { 0 }
    func handleOutput(framer: NWProtocolFramer.Instance, message: NWProtocolFramer.Message, messageLength: Int, isComplete: Bool) {}
    func wakeup(framer: NWProtocolFramer.Instance) {}
    func stop(framer: NWProtocolFramer.Instance) -> Bool { true }
    func cleanup(framer: NWProtocolFramer.Instance) {}
}
