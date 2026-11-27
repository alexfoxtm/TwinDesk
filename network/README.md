# TwinDesk embedded Tailscale

The embedded Go engine, device-name validation, one-use local bridge, and private-tailnet fixtures come from AppShare at `acf64930eac04c976f204441e64dc25a67c69b6d`. TwinDesk uses its own node identities, profile directory, and TCP port 47800. Build outputs include the Go and dependency notices.

Sign in to the same Tailscale account in each TwinDesk installation. The Mac's embedded Tailscale pairing QR names its stable node and pins its TwinDesk TLS certificate. The Mac must approve new pairings. An embedded session requires the approved TwinDesk token from the device on the witnessed Tailscale route. Each dial uses a short-lived local bridge with a one-use proof before TLS. Stop closes the bridges. Sign out removes only the local TwinDesk network profile.

Commands are `./build.sh mac arm64 <output>` (or `x64`), `./build.sh ios`, and `./build.sh android <output>`. Use Go from go.mod, Xcode for Apple builds, and the pinned NDK for Android.

The embedded path carries TwinDesk's authenticated WebSocket. Already-paired Android phones can connect to the exact paired Mac using their saved credentials. An explicit pairing QR is available for a new pairing or to repair a stale binding.

After returning to Wi-Fi, Android verifies the paired Mac's certificate over its local network before switching back to the normal connection. TwinDesk Network stays signed in for the next fallback. A manual TwinDesk Network connection on the same Wi-Fi stays on that route until the network changes.

An already-authorized Mac can use Android Wireless debugging through the embedded route while the phone has Wi-Fi and its current wireless ADB listener is available. Android's own debugging approval still applies, and Stop or a connection change closes the tunnel. Initial Wireless debugging pairing remains on the same Wi-Fi.

Updated Macs and Android phones carry screen and audio through a per-session TURN relay. Native Android mirroring and shared folders in both directions also use the embedded route. These connections require a current pairing session and keep the existing screen and folder permissions. Ordinary file transfer and Photo Save As use the authenticated session. Automatic Direct-mode photo backup over the embedded route requires an unmetered connection.

Direct mode can use the Android lock viewer over the embedded route when the Mac's existing Screen Sharing and remote-view permissions allow it. USB and Wi-Fi Direct require their underlying physical links. Separate fast-file endpoints continue to use the normal connection. Local and standalone Tailscale routes retain their existing behavior.
