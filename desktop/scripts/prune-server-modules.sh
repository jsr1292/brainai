#!/usr/bin/env bash
# Removes from a staged server's node_modules what the server never loads (sources, build scripts, type
# declarations, source maps, the ES-module copy of a package that is only ever require()d), so the app ships fewer
# files. Only the native packages are installed there (bundle-server.mjs); the platform binaries are the callers' job.
# Usage: prune-server-modules.sh <staged server folder>
set -euo pipefail
M="${1:?staged server folder}/node_modules"
[ -d "$M" ] || { echo "No node_modules in $1" >&2; exit 1; }
rm -rf "$M/better-sqlite3/src" "$M/better-sqlite3/deps" "$M/better-sqlite3/binding.gyp"
rm -rf "$M/sharp/src" "$M/sharp/install" "$M/sharp/lib"
rm -rf "$M/onnxruntime-node/script" "$M/onnxruntime-node/lib"
# transformers.js imports the ES build of onnxruntime-common and onnxruntime-node requires the CommonJS one: both stay.
rm -rf "$M/onnxruntime-common/lib"
find "$M" -type f \( -name '*.d.ts' -o -name '*.d.cts' -o -name '*.d.mts' -o -name '*.map' -o -name '*.ts' ! -name '*.d.ts' \) -delete
find "$M" -type f \( -iname 'README*' -o -iname 'CHANGELOG*' \) -delete
find "$M" -type d -empty -delete
