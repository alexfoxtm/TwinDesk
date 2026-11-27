#!/bin/sh
# Use the same SDK and aapt for Mac packaging and the local fork release.
AAPT_BIN=${AAPT:-}
if [ -z "$AAPT_BIN" ]; then
  for tool in "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"/build-tools/*/aapt; do
    [ ! -x "$tool" ] || AAPT_BIN=$tool
  done
fi
[ -n "$AAPT_BIN" ] && [ -x "$AAPT_BIN" ] || { echo 'error: aapt is required to verify the Android APK' >&2; exit 1; }
exec "$AAPT_BIN" dump badging "$1"
