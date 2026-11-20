#!/usr/bin/env bash
# Stages what the Mac app runs (D2, docs/DESKTOP.md): the esbuild-bundled server (bundle-server.mjs) with its native packages (the
# darwin-arm64 binaries only) in desktop/src-tauri/resources/server/, with no models (the app downloads them), and a
# checksum-verified Node 22 as the Tauri sidecar desktop/src-tauri/binaries/node-aarch64-apple-darwin. Run on an
# Apple-silicon Mac.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TAURI="$ROOT/desktop/src-tauri"
SERVER="$TAURI/resources/server"
NODE_MAJOR="${NODE_MAJOR:-22}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || { echo "Build the Mac app on an Apple-silicon Mac." >&2; exit 1; }
# The app must contain exactly a commit, so nothing uncommitted ships.
if [ -n "$(cd "$ROOT" && git status --porcelain -- src package.json package-lock.json)" ] && [ "${ALLOW_DIRTY:-0}" != "1" ]; then
  echo "Uncommitted changes in the server: commit them first (or set ALLOW_DIRTY=1 for a throwaway build)." >&2; exit 1
fi

echo "Bundling the server ..."
# The type check is the build's gate; the shipped JavaScript is the esbuild bundle (dist/index.js, dist/cli.js and the
# hooks, with every dependency inside except the native packages, which are installed below).
(cd "$ROOT" && npx tsc --noEmit -p tsconfig.build.json)
rm -rf "$SERVER" && mkdir -p "$SERVER" "$TAURI/binaries"
NODE_TARGET="node$NODE_MAJOR" node "$ROOT/desktop/scripts/bundle-server.mjs" "$SERVER" >/dev/null
# No models: the app downloads the ones the owner chooses into its data folder (src/models/manager.ts). The licences
# stay with the app: a Gemma download gets its notice and terms from licenses/ (Gemma Terms of Use, section 3.1).
cp -R "$ROOT/licenses" "$SERVER/licenses"
[ -f "$SERVER/licenses/GEMMA-NOTICE.txt" ] || { echo "licenses/GEMMA-NOTICE.txt is missing: a Gemma download needs it" >&2; exit 1; }

echo "Installing the native darwin-arm64 packages ..."
(cd "$SERVER" && npm ci --omit=dev --ignore-scripts --os=darwin --cpu=arm64 --no-audit --no-fund >/dev/null)
# onnxruntime-node ships binaries for every platform; only darwin-arm64 is used.
ORT="$SERVER/node_modules/onnxruntime-node/bin/napi-v6"
rm -rf "$ORT/linux" "$ORT/win32" "$ORT/darwin/x64"
rm -f "$SERVER/node_modules/better-sqlite3/prebuilds/"{linux,win32,darwin-x64}*.node 2>/dev/null || true
"$ROOT/desktop/scripts/prune-server-modules.sh" "$SERVER"
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

# The app ships no model (it downloads them): no models folder, and under 100 MB of model files (none, in fact).
MODEL_BYTES="$(find "$SERVER" -type f \( -name '*.onnx' -o -name '*.onnx_data' -o -name '*.safetensors' \) -exec stat -f %z {} + | awk '{s+=$1} END {print s+0}')"
[ ! -e "$SERVER/models" ] && [ "$MODEL_BYTES" -lt 100000000 ] || { echo "Model files are in the staged app ($MODEL_BYTES bytes): it must not ship them" >&2; exit 1; }
echo "Staged the server ($(du -sh "$SERVER" | cut -f1)) and Node $VERSION for the Mac app."
