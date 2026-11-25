// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This iPhone's screen on the computer, Meet-style (the whole screen, every app). The broadcast
// extension (Broadcast/SampleHandler.swift) encodes it and hands it to us on 127.0.0.1:47830; we
// send it to the computer as an Android phone does without wireless debugging (Mirror.kt; the
// computer's shared/nativescreen.js), so its phone window shows it:
//   phone.mirror {open}                         to the computer: shared from here (the person
//                                               started it on the iPhone), open its window / closed
//   phone.mirror.want {on, key, maxSize, bitrate, fps} | {on, sync}   from it
//   phone.mirror.state {on, waiting, error, w, h, sw, sh, key}        to it
//   POST /twindesk/mirror (x-twindesk-mirror: key), the session's HTTPS port: scrcpy's packets
// When the computer asks (its Show screen), it names its AirPlay receiver too (want.airplay, turned
// on there): the app asks here, Share Screen or Screen Mirroring to it (UI/MirrorGuide.swift shows
// where that is), and phone.mirror.state {on: false, airplay: true} closes its window for AirPlay's.
import Foundation
import Network
import UIKit

final class Mirror: Feature {
    static let port: UInt16 = 47830
    private static let requestSeconds: TimeInterval = 120 // NativeScreen's original Start deadline
    private static let pickerSeconds: TimeInterval = 30 // the existing window for the system picker

    private var listener: NWListener?
    private var ext: NWConnection? // the broadcast extension, while it shares
    private var rx = Data()
    struct Request: Identifiable {
        let id = UUID()
        fileprivate let session: UUID
        fileprivate let want: JSON
        fileprivate let deadline: DispatchTime
        fileprivate var key: String { want.str("key", max: 64) }
    }

    private(set) var sharing = false // the extension is running
    private var asking = false
    var prompt: Request? { asking ? request : nil }
    private(set) var airplayTo: String? // the computer's AirPlay receiver (Screen Mirroring lists it so)
    // A Mac whose AirPlay Receiver is off (want.airplayOff): the sheet says where to turn it on there.
    private(set) var airplayOff = false
    // Where Screen Mirroring goes: the receiver the computer named, else the computer's own name.
    var airplayName: String { airplayTo ?? core.link.host?.name ?? tr("the computer") }
    private(set) var size: (w: Int, h: Int, sw: Int, sh: Int)?
    private var request: Request?
    private var acceptedUntil: DispatchTime?
    private var acceptanceExpiry: DispatchWorkItem?
    private var pickerRequest: (id: UUID, until: DispatchTime)? // bounded even after the underlying request is gone
    private var want: JSON? { request?.want }

    private func owns(_ session: UUID) -> Bool {
        core.link.q.sync { core.link.sessionID == session }
    }
    private var upload: NWConnection? // io only: the stream to the computer, while it goes
    private var uploadGen = 0 // main: which stream is current (an old one's end restarts nothing)
    private var inflight = 0 // io only: bytes handed to the connection, not sent yet
    private var skipToKey = false // io only: frames dropped, so the rest wait for the next keyframe
    private let io = DispatchQueue(label: "td.mirror")
    private var sessionPacket: Data? // the size packet: first in every new request
    private var configPacket: Data? // SPS/PPS: next, so the window can decode from the first frame
    var peerTap: ((Data) -> Void)? // a phone watching (Peer.swift): every packet, as it comes
    // Share was tapped and iOS's sheet is up (it takes the app out of focus): the session stays on
    // Wi-Fi meanwhile (Core.networkBusy), so the picture has a way once the broadcast starts.
    private static var now: DispatchTime { .now() }
    var starting: Bool { startUntil > Self.now }
    private var startUntil = DispatchTime(uptimeNanoseconds: 0)
    func willStart(for id: UUID?) -> Bool {
        let now = Self.now
        expireRequest(at: now)
        guard !sharing else { return false }
        if let id {
            guard let request, request.id == id, let until = acceptedUntil, owns(request.session) else { return false }
            pickerRequest = (id, until)
            startUntil = until
        } else {
            // A fresh local Share must not inherit an abandoned desktop acceptance.
            if acceptedUntil != nil, let request { retireUnstarted(request) }
            pickerRequest = nil
            startUntil = now + Self.pickerSeconds
        }
        return true
    }
    private var openPending: UUID? // shared on Bluetooth: tell this session once back on the network
    private var announcedSession: UUID? // the local broadcast opened this computer's window
    private var uploadPending = false // asked for while on Bluetooth: the stream starts once on the network
    private var graceWork: DispatchWorkItem? // the session dropped while sharing: the broadcast waits this long

    override init(_ core: Core) {
        super.init(core)
        startListening()
    }

    // ---- the extension ----

    private func startListening() {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: Self.port)!)
        params.allowLocalEndpointReuse = true
        guard let l = try? NWListener(using: params) else { return }
        l.newConnectionHandler = { [weak self] c in DispatchQueue.main.async { self?.accept(c) } }
        l.stateUpdateHandler = { [weak self] st in
            if case .failed = st { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self?.listener = nil; self?.startListening() } }
        }
        l.start(queue: .main)
        listener = l
    }

    private func accept(_ c: NWConnection) {
        let now = Self.now
        expireRequest(at: now)
        if let picker = pickerRequest {
            if now < picker.until {
                guard let request, request.id == picker.id, acceptedUntil == picker.until,
                      !sharing, owns(request.session) else { c.cancel(); return }
            } else if request != nil {
                // ReplayKit does not identify its launcher. An expired picker may not be used to
                // answer another desktop request. A new Share Screen tap opens a fresh picker.
                c.cancel()
                return
            }
            pickerRequest = nil
        } else if acceptedUntil != nil {
            // Share Screen accepted the prompt, but its deferred picker has not opened yet.
            c.cancel()
            return
        }
        clearAcceptance()
        ext?.cancel()
        ext = c
        rx = Data()
        c.stateUpdateHandler = { [weak self] st in
            switch st {
            case .failed, .cancelled: DispatchQueue.main.async { if self?.ext === c { self?.extGone() } }
            default: break
            }
        }
        c.start(queue: .main)
        sharing = true
        if asking { Notifier.shared.cancel("share") }
        asking = false
        startUntil = DispatchTime(uptimeNanoseconds: 0)
        sendExt(["ack": 1]) // the extension knows the app has it (else it ends the broadcast, never recording for nothing)
        Background.shared.apply() // the app stays up while it relays the screen
        read(c)
        core.changed()
        // A phone holds the session (Peer, phone to phone: no computer then): the screen goes to it,
        // once it asks (screen.start) or at once if it asked before Share Screen was started.
        if core.peer.connected {
            core.peer.shareStarted()
            return
        }
        if !core.connected {
            // Nothing to share with: a session coming back soon still gets it (onWelcome), else the
            // broadcast stops itself and says why.
            waitForSession()
            return
        }
        announce()
    }

    // Shared from here: the computer opens its window and asks (phone.mirror.want). On Bluetooth the
    // picture has no way: back onto the network first (told then, networkBack), or after a few
    // seconds anyway (the computer says what it needs).
    private func announce() {
        let link = core.link
        guard sharing, let session = link.q.sync(execute: { link.sessionID }) else { return }
        if want != nil { return configure() }
        if link.viaBle {
            openPending = session
            core.needNetwork()
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                guard let self, self.sharing, self.openPending == session else { return }
                self.open(for: session)
            }
            return
        }
        open(for: session)
    }

    private func open(for session: UUID) {
        openPending = nil
        guard owns(session) else { return }
        if core.link.send(msg("phone.mirror", ["open": true]), session: session) { announcedSession = session }
    }

    // The session moved from Bluetooth back onto the network (Core.offBle): what waited for it now.
    func networkBack() {
        guard sharing, core.connected, !core.link.viaBle else { return }
        if let session = openPending { open(for: session) }
        if uploadPending || want != nil { uploadPending = false; startUpload() } // a stream on the old way: again on this one
    }

    private func waitForSession() {
        graceWork?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self = self, self.sharing, !self.core.connected, !self.core.peer.connected else { return }
            self.sendExt(["stop": 1])
        }
        graceWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: w)
    }

    private func read(_ c: NWConnection) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, err in
            guard let self = self, self.ext === c else { return }
            if let d = data { self.rx.append(d); self.parse() }
            if done || err != nil { self.extGone(); return }
            self.read(c)
        }
    }

    private func parse() {
        while rx.count >= 5 {
            let s = rx.startIndex
            let n = Int(rx[s + 1]) << 24 | Int(rx[s + 2]) << 16 | Int(rx[s + 3]) << 8 | Int(rx[s + 4])
            guard rx.count >= 5 + n else { return }
            let type = rx[s]
            let body = rx.subdata(in: (s + 5)..<(s + 5 + n))
            rx = rx.subdata(in: (s + 5 + n)..<rx.endIndex)
            if type == 2 { packet(body); continue }
            guard type == 1, let m = (try? JSONSerialization.jsonObject(with: body)) as? JSON else { continue }
            if m["stopped"] != nil { extGone(); return }
            if m["hello"] != nil {
                size = (m.int("w"), m.int("h"), m.int("sw"), m.int("sh"))
                sendState()
            }
        }
    }

    private func extGone() {
        guard sharing else { return }
        sharing = false
        graceWork?.cancel()
        graceWork = nil
        openPending = nil
        uploadPending = false
        Background.shared.apply()
        ext?.cancel()
        ext = nil
        size = nil
        endUpload()
        if let request {
            core.link.send(msg("phone.mirror.state", ["on": false, "key": request.key]), session: request.session)
        }
        if let session = request?.session ?? announcedSession {
            core.link.send(msg("phone.mirror", ["open": false]), session: session)
        }
        announcedSession = nil
        discardRequest()
        core.changed()
        // Shared off screen and done: onto Bluetooth now (Core.backgrounded waited for it).
        DispatchQueue.main.async { if !self.core.inFront { self.core.backgrounded() } }
    }

    private func sendExt(_ m: JSON) {
        guard let c = ext, let d = try? JSONSerialization.data(withJSONObject: m) else { return }
        var f = Data([1])
        let n = UInt32(d.count)
        f.append(contentsOf: [UInt8(n >> 24), UInt8(n >> 16 & 255), UInt8(n >> 8 & 255), UInt8(n & 255)])
        f.append(d)
        c.send(content: f, completion: .idempotent)
    }

    // A phone wants it (Peer.swift): the encoder on, at its size, a keyframe now.
    func peerWant(_ maxSize: Int) {
        let w = want
        sendExt(["maxSize": w?.int("maxSize") ?? maxSize, "bitrate": w?.int("bitrate", 8_000_000) ?? 6_000_000, "fps": min(60, w?.int("fps", 30) ?? 30), "want": 1, "sync": 1])
    }

    // Stop sharing (the app's button): the extension ends the broadcast.
    func stop() {
        sendExt(["stop": 1])
        extGone()
    }

    // ---- the computer ----

    func receiveWant(_ m: JSON, session: UUID) {
        guard owns(session) else { return }
        let now = Self.now
        let next = Request(session: session, want: m, deadline: now + Self.requestSeconds)
        if !m.bool("on") {
            guard let request, request.session == session, request.key == next.key else { return }
            discardRequest()
            Notifier.shared.cancel("share")
            core.changed()
            endUpload()
            if sharing { sendExt(["stop": 1]) }
            return
        }
        if m.bool("sync") {
            if request?.session == session && (next.key.isEmpty || request?.key == next.key) {
                sendExt(["sync": 1])
            }
            return
        }
        if !sharing, let request, request.session == session, !next.key.isEmpty, request.key == next.key,
           now < (acceptedUntil ?? request.deadline) { return }
        clearAcceptance()
        request = next
        let air = m.str("airplay", max: 100)
        airplayTo = air.isEmpty ? nil : air
        airplayOff = m.bool("airplayOff")
        if sharing { configure() }
        else {
            // The computer asked first (its Show Phone Screen): Start is the person's, on this iPhone.
            core.link.send(msg("phone.mirror.state", ["on": false, "waiting": true, "key": next.key]), session: session)
            asking = true
            core.changed()
            Notifier.shared.shareAsk(core.link.host?.name ?? tr("The computer"), airplay: airplayTo)
        }
    }

    private func clearAcceptance() {
        acceptanceExpiry?.cancel()
        acceptanceExpiry = nil
        acceptedUntil = nil
    }

    private func discardRequest() {
        clearAcceptance()
        request = nil
        asking = false
    }

    private func retireUnstarted(_ request: Request) {
        discardRequest()
        Notifier.shared.cancel("share")
        core.changed()
        core.link.send(msg("phone.mirror.state", ["on": false, "error": "Start wasn’t tapped on the phone", "key": request.key]), session: request.session)
    }

    private func expireRequest(at now: DispatchTime) {
        guard !sharing, let request, now >= (acceptedUntil ?? request.deadline) else { return }
        retireUnstarted(request)
    }

    private func finishPrompt(_ id: UUID, at now: DispatchTime = Mirror.now) -> Request? {
        expireRequest(at: now)
        guard let prompt, prompt.id == id, !sharing, owns(prompt.session) else { return nil }
        asking = false
        Notifier.shared.cancel("share")
        core.changed()
        return prompt
    }

    // Leave the request in place for ReplayKit's eventual broadcast connection.
    func acceptPrompt(_ id: UUID) -> Bool {
        let now = Self.now
        guard let prompt = finishPrompt(id, at: now) else { return false }
        let until = min(prompt.deadline, now + Self.pickerSeconds)
        acceptedUntil = until
        let expiry = DispatchWorkItem { [weak self] in
            guard let self, self.request?.id == id, self.acceptedUntil == until else { return }
            self.expireRequest(at: Self.now)
        }
        acceptanceExpiry = expiry
        DispatchQueue.main.asyncAfter(deadline: until, execute: expiry)
        return true
    }

    // Screen Mirroring (AirPlay) in place of Share Screen.
    func useAirPlay(_ id: UUID) {
        guard let prompt = finishPrompt(id) else { return }
        discardRequest()
        core.link.send(msg("phone.mirror.state", ["on": false, "airplay": true, "key": prompt.key]), session: prompt.session)
    }

    func decline(_ id: UUID) {
        guard let prompt = finishPrompt(id) else { return }
        discardRequest()
        core.link.send(msg("phone.mirror.state", ["on": false, "error": "Not shared from the \(Device.word)", "key": prompt.key]), session: prompt.session)
    }

    // The session dropped (a Wi-Fi blip, the computer restarting): the broadcast waits a little for it
    // to come back (onWelcome) before it stops, and encodes nothing meanwhile.
    override func onClosed() {
        discardRequest()
        Notifier.shared.cancel("share")
        openPending = nil
        announcedSession = nil
        uploadPending = false
        endUpload()
        if sharing { sendExt(["want": 0]); waitForSession() }
    }

    override func onWelcome(_ host: Computer, _ m: JSON) {
        graceWork?.cancel()
        graceWork = nil
        if sharing { announce() }
    }

    private func configure() {
        guard let request, owns(request.session) else { return }
        let w = request.want
        sendExt(["maxSize": w.int("maxSize"), "bitrate": w.int("bitrate", 8_000_000), "fps": min(60, w.int("fps", 30)), "want": 1, "sync": 1])
        if core.link.viaBle { uploadPending = true; core.needNetwork() } // no picture through Bluetooth (networkBack)
        else { startUpload() }
        sendState()
    }

    private func sendState() {
        guard let request, let s = size else { return }
        core.link.send(msg("phone.mirror.state", ["on": true, "key": request.key, "w": s.w, "h": s.h, "sw": s.sw, "sh": s.sh]), session: request.session)
    }

    // ---- the stream: one long POST, its body fed as packets come ----
    //
    // A TLS connection of our own (the computer's certificate pinned as the session's), the request
    // written by hand with a chunked body: each packet one chunk, sent as it comes. (It was a
    // URLSession upload fed through bound streams whose run loop held the queue the packets came in
    // on, so after the first two packets nothing more reached the computer.)

    private func startUpload() {
        endUpload()
        guard let request else { return }
        let link = core.link
        let target: (URLRequest, String)? = link.q.sync {
            guard link.sessionID == request.session, let req = link.sessionRequest("/twindesk/mirror", method: "POST") else { return nil }
            return (req, link.seenFp.isEmpty ? (link.host?.fp ?? "") : link.seenFp)
        }
        guard let (req, pin) = target, let u = req.url, let host = u.host, let port = u.port,
              let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else {
            link.send(msg("phone.mirror.state", ["on": false, "error": "the connection closed", "key": request.key]), session: request.session)
            return
        }
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, done in
            let fp = Link.leafFingerprint(sec_trust_copy_ref(trust).takeRetainedValue())
            done(fp != nil && (pin.isEmpty || fp == pin))
        }, io)
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let c = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: NWParameters(tls: tls, tcp: tcp))
        uploadGen += 1
        let gen = uploadGen
        let head = "POST /twindesk/mirror HTTP/1.1\r\nHost: \(host):\(port)\r\nContent-Type: application/octet-stream\r\n"
            + "x-twindesk-mirror: \(request.key)\r\nTransfer-Encoding: chunked\r\n\r\n"
        let first = [sessionPacket, configPacket].compactMap { $0 }
        c.stateUpdateHandler = { [weak self] st in
            guard let self = self else { return }
            switch st {
            case .ready:
                c.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
                self.upload = c
                self.inflight = 0
                self.skipToKey = true // from a keyframe on (the extension is asked for one)
                for p in first { self.chunk(c, p) }
                DispatchQueue.main.async { self.sendExt(["sync": 1]) }
                self.drain(c, gen)
            case .failed(let e):
                NSLog("TwinDesk: screen stream: %@", e.localizedDescription)
                c.cancel()
                self.uploadEnded(c, gen)
            case .cancelled: self.uploadEnded(c, gen)
            default: break
            }
        }
        c.start(queue: io)
    }

    // The computer's answer: read and dropped; its end is the stream's.
    private func drain(_ c: NWConnection, _ gen: Int) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] _, _, done, err in
            if done || err != nil { c.cancel(); self?.uploadEnded(c, gen); return }
            self?.drain(c, gen)
        }
    }

    // io: gone (the computer closed it, the network dropped). Still sharing and still wanted: again.
    private func uploadEnded(_ c: NWConnection, _ gen: Int) {
        if upload === c { upload = nil }
        DispatchQueue.main.async {
            guard gen == self.uploadGen else { return }
            NSLog("TwinDesk: screen stream ended")
            if self.sharing, self.want != nil, self.core.connected {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { if gen == self.uploadGen && self.sharing && self.want != nil { self.startUpload() } }
            }
        }
    }

    private func endUpload() {
        uploadGen += 1
        io.async {
            guard let c = self.upload else { return }
            self.upload = nil
            c.send(content: Data("0\r\n\r\n".utf8), completion: .contentProcessed { _ in c.cancel() })
        }
    }

    // io: one packet as one chunk.
    private func chunk(_ c: NWConnection, _ p: Data) {
        var d = Data(String(p.count, radix: 16).utf8)
        d.append(contentsOf: [13, 10])
        d.append(p)
        d.append(contentsOf: [13, 10])
        let n = d.count
        inflight += n
        c.send(content: d, completion: .contentProcessed { [weak self] _ in self?.io.async { self?.inflight -= n } })
    }

    // A packet from the extension: kept if it's the size or SPS/PPS, then on to the computer.
    private func packet(_ p: Data) {
        guard p.count >= 12 else { return }
        peerTap?(p)
        let b = p[p.startIndex]
        if b & 0x80 != 0 { sessionPacket = p; configPacket = nil }
        else if b & 0x40 != 0 { configPacket = p } // bit 62: config
        io.async {
            guard let c = self.upload else { return }
            let special = b & 0xC0 != 0 // the size or SPS/PPS: always
            let key = b & 0x20 != 0 // bit 61: a keyframe
            // Behind by more than ~2 s of picture: frames dropped until a keyframe (asked for now).
            if !special && self.inflight > 4 << 20 {
                if !self.skipToKey { self.skipToKey = true; DispatchQueue.main.async { self.sendExt(["sync": 1]) } }
                return
            }
            if !special && self.skipToKey { if key { self.skipToKey = false } else { return } }
            self.chunk(c, p)
        }
    }
}
