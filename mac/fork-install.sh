#!/bin/bash
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Build this fork and install it on the Mac and, when one phone is attached, on that phone.
# Older APKs and apps are moved aside, never deleted. A running Mac app is asked to quit and
# is not replaced until its main process has exited.
# shellcheck shell=bash

# -E: bash 3.2 does not run an ERR trap inside functions unless errtrace is on.
set -Eeuo pipefail

# Fallbacks used only when the checkout does not define these names.
# Package: android/app/build.gradle.kts applicationId, checked against mac/phone-bridge.js.
# Log folder: mac/main.js setAppLogsPath. Log file: shared/applog.js.
ANDROID_PACKAGE_FALLBACK=""
LOG_FOLDER_FALLBACK=""
LOG_FILE_FALLBACK=""

ROOT=$(cd "$(dirname "$0")/.." && pwd)

DRY_RUN=0
SKIP_ANDROID=0
SKIP_MAC=0
NO_INSTALL=0
ALLOW_DIRTY=0
QUIT_TIMEOUT=45
DEVICE=""
POLL_INTERVAL="${FORK_INSTALL_POLL_INTERVAL:-1}"
POST_WAIT="${FORK_INSTALL_POST_WAIT:-25}"
APPLICATIONS="${FORK_INSTALL_APPLICATIONS:-/Applications}"
LOG_DIR="${FORK_INSTALL_LOG_DIR:-$ROOT/mac/dist}"
LOG=""
CURRENT_STEP="startup"
PHONE_FAILED=0
NEW_APK=""
ADB=""
serial=""

# Identity read from the checkout (mac/build-app.sh is the bundle-id source of truth).
bundle_id=""
application_id=""
app_name=""
exe_name=""
apk_dest=""
version_name=""
mac_version=""
fork_build=""
log_folder=""
log_file=""
short_sha=""
full_sha=""
main_bin=""
# Filled by collect_main_pids. Empty means the main executable is not running.
MAIN_PIDS=()

usage() {
  cat <<'EOF'
Usage: mac/fork-install.sh [options]

Build the fork (Android full release, then mac/build-app.sh) and install it.
The Mac app is replaced only after its main process has exited. Older APKs and
apps are moved aside, never deleted.

Options:
  --dry-run            Print each step and the commands it would run. Change nothing.
  --skip-android       Do not rebuild the Android APK.
  --skip-mac           Do not rebuild the Mac app.
  --no-install         Build only: do not quit, copy, or install.
  --device <serial>    adb serial for the phone (for example a host:port).
  --quit-timeout <s>   Seconds to wait for the main process after each quit (default 45).
  --allow-dirty        Build even when the checkout has uncommitted changes.
  -h, --help           Show this help.

Before distributing a new build, increment CURRENT_PROJECT_VERSION in
ios/ForkBuild.xcconfig. Installing requires a higher build than the installed Mac app.

A phone install needs --device, or exactly one attached physical device
(emulator-* is ignored). If that install fails, the Mac install is left as it is.

Environment (overrides for tests and unusual layouts):
  FORK_INSTALL_APPLICATIONS    Where the Mac app is installed (default: /Applications).
  FORK_INSTALL_APP_LOG         Mac log to scan after launch
                               (default: $HOME/Library/Logs/<folder>/TwinDesk.log).
  FORK_INSTALL_LOG_DIR         Directory for this script's log (default: mac/dist).
  FORK_INSTALL_ADB             adb binary (default: $ANDROID_HOME/platform-tools/adb, else adb).
  AAPT                         aapt binary for APK metadata checks (default: SDK build-tools).
  FORK_INSTALL_POLL_INTERVAL   Whole seconds between quit polls (default: 1).
  FORK_INSTALL_POST_WAIT       Whole seconds to wait before reading logs (default: 25).
EOF
}

fail() {
  printf 'fork-install: %s\n' "$1" >&2
  if [ -n "${LOG:-}" ]; then
    printf 'fork-install: log: %s\n' "$LOG" >&2
  fi
  exit 1
}

on_err() {
  local code="$1"
  if [ "$code" -eq 0 ]; then
    code=1
  fi
  printf 'fork-install: step failed: %s (exit %s)\n' "${CURRENT_STEP:-unknown}" "$code" >&2
  if [ -n "${LOG:-}" ]; then
    printf 'fork-install: log: %s\n' "$LOG" >&2
  fi
  exit "$code"
}

# For use inside $( ): bash 3.2 runs the inherited ERR trap there even when the caller tests
# the result, which prints a false "step failed". The trap is dropped in that subshell only.
no_err_trap() {
  trap - ERR
  "$@"
}

step() {
  printf '%s\n' "$1"
  if [ -n "${LOG:-}" ]; then
    printf '%s\n' "$1" >>"$LOG"
  fi
}

would() {
  printf 'would run:'
  local arg
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
}

is_uint() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  return 0
}

is_pos_int() {
  is_uint "$1" || return 1
  [ "$((10#$1))" -ge 1 ]
}

require_id() {
  case "$1" in
    ""|*[!A-Za-z0-9.-]*) return 1 ;;
  esac
  return 0
}

# Drop a trailing slash and any doubled slash so the main executable path is exact.
normalize_dir() {
  local p="$1"
  # Not ${p//\/\//\/}: bash 3.2 keeps that replacement's backslash in the result.
  while [[ "$p" == *//* ]]; do
    p="${p%%//*}/${p#*//}"
  done
  while [ "$p" != "/" ] && [ "${p%/}" != "$p" ]; do
    p="${p%/}"
  done
  printf '%s\n' "$p"
}

load_identity() {
  local build gradle bridge mainjs pkg applog
  build="$ROOT/mac/build-app.sh"
  gradle="$ROOT/android/app/build.gradle.kts"
  bridge="$ROOT/mac/phone-bridge.js"
  mainjs="$ROOT/mac/main.js"
  pkg="$ROOT/mac/package.json"
  applog="$ROOT/shared/applog.js"
  [ -f "$build" ] || fail "missing mac/build-app.sh"
  [ -f "$gradle" ] || fail "missing android/app/build.gradle.kts"
  [ -f "$bridge" ] || fail "missing mac/phone-bridge.js"
  [ -f "$mainjs" ] || fail "missing mac/main.js"
  [ -f "$pkg" ] || fail "missing mac/package.json"

  bundle_id=$(awk '
    match($0, /--app-bundle-id=[^[:space:]]+/) {
      s = substr($0, RSTART, RLENGTH)
      sub(/^--app-bundle-id=/, "", s)
      print s
      exit
    }
  ' "$build")
  exe_name=$(awk '
    match($0, /--executable-name=[^[:space:]]+/) {
      s = substr($0, RSTART, RLENGTH)
      sub(/^--executable-name=/, "", s)
      print s
      exit
    }
  ' "$build")
  app_name=$(awk -F"'" '/^FORK_APP=/ { print $2; exit }' "$build")
  app_name=${app_name##*/}
  apk_dest=$(awk -F= '/^APK_DEST=/ { print $2; exit }' "$build")
  application_id=$(awk -F'"' '/^[[:space:]]*applicationId[[:space:]]*=/ { print $2; exit }' "$gradle")
  version_name=$(awk -F'"' '/^[[:space:]]*versionName[[:space:]]*=/ { print $2; exit }' "$gradle")
  local bridge_id
  bridge_id=$(awk -F"'" '/^const APP_ID = / { print $2; exit }' "$bridge")
  log_folder=$(awk -F"'" '/setAppLogsPath\(/ { print $(NF-1); exit }' "$mainjs")
  mac_version=$(awk -F'"' '/"version"[[:space:]]*:/ { print $4; exit }' "$pkg")
  if [ -f "$applog" ]; then
    log_file=$(awk '
      match($0, /: '\''[^'\'']+\.log'\''/) {
        print substr($0, RSTART + 3, RLENGTH - 4)
        exit
      }
    ' "$applog")
  fi

  [ -n "$application_id" ] || application_id=$ANDROID_PACKAGE_FALLBACK
  [ -n "$log_folder" ] || log_folder=$LOG_FOLDER_FALLBACK
  [ -n "$log_file" ] || log_file=$LOG_FILE_FALLBACK

  require_id "$bundle_id" || fail "mac/build-app.sh has no fork bundle id"
  case "$bundle_id" in
    org.macshare.mac|org.macshare.mac.*)
      fail "checkout bundle id ${bundle_id} is not this fork"
      ;;
  esac
  require_id "$application_id" || fail "android applicationId is missing"
  [ "$application_id" = "${bundle_id}.android" ] || fail "applicationId ${application_id} does not match ${bundle_id}.android"
  [ "$bridge_id" = "$application_id" ] || fail "mac/phone-bridge.js APP_ID does not match applicationId"
  [ -n "$app_name" ] || fail "mac/build-app.sh has no FORK_APP"
  [ -n "$exe_name" ] || fail "mac/build-app.sh has no executable name"
  [ -n "$apk_dest" ] || fail "mac/build-app.sh has no APK_DEST"
  [ -n "$version_name" ] || fail "android versionName is missing"
  [ -n "$mac_version" ] || fail "mac/package.json version is missing"
  [ -n "$log_folder" ] || fail "mac/main.js has no log folder"
  [ -n "$log_file" ] || fail "shared/applog.js has no log file name"
  case "$log_folder" in
    *[!A-Za-z0-9._-]*) fail "refusing unsafe log folder name" ;;
  esac
  case "$log_file" in
    *[!A-Za-z0-9._-]*) fail "refusing unsafe log file name" ;;
  esac
  case "$version_name" in
    *[!A-Za-z0-9._-]*) fail "refusing unsafe versionName" ;;
  esac

  APPLICATIONS=$(normalize_dir "$APPLICATIONS")
  [ -n "$APPLICATIONS" ] || fail "FORK_INSTALL_APPLICATIONS is empty"
  main_bin="${APPLICATIONS%/}/${app_name}/Contents/MacOS/${exe_name}"
}

load_commit() {
  local dirty
  git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "not a git checkout: ${ROOT}"
  full_sha=$(git -C "$ROOT" rev-parse HEAD)
  short_sha=$(git -C "$ROOT" rev-parse --short HEAD)
  [ -n "$full_sha" ] && [ -n "$short_sha" ] || fail "could not read HEAD"
  case "$short_sha" in
    *[!A-Za-z0-9]*) fail "refusing unsafe commit id" ;;
  esac
  dirty=$(git -C "$ROOT" status --porcelain)
  if [ -n "$dirty" ] && [ "$ALLOW_DIRTY" -ne 1 ]; then
    fail "checkout is not clean; commit the changes or pass --allow-dirty"
  fi
  local subject
  subject=$(git -C "$ROOT" log -1 --format=%s)
  if [ -n "$dirty" ]; then
    step "commit ${short_sha} ${full_sha} ${bundle_id} (dirty) ${subject}"
  else
    step "commit ${short_sha} ${full_sha} ${bundle_id} ${subject}"
  fi
}

open_log() {
  if [ "$DRY_RUN" -eq 1 ]; then
    return 0
  fi
  mkdir -p "$LOG_DIR"
  LOG="${LOG_DIR}/fork-install-${short_sha}-$(date +%Y%m%d-%H%M%S).log"
  : >"$LOG"
  step "log: ${LOG}"
}

# Same selection as mac/build-app.sh (the lexicographically last android/dist/*-full.apk).
selected_full_apk() {
  # shellcheck disable=SC2012
  ls "$ROOT"/android/dist/*-full.apk 2>/dev/null | sort | tail -1 || true
}

sha256_file() {
  shasum -a 256 "$1" | awk 'NR == 1 { print $1; exit }'
}

archive_dir() {
  # Print mac/dist/previous-before-<sha>[/<leaf>], with -<n> if that folder already has the app.
  local leaf="$1"
  local base="$ROOT/mac/dist/previous-before-${short_sha}"
  local dir="$base"
  local n=2
  if [ -n "$leaf" ]; then
    dir="${base}/${leaf}"
  fi
  if [ ! -e "${dir}/${app_name}" ]; then
    printf '%s\n' "$dir"
    return 0
  fi
  while [ "$n" -le 100 ]; do
    dir="${base}-${n}"
    if [ -n "$leaf" ]; then
      dir="${base}-${n}/${leaf}"
    fi
    if [ ! -e "${dir}/${app_name}" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
    n=$((n + 1))
  done
  fail "too many previous copies under mac/dist"
}

run_in() {
  local dir="$1"
  shift
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'would run: (cd %q &&' "$dir"
    local arg
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf ')\n'
    return 0
  fi
  # The log redirect would swallow the ERR trap. Clear it in the subshell and
  # return the status so the caller (still inside a function) reports the step.
  local code=0
  (set +E; trap - ERR; cd "$dir" && "$@") >>"$LOG" 2>&1 || code=$?
  if [ "$code" -ne 0 ]; then
    return "$code"
  fi
}

commit_apk_path() {
  printf '%s\n' "$ROOT/android/dist/twindesk-full-${version_name}-${short_sha}-full.apk"
}

# --skip-android is only safe when this commit's apk is already on disk.
# --skip-mac and --no-install together never read it.
require_commit_apk() {
  local expected
  if [ "$SKIP_ANDROID" -ne 1 ]; then
    return 0
  fi
  if [ "$SKIP_MAC" -eq 1 ] && [ "$NO_INSTALL" -eq 1 ]; then
    return 0
  fi
  expected=$(commit_apk_path)
  if [ ! -f "$expected" ]; then
    step "android: no apk for this commit at ${expected}; run without --skip-android"
    fail "no apk for this commit at ${expected}; run without --skip-android"
  fi
}

move_apk_aside() {
  local apk="$1"
  local base target n
  base=$(basename "$apk")
  target="$ROOT/android/dist/previous/${base}"
  if [ -e "$target" ]; then
    n=2
    while [ -e "$ROOT/android/dist/previous/${base}.${n}" ]; do
      n=$((n + 1))
      [ "$n" -le 100 ] || fail "too many copies of ${base}"
    done
    target="$ROOT/android/dist/previous/${base}.${n}"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    would mkdir -p "$ROOT/android/dist/previous"
    would mv "$apk" "$target"
  else
    mkdir -p "$ROOT/android/dist/previous"
    mv "$apk" "$target"
  fi
}

move_other_full_apks() {
  local extra="$1"
  local apk others
  others=$extra
  for apk in "$ROOT"/android/dist/*-full.apk; do
    [ -f "$apk" ] || continue
    [ "$apk" = "$NEW_APK" ] && continue
    others=$((others + 1))
    move_apk_aside "$apk"
  done
  if [ "$others" -eq 0 ]; then
    step "android: no older full APK to move"
  elif [ "$DRY_RUN" -eq 1 ]; then
    step "android: would move ${others} older full APK(s) to android/dist/previous"
  else
    step "android: moved ${others} older full APK(s) to android/dist/previous"
  fi
}

build_android() {
  local src moved_same
  if [ "$SKIP_ANDROID" -eq 1 ]; then
    step "android: skipped"
    if [ "$SKIP_MAC" -eq 1 ] && [ "$NO_INSTALL" -eq 1 ]; then
      return 0
    fi
    NEW_APK=$(commit_apk_path)
    [ -f "$NEW_APK" ] || fail "no apk for this commit at ${NEW_APK}; run without --skip-android"
    verify_android_build "$NEW_APK"
    # Keep an older name that sorts later from being the one build-app.sh bundles.
    if [ "$SKIP_MAC" -eq 0 ]; then
      move_other_full_apks 0
    fi
    return 0
  fi
  NEW_APK=$(commit_apk_path)
  src="$ROOT/android/app/build/outputs/apk/full/release/app-full-release.apk"
  CURRENT_STEP="android: assembleFullRelease"
  step "android: assembleFullRelease -> $(basename "$NEW_APK")"
  run_in "$ROOT/android" ./gradlew assembleFullRelease
  moved_same=0
  if [ "$DRY_RUN" -eq 1 ]; then
    would mkdir -p "$ROOT/android/dist"
    if [ -e "$NEW_APK" ]; then
      move_apk_aside "$NEW_APK"
      moved_same=1
    fi
    would cp "$src" "$NEW_APK"
  else
    [ -f "$src" ] || fail "gradle did not produce ${src}"
    verify_android_build "$src"
    mkdir -p "$ROOT/android/dist"
    if [ -e "$NEW_APK" ]; then
      move_apk_aside "$NEW_APK"
      moved_same=1
    fi
    cp "$src" "$NEW_APK"
  fi
  move_other_full_apks "$moved_same"
  if [ "$DRY_RUN" -eq 1 ]; then
    step "android: build-app.sh would bundle $(basename "$NEW_APK")"
    return 0
  fi
  local selected
  selected=$(selected_full_apk)
  [ "$selected" = "$NEW_APK" ] || fail "build-app.sh would bundle ${selected:-nothing}, not ${NEW_APK}"
  step "android: build-app.sh will bundle $(basename "$NEW_APK")"
}

verify_android_build() {
  [ "$DRY_RUN" -eq 0 ] || return 0
  local apk="$1" badging expected_code actual_code actual_name
  CURRENT_STEP="android: verify apk version"
  expected_code=$((100000 + fork_build))
  badging=$(sh "$ROOT/mac/scripts/apk-badging.sh" "$apk") ||
    fail "could not read metadata for $apk"
  actual_code=$(sed -n "s/^package: .* versionCode='\([0-9]*\)'.*/\1/p" <<<"$badging")
  actual_name=$(sed -n "s/^package: .* versionName='\([^']*\)'.*/\1/p" <<<"$badging")
  [ "$actual_code" = "$expected_code" ] && [ "$actual_name" = "$version_name" ] ||
    fail "APK metadata must match $version_name (versionCode $expected_code); rebuild without --skip-android"
}

build_mac() {
  local existing dest
  if [ "$SKIP_MAC" -eq 1 ]; then
    step "mac: skipped"
    return 0
  fi
  existing="$ROOT/mac/dist/${app_name}"
  if [ -e "$existing" ]; then
    dest=$(archive_dir "")
    CURRENT_STEP="mac: move existing build aside"
    if [ "$DRY_RUN" -eq 1 ]; then
      step "mac: would move existing build to ${dest}"
      would mkdir -p "$dest"
      would mv "$existing" "${dest}/"
    else
      step "mac: moving existing build to ${dest}"
      mkdir -p "$dest"
      mv "$existing" "${dest}/"
    fi
  fi
  CURRENT_STEP="mac: npm run dist"
  if [ "$DRY_RUN" -eq 1 ]; then
    step "mac: would run npm run dist"
  else
    step "mac: npm run dist"
  fi
  run_in "$ROOT/mac" npm run dist
}

require_newer_fork_build() {
  [ "$NO_INSTALL" -eq 0 ] || return 0
  local installed="$APPLICATIONS/$app_name" previous
  [ -e "$installed" ] || return 0
  previous=$(plutil -extract CFBundleVersion raw "$installed/Contents/Info.plist" 2>/dev/null) ||
    fail "could not read the installed Mac CFBundleVersion"
  # Before the fork counter, CFBundleVersion used the dotted release version.
  # A single-component build is newer than a dotted one if its first component is greater.
  [[ "$previous" =~ ^[0-9]{1,4}([.][0-9]+){0,2}$ ]] ||
    fail "unexpected installed Mac CFBundleVersion: ${previous}"
  (( fork_build > 10#${previous%%.*} )) ||
    fail "fork build ${fork_build} must exceed installed Mac build ${previous}; bump ios/ForkBuild.xcconfig"
}

verify_build() {
  local built bundled want got apk_path info
  built="$ROOT/mac/dist/${app_name}"
  if [ "$SKIP_MAC" -eq 1 ] && [ "$NO_INSTALL" -eq 1 ]; then
    return 0
  fi
  if [ -z "$NEW_APK" ]; then
    apk_path=$(selected_full_apk)
  else
    apk_path=$NEW_APK
  fi
  bundled="${built}/Contents/Resources/app/mac/${apk_dest}"
  if [ "$DRY_RUN" -eq 1 ]; then
    step "mac: would verify the signature"
    would codesign --verify --deep --strict "$built"
    step "mac: would verify build ${mac_version} (${fork_build})"
    if [ -n "$apk_path" ] && [ "$SKIP_MAC" -eq 0 ]; then
      step "mac: would verify the bundled apk"
      would shasum -a 256 "$apk_path"
      would shasum -a 256 "$bundled"
    fi
    return 0
  fi
  if [ ! -e "$built" ]; then
    fail "built app not found at ${built}"
  fi
  CURRENT_STEP="mac: codesign --verify --deep --strict"
  step "mac: verifying signature"
  if ! codesign --verify --deep --strict "$built" >>"$LOG" 2>&1; then
    fail "signature check failed for ${built}"
  fi
  step "mac: signature ok"
  info="$built/Contents/Info.plist"
  [ "$(plutil -extract CFBundleShortVersionString raw "$info")" = "$mac_version" ] &&
    [ "$(plutil -extract CFBundleVersion raw "$info")" = "$fork_build" ] ||
    fail "Mac bundle metadata must match ${mac_version} (${fork_build}); rebuild without --skip-mac"
  if [ -n "$apk_path" ] && [ "$SKIP_MAC" -eq 0 ]; then
    CURRENT_STEP="mac: bundled apk sha256"
    [ -f "$bundled" ] || fail "bundled apk not found at ${bundled}"
    [ -f "$apk_path" ] || fail "apk not found at ${apk_path}"
    want=$(sha256_file "$apk_path")
    got=$(sha256_file "$bundled")
    [ "$want" = "$got" ] || fail "bundled apk sha256 ${got} does not match ${want}"
    step "mac: bundled apk matches ${want}"
  fi
}

# List main-process pids into MAIN_PIDS.
# ps -axo pid=,command= (no header; pid may be space-padded). Match the
# normalised executable as a plain prefix: end of the command, or a space.
# A helper under Contents/Frameworks does not match. If ps itself fails,
# stop; that is not "not running".
collect_main_pids() {
  local listing line trimmed pid cmd prefix n code
  code=0
  prefix="${main_bin} "
  n=${#prefix}
  # +E so a failing ps does not run the ERR trap inside the substitution.
  set +E
  listing=$(ps -axo pid=,command=) || code=$?
  set -E
  if [ "$code" -ne 0 ]; then
    fail "could not list processes"
  fi
  MAIN_PIDS=()
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    trimmed=$line
    while [ "${trimmed# }" != "$trimmed" ]; do
      trimmed=${trimmed# }
    done
    pid=${trimmed%% *}
    case "$pid" in
      ''|*[!0-9]*) continue ;;
    esac
    cmd=${trimmed#"$pid"}
    while [ "${cmd# }" != "$cmd" ]; do
      cmd=${cmd# }
    done
    if [ "$cmd" = "$main_bin" ] || [ "${cmd:0:n}" = "$prefix" ]; then
      MAIN_PIDS[${#MAIN_PIDS[@]}]=$pid
    fi
  done <<EOF
$listing
EOF
}

pid_still_main() {
  local want="$1" pid
  collect_main_pids
  if [ "${#MAIN_PIDS[@]}" -eq 0 ]; then
    return 1
  fi
  for pid in "${MAIN_PIDS[@]}"; do
    [ "$pid" = "$want" ] && return 0
  done
  return 1
}

# Move a partial or unverified copy into the archive and put the previous app
# back. Never rm. fail() does not return.
restore_installed_app() {
  local installed_path="$1"
  local archived="$2"
  local why="$3"
  local partial="" previous n
  previous="${archived}/${app_name}"
  if [ -e "$installed_path" ]; then
    partial="${archived}/partial-${app_name}"
    n=2
    while [ -e "$partial" ]; do
      partial="${archived}/partial-${n}-${app_name}"
      n=$((n + 1))
      [ "$n" -le 100 ] || fail "${why}; too many partial copies in ${archived}; previous app is at ${previous}"
    done
    if ! mv "$installed_path" "$partial"; then
      fail "${why}; could not move the partial copy; it is at ${installed_path}; previous app is at ${previous}"
    fi
  fi
  if [ ! -e "$previous" ]; then
    fail "${why}; previous app is not in the archive at ${previous}"
  fi
  if ! mv "$previous" "$installed_path"; then
    fail "${why}; could not put the previous app back; it is at ${previous}"
  fi
  if [ ! -e "$installed_path" ]; then
    fail "${why}; previous app is not at ${installed_path} after restore; archive: ${archived}"
  fi
  if [ -n "$partial" ]; then
    fail "${why}; previous app restored to ${installed_path}; partial copy is at ${partial}; archive: ${archived}"
  fi
  fail "${why}; previous app restored to ${installed_path}; archive: ${archived}"
}

wait_for_main() {
  local timeout="$1"
  shift
  local started waited pid alive
  started=$(date +%s)
  while :; do
    alive=0
    for pid in "$@"; do
      if pid_still_main "$pid"; then
        alive=1
        break
      fi
    done
    if [ "$alive" -eq 0 ]; then
      return 0
    fi
    waited=$(( $(date +%s) - started ))
    if [ "$waited" -ge "$timeout" ]; then
      return 1
    fi
    sleep "$POLL_INTERVAL"
  done
}

install_mac() {
  local built installed dest quit_apple
  local quit_attempts archived_dir moved_aside waiting pid
  built="$ROOT/mac/dist/${app_name}"
  installed="${APPLICATIONS%/}/${app_name}"
  # "is running" does not launch the app. A bare "tell application id … to quit" does.
  quit_apple="if application id \"${bundle_id}\" is running then tell application id \"${bundle_id}\" to quit"
  if [ "$NO_INSTALL" -eq 1 ]; then
    step "install: skipped (--no-install)"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    step "mac: would quit application id ${bundle_id} only if it is running, then wait up to ${QUIT_TIMEOUT}s for ${main_bin} (ask once more, then stop if it is still running)"
    would osascript -e "$quit_apple"
    if [ -e "$installed" ]; then
      dest=$(archive_dir installed)
      would mkdir -p "$dest"
      would mv "$installed" "${dest}/"
    else
      step "mac: nothing currently at ${installed}"
    fi
    would ditto "$built" "$installed"
    would codesign --verify --deep --strict "$installed"
    would open "$installed"
    return 0
  fi
  [ -e "$built" ] || fail "built app not found at ${built}"
  quit_attempts=0
  while :; do
    collect_main_pids
    if [ "${#MAIN_PIDS[@]}" -eq 0 ]; then
      if [ "$quit_attempts" -eq 0 ]; then
        step "mac: not running"
      else
        step "mac: main process exited"
      fi
      break
    fi
    if [ "$quit_attempts" -ge 2 ]; then
      fail "app ${bundle_id} is still running after two quits (${QUIT_TIMEOUT}s each); left it in place"
    fi
    quit_attempts=$((quit_attempts + 1))
    CURRENT_STEP="mac: quit ${bundle_id}"
    if [ "$quit_attempts" -eq 1 ]; then
      step "mac: quitting ${bundle_id} (pid ${MAIN_PIDS[*]})"
    else
      step "mac: still running (pid ${MAIN_PIDS[*]}); asking again"
    fi
    if ! osascript -e "$quit_apple" >>"$LOG" 2>&1; then
      step "mac: quit request returned an error; still waiting for pid ${MAIN_PIDS[*]}"
    fi
    # Snapshot the pids. collect_main_pids inside the wait replaces MAIN_PIDS.
    waiting=()
    for pid in "${MAIN_PIDS[@]}"; do
      waiting[${#waiting[@]}]=$pid
    done
    if ! wait_for_main "$QUIT_TIMEOUT" "${waiting[@]}"; then
      continue
    fi
  done
  moved_aside=0
  archived_dir=""
  if [ -e "$installed" ]; then
    dest=$(archive_dir installed)
    archived_dir=$dest
    CURRENT_STEP="mac: move installed app aside"
    step "mac: moving installed app to ${dest}"
    mkdir -p "$dest"
    mv "$installed" "${dest}/"
    moved_aside=1
  fi
  CURRENT_STEP="mac: ditto to ${APPLICATIONS}"
  # Nothing here may stop the script before ditto: the previous app is already moved aside.
  step "mac: installing into ${APPLICATIONS}" || true
  # ditto copies the contents of a source folder, so the destination is the app itself.
  if ! ditto "$built" "$installed" >>"$LOG" 2>&1; then
    if [ "$moved_aside" -eq 1 ]; then
      restore_installed_app "$installed" "$archived_dir" "ditto into ${APPLICATIONS} failed"
    fi
    if [ -e "$installed" ]; then
      fail "ditto into ${APPLICATIONS} failed; partial copy left at ${installed}"
    fi
    fail "ditto into ${APPLICATIONS} failed"
  fi
  CURRENT_STEP="mac: codesign installed app"
  if ! codesign --verify --deep --strict "$installed" >>"$LOG" 2>&1; then
    if [ "$moved_aside" -eq 1 ]; then
      restore_installed_app "$installed" "$archived_dir" "installed app failed the signature check; not opening it"
    fi
    fail "installed app failed the signature check; not opening it; it is at ${installed}"
  fi
  step "mac: installed signature ok"
  CURRENT_STEP="mac: open"
  open "$installed" >>"$LOG" 2>&1
  step "mac: opened ${installed}"
}

resolve_adb() {
  if [ -n "${FORK_INSTALL_ADB:-}" ]; then
    if [ ! -x "${FORK_INSTALL_ADB}" ]; then
      fail "FORK_INSTALL_ADB is not executable"
    fi
    ADB=$FORK_INSTALL_ADB
    return 0
  fi
  if [ -n "${ANDROID_HOME:-}" ] && [ -x "${ANDROID_HOME}/platform-tools/adb" ]; then
    ADB="${ANDROID_HOME}/platform-tools/adb"
    return 0
  fi
  if command -v adb >/dev/null 2>&1; then
    ADB=$(command -v adb)
    return 0
  fi
  ADB=""
}

physical_serials() {
  local out
  if ! out=$(no_err_trap "$ADB" devices 2>&1); then
    printf 'fork-install: adb devices failed\n%s\n' "$out" >&2
    return 1
  fi
  printf '%s\n' "$out" | awk 'NR > 1 && $2 == "device" && $1 !~ /^emulator-/ { print $1 }'
}

install_phone() {
  local apk devices=()
  local one
  serial=""
  if [ "$NO_INSTALL" -eq 1 ]; then
    return 0
  fi
  if [ -n "$NEW_APK" ]; then
    apk=$NEW_APK
  else
    apk=$(selected_full_apk)
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    if [ -n "$DEVICE" ]; then
      serial=$DEVICE
      resolve_adb
      step "phone: would install -r on ${serial}"
      would "${ADB:-adb}" -s "$serial" install -r "$apk"
    else
      step "phone: would detect one physical device (adb is not run during --dry-run)"
      serial=""
    fi
    return 0
  fi
  resolve_adb
  if [ -n "$DEVICE" ]; then
    serial=$DEVICE
  elif [ -z "$ADB" ]; then
    step "phone: skipped (adb not found; pass --device or set ANDROID_HOME)"
    return 0
  else
    local listed
    if ! listed=$(no_err_trap physical_serials); then
      step "phone: skipped (could not list devices)"
      PHONE_FAILED=1
      serial=""
      return 0
    fi
    while IFS= read -r one; do
      [ -n "$one" ] || continue
      devices[${#devices[@]}]=$one
    done <<EOF
$listed
EOF
    if [ "${#devices[@]}" -eq 1 ]; then
      serial=${devices[0]}
      step "phone: using ${serial}"
    elif [ "${#devices[@]}" -eq 0 ]; then
      step "phone: skipped (no physical device attached; emulator-* is ignored)"
      return 0
    else
      step "phone: skipped (more than one physical device: ${devices[*]}; pass --device)"
      return 0
    fi
  fi
  if [ -z "$ADB" ]; then
    step "phone: install failed (adb not found). The Mac install was not changed."
    PHONE_FAILED=1
    serial=""
    return 0
  fi
  if [ -z "$apk" ] || [ ! -f "$apk" ]; then
    step "phone: install failed (no apk to install). The Mac install was not changed."
    PHONE_FAILED=1
    return 0
  fi
  CURRENT_STEP="phone: adb install -r"
  step "phone: install -r on ${serial}"
  if ! "$ADB" -s "$serial" install -r "$apk" >>"$LOG" 2>&1; then
    printf 'fork-install: phone install failed; the Mac app was left installed. log: %s\n' "$LOG" >&2
    PHONE_FAILED=1
    return 0
  fi
  step "phone: installed on ${serial}"
}

report_mac_log() {
  local app_log marker
  if [ -n "${FORK_INSTALL_APP_LOG:-}" ]; then
    app_log=$FORK_INSTALL_APP_LOG
  else
    app_log="${HOME}/Library/Logs/${log_folder}/${log_file}"
  fi
  marker="---- TwinDesk ${mac_version} started"
  if [ ! -e "$app_log" ]; then
    step "mac log: missing ${app_log}"
    return 0
  fi
  if [ ! -r "$app_log" ] || [ ! -f "$app_log" ]; then
    step "mac log: unreadable ${app_log}"
    return 0
  fi
  # Lines after the last start marker. [crash] is literal; a regex would treat the brackets as a class.
  local tmp code
  code=0
  set +E
  tmp=$(awk -v marker="$marker" '
    index($0, marker) { found = 1; n = 0; next }
    found && (index($0, "WARN") || index($0, "ERROR") || index($0, "[crash]")) {
      n++
      line[n] = $0
    }
    END {
      if (!found) { print "NO_START"; exit }
      if (n == 0) { print "CLEAN"; exit }
      for (i = 1; i <= n; i++) print line[i]
    }
  ' "$app_log") || code=$?
  set -E
  if [ "$code" -ne 0 ]; then
    step "mac log: unreadable ${app_log}"
    return 0
  fi
  case "$tmp" in
    NO_START)
      step "mac log: no start line for this launch (${marker})"
      ;;
    CLEAN)
      step "no warnings or errors since start"
      ;;
    "")
      step "mac log: unreadable ${app_log}"
      ;;
    *)
      step "mac log: warnings, errors, or crashes since start"
      printf '%s\n' "$tmp"
      ;;
  esac
}

report_phone() {
  local package="$application_id"
  local pids crashes
  if [ -z "$serial" ] || [ -z "$ADB" ]; then
    return 0
  fi
  if pids=$(no_err_trap "$ADB" -s "$serial" shell pidof "$package" 2>>"${LOG:-/dev/null}"); then
    step "phone: ${package} is running (${pids})"
  else
    step "phone: ${package} is not running"
  fi
  crashes=$("$ADB" -s "$serial" logcat -b crash -d 2>>"${LOG:-/dev/null}" || true)
  # Matched in the shell: grep -q in a pipe exits early, printf gets SIGPIPE, and pipefail loses the match.
  case "$crashes" in
    *"$package"*) step "phone: crash buffer mentions ${package}" ;;
    *) step "phone: crash buffer does not mention ${package}" ;;
  esac
}

after_report() {
  local app_log
  if [ -n "${FORK_INSTALL_APP_LOG:-}" ]; then
    app_log=$FORK_INSTALL_APP_LOG
  else
    app_log="${HOME}/Library/Logs/${log_folder}/${log_file}"
  fi
  if [ "$NO_INSTALL" -eq 1 ]; then
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    step "after: would wait ${POST_WAIT}s, then read ${app_log} for WARN, ERROR, or [crash] after ---- TwinDesk ${mac_version} started"
    if [ -n "$serial" ]; then
      would "${ADB:-adb}" -s "$serial" shell pidof "$application_id"
      would "${ADB:-adb}" -s "$serial" logcat -b crash -d
    fi
    return 0
  fi
  CURRENT_STEP="after: wait and read logs"
  step "after: waiting ${POST_WAIT}s"
  if [ "$POST_WAIT" -gt 0 ]; then
    sleep "$POST_WAIT"
  fi
  report_mac_log
  if [ -n "$serial" ]; then
    report_phone
  fi
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help)
        usage
        exit 0
        ;;
      --dry-run) DRY_RUN=1 ;;
      --skip-android) SKIP_ANDROID=1 ;;
      --skip-mac) SKIP_MAC=1 ;;
      --no-install) NO_INSTALL=1 ;;
      --allow-dirty) ALLOW_DIRTY=1 ;;
      --quit-timeout)
        shift
        [ "$#" -ge 1 ] || fail "missing value for --quit-timeout"
        QUIT_TIMEOUT=$1
        ;;
      --device)
        shift
        [ "$#" -ge 1 ] || fail "missing value for --device"
        DEVICE=$1
        ;;
      *)
        fail "unknown flag: $1"
        ;;
    esac
    shift
  done
}

main() {
  parse_args "$@"
  is_pos_int "$QUIT_TIMEOUT" || fail "--quit-timeout wants a positive whole number of seconds"
  is_pos_int "$POLL_INTERVAL" || fail "FORK_INSTALL_POLL_INTERVAL wants a positive whole number of seconds"
  is_uint "$POST_WAIT" || fail "FORK_INSTALL_POST_WAIT wants a whole number of seconds"
  [ -n "$APPLICATIONS" ] || fail "FORK_INSTALL_APPLICATIONS is empty"
  load_identity
  load_commit
  fork_build=$(sh "$ROOT/mac/scripts/fork-build.sh" "$ROOT")
  require_newer_fork_build
  require_commit_apk
  open_log
  build_android
  build_mac
  verify_build
  install_mac
  install_phone
  after_report
  if [ "$PHONE_FAILED" -eq 1 ]; then
    exit 1
  fi
}

trap 'on_err $?' ERR
main "$@"
