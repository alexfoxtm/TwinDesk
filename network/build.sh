#!/bin/bash
set -euo pipefail

invocation_dir="$PWD"
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$source_dir"
cache_root="${TWINDESK_NETWORK_CACHE:-$HOME/orca/tmp/twindesk-network}"
tags=ts_omit_logtail,ts_omit_portmapper
android_ndk_version=29.0.14206865

# Ignore per-user Go build overrides so each slice has its intended target and dependencies.
export GOENV=off GOFLAGS='' GOWORK=off GOTOOLCHAIN=local GOEXPERIMENT='' CGO_ENABLED=1 ZERO_AR_DATE=1
export GOAMD64=v1 GOARM64=v8.0
unset CGO_CFLAGS CGO_CPPFLAGS CGO_CXXFLAGS CGO_FFLAGS CGO_LDFLAGS

go_binary=""
# A GUI-launched build can have an executable Go for a different host architecture first on PATH.
while IFS= read -r candidate; do
    if go_version="$("$candidate" version 2>/dev/null)"; then
        go_binary="$candidate"
        break
    fi
done < <(type -aP go)
if [[ -z "$go_binary" ]]; then
    echo "Install a runnable Go toolchain (see network/go.mod) and put it on PATH." >&2
    exit 2
fi

usage() {
    echo "Usage: $0 ios | android <generated-output-directory> | mac <arm64|x64> <output-directory>" >&2
    exit 2
}

mode="${1:-}"
host_os="$(uname -s)"
hash_cmd=(shasum -a 256)
if ! command -v shasum >/dev/null 2>&1; then hash_cmd=(sha256sum); fi
case "$mode" in
    ios)
        [[ $# == 1 ]] || usage
        toolchain_id="$(xcodebuild -version)"
        ;;
    mac)
        [[ $# == 3 ]] || usage
        case "$2" in
            arm64) mac_arch=arm64; mac_target=arm64-apple-macos13.0 ;;
            x64) mac_arch=amd64; mac_target=x86_64-apple-macos13.0 ;;
            *) usage ;;
        esac
        mac_output="$3"
        [[ "$mac_output" == /* ]] || mac_output="$invocation_dir/$mac_output"
        toolchain_id="$(xcodebuild -version) $mac_target"
        ;;
    android)
        [[ $# == 2 ]] || usage
        android_output="$2"
        if [[ "$host_os" == MINGW* || "$host_os" == MSYS* ]]; then
            android_output="$(cygpath -u "$android_output")"
        fi
        [[ "$android_output" == /* ]] || android_output="$invocation_dir/$android_output"
        ndk="${ANDROID_NDK_HOME:-${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}/ndk/$android_ndk_version}"
        case "$host_os" in
            Darwin) toolchain="$ndk/toolchains/llvm/prebuilt/darwin-x86_64" ;;
            Linux) toolchain="$ndk/toolchains/llvm/prebuilt/linux-x86_64" ;;
            MINGW*|MSYS*) toolchain="$(cygpath -u "$ndk")/toolchains/llvm/prebuilt/windows-x86_64" ;;
            *) echo "Android network builds require macOS, Linux, or Git Bash on Windows." >&2; exit 2 ;;
        esac
        if [[ "$host_os" == MINGW* || "$host_os" == MSYS* ]]; then
            [[ -x "$toolchain/bin/clang.exe" ]] || { echo "Install Android NDK $android_ndk_version." >&2; exit 2; }
            android_clang="$(cygpath -m "$toolchain/bin/clang.exe")"
            clang_arm64="\"$android_clang\" --target=aarch64-linux-android29"
            clang_x64="\"$android_clang\" --target=x86_64-linux-android29"
            toolchain_id="$("$toolchain/bin/clang.exe" --version)"
        else
            if [[ ! -x "$toolchain/bin/aarch64-linux-android29-clang" ]]; then
                echo "Install Android NDK $android_ndk_version and set ANDROID_NDK_HOME or ANDROID_HOME." >&2
                exit 2
            fi
            clang_arm64="\"$toolchain/bin/aarch64-linux-android29-clang\""
            clang_x64="\"$toolchain/bin/x86_64-linux-android29-clang\""
            toolchain_id="$(cat "$ndk/source.properties"; "$toolchain/bin/clang" --version)"
        fi
        ;;
    *) usage ;;
esac

fingerprint() {
    {
        printf '%s\n' "$mode" "$go_version" "$toolchain_id"
        find . -type f ! -name '*_test.go' \
            \( -name '*.go' -o -name '*.c' -o -name '*.h' -o -name module.modulemap \) -print \
            | LC_ALL=C sort | while IFS= read -r file; do
            "${hash_cmd[@]}" "$file"
        done
        "${hash_cmd[@]}" build.sh go.mod go.sum
    } | "${hash_cmd[@]}" | cut -d ' ' -f 1
}

key="$(fingerprint)"
mkdir -p "$cache_root"
cache_root="$(cd "$cache_root" && pwd)"
cached="$cache_root/$key"

stage=""
link_stage=""
cleanup() {
    [[ -z "$stage" ]] || rm -rf "$stage"
    [[ -z "$link_stage" ]] || rm -rf "$link_stage"
}
trap cleanup EXIT

replace_link() {
    if [[ "$host_os" == Darwin ]]; then
        mv -fh "$1" "$2"
    else
        mv -fT "$1" "$2"
    fi
}

build_slice() {
    local os="$1" arch="$2" compiler="$3" buildmode="$4" output="$5"
    mkdir -p "$(dirname "$output")"
    local package="${6:-./bridge}"
    GOOS="$os" GOARCH="$arch" CC="$compiler" \
        "$go_binary" build -mod=readonly -trimpath -buildvcs=false -tags "$tags" \
            -buildmode="$buildmode" -ldflags="-s -w" -o "$output" "$package"
    GOOS="$os" GOARCH="$arch" CC="$compiler" \
        "$go_binary" list -mod=readonly -deps -tags "$tags" \
            -f '{{with .Module}}{{if not .Main}}{{.Path}}{{"\t"}}{{.Version}}{{"\t"}}{{.Dir}}{{end}}{{end}}' \
            "$package" >> "$stage/modules"
}

apple_slice() {
    local sdk="$1" arch="$2" os="$3" target="$4" output="$5"
    local clang sysroot
    clang="$(xcrun --sdk "$sdk" --find clang)"
    sysroot="$(xcrun --sdk "$sdk" --show-sdk-path)"
    build_slice "$os" "$arch" "\"$clang\" -isysroot \"$sysroot\" -target $target" c-archive "$output"
}

notice_paths() {
    find "$1" -type f \( -name 'LICENSE*' -o -name 'LICENCE*' -o -name 'COPYING*' \
        -o -name 'NOTICE*' -o -name 'PATENTS*' \) -print | LC_ALL=C sort
}

write_notices() {
    printf 'TwinDesk embedded network dependencies\n\n'
    printf '%s\n\n' "$go_version"
    local goroot license
    goroot="$("$go_binary" env GOROOT)"
    license="$goroot/LICENSE"
    # Homebrew keeps the license one level above the toolchain's libexec directory.
    [[ -f "$license" ]] || license="$goroot/../LICENSE"
    cat "$license"
    if [[ -f "$goroot/PATENTS" ]]; then
        printf '\n\nPATENTS\n\n'
        cat "$goroot/PATENTS"
    fi
    if [[ -d "$goroot/src/vendor" ]]; then
        printf '\n\nGo toolchain vendored sources\n'
        while IFS= read -r notice; do
            printf '\n%s\n\n' "${notice#"$goroot/src/vendor/"}"
            cat "$notice"
        done < <(notice_paths "$goroot/src/vendor")
    fi
    LC_ALL=C sort -u "$stage/modules" | while IFS=$'\t' read -r module version dir; do
        [[ -n "$module" ]] || continue
        printf '\n\n%s %s\n' "$module" "$version"
        local found=false notice
        while IFS= read -r notice; do
            printf '\n%s\n\n' "${notice#"$dir/"}"
            cat "$notice"
            found=true
        done < <(notice_paths "$dir")
        if [[ "$found" == false ]]; then
            echo "Missing license notice for $module $version" >&2
            return 1
        fi
    done
}

if [[ ! -f "$cached/NetworkNotices.txt" ]]; then
    stage="$(mktemp -d "$cache_root/build.XXXXXX")"
    mkdir "$stage/output"
    if [[ "$mode" == ios ]]; then
        apple_slice iphoneos arm64 ios arm64-apple-ios16.0 "$stage/ios/libCTwinDeskNetwork.a"
        apple_slice iphonesimulator arm64 ios arm64-apple-ios16.0-simulator "$stage/sim-arm64/libCTwinDeskNetwork.a"
        apple_slice iphonesimulator amd64 ios x86_64-apple-ios16.0-simulator "$stage/sim-x86_64/libCTwinDeskNetwork.a"
        mkdir "$stage/sim"
        xcrun lipo -create "$stage"/sim-*/libCTwinDeskNetwork.a -output "$stage/sim/libCTwinDeskNetwork.a"
        xcodebuild -create-xcframework \
            -library "$stage/ios/libCTwinDeskNetwork.a" -headers "$source_dir/bridge/include" \
            -library "$stage/sim/libCTwinDeskNetwork.a" -headers "$source_dir/bridge/include" \
            -output "$stage/output/CTwinDeskNetwork.xcframework" >&2
    elif [[ "$mode" == mac ]]; then
        clang="$(xcrun --sdk macosx --find clang)"
        sysroot="$(xcrun --sdk macosx --show-sdk-path)"
        build_slice darwin "$mac_arch" "\"$clang\" -isysroot \"$sysroot\" -target $mac_target" exe "$stage/output/twindesk-network" ./cmd/desktop
    else
        build_slice android arm64 "$clang_arm64" c-shared \
            "$stage/lib/arm64-v8a/libtwindesk_network.so"
        build_slice android amd64 "$clang_x64" c-shared \
            "$stage/lib/x86_64/libtwindesk_network.so"
        for abi in arm64-v8a x86_64; do
            mkdir -p "$stage/output/jniLibs/$abi"
            mv "$stage/lib/$abi/libtwindesk_network.so" "$stage/output/jniLibs/$abi/"
        done
    fi
    "$go_binary" mod verify >&2
    write_notices > "$stage/output/NetworkNotices.txt"
    if [[ "$(fingerprint)" != "$key" ]]; then
        echo "Embedded network sources changed during the build. Run the build again." >&2
        exit 1
    fi
    if [[ ! -f "$cached/NetworkNotices.txt" ]]; then
        if [[ "$host_os" == MINGW* || "$host_os" == MSYS* ]]; then
            mv -T "$stage/output" "$cached" || [[ -f "$cached/NetworkNotices.txt" ]]
        else
            ln -s "$stage/output" "$stage/publish"
            replace_link "$stage/publish" "$cached"
            rm -rf "${stage:?}"/{mac*,ios,sim*,lib,modules}
            stage=""
        fi
    fi
fi

if [[ "$mode" == ios ]]; then
    ios_output="$source_dir/../ios/Vendor"
    mkdir -p "$ios_output"
    link_stage="$(mktemp -d "$ios_output/embedded.XXXXXX")"
    ln -s "$cached/CTwinDeskNetwork.xcframework" "$link_stage/CTwinDeskNetwork.xcframework"
    replace_link "$link_stage/CTwinDeskNetwork.xcframework" "$ios_output/CTwinDeskNetwork.xcframework"
    cp "$cached/NetworkNotices.txt" "$ios_output/TwinDeskNetworkNotices.txt"
elif [[ "$mode" == mac ]]; then
    mkdir -p "$mac_output"
    cp "$cached/twindesk-network" "$mac_output/"
    cp "$cached/NetworkNotices.txt" "$mac_output/TwinDeskNetworkNotices.txt"
else
    mkdir -p "$android_output/assets"
    cp -R "$cached/jniLibs" "$android_output/"
    cp "$cached/NetworkNotices.txt" "$android_output/assets/TwinDeskNetworkNotices.txt"
fi
