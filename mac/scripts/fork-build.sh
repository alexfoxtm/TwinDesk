#!/bin/sh
# Read the fork counter from the checkout passed in $1.
build=$(sed -n 's/^CURRENT_PROJECT_VERSION = \([1-9][0-9]\{0,3\}\)$/\1/p' "$1/ios/ForkBuild.xcconfig")
case "$build" in
  ''|*[!0-9]*) echo 'error: set one positive numeric build (1–9999) in ios/ForkBuild.xcconfig' >&2; exit 1 ;;
esac
printf '%s\n' "$build"
