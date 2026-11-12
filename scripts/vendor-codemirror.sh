#!/usr/bin/env bash
# Bundles the page editor's CodeMirror 6 (UI round, task 1) into one committed ES module under static/vendor, in the
# style of vendor-mermaid.sh: esbuild and the @codemirror/* packages are devDependencies only (no new runtime
# dependency on the server); the browser loads the committed bundle from /static/vendor/codemirror-<version>/editor.mjs,
# and the version in the folder's name is what lets /static/vendor be cached for a year. Run after bumping them, then
# commit the folder.
set -euo pipefail
cd "$(dirname "$0")/.."
VER="$(node -p "require('./node_modules/@codemirror/view/package.json').version")"
OUT="src/web/static/vendor/codemirror-$VER"
rm -rf "$OUT"
mkdir -p "$OUT"
npx esbuild scripts/vendor/codemirror-entry.mjs --bundle --format=esm --minify --target=es2020 --outfile="$OUT/editor.mjs"
cp node_modules/@codemirror/view/LICENSE "$OUT/LICENSE"
echo "vendored CodeMirror $VER ($(wc -c < "$OUT/editor.mjs" | tr -d ' ') bytes)"
