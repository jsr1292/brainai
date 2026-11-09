#!/usr/bin/env bash
# Puts Microsoft's Visual C++ 2015-2022 runtime files that BrainAI's Windows build needs into a folder. The builds put
# them in the folder of each native module that loads them (onnxruntime's and argon2's): Node loads a module with
# LoadLibraryEx(LOAD_WITH_ALTERED_SEARCH_PATH), so Windows looks for its DLLs in the module's own folder first, then
# System32. The app then runs on a PC without the runtime, or with an older one, and needs no administrator.
#
# The files come only from Microsoft's official VC_redist.x64.exe, pinned by URL, size and SHA-256 (version
# 14.44.35211.0; its Authenticode signature and each DLL's were verified against Microsoft's roots on 2026-11-09, see
# docs/superpowers/plans/2026-11-09-brainai-b8-vcruntime.md), and each DLL is pinned by SHA-256. Any mismatch stops
# the build and stages nothing. Refreshing the runtime (Microsoft security fixes) means changing these pins.
#
# Usage: scripts/windows/vcruntime.sh <dest-dir>     (needs cabextract: brew install cabextract)
#        scripts/windows/vcruntime.sh --list         (the file names, one per line)
set -euo pipefail

URL="${VC_REDIST_URL:-https://download.visualstudio.microsoft.com/download/pr/990c720a-46ce-4dc7-87b9-c2eb615d34b9/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe}"
PACKAGE_SHA256=cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b
PACKAGE_SIZE=25635768
# Inside the package's attached container, cabinet a12 is packages\vcRuntimeMinimum_amd64\cab1.cab.
CABINET=a12
FILES=(vcruntime140.dll vcruntime140_1.dll msvcp140.dll msvcp140_1.dll msvcp140_atomic_wait.dll)
SHA256S=(
  d5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066
  1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f
  0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9
  bfad5aef4c63a669e3c140655cdfdf395b6c979b400a447bd5dcb65ed8826c3d
  640b2aefced484d0368eea5bdd06addd0658a3a70a49256e560d6923b404a479
)

if [ "${1:-}" = "--list" ]; then printf '%s\n' "${FILES[@]}"; exit 0; fi
DEST="${1:?Usage: vcruntime.sh <dest-dir>}"
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

CACHE="${VC_CACHE:-$HOME/.cache/brainai}"
PKG="$CACHE/VC_redist.x64.exe"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A cached package is used only while it still matches the pins; a download is checked before it is kept.
if [ ! -f "$PKG" ] || [ "$(sha "$PKG")" != "$PACKAGE_SHA256" ]; then
  echo "Downloading Microsoft's Visual C++ runtime package ..."
  curl -fsSL --retry 3 -o "$WORK/package.exe" "$URL" || { echo "Could not download the Visual C++ runtime package from $URL. Nothing was staged." >&2; exit 1; }
  got="$(sha "$WORK/package.exe")"
  size="$(wc -c < "$WORK/package.exe" | tr -d ' ')"
  if [ "$got" != "$PACKAGE_SHA256" ] || [ "$size" != "$PACKAGE_SIZE" ]; then
    echo "The Visual C++ runtime package is not the pinned one (SHA-256 $got, $size bytes; expected $PACKAGE_SHA256, $PACKAGE_SIZE bytes). Nothing was staged." >&2
    exit 1
  fi
  mkdir -p "$CACHE"
  mv "$WORK/package.exe" "$PKG"
fi

command -v cabextract >/dev/null 2>&1 || { echo "Missing cabextract: brew install cabextract" >&2; exit 1; }
mkdir -p "$WORK/outer" "$WORK/inner"
cabextract -q -F "$CABINET" -d "$WORK/outer" "$PKG" || { echo "cabextract could not unpack the package. Nothing was staged." >&2; exit 1; }
[ -f "$WORK/outer/$CABINET" ] || { echo "The runtime cabinet ($CABINET) is missing from the package. Nothing was staged." >&2; exit 1; }
cabextract -q -d "$WORK/inner" "$WORK/outer/$CABINET" || { echo "cabextract could not unpack the runtime cabinet. Nothing was staged." >&2; exit 1; }
for i in "${!FILES[@]}"; do
  f="${FILES[$i]}"
  src="$WORK/inner/${f}_amd64"
  [ -f "$src" ] || { echo "$f is missing from the runtime package. Nothing was staged." >&2; exit 1; }
  got="$(sha "$src")"
  [ "$got" = "${SHA256S[$i]}" ] || { echo "$f does not match its pin (SHA-256 $got, expected ${SHA256S[$i]}). Nothing was staged." >&2; exit 1; }
  cp "$src" "$WORK/$f"
done
# All five checked: only now do they reach the destination.
mkdir -p "$DEST"
for f in "${FILES[@]}"; do install -m 0644 "$WORK/$f" "$DEST/$f"; done
echo "Staged the Visual C++ runtime (14.44.35211.0, ${#FILES[@]} files) in $DEST"
