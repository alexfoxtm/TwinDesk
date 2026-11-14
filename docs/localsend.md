# Files with LocalSend-compatible apps

TwinDesk on the Mac and on Android can find devices that run an app speaking the LocalSend protocol
(v2), send them files and receive theirs, with no TwinDesk on the other side and no pairing. It runs
beside the computer's session and needs none. "LocalSend" names the protocol; TwinDesk is not
affiliated with LocalSend.

## Turning it on

It is off until you turn it on, on each device:

- **Mac:** Files › *Files with LocalSend-compatible apps*.
- **Android:** Files › *Files with LocalSend-compatible apps* (it is there without a computer connected).

While it is off nothing is listened for, announced or accepted. On Android it runs while TwinDesk runs.

## What it does

- **Finds devices** on the network by the protocol's multicast announce (224.0.0.167:53317), or by
  an address you type (*Add a device by its address*) where the network doesn't carry multicast.
- **Sends** files (folders too, from the Mac) to a device you pick. The other person accepts there;
  a device that asks for its PIN gets a field for it.
- **Receives** only what you accept. Every transfer is asked about first, with who it says it is,
  its address and whether that device was checked before; there is no "always accept". Accepted
  files go to the Mac's received-files folder, or Downloads › TwinDesk on Android.

## What keeps it safe

- **Certificates.** Each device has a self-signed certificate; its SHA-256 is the fingerprint the
  protocol announces. An announce is only a claim: a device is listed as verified after a TLS
  connection to its address shows that certificate, and files are sent only over a connection whose
  certificate is the expected one (checked before a byte of the request is written). Our own
  connections present our certificate too, so a receiver that asks for one can check who is sending.
- **Who is asking.** The device behind an offer is the certificate its connection presented, never
  the name, fingerprint or address the request writes about itself. A sender that presents none (an
  older app, or anything that only says who it is) is still asked about, as *didn't prove which
  device it is*, with no fingerprint shown, and is never a known device. *Known* is a certificate
  the person here accepted files from before, or sent files to (kept in `localsend-known.json`:
  fingerprints and names, no keys, the last 256). A name that reads like a known or listed device's
  from another certificate is called out in the question. A device already checked isn't renamed or
  moved by an announce or a `/register` that doesn't come with its certificate.
- **No downgrade.** Devices with encryption off (plain HTTP), protocol v1 and versions after 2 are
  listed as not supported with the reason, and nothing is sent to them. A device known over HTTPS is
  never moved to HTTP by a later announce.
- **Sessions.** One token per file, only from the address that made the offer; the body must be
  exactly the size that was offered, and a file that comes with a SHA-256 must match it. Only the
  sender's address can cancel its session.
- **Names.** What a sender calls a file never decides where it lands: `..`, separators, control
  characters and reserved names are removed, nothing existing is replaced. Characters that are not
  shown or that turn the text around (the right-to-left override in `invoice‮fdp.exe`) are taken
  out of file and device names. Letters that only look alike (Latin and Cyrillic "a") are not told apart.
- **Limits.** Local addresses only; one question per address at a time and three in all, counted
  again in the same step that asks, so requests arriving together still make one question; two
  offers being read per address; a pause after a Decline; four transfers at once; 5000 files an
  offer; a free-space check; idle sessions end.
- **Interfaces.** The port is open on every interface (addresses come and go), and a connection that
  arrives on an address that isn't a local network's is closed before TLS; one from an address that
  isn't local gets 403.
- **What arrives.** On macOS every received file, and each folder made for it, is marked as
  downloaded (`com.apple.quarantine`), so Gatekeeper checks an app or a script before its first run.
  On Android, Accept needs the phone unlocked: on the notification (Android 12 and later ask for the
  unlock themselves) and on the page shown over the lock screen. Decline never does.
- **On and off.** Turning it off while it is still starting leaves nothing listening.

## Not supported

Plain HTTP devices, protocol v1, the browser download API (protocol section 5), the HTTP address scan
(section 3.2: use *Add a device by its address*), and text messages as messages (they arrive as a
file, with the text shown in the question). Windows and Linux have no page for it yet.

## For developers

| File | What |
|---|---|
| `shared/localsend/core.js` | The protocol for Node (MPL-2.0): identity, discovery, server, client. No Electron. |
| `shared/localsend/wire.js` | The setting, the state a page shows and its actions. No Electron: the app gives it its dialogs. |
| `shared/ui-localsend.js` | The cards on the Files page (`UI.localsend()`). |
| `mac/localsend.js` | The Mac's question, file dialog and notifications around `wire.js`. |
| `android/.../LocalSendCore.kt` | The same protocol in Kotlin (MPL-2.0), with nothing of Android. |
| `android/.../LocalSend.kt`, `LocalSendUi.kt` | The phone around it: the switch, Downloads, the question, the cards. |

Windows and Linux can wire it as `mac/localsend.js` does: `startLocalSend({...})` with their own
`ask`, `choose`, `say` and `reveal`, its `actions` on their IPC, `state.localsend = ls.view()`, and
`shared/ui-localsend.js` on their Files page.

Tests, offline on 127.0.0.1. The receiver that takes no connection without a client certificate is
a stand-in written in the tests: none of this has been run against the LocalSend app itself here.

```
node shared/test/localsend.js           # two Node nodes, a client and a receiver written from the protocol text
node shared/test/localsend-android.js   # the Kotlin core on a JVM against the Node core (needs Java and Gradle's cache; skipped without)
```

`core.js` and `LocalSendCore.kt` are adapted from NectarLink and stay under the MPL-2.0
(`licenses/MPL-2.0.txt`, `THIRD_PARTY_NOTICES`).
