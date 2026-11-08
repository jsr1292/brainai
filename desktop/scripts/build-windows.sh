#!/usr/bin/env bash
# Builds the BrainAI Windows app on this Mac (D6, docs/DESKTOP.md): the Tauri shell cross-compiled for
# x86_64-pc-windows-msvc with cargo-xwin, packed by NSIS into a per-user Setup .exe, with the server staged for
# win32-x64 (stage-server-windows.sh). Output: dist-windows/BrainAI_<version>_x64-setup.exe and SHA256SUMS.
# --placeholder builds the shell with empty server parts (only to check the cross-build itself).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESK="$ROOT/desktop"
TAURI="$DESK/src-tauri"
TARGET=x86_64-pc-windows-msvc
export PATH="$HOME/.cargo/bin:$(brew --prefix llvm 2>/dev/null)/bin:$(brew --prefix lld 2>/dev/null)/bin:$PATH"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing $1: $2" >&2; exit 1; }; }
need cargo-xwin "cargo install --locked cargo-xwin"
need makensis "brew install nsis"
need lld-link "brew install lld llvm"
rustup target list --installed | grep -qx "$TARGET" || { echo "Missing the Rust target: rustup target add $TARGET" >&2; exit 1; }

if [ "${1:-}" = "--placeholder" ]; then
  mkdir -p "$TAURI/binaries" "$TAURI/resources/server-windows"
  : > "$TAURI/binaries/node-$TARGET.exe"
  : > "$TAURI/resources/server-windows/.placeholder"
else
  "$DESK/scripts/stage-server-windows.sh"
fi

(cd "$DESK" && npx tauri build --runner cargo-xwin --target "$TARGET" --bundles nsis)

OUT="$ROOT/dist-windows"
mkdir -p "$OUT"
SETUP="$(ls -t "$TAURI/target/$TARGET/release/bundle/nsis/"*_x64-setup.exe | head -1)"
cp "$SETUP" "$OUT/"
(cd "$OUT" && shasum -a 256 "$(basename "$SETUP")" > SHA256SUMS)
echo "Built $OUT/$(basename "$SETUP")"
cat "$OUT/SHA256SUMS"
