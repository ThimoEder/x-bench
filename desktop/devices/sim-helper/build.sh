#!/bin/bash
# Builds xbench-sim, the iOS simulator helper, into desktop/devices/sim-helper/build: the binary and the idb
# frameworks it links (FBControlCore, XCTestBootstrap, FBSimulatorControl), built from a pinned revision
# of cameroncooke/idb, a maintained fork of Meta's idb that works with Xcode 26 and 27. Needs Xcode and XcodeGen. Sources and intermediate products stay in
# ~/.cache/x-bench-sim (X_BENCH_SIM_CACHE).

set -euo pipefail

IDB_URL="https://github.com/cameroncooke/idb.git"
IDB_REF="604c51013438f0c3603b720a05a44b7c5b8f286d"
FRAMEWORKS=(FBControlCore XCTestBootstrap FBSimulatorControl)

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cache="${X_BENCH_SIM_CACHE:-$HOME/.cache/x-bench-sim}"
out="$here/build"
products="$cache/dd/Build/Products/Release"

mkdir -p "$cache"
if [[ ! -d "$cache/idb/.git" ]]; then
  git clone --quiet "$IDB_URL" "$cache/idb"
fi
if [[ "$(git -C "$cache/idb" rev-parse HEAD)" != "$IDB_REF" ]]; then
  git -C "$cache/idb" fetch --quiet origin "$IDB_REF"
  git -C "$cache/idb" checkout --quiet --detach "$IDB_REF"
  rm -rf "$cache/dd"
fi
# Swift modules only import into the compiler that built them, so an Xcode update rebuilds the frameworks.
swift_version="$(xcrun swiftc --version 2>/dev/null | sed -n 1p)"
if [[ "$(cat "$cache/dd/swift-version" 2>/dev/null)" != "$swift_version" ]]; then
  rm -rf "$cache/dd"
fi

if [[ ! -d "$products/FBSimulatorControl.framework" ]]; then
  command -v xcodegen >/dev/null || { echo "XcodeGen is needed: brew install xcodegen" >&2; exit 1; }
  (cd "$cache/idb" && ./build.sh generate >/dev/null)
  for scheme in "${FRAMEWORKS[@]}"; do
    xcodebuild -project "$cache/idb/FBSimulatorControl.xcodeproj" -scheme "$scheme" -sdk macosx \
      -destination generic/platform=macOS -configuration Release -derivedDataPath "$cache/dd" build \
      SKIP_INSTALL=NO ONLY_ACTIVE_ARCH=NO ARCHS=arm64 CODE_SIGNING_ALLOWED=NO \
      GCC_TREAT_WARNINGS_AS_ERRORS=NO SWIFT_TREAT_WARNINGS_AS_ERRORS=NO \
      'OTHER_LDFLAGS=$(inherited) -Wl,-headerpad_max_install_names' -quiet
  done
  echo "$swift_version" > "$cache/dd/swift-version"
fi

rm -rf "$out"
mkdir -p "$out/Frameworks"
for name in "${FRAMEWORKS[@]}"; do
  cp -R "$products/$name.framework" "$out/Frameworks/"
done
cp "$cache/idb/LICENSE" "$out/LICENSE-idb"

# The idb modules import Apple's private frameworks, described by idb's module maps at compile time only.
headers=()
for module in AccessibilityPlatformTranslation AXRuntime CoreSimDeviceIO CoreSimulator CoreSimulatorUtilities SimulatorKit; do
  headers+=("-I$cache/idb/PrivateHeaders/$module")
done

xcrun swiftc -O -parse-as-library -target arm64-apple-macos14.0 "-I$cache/idb/PrivateHeaders" "${headers[@]}" \
  -F "$products" -framework FBControlCore -framework FBSimulatorControl -framework XCTestBootstrap \
  -Xlinker -rpath -Xlinker @executable_path/Frameworks \
  "$here/main.swift" -o "$out/xbench-sim"

# Ad-hoc signatures; the packaged app signs them again with its own identity.
for name in "${FRAMEWORKS[@]}"; do
  codesign --force --sign - "$out/Frameworks/$name.framework" >/dev/null
done
codesign --force --sign - "$out/xbench-sim" >/dev/null
echo "$out/xbench-sim"
