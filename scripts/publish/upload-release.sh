#!/usr/bin/env bash
# Puts a built release on the public repo's GitHub Releases as the latest one, then checks what the world now sees.
#   - Creates release v<version> as a draft (the tag must already be pushed: --verify-tag) with the dmg, the app.tar.gz,
#     the setup.exe, install-app.ps1, latest.json and SHA256SUMS, and only then publishes it as the latest, so a
#     half-uploaded release is never "latest". If the release exists, uploads over it (--clobber), then publishes it
#     as the latest again, so a half-done run can be repeated.
#   - Then downloads .../releases/latest/download/latest.json (its version must be <version>) and SHA256SUMS (it must
#     equal the local file). Exit 1 if either check fails, 2 for a bad call or a missing file.
#   - --check-only: runs only that check, uploads nothing and calls no gh (when only the check failed).
# Usage: scripts/publish/upload-release.sh <version> <dir> [--check-only]      (dir: dist-release/<version>)
set -uo pipefail
VERSION="${1:-}" DIR="${2:-}" MODE="${3:-}"
REPO_SLUG="jsr1292/brainai"
BASE="https://github.com/$REPO_SLUG/releases/latest/download"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && [ -d "$DIR" ] && { [ -z "$MODE" ] || [ "$MODE" = --check-only ]; } || { echo "Usage: upload-release.sh <version> <dir> [--check-only]" >&2; exit 2; }
DIR="$(cd "$DIR" && pwd)"
FILES=()
for n in "BrainAI_${VERSION}_aarch64.dmg" "BrainAI_${VERSION}_aarch64.app.tar.gz" "BrainAI_${VERSION}_x64-setup.exe" install-app.ps1 latest.json SHA256SUMS release-notes.md; do
  [ -f "$DIR/$n" ] || { echo "Missing $DIR/$n" >&2; exit 2; }
  [ "$n" = release-notes.md ] || FILES+=("$DIR/$n")
done

if [ "$MODE" != --check-only ]; then
  if gh release view "v$VERSION" --repo "$REPO_SLUG" >/dev/null 2>&1; then
    echo "Release v$VERSION exists: uploading over it ..."
    gh release upload "v$VERSION" --repo "$REPO_SLUG" --clobber "${FILES[@]}" || { echo "The upload failed" >&2; exit 1; }
  else
    echo "Creating release v$VERSION as a draft ..."
    gh release create "v$VERSION" --repo "$REPO_SLUG" --verify-tag --title "BrainAI $VERSION" --notes-file "$DIR/release-notes.md" --draft "${FILES[@]}" \
      || { echo "Could not create the release (is the tag v$VERSION pushed?)" >&2; exit 1; }
  fi
  gh release edit "v$VERSION" --repo "$REPO_SLUG" --draft=false --latest || { echo "Could not publish it as the latest" >&2; exit 1; }
fi

# What the world sees now. GitHub can take a moment to move "latest", so each check is tried a few times.
WAIT="${BRAINAI_VERIFY_WAIT:-5}"
TMP="$(mktemp -d)" && trap 'rm -rf "$TMP"' EXIT
check() {
  local i
  for i in 1 2 3 4 5; do
    curl -fsSL --max-time 20 "$BASE/latest.json" -o "$TMP/latest.json" 2>/dev/null && curl -fsSL --max-time 20 "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS" 2>/dev/null \
      && [ "$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version))}catch{}' "$TMP/latest.json")" = "$VERSION" ] \
      && cmp -s "$TMP/SHA256SUMS" "$DIR/SHA256SUMS" && return 0
    [ "$i" = 5 ] || sleep "$WAIT"
  done
  return 1
}
if ! check; then
  echo "The published latest.json does not say $VERSION, or the published SHA256SUMS differs from the local one." >&2
  echo "The release may be a draft, or not yet the latest: look at https://github.com/$REPO_SLUG/releases" >&2
  exit 1
fi
echo "Published and checked: $BASE/latest.json says $VERSION and SHA256SUMS match."
