#!/usr/bin/env bash
# Nightly Markdown export of the brain into git: writes every page and fact as Markdown (cli export-brain, inside the
# app container), mirrors it into ~/brain-export, commits only when something changed (as EXPORT_GIT_NAME and
# EXPORT_GIT_EMAIL from overlay/scripts.env), and pushes to the bare repo ~/git/brain-export.git (which backup-git.sh
# copies to the folders in GIT_COPY_DIRS). Creates the working copy and the bare repo the first time (inside an
# existing ~/git: it never re-creates a missing one). Writes data/export-status.json for Settings › Backups and health.
set -uo pipefail
# The clone this script lives in (scripts/..), wherever it was cloned; APP_DIR overrides.
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# The owner's settings (overlay/scripts.env), read as KEY=value text; the environment wins.
. "$(dirname "${BASH_SOURCE[0]}")/lib/overlay.sh"
brain_overlay
EXPORT_DIR="${EXPORT_DIR:-$HOME/brain-export}"
BARE="${BARE:-$HOME/git/brain-export.git}"
EXPORT_CMD="${EXPORT_CMD:-cd \"$APP_DIR\" && docker compose exec -T app node dist/cli.js export-brain /app/data/export </dev/null}"
STAGE="$APP_DIR/data/export"
STATUS="$APP_DIR/data/export-status.json"

json() { printf '%s' "$1" | tr '\n\r\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
status() { # ok detail
  printf '{"at":"%s","ok":%s%s}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "${2:+,\"detail\":\"$(json "$2")\"}" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
}
fail() { echo "export-brain: $1" >&2; status false "$1"; exit 1; }

# The bare repo is created only on the very first run, inside an existing ~/git. A missing ~/git (lost, or not
# restored yet), or a bare repo that vanished after the working copy was made, is a failure: re-creating either
# would leave ~/git holding only this export, and backup-git.sh would then mirror that over the copies.
if [ ! -d "$BARE" ]; then
  [ -d "$(dirname "$BARE")" ] || fail "$(dirname "$BARE") is missing: restore it before the export pushes to it"
  [ ! -d "$EXPORT_DIR/.git" ] || fail "$BARE is gone but $EXPORT_DIR was pushed to it before: restore it from the git backups"
  git init -q --bare -b main "$BARE" || fail "could not create $BARE"
fi
if [ ! -d "$EXPORT_DIR/.git" ]; then
  { mkdir -p "$EXPORT_DIR" && git -C "$EXPORT_DIR" init -q -b main && git -C "$EXPORT_DIR" remote add origin "$BARE"; } || fail "could not create $EXPORT_DIR"
fi

# One run at a time, and never hung for ever (flock and timeout where the system has them).
if command -v flock >/dev/null 2>&1; then
  exec 9>"$APP_DIR/data/export.lock"
  flock -n 9 || fail "another export is running"
fi
RUN=(bash -c "$EXPORT_CMD")
command -v timeout >/dev/null 2>&1 && RUN=(timeout 600 bash -c "$EXPORT_CMD")
"${RUN[@]}" || fail "the export command failed"
# An export that produced nothing must never be mirrored: that would commit the deletion of every page.
[ -f "$STAGE/README.md" ] || fail "the export left no README.md in $STAGE, nothing was mirrored"
if [ -z "$(find "$STAGE/pages" -name '*.md' -type f 2>/dev/null | head -n 1)" ] && [ -n "$(git -C "$EXPORT_DIR" ls-files pages 2>/dev/null | head -n 1)" ]; then
  fail "the export has no pages but the last one did, so nothing was mirrored (is this the right database?)"
fi
# First remove what the export no longer has: the .md files under pages/ and facts/ (anything else the owner keeps in
# the folder, a note or an image, stays) and every file under skills/, which is the export's alone and holds any text
# file (audit F09). Pruning before the copy lets a skill folder become a file of the same name. Then copy, without
# --delete.
( cd "$EXPORT_DIR" && find pages facts -type f -name '*.md' 2>/dev/null ) | while IFS= read -r f; do
  [ -e "$STAGE/$f" ] || rm -f -- "${EXPORT_DIR:?}/${f:?}"
done
( cd "$EXPORT_DIR" && find skills -type f 2>/dev/null ) | while IFS= read -r f; do
  [ -f "$STAGE/$f" ] || rm -f -- "${EXPORT_DIR:?}/${f:?}"
done
find "$EXPORT_DIR/pages" "$EXPORT_DIR/facts" "$EXPORT_DIR/skills" -mindepth 1 -type d -empty -delete 2>/dev/null
rsync -a --exclude .git "$STAGE/" "$EXPORT_DIR/" || fail "copying the export into $EXPORT_DIR failed"

cd "$EXPORT_DIR" || fail "no $EXPORT_DIR"
git add -A || fail "git add failed"
if [ -n "$(git status --porcelain)" ]; then
  git -c user.name="${EXPORT_GIT_NAME:-brain export}" -c user.email="${EXPORT_GIT_EMAIL:-brain@localhost}" commit -q -m "brain export $(date +%F)" || fail "git commit failed"
fi
git push -q origin HEAD:main || fail "pushing to $BARE failed"
status true "at $(git rev-parse --short HEAD)"
echo "export-brain: $(git rev-parse --short HEAD) pushed to $BARE"
