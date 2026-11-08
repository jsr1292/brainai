#!/usr/bin/env bash
# Publishes a release: the committed HEAD of the repo you run it in, checked by the publish gate, becomes one commit
# "BrainAI <version>" and a tag v<version> on the public repo. Nothing reaches the public repo unless the gate passed.
#   - Works on a fresh clone of HEAD, so uncommitted files are never published.
#   - The public commit holds exactly the gate's checked tree: every tracked file minus docs/superpowers/; files gone
#     from the private repo are removed from the public one.
#   - Refuses (exit 2) a version that is not like 1.2.3, one with no "## <version>" entry in CHANGELOG.md, one already
#     tagged on the public repo, or a run without PUBLISH_NAME and PUBLISH_EMAIL (the public commit's author, e.g. a
#     GitHub noreply address).
#   - A gate finding is exit 1 and publishes nothing.
#   - Refuses an unreadable or empty denylist, and (run from the repo it releases) uncommitted edits to the gate.
#   - The caller's git hooks and signing are switched off for the public commit and tag.
# Usage: PUBLISH_NAME=… PUBLISH_EMAIL=… scripts/publish/release.sh <denylist> <public-repo-url> <version> [--no-tests] [--dry-run]
set -uo pipefail
# The caller's environment must not redirect git, and dates carry no local offset.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
export TZ=UTC

SELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$SELF_ROOT/scripts/publish/check-public-tree.sh"
DENYLIST="" PUBLIC="" VERSION="" GATE_ARGS=() DRY=0
for arg in "$@"; do
  case "$arg" in
    --no-tests) GATE_ARGS+=(--no-tests) ;;
    --dry-run) DRY=1 ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) if [ -z "$DENYLIST" ]; then DENYLIST="$arg"; elif [ -z "$PUBLIC" ]; then PUBLIC="$arg"; elif [ -z "$VERSION" ]; then VERSION="$arg"; else echo "Too many arguments" >&2; exit 2; fi ;;
  esac
done
[ -n "$VERSION" ] || { echo "Usage: release.sh <denylist> <public-repo-url> <version> [--no-tests] [--dry-run]" >&2; exit 2; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Give a version like 1.2.3" >&2; exit 2; }
[ -n "${PUBLISH_NAME:-}" ] && [ -n "${PUBLISH_EMAIL:-}" ] || { echo "Set PUBLISH_NAME and PUBLISH_EMAIL: the public commit's author" >&2; exit 2; }
[ -f "$DENYLIST" ] && [ -r "$DENYLIST" ] || { echo "No readable denylist file at the path given" >&2; exit 2; }
# Absolute, so the gate (run inside the clone) reads this file and never a tracked one of the same name.
DENYLIST="$(cd "$(dirname "$DENYLIST")" && pwd)/$(basename "$DENYLIST")"
# A release always checks words: an empty list (fine for a fork's CI) is refused here.
tr -d '\r' < "$DENYLIST" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | grep -v '^#' | grep -qv '^$' || { echo "The denylist has no words: a release needs your list" >&2; exit 2; }
REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "Run this inside the private git repository" >&2; exit 2; }
HEAD="$(git -C "$REPO" rev-parse HEAD)"
# The gate that runs is this script's own copy: when that is the repo being released, it must be the committed one.
if [ "$(cd "$SELF_ROOT" && pwd -P)" = "$(cd "$REPO" && pwd -P)" ] && ! git -C "$REPO" diff --quiet HEAD -- scripts/publish src/scripts/secretScan.ts; then
  echo "There are uncommitted changes to the gate (scripts/publish or src/scripts/secretScan.ts): commit or undo them first" >&2; exit 2
fi
git -C "$REPO" show "$HEAD:CHANGELOG.md" 2>/dev/null | grep -qE "^## ${VERSION//./\\.}( |$)" || { echo "CHANGELOG.md has no \"## $VERSION\" entry: write it and commit first" >&2; exit 2; }
git ls-remote --exit-code --tags "$PUBLIC" "refs/tags/v$VERSION" >/dev/null 2>&1
case $? in
  0) echo "v$VERSION is already on the public repo" >&2; exit 2 ;;
  2) ;;
  *) echo "Could not reach the public repo" >&2; exit 2 ;;
esac

WORK="$(mktemp -d)" && [ -n "$WORK" ] || { echo "Could not make a temporary folder" >&2; exit 2; }
trap 'rm -rf "$WORK"' EXIT

# 1. The committed HEAD only, checked by the gate.
git clone -q "$REPO" "$WORK/src" && git -C "$WORK/src" checkout -q "$HEAD" || { echo "Could not clone HEAD" >&2; exit 2; }
echo "Checking $(git -C "$WORK/src" log -1 --format='%h %s')..."
(cd "$WORK/src" && bash "$GATE" "$DENYLIST" "$WORK/tree" ${GATE_ARGS[@]+"${GATE_ARGS[@]}"})
gate=$?
[ "$gate" -eq 0 ] || { echo "The gate did not pass: nothing was published." >&2; exit "$gate"; }

# 2. The public repo's tree becomes exactly the checked tree.
git clone -q --branch main "$PUBLIC" "$WORK/pub" || { echo "Could not clone the public repo's main" >&2; exit 2; }
find "$WORK/pub" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} + || { echo "Could not clear the public copy" >&2; exit 2; }
(cd "$WORK/tree" && tar -cf - .) | (cd "$WORK/pub" && tar -xf -) || { echo "Could not copy the checked tree" >&2; exit 2; }
# --force: .gitignore and the caller's excludes must not drop a checked file.
git -C "$WORK/pub" add -A --force . || { echo "Could not stage the checked tree" >&2; exit 2; }
# The commit must hold exactly the checked tree, file for file.
diff <(cd "$WORK/tree" && find . \( -type f -o -type l \) | sed 's|^\./||' | LC_ALL=C sort) <(git -C "$WORK/pub" ls-files | LC_ALL=C sort) >/dev/null \
  || { echo "The staged files differ from the checked tree: nothing published" >&2; exit 2; }
if git -C "$WORK/pub" diff --cached --quiet; then echo "Nothing changed since the last release: nothing published." >&2; exit 2; fi
export GIT_AUTHOR_NAME="$PUBLISH_NAME" GIT_AUTHOR_EMAIL="$PUBLISH_EMAIL" GIT_COMMITTER_NAME="$PUBLISH_NAME" GIT_COMMITTER_EMAIL="$PUBLISH_EMAIL"
# No signing and no hooks from the caller's config: either could put the owner's identity in the public history.
PUBGIT=(git -C "$WORK/pub" -c commit.gpgsign=false -c tag.gpgsign=false -c core.hooksPath=/dev/null)
"${PUBGIT[@]}" commit -q -m "BrainAI $VERSION" && "${PUBGIT[@]}" tag -a "v$VERSION" -m "BrainAI $VERSION" || { echo "Could not commit" >&2; exit 2; }
git -C "$WORK/pub" --no-pager show --stat --format='%h %s (%an)' HEAD | tail -n 3

# 3. Push the commit and the tag together.
if [ "$DRY" = 1 ]; then echo "Dry run: nothing pushed."; exit 0; fi
"${PUBGIT[@]}" push -q --atomic origin HEAD:main "v$VERSION" || { echo "The push failed: nothing was published." >&2; exit 1; }
echo "Published BrainAI $VERSION ($(git -C "$WORK/pub" rev-parse --short HEAD)) to $PUBLIC"
