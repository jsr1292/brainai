#!/usr/bin/env bash
# Builds the BrainAI Windows app on this Mac (D6, docs/DESKTOP.md): the Tauri shell cross-compiled for
# x86_64-pc-windows-msvc with cargo-xwin, packed by NSIS into a per-user Setup .exe, with the server staged for
# win32-x64 (stage-server-windows.sh). Output: dist-windows/BrainAI_<version>_x64-setup.exe and SHA256SUMS.
# --placeholder builds the shell with empty server parts (only to check the cross-build itself).
# --config <json> (repeatable) is passed on to `tauri build`, as build-apps.sh does to make the updater files; the
# TAURI_SIGNING_PRIVATE_KEY(_PASSWORD) a caller sets in the environment reach that `tauri build` line only (never the
# staging and its npm install scripts), and then the update signature (<setup>.exe.sig) is copied beside the
# installer. CARGO_TARGET_DIR, when set, is where the build goes.
# Usage: desktop/scripts/build-windows.sh [--placeholder] [--config <json>]...
set -euo pipefail
# The updater key stays a shell variable here: no child process sees it until the `tauri build` line below.
export -n TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD 2>/dev/null || true
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

PLACEHOLDER=0
CONFIG=()
while [ $# -gt 0 ]; do
  case "$1" in
    --placeholder) PLACEHOLDER=1 ;;
    --config) [ $# -ge 2 ] || { echo "--config needs a value" >&2; exit 2; }; CONFIG+=(--config "$2"); shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$PLACEHOLDER" = 1 ]; then
  mkdir -p "$TAURI/binaries" "$TAURI/resources/server-windows"
  : > "$TAURI/binaries/node-$TARGET.exe"
  : > "$TAURI/resources/server-windows/.placeholder"
else
  "$DESK/scripts/stage-server-windows.sh"
fi

(
  if [ -n "${TAURI_SIGNING_PRIVATE_KEY:+x}" ]; then export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD; fi
  cd "$DESK" && npx tauri build --runner cargo-xwin --target "$TARGET" --bundles nsis ${CONFIG[@]+"${CONFIG[@]}"}
)

OUT="$ROOT/dist-windows"
mkdir -p "$OUT"
SETUP="$(ls -t "${CARGO_TARGET_DIR:-$TAURI/target}/$TARGET/release/bundle/nsis/"*_x64-setup.exe | head -1)"
cp "$SETUP" "$OUT/"
rm -f "$OUT/$(basename "$SETUP").sig"
# Only a signature this build made (with a key set): an older one in the target folder would not match.
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:+x}" ] && [ -f "$SETUP.sig" ]; then cp "$SETUP.sig" "$OUT/"; fi
(cd "$OUT" && shasum -a 256 "$(basename "$SETUP")" > SHA256SUMS)
echo "Built $OUT/$(basename "$SETUP")"
cat "$OUT/SHA256SUMS"
