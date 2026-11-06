#!/bin/bash
# Builds unity_view.node, the Node-API addon that draws a Syphon server in the app window, into
# desktop/unity/unity-view/build. It compiles Syphon's client sources from a pinned revision in with the addon,
# so it needs neither the Syphon framework nor Xcode's Metal toolchain. Sources stay in ~/.cache/x-bench-unity-view.

set -euo pipefail

SYPHON_URL="https://github.com/Syphon/Syphon-Framework.git"
SYPHON_REF="f476167"
SYPHON_SOURCES=(SyphonMetalClient.m SyphonClientBase.m SyphonClientConnectionManager.m SyphonServerDirectory.m
  SyphonPrivate.m SyphonMessaging.m SyphonCFMessageReceiver.m SyphonCFMessageSender.m SyphonMessageQueue.m
  SyphonMessageReceiver.m SyphonMessageSender.m SyphonImageBase.m SyphonDispatch.c)

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cache="${X_BENCH_UNITY_VIEW_CACHE:-$HOME/.cache/x-bench-unity-view}"
syphon="$cache/Syphon-Framework"
out="$here/build"

mkdir -p "$cache" "$out/obj"
if [[ ! -d "$syphon/.git" ]]; then
  git clone --quiet "$SYPHON_URL" "$syphon"
fi
if [[ "$(git -C "$syphon" rev-parse --short HEAD)" != "$SYPHON_REF" ]]; then
  git -C "$syphon" fetch --quiet origin
  git -C "$syphon" checkout --quiet --detach "$SYPHON_REF"
fi

mkdir -p "$cache/include"
ln -sfn "$syphon" "$cache/include/Syphon"
node_include="$(dirname "$(dirname "$(command -v node)")")/include/node"
flags=(-arch arm64 -mmacosx-version-min=12.0 -O2 -fobjc-arc -I"$syphon" -I"$cache/include" -include "$syphon/Syphon_Prefix.pch"
  -Wno-deprecated-declarations)

objects=()
for source in "${SYPHON_SOURCES[@]}"; do
  object="$out/obj/${source%.*}.o"
  clang "${flags[@]}" -c "$syphon/$source" -o "$object"
  objects+=("$object")
done
clang++ "${flags[@]}" -std=c++17 -I"$node_include" -DNODE_GYP_MODULE_NAME=unity_view -c "$here/addon.mm" -o "$out/obj/addon.o"

clang++ -arch arm64 -mmacosx-version-min=12.0 -bundle -undefined dynamic_lookup "$out/obj/addon.o" "${objects[@]}" \
  -framework Cocoa -framework Metal -framework QuartzCore -framework IOSurface -o "$out/unity_view.node"
echo "$out/unity_view.node"
