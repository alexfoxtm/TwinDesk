#!/bin/bash
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Stages the fork's unsigned TwinDesk.ipa for developer mode ("This Mac's developer certificate",
# mac/ios-developer-sign.js) in the app's settings folder, never inside the app:
#   <out>/TwinDesk.ipa        built by ios/build.sh from the committed tree (git archive HEAD)
#   <out>/TwinDesk.ipa.stamp  ios=<git rev-parse HEAD:ios>, web=<tree of the app pages ios/ embeds>,
#                             network=<embedded network tree>, sha256 and version of that TwinDesk.ipa
# It rebuilds only when the iOS, embedded web, or embedded network trees differ, or the staged IPA
# or stamp is missing, mismatched or invalid. A new IPA is checked with the same inventory rules
# as installs (Payload/TwinDesk.app com.twindesk.ios, iPhone and iPad, exactly .share and
# .broadcast) before it atomically replaces the old one; on any failure the cached IPA stays.
# It never downloads releases and never touches the app bundle.
#
# Usage: stage-ios-ipa.sh [--out /abs/dir] [--repo /abs/checkout] [--force]
#   --out   default ~/Library/Application Support/io.github.alexfoxtm.twindesk/ios-developer
# TWINDESK_STAGE_IOS_BUILD (tests only): a command run in place of ios/build.sh, in the exported ios/.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VERIFY="$HERE/../ios-developer-sign.js"
REPO=""
OUT="$HOME/Library/Application Support/io.github.alexfoxtm.twindesk/ios-developer"
FORCE=0
NODE="${NODE:-node}"

die() { echo "stage-ios-ipa: $*" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || die "--out needs a directory"; OUT="$2"; shift 2 ;;
    --repo) [ $# -ge 2 ] || die "--repo needs a checkout"; REPO="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "Usage: stage-ios-ipa.sh [--out /abs/dir] [--repo /abs/checkout] [--force]" >&2; exit 2 ;;
  esac
done
case "$OUT" in /*) ;; *) die "--out must be an absolute path" ;; esac
[ -n "$REPO" ] || REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
WEB=android/app/src/main/assets/web
IOS_TREE="$(git -C "$REPO" rev-parse --verify --quiet HEAD:ios)" || die "no ios/ tree at HEAD in $REPO"
WEB_TREE="$(git -C "$REPO" rev-parse --verify --quiet "HEAD:$WEB")" || die "no $WEB tree at HEAD in $REPO"
NETWORK_TREE="$(git -C "$REPO" rev-parse --verify --quiet HEAD:network || true)"
NETWORK_TREE="${NETWORK_TREE:--}"
SOURCE_TREES=(ios "$WEB")
if [ "$NETWORK_TREE" != "-" ]; then SOURCE_TREES+=(network); fi
IPA="$OUT/TwinDesk.ipa"
STAMP="$OUT/TwinDesk.ipa.stamp"

field() { sed -n "s/^$1=//p" "$2" 2>/dev/null | head -1; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
version_of() { "$NODE" "$VERIFY" --verify "$1" | sed -n 's/.*"version":"\([0-9.]*\)".*/\1/p'; }

# The staged IPA is valid: its stamp names the IPA it sits next to, and that IPA still passes the
# inventory check with the stamped version. Current: valid, and stamped for this tree.
valid() {
  [ -f "$IPA" ] && [ -f "$STAMP" ] || return 1
  [ "$(field sha256 "$STAMP")" = "$(sha "$IPA")" ] || return 1
  local v; v="$(version_of "$IPA" 2>/dev/null)" || return 1
  [ -n "$v" ] && [ "$(field version "$STAMP")" = "$v" ]
}
current() {
  [ -f "$STAMP" ] && [ "$(field ios "$STAMP")" = "$IOS_TREE" ] && [ "$(field web "$STAMP")" = "$WEB_TREE" ] &&
    [ "$(field network "$STAMP")" = "$NETWORK_TREE" ] && valid
}

mkdir -p "$OUT"
LOCK="$OUT/.stage.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  pid="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then die "another staging run ($pid) is in progress"; fi
  rm -rf "$LOCK"; mkdir "$LOCK" || die "cannot lock $OUT"
fi
echo $$ > "$LOCK/pid"
WORK=""
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; rm -f "$OUT/.TwinDesk.ipa.$$" "$OUT/.TwinDesk.ipa.stamp.$$"; rm -rf "$LOCK"; }
trap cleanup EXIT

if [ "$FORCE" = 0 ] && current; then
  echo "stage-ios-ipa: up to date ios=$IOS_TREE version=$(field version "$STAMP") sha256=$(field sha256 "$STAMP")"
  exit 0
fi

kept() { if valid; then echo "stage-ios-ipa: keeping the cached IPA ($(field version "$STAMP"))" >&2; fi; }
fail() { echo "stage-ios-ipa: $*" >&2; kept; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/twindesk-stage-ios.XXXXXX")"
git -C "$REPO" archive --format=tar HEAD "${SOURCE_TREES[@]}" | tar -x -C "$WORK" || fail "could not export the committed iOS sources"
if [ -n "${TWINDESK_STAGE_IOS_BUILD:-}" ]; then
  (cd "$WORK/ios" && $TWINDESK_STAGE_IOS_BUILD) || fail "the iOS build failed"
else
  "$WORK/ios/build.sh" || fail "ios/build.sh failed"
fi
NEW="$WORK/ios/dist/TwinDesk.ipa"
[ -f "$NEW" ] || fail "ios/build.sh made no dist/TwinDesk.ipa"
VERSION="$(version_of "$NEW")" || fail "the new IPA is invalid"
[ -n "$VERSION" ] || fail "the new IPA has no version"
SUM="$(sha "$NEW")"

# Same directory, so both renames are atomic. The IPA goes first: an interrupted run leaves a stamp
# that no longer matches the IPA, and the next run rebuilds.
cp "$NEW" "$OUT/.TwinDesk.ipa.$$"
[ "$(sha "$OUT/.TwinDesk.ipa.$$")" = "$SUM" ] || fail "the copied IPA does not match"
printf 'ios=%s\nweb=%s\nnetwork=%s\nsha256=%s\nversion=%s\n' "$IOS_TREE" "$WEB_TREE" "$NETWORK_TREE" "$SUM" "$VERSION" > "$OUT/.TwinDesk.ipa.stamp.$$"
mv -f "$OUT/.TwinDesk.ipa.$$" "$IPA"
mv -f "$OUT/.TwinDesk.ipa.stamp.$$" "$STAMP"
current || die "the staged IPA does not verify"
echo "stage-ios-ipa: staged ios=$IOS_TREE version=$VERSION sha256=$SUM"
