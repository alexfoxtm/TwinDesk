# TwinDesk embedded Tailscale

The embedded Go engine, device-name validation, one-use local bridge, and private-tailnet fixtures come from AppShare at `acf64930eac04c976f204441e64dc25a67c69b6d`. TwinDesk uses its own node identities, profile directory, and TCP port 47800. Build outputs include the Go and dependency notices.

Sign in to the same Tailscale account in each TwinDesk installation. The Mac's embedded Tailscale pairing QR names its stable node and pins its TwinDesk TLS certificate. The Mac must approve pairing. Only that device's approved TwinDesk token and witnessed Tailscale node can open the embedded session afterward. Each dial uses a short-lived local bridge with a one-use proof before TLS. Stop closes the bridges. Sign out removes only the local TwinDesk network profile.

Commands are `./build.sh mac arm64 <output>` (or `x64`), `./build.sh ios`, and `./build.sh android <output>`. Use Go from go.mod, Xcode for Apple builds, and the pinned NDK for Android.

The embedded path carries TwinDesk's authenticated WebSocket. File transfer uses its in-session fallback. The separate direct screen, audio, and HTTP paths require a normal TwinDesk connection. Local and standalone Tailscale routes retain their existing behavior.
