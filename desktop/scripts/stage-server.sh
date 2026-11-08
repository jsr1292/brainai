#!/usr/bin/env bash
# Stages what the Mac app runs (D2, docs/DESKTOP.md): the compiled server with its production dependencies (the
# darwin-arm64 binaries only) and the search model in desktop/src-tauri/resources/server/, and a checksum-verified
# Node 22 as the Tauri sidecar desktop/src-tauri/binaries/node-aarch64-apple-darwin. Run on an Apple-silicon Mac.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TAURI="$ROOT/desktop/src-tauri"
SERVER="$TAURI/resources/server"
NODE_MAJOR="${NODE_MAJOR:-22}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || { echo "Build the Mac app on an Apple-silicon Mac." >&2; exit 1; }
[ -f "$ROOT/models/Xenova/multilingual-e5-small/onnx/model_quantized.onnx" ] || {
  echo "The search model is missing: run  npm run model  first." >&2; exit 1; }
[ -f "$ROOT/models/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1/onnx/model_qint8_arm64.onnx" ] || {
  echo "The reranker model is missing: run  npm run model  first." >&2; exit 1; }
# The app must contain exactly a commit, so nothing uncommitted ships.
if [ -n "$(cd "$ROOT" && git status --porcelain -- src package.json package-lock.json)" ] && [ "${ALLOW_DIRTY:-0}" != "1" ]; then
  echo "Uncommitted changes in the server: commit them first (or set ALLOW_DIRTY=1 for a throwaway build)." >&2; exit 1
fi

echo "Building the server ..."
(cd "$ROOT" && rm -rf dist && npm run build >/dev/null)
rm -rf "$SERVER" && mkdir -p "$SERVER" "$TAURI/binaries"
cp -R "$ROOT/dist" "$ROOT/package.json" "$ROOT/package-lock.json" "$SERVER/"
cp -RL "$ROOT/models" "$SERVER/models"

echo "Installing the darwin-arm64 dependencies ..."
(cd "$SERVER" && npm ci --omit=dev --ignore-scripts --os=darwin --cpu=arm64 --no-audit --no-fund >/dev/null)
# onnxruntime-node ships binaries for every platform; only darwin-arm64 is used.
ORT="$SERVER/node_modules/onnxruntime-node/bin/napi-v6"
rm -rf "$ORT/linux" "$ORT/win32" "$ORT/darwin/x64"
rm -f "$SERVER/node_modules/better-sqlite3/prebuilds/"{linux,win32,darwin-x64}*.node 2>/dev/null || true
# The browser build of the runtime (about 140 MB): the server uses onnxruntime-node (checked: it starts and searches without it).
rm -rf "$SERVER/node_modules/onnxruntime-web"
for f in \
  better-sqlite3/prebuilds/darwin-arm64.node \
  @node-rs/argon2-darwin-arm64/argon2.darwin-arm64.node \
  onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node; do
  file "$SERVER/node_modules/$f" | grep -q 'Mach-O 64-bit.*arm64' || { echo "Missing or not a darwin-arm64 binary: $f" >&2; exit 1; }
done
ls "$SERVER/node_modules/@img/sharp-darwin-arm64/lib/"*.node >/dev/null

echo "Downloading Node $NODE_MAJOR for macOS arm64 ..."
VERSION="$(curl -fsSL --retry 3 --http1.1 https://nodejs.org/dist/index.json | node -e "
  const all = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  console.log(all.find((r) => r.version.startsWith('v$NODE_MAJOR.')).version)")"
TAR="node-$VERSION-darwin-arm64.tar.gz"
curl -fsSL --retry 3 --http1.1 -o "$WORK/$TAR" "https://nodejs.org/dist/$VERSION/$TAR"
curl -fsSL --retry 3 --http1.1 -o "$WORK/SHASUMS256.txt" "https://nodejs.org/dist/$VERSION/SHASUMS256.txt"
(cd "$WORK" && grep " $TAR\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) || { echo "Checksum mismatch for $TAR" >&2; exit 1; }
tar -xzf "$WORK/$TAR" -C "$WORK" "node-$VERSION-darwin-arm64/bin/node" "node-$VERSION-darwin-arm64/LICENSE"
install -m 0755 "$WORK/node-$VERSION-darwin-arm64/bin/node" "$TAURI/binaries/node-aarch64-apple-darwin"
cp "$WORK/node-$VERSION-darwin-arm64/LICENSE" "$SERVER/NODE-LICENSE"
file "$TAURI/binaries/node-aarch64-apple-darwin" | grep -q 'Mach-O 64-bit.*arm64' || { echo "Node is not a darwin-arm64 binary" >&2; exit 1; }

echo "Staged the server ($(du -sh "$SERVER" | cut -f1)) and Node $VERSION for the Mac app."
