#!/usr/bin/env bash
# Mirrors the model files on the public repo's release models-v1: the fallback the app uses when Hugging Face is
# unreachable. The release is a prerelease and never the "latest", so it can never be taken for an app update.
#   - The list is src/scripts/modelAssets.ts. Files are kept in ~/.cache/brainai/model-assets/ and reused when their
#     SHA-256 matches; others come from Hugging Face (curl) or, for file: entries, from this repo.
#   - A file whose SHA-256 differs from its pin is refused (exit 1) and nothing is uploaded.
#   - --if-missing: exit 0 at once when the release already has every asset.
# Usage: scripts/publish/upload-models.sh [--if-missing]
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_SLUG="jsr1292/brainai" TAG="models-v1"
IF_MISSING=0
case "${1:-}" in "") ;; --if-missing) IF_MISSING=1 ;; *) echo "Usage: upload-models.sh [--if-missing]" >&2; exit 2 ;; esac
CACHE="${BRAINAI_ASSET_CACHE:-$HOME/.cache/brainai/model-assets}"
sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }

# name<TAB>url<TAB>sha256 lines. BRAINAI_MODEL_ASSETS_JSON points at a ready list (tests); normally it is generated.
LIST="$(mktemp)" && trap 'rm -f "$LIST"' EXIT
if [ -n "${BRAINAI_MODEL_ASSETS_JSON:-}" ]; then JSON="$(cat "$BRAINAI_MODEL_ASSETS_JSON")"; else JSON="$(cd "$ROOT" && node --import tsx src/scripts/modelAssets.ts)" || { echo "Could not list the model files" >&2; exit 2; }; fi
printf '%s' "$JSON" | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{for(const a of JSON.parse(s))console.log([a.name,a.url,a.sha256].join("\t"))})' > "$LIST" || { echo "The model list is not valid" >&2; exit 2; }
[ -s "$LIST" ] || { echo "The model list is empty" >&2; exit 2; }

EXISTS=0 HAVE=""
if HAVE="$(gh release view "$TAG" --repo "$REPO_SLUG" --json assets --jq '.assets[].name' 2>/dev/null)"; then EXISTS=1; fi
MISSING=()
while IFS=$'\t' read -r name url hash; do
  printf '%s\n' "$HAVE" | grep -qxF "$name" || MISSING+=("$name")
done < "$LIST"
if [ "$IF_MISSING" = 1 ] && [ "$EXISTS" = 1 ] && [ "${#MISSING[@]}" -eq 0 ]; then echo "$TAG already has every model file."; exit 0; fi

# Fetch and check every missing file before anything is created or uploaded.
mkdir -p "$CACHE" || exit 2
PATHS=()
for want in ${MISSING[@]+"${MISSING[@]}"}; do
  while IFS=$'\t' read -r name url hash; do
    [ "$name" = "$want" ] || continue
    f="$CACHE/$name"
    if [ ! -f "$f" ] || [ "$(sha256 "$f")" != "$hash" ]; then
      rm -f "$f"
      case "$url" in
        file:*) cp "$ROOT/${url#file:}" "$f" || { echo "Cannot copy $url" >&2; exit 1; } ;;
        *) echo "Downloading $name ..."; curl -fL --retry 3 -o "$f.part" "$url" || { rm -f "$f.part"; echo "Download failed: $url" >&2; exit 1; }; mv "$f.part" "$f" ;;
      esac
    fi
    if [ "$(sha256 "$f")" != "$hash" ]; then rm -f "$f"; echo "Refused: $name does not match its pinned SHA-256. Nothing was uploaded." >&2; exit 1; fi
    PATHS+=("$f")
  done < "$LIST"
done

if [ "$EXISTS" = 0 ]; then
  NOTES="These are the search-model files BrainAI downloads when Hugging Face cannot be reached: the embedding and reranking models it offers, byte for byte as published, each checked against a fixed SHA-256 before use. They keep their own licences (MIT, Apache-2.0, and for Gemma the Gemma Terms of Use, https://ai.google.dev/gemma/terms); the licence and notice files are included. This is not an app release."
  gh release create "$TAG" --repo "$REPO_SLUG" --prerelease --latest=false --title "BrainAI model files (v1)" --notes "$NOTES" || { echo "Could not create $TAG" >&2; exit 1; }
fi
if [ "${#PATHS[@]}" -gt 0 ]; then
  gh release upload "$TAG" --repo "$REPO_SLUG" "${PATHS[@]}" || { echo "The upload failed" >&2; exit 1; }
fi
echo "$TAG has every model file."
