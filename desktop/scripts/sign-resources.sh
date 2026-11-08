#!/usr/bin/env bash
# Signs every native file in the staged server (desktop/src-tauri/resources/server) with the hardened runtime, before
# `npx tauri build`: notarisation refuses any unsigned Mach-O file in the bundle. Usage:
#   desktop/scripts/sign-resources.sh "<signing identity>"     (as in APPLE_SIGNING_IDENTITY; "-" signs ad hoc, to test)
set -euo pipefail
IDENTITY="${1:?Give the signing identity, or - for an ad-hoc test signature}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$ROOT/src-tauri/resources/server"
[ -d "$SERVER" ] || { echo "Stage the server first: desktop/scripts/stage-server.sh" >&2; exit 1; }
TIMESTAMP=(--timestamp)
[ "$IDENTITY" = "-" ] && TIMESTAMP=()
count=0
while IFS= read -r -d '' f; do
  if file "$f" | grep -q 'Mach-O'; then
    codesign --force --options runtime ${TIMESTAMP[@]+"${TIMESTAMP[@]}"} --sign "$IDENTITY" "$f"
    count=$((count + 1))
  fi
done < <(find "$SERVER" -type f \( -name '*.node' -o -name '*.dylib' -o -name '*.so' \) -print0)
echo "Signed $count native files in the staged server."
