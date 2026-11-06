#!/usr/bin/env bash
# Builds dist-windows/work-memory-win-x64-<commit>.zip on the Mac: the compiled server, its production
# dependencies with their Windows x64 binaries, the search model, a Windows node.exe (checksum-verified) and the
# PowerShell scripts. The laptop then needs no internet access and no installs. See docs/WORK.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE_MAJOR="${NODE_MAJOR:-22}"
OUT="$ROOT/dist-windows"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/WorkMemory"

[ -f "$ROOT/models/Xenova/multilingual-e5-small/onnx/model_quantized.onnx" ] || {
  echo "The search model is missing: run  MODEL_DIR=./models npx tsx src/scripts/warmModel.ts  first." >&2; exit 1; }

# The zip is named after the commit, so it must contain exactly that commit.
if [ -n "$(cd "$ROOT" && git status --porcelain)" ] && [ "${ALLOW_DIRTY:-0}" != "1" ]; then
  echo "Uncommitted changes: commit them first (or set ALLOW_DIRTY=1 for a throwaway build)." >&2; exit 1
fi

echo "Building the server ..."
# A clean build, so no stale or test files ship.
(cd "$ROOT" && rm -rf dist && npm run build >/dev/null)
mkdir -p "$STAGE/app" "$STAGE/node"
cp -R "$ROOT/dist" "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/app/"
cp -R "$ROOT/models" "$STAGE/app/models"

echo "Installing the Windows x64 dependencies ..."
(cd "$STAGE/app" && npm ci --omit=dev --ignore-scripts --os=win32 --cpu=x64 --no-audit --no-fund >/dev/null)
# onnxruntime-node ships binaries for every platform; only Windows x64 is used.
ORT="$STAGE/app/node_modules/onnxruntime-node/bin/napi-v6"
rm -rf "$ORT/darwin" "$ORT/linux" "$ORT/win32/arm64"

for f in \
  better-sqlite3/prebuilds/win32-x64.node \
  @node-rs/argon2-win32-x64-msvc/argon2.win32-x64-msvc.node \
  onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node; do
  file "$STAGE/app/node_modules/$f" | grep -q 'PE32+ executable.*x86-64' || { echo "Missing or not a Windows x64 binary: $f" >&2; exit 1; }
done
ls "$STAGE/app/node_modules/@img/sharp-win32-x64/lib/"*.node >/dev/null

echo "Downloading Node $NODE_MAJOR for Windows ..."
VERSION="$(curl -fsSL --retry 3 --http1.1 https://nodejs.org/dist/index.json | node -e "
  const all = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  console.log(all.find((r) => r.version.startsWith('v$NODE_MAJOR.')).version)")"
ZIP="node-$VERSION-win-x64.zip"
curl -fsSL --retry 3 --http1.1 -o "$WORK/$ZIP" "https://nodejs.org/dist/$VERSION/$ZIP"
curl -fsSL --retry 3 --http1.1 -o "$WORK/SHASUMS256.txt" "https://nodejs.org/dist/$VERSION/SHASUMS256.txt"
(cd "$WORK" && grep " $ZIP\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) || { echo "Checksum mismatch for $ZIP" >&2; exit 1; }
unzip -q -j "$WORK/$ZIP" "node-$VERSION-win-x64/node.exe" "node-$VERSION-win-x64/LICENSE" -d "$STAGE/node"

cp "$ROOT"/scripts/windows/*.ps1 "$STAGE/"
cp "$ROOT/scripts/windows/README.txt" "$STAGE/"
# Windows tools expect CRLF line endings in scripts and text files.
for f in "$STAGE"/*.ps1 "$STAGE/README.txt"; do perl -pi -e 's/\r?\n/\r\n/' "$f"; done

mkdir -p "$OUT"
NAME="work-memory-win-x64-$(cd "$ROOT" && git rev-parse --short HEAD).zip"
rm -f "$OUT/$NAME"
(cd "$WORK" && zip -qr "$OUT/$NAME" WorkMemory)
echo "Built $OUT/$NAME ($(du -h "$OUT/$NAME" | cut -f1), Node $VERSION)"
