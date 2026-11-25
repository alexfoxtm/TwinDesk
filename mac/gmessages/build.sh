#!/bin/sh
# Build both Google Messages helpers and stage the linked transport's corresponding source.
set -eu
case "${1:-$(uname -m)}" in
  x64|x86_64) swift_arch=x86_64; go_arch=amd64 ;;
  arm64|aarch64) swift_arch=arm64; go_arch=arm64 ;;
  *) echo "Unsupported Google Messages helper architecture" >&2; exit 2 ;;
esac
out=${2:-$(dirname "$0")/../../mac-helper/.build/release}
mkdir -p "$out"
out=$(cd "$out" && pwd)
cd "$(dirname "$0")"
export GOWORK=off
export GOTOOLCHAIN=local
xcrun swiftc -O -swift-version 5 -target "$swift_arch-apple-macos13.0" Pairing.swift -o "$out/twindesk-gmessages"
CGO_ENABLED=0 GOOS=darwin GOARCH="$go_arch" go build -trimpath -o "$out/twindesk-gmessages-transport" .
