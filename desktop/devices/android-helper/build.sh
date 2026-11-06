#!/bin/bash
# Builds X Bench's Android helpers into desktop/devices/android-helper/build:
# - scrcpy-server and its license, copied from scrcpy/, the scrcpy release X Bench ships.
# - xbench-encode, which encodes the Android emulator's frames as H.264 on the Mac (needs Xcode).
# - xbench-android.jar, which reads a device's screen on the device, built with the Android SDK's android.jar
#   and d8 (ANDROID_HOME, else ~/Library/Android/sdk) and a JDK. Left out with a warning when the SDK is missing.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
out="$here/build"

rm -rf "$out"
mkdir -p "$out"

cp "$here/scrcpy/scrcpy-server" "$out/scrcpy-server"
cp "$here/scrcpy/LICENSE" "$out/scrcpy-LICENSE"

xcrun swiftc -O -target arm64-apple-macos14.0 "$here/encode.swift" -o "$out/xbench-encode"
# An ad-hoc signature; the packaged app signs it again with its own identity.
codesign --force --sign - "$out/xbench-encode" >/dev/null
echo "$out/xbench-encode"

platform="$(ls -d "$sdk"/platforms/android-* 2>/dev/null | sort -V | tail -1 || true)"
tools="$(ls -d "$sdk"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)"
if [[ ! -f "$platform/android.jar" || ! -x "$tools/d8" ]] || ! command -v javac >/dev/null; then
  echo "No Android SDK with a platform and build tools, or no JDK, in $sdk: building without xbench-android.jar." >&2
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

javac -source 8 -target 8 -Xlint:-options -nowarn -bootclasspath "$platform/android.jar:$tools/core-lambda-stubs.jar" -d "$work/classes" "$here/Helper.java"
"$tools/d8" --release --min-api 26 --lib "$platform/android.jar" --output "$work" $(find "$work/classes" -name '*.class')
(cd "$work" && zip -q -X "$out/xbench-android.jar" classes.dex)
echo "$out/xbench-android.jar"
