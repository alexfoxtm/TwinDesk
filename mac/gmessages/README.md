# TwinDesk Google Messages transport

TwinDesk uses the libgm package from [mautrix-gmessages v0.2611.0](https://github.com/mautrix/gmessages/tree/3c3a87849d0a1bebc415493927be0314ec7e245b)
under the GNU AGPL version 3. See [LICENSE](LICENSE) for the license and [go.mod](go.mod)
and [go.sum](go.sum) for the exact dependency graph. The bundled `vendor/`
directory contains the linked dependency source and its notices. The binary
and the Go wrapper are distributed under AGPL-3.0. The separate macOS bridge
and TwinDesk application retain their GPL-3.0 license.

Build from this directory with macOS Xcode Command Line Tools and a Go
toolchain that supports Go 1.26 or newer. Run `./build.sh arm64 /absolute/output`
or use `x64` for Intel. For an offline rebuild from the app's bundled source,
set `GOFLAGS=-mod=vendor`. The parent app build signs both helpers.

The macOS bridge owns a nonpersistent WebKit data store and one local Keychain
item per selected Android device under `io.github.alexfoxtm.twindesk.google-messages`.
It exchanges session data with its transport over inherited pipes. Its
interface to Electron carries commands, state and message content. The
transport does not maintain a disk cache. Disconnect removes the local
Keychain item. The phone still manages its list of paired devices in Google
Messages.

The bridge follows the [libgm Google Account flow](https://docs.mau.fi/bridges/go/gmessages/authentication.html).
The Google sign-in and the phone's emoji confirmation require a live test.
