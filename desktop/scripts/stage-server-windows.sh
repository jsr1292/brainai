#!/usr/bin/env bash
# Stages what the Windows app runs (D6, docs/DESKTOP.md), on the Mac: the compiled server with its production
# dependencies (their Windows x64 binaries only) and the search model in desktop/src-tauri/resources/server-windows/,
# and a checksum-verified Windows node.exe (Node 22) as the Tauri sidecar binaries/node-x86_64-pc-windows-msvc.exe.
# Every native file in the staged tree is checked to be a Windows x64 binary.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TAURI="$ROOT/desktop/src-tauri"
SERVER="$TAURI/resources/server-windows"
SIDECAR="$TAURI/binaries/node-x86_64-pc-windows-msvc.exe"
NODE_MAJOR="${NODE_MAJOR:-22}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -f "$ROOT/models/Xenova/multilingual-e5-small/onnx/model_quantized.onnx" ] || {
  echo "The search model is missing: run  npm run model  first." >&2; exit 1; }
# The app must contain exactly a commit, so nothing uncommitted ships.
if [ -n "$(cd "$ROOT" && git status --porcelain -- src package.json package-lock.json)" ] && [ "${ALLOW_DIRTY:-0}" != "1" ]; then
  echo "Uncommitted changes in the server: commit them first (or set ALLOW_DIRTY=1 for a throwaway build)." >&2; exit 1
fi

echo "Building the server ..."
(cd "$ROOT" && rm -rf dist && npm run build >/dev/null)
rm -rf "$SERVER" && mkdir -p "$SERVER" "$TAURI/binaries"
cp -R "$ROOT/dist" "$ROOT/package.json" "$ROOT/package-lock.json" "$SERVER/"
cp -RL "$ROOT/models" "$SERVER/models"

echo "Installing the win32-x64 dependencies ..."
(cd "$SERVER" && npm ci --omit=dev --ignore-scripts --os=win32 --cpu=x64 --no-audit --no-fund >/dev/null)
# onnxruntime-node ships binaries for every platform; only Windows x64 is used.
ORT="$SERVER/node_modules/onnxruntime-node/bin/napi-v6"
rm -rf "$ORT/darwin" "$ORT/linux" "$ORT/win32/arm64"
rm -f "$SERVER/node_modules/better-sqlite3/prebuilds/"{linux,darwin,win32-arm64,win32-ia32}*.node 2>/dev/null || true
# The browser build of the runtime (about 140 MB): the server uses onnxruntime-node.
rm -rf "$SERVER/node_modules/onnxruntime-web"
for f in \
  better-sqlite3/prebuilds/win32-x64.node \
  @node-rs/argon2-win32-x64-msvc/argon2.win32-x64-msvc.node \
  onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node; do
  file "$SERVER/node_modules/$f" | grep -q 'PE32+ executable.*x86-64' || { echo "Missing or not a Windows x64 binary: $f" >&2; exit 1; }
done
ls "$SERVER/node_modules/@img/sharp-win32-x64/lib/"*.node >/dev/null
# No binary for another system may ship (a Mac or Linux .node would fail to load on Windows).
BAD="$(find "$SERVER" -type f \( -name '*.node' -o -name '*.dylib' -o -name '*.so' -o -name '*.so.*' \) -print0 | xargs -0 file | grep -v 'PE32+ executable.*x86-64' || true)"
[ -z "$BAD" ] || { echo "Not Windows x64 binaries:" >&2; echo "$BAD" >&2; exit 1; }

echo "Downloading Node $NODE_MAJOR for Windows x64 ..."
VERSION="$(curl -fsSL --retry 3 --http1.1 https://nodejs.org/dist/index.json | node -e "
  const all = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  console.log(all.find((r) => r.version.startsWith('v$NODE_MAJOR.')).version)")"
ZIP="node-$VERSION-win-x64.zip"
curl -fsSL --retry 3 --http1.1 -o "$WORK/$ZIP" "https://nodejs.org/dist/$VERSION/$ZIP"
curl -fsSL --retry 3 --http1.1 -o "$WORK/SHASUMS256.txt" "https://nodejs.org/dist/$VERSION/SHASUMS256.txt"
(cd "$WORK" && grep " $ZIP\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) || { echo "Checksum mismatch for $ZIP" >&2; exit 1; }
unzip -q -j "$WORK/$ZIP" "node-$VERSION-win-x64/node.exe" "node-$VERSION-win-x64/LICENSE" -d "$WORK/node"
install -m 0755 "$WORK/node/node.exe" "$SIDECAR"
cp "$WORK/node/LICENSE" "$SERVER/NODE-LICENSE"
file "$SIDECAR" | grep -q 'PE32+ executable.*x86-64' || { echo "node.exe is not a Windows x64 binary" >&2; exit 1; }

echo "Staged the server ($(du -sh "$SERVER" | cut -f1)) and Node $VERSION for the Windows app."
