#!/usr/bin/env bash
# Copies the diagram drawer and its sanitiser from node_modules into src/web/static/vendor (round 2 section 12):
# Mermaid's ES module build (its entry and every chunk, no source maps) and DOMPurify's ES module, with their
# licences. The version is in each folder's name, which is what lets /static/vendor be cached for a year.
# Run after changing either dev dependency's version, then commit the folders.
set -euo pipefail
cd "$(dirname "$0")/.."
MERMAID="$(node -p "require('./node_modules/mermaid/package.json').version")"
PURIFY="$(node -p "require('./node_modules/dompurify/package.json').version")"
M="src/web/static/vendor/mermaid-$MERMAID"
P="src/web/static/vendor/dompurify-$PURIFY"
rm -rf "$M" "$P"
mkdir -p "$M/chunks/mermaid.esm.min" "$P"
cp node_modules/mermaid/dist/mermaid.esm.min.mjs "$M/"
cp node_modules/mermaid/dist/chunks/mermaid.esm.min/*.mjs "$M/chunks/mermaid.esm.min/"
cp node_modules/mermaid/LICENSE "$M/"
cp node_modules/dompurify/dist/purify.es.mjs "$P/"
cp node_modules/dompurify/LICENSE "$P/"
# The bundles end with a sourceMappingURL comment; the maps are not shipped, so the comment goes too.
find "$M" "$P" -name '*.mjs' -exec sed -i.bak -E '/^\/\/# sourceMappingURL=.*$/d' {} + && find "$M" "$P" -name '*.bak' -delete
echo "vendored mermaid $MERMAID ($(ls "$M/chunks/mermaid.esm.min" | wc -l | tr -d ' ') chunks) and dompurify $PURIFY"
