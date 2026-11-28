// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
import Foundation
import CoreFoundation
import UIKit
import SwiftUI

func supportedVideoLink(_ value: String) -> URL? {
    guard value.count <= 2048, let c = URLComponents(string: value),
          c.scheme == "https", c.user == nil, c.password == nil, c.port == nil,
          let host = c.host else { return nil }
    let path = c.path
    let query = c.queryItems ?? []
    let valid: Bool
    switch host {
    case "www.youtube.com":
        let id = query.first { $0.name == "v" }?.value ?? ""
        valid = path == "/watch" && id.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil
    case "vimeo.com":
        valid = path.range(of: "^/[0-9]{1,20}/?$", options: .regularExpression) != nil
    case "www.twitch.tv":
        valid = path.range(of: "^/videos/[0-9]{1,20}/?$", options: .regularExpression) != nil
    case "www.dailymotion.com":
        valid = path.range(of: "^/video/[A-Za-z0-9]{1,40}/?$", options: .regularExpression) != nil
    default: valid = false
    }
    guard valid else { return nil }
    let keys: Set<String> = host == "www.youtube.com" ? ["v", "t"] : host == "vimeo.com" ? [] : host == "www.dailymotion.com" ? ["start"] : ["t"]
    guard Set(query.map(\.name)) == keys, query.count == keys.count else { return nil }
    let stamp = host == "vimeo.com" ? c.fragment?.replacingOccurrences(of: "^t=", with: "", options: .regularExpression)
        : query.first { $0.name == (host == "www.dailymotion.com" ? "start" : "t") }?.value
    let digits = stamp?.replacingOccurrences(of: "s$", with: "", options: .regularExpression) ?? ""
    guard digits.range(of: "^[0-9]{1,6}$", options: .regularExpression) != nil,
          let seconds = Int(digits), (0...604800).contains(seconds),
          host == "vimeo.com" ? c.fragment == "t=\(seconds)s" : c.fragment == nil else { return nil }
    return c.url
}

final class VideoHandoff: Feature {
    struct Offer {
        let id: String
        let url: URL
        let seconds: Int
        let session: UUID
        let expires: TimeInterval
    }
    private(set) var incoming: Offer?
    var current: Offer? {
        guard let offer = incoming, core.link.connected, core.link.sessionID == offer.session,
              ProcessInfo.processInfo.systemUptime < offer.expires else { return nil }
        return offer
    }
    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        guard t == "video.offer" else { return false }
        guard let session = core.link.sessionID, let url = supportedVideoLink(m.str("url")),
              let id = UUID(uuidString: m.str("id")),
              let raw = m["seconds"] as? NSNumber, CFGetTypeID(raw) != CFBooleanGetTypeID(),
              raw.doubleValue == Double(raw.intValue), (0...604800).contains(raw.intValue),
              Self.position(url) == raw.intValue else { return true }
        incoming = Offer(id: id.uuidString.lowercased(), url: url, seconds: raw.intValue, session: session,
                         expires: ProcessInfo.processInfo.systemUptime + 600)
        core.changed()
        return true
    }
    private static func position(_ url: URL) -> Int? {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let value = c.host == "vimeo.com" ? c.fragment?.replacingOccurrences(of: "t=", with: "")
            : c.queryItems?.first { $0.name == (c.host == "www.dailymotion.com" ? "start" : "t") }?.value
        return value.flatMap { Int($0.replacingOccurrences(of: "s", with: "")) }
    }
    func open() {
        guard let offer = current else { return dismiss() }
        UIApplication.shared.open(offer.url, options: [:]) { [weak self] opened in
            guard let self, opened, self.current?.id == offer.id else { return }
            self.core.link.send(["t": "video.ack", "id": offer.id], session: offer.session)
            self.dismiss()
        }
    }
    func dismiss() { incoming = nil; core.changed() }
    override func onWelcome(_ host: Computer, _ m: JSON) { incoming = nil }
    override func onClosed() { incoming = nil }
}

struct VideoHandoffCard: View {
    @EnvironmentObject var core: Core
    var body: some View {
        if let offer = core.videoHandoff.current {
            let hours = offer.seconds / 3600
            let time = hours > 0 ? String(format: "%d:%02d:%02d", hours, offer.seconds / 60 % 60, offer.seconds % 60)
                : String(format: "%d:%02d", offer.seconds / 60, offer.seconds % 60)
            VStack(alignment: .leading, spacing: 12) {
                CardHeader(symbol: "play.rectangle", color: TDColor.accent, title: tr("Continue watching"),
                           detail: offer.url.host ?? "")
                Text(tr("Continue at {time}", ["time": time]))
                    .foregroundStyle(TDColor.muted)
                HStack {
                    Button(tr("Open video")) { core.videoHandoff.open() }.primaryButton()
                    Button(tr("Dismiss")) { core.videoHandoff.dismiss() }
                }
            }.frame(maxWidth: .infinity, alignment: .leading).glassCard()
        }
    }
}
