#!/usr/bin/env bash
# Weekly off-site copy, so the memory survives losing the house: the newest nightly backup (which holds no
# password, authenticator secret, sessions or tokens), a readable Markdown export of the facts and the nightly page
# and fact export tree (~/brain-export, from export-brain.sh, without its .git), packed into one file,
# encrypted to the owner's age public key and uploaded with rclone. The private key is kept only outside the
# house (the owner's password manager); this server can encrypt but never decrypt. Copies older than
# OFFSITE_KEEP_DAYS are deleted from the remote. The outcome goes to data/offsite-status.json for the dashboard.
# Restoring: docs/RUNBOOK.md.
set -euo pipefail

# The clone this script lives in (scripts/..), wherever it was cloned; APP_DIR overrides.
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# The owner's settings (overlay/scripts.env), read as KEY=value text; the environment wins.
. "$(dirname "${BASH_SOURCE[0]}")/lib/overlay.sh"
brain_overlay
REMOTE="${OFFSITE_REMOTE:-gdrive:memory-backups}"
RECIPIENT_FILE="${OFFSITE_RECIPIENT_FILE:-$APP_DIR/offsite-recipient.txt}"
KEEP_DAYS="${OFFSITE_KEEP_DAYS:-90}"
BRAIN_EXPORT_DIR="${BRAIN_EXPORT_DIR:-$HOME/brain-export}"
EXPORT_CMD="${EXPORT_CMD:-docker compose -f \"$APP_DIR/docker-compose.yml\" exec -T app node dist/cli.js export}"

STATUS_FILE="$APP_DIR/data/offsite-status.json"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NAME="memory-$(date +%F).tar.gz.age"
WORK="$(mktemp -d)"
STEP="starting"
DONE=0
# Set when the copy was uploaded but is missing something: the status then says so (ok false) instead of ok.
WARN=

# Text for a JSON string: backslashes and quotes escaped, line breaks and tabs turned into spaces.
json() { printf '%s' "$1" | tr '\n\r\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
finish() {
  rm -rf "$WORK"
  [ "$DONE" = "1" ] || echo "offsite: failed while $STEP" >&2
  [ -d "$APP_DIR/data" ] || return 0
  if [ "$DONE" = "1" ] && [ -n "$WARN" ]; then
    printf '{"at":"%s","ok":false,"where":"%s","file":"%s","error":"%s"}' "$STARTED" "$(json "$REMOTE")" "$(json "$NAME")" "$(json "$WARN")" > "$STATUS_FILE.tmp"
  elif [ "$DONE" = "1" ]; then
    printf '{"at":"%s","ok":true,"where":"%s","file":"%s"}' "$STARTED" "$(json "$REMOTE")" "$(json "$NAME")" > "$STATUS_FILE.tmp"
  else
    printf '{"at":"%s","ok":false,"where":"%s","error":"failed while %s"}' "$STARTED" "$(json "$REMOTE")" "$(json "$STEP")" > "$STATUS_FILE.tmp"
  fi
  mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}
trap finish EXIT

STEP="looking for the key (no key to encrypt to: $RECIPIENT_FILE)"
[ -s "$RECIPIENT_FILE" ]

STEP="finding the newest nightly backup"
# Only the dated nightly files, which hold no sign-in data: never a full copy such as memory-pre-migration11.db.
NEWEST="$(ls -1 "$APP_DIR"/backups/memory-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].db | sort | tail -n 1)"
cp "$NEWEST" "$WORK/"

STEP="removing sign-in data from the copy"
# Nightly backups are already stripped; this makes sure of it for what leaves the house (older files were not).
"$(dirname "$0")/strip-signin.sh" "$WORK/$(basename "$NEWEST")"

STEP="exporting the memories as Markdown"
bash -c "$EXPORT_CMD" > "$WORK/memory.md"

STEP="copying the page export from $BRAIN_EXPORT_DIR"
# The pages live only in the nightly export tree. Without it the copy still goes (the database holds them), but the
# status says the readable pages are missing.
PACK=("$(basename "$NEWEST")" memory.md)
if [ -f "$BRAIN_EXPORT_DIR/README.md" ]; then
  # An extra: a failed copy (a file vanishing while the export runs) must never stop the database from leaving.
  if rsync -a --exclude /.git "$BRAIN_EXPORT_DIR/" "$WORK/brain-export/"; then
    PACK+=(brain-export)
  else
    WARN="uploaded without the pages: copying $BRAIN_EXPORT_DIR failed"
    echo "offsite: $WARN" >&2
  fi
else
  WARN="uploaded without the pages: no Markdown export at $BRAIN_EXPORT_DIR (scripts/export-brain.sh)"
  echo "offsite: $WARN" >&2
fi

STEP="packing"
tar -czf "$WORK/pack.tar.gz" -C "$WORK" "${PACK[@]}"

STEP="encrypting"
age -R "$RECIPIENT_FILE" -o "$WORK/$NAME" "$WORK/pack.tar.gz"

STEP="uploading to $REMOTE"
rclone copy "$WORK/$NAME" "$REMOTE"

STEP="removing copies older than $KEEP_DAYS days from $REMOTE"
# Deleted for good, not moved to the Drive trash, so old copies free their space.
rclone delete "$REMOTE" --min-age "${KEEP_DAYS}d" --include 'memory-*.tar.gz.age' --drive-use-trash=false

# Pictures (round 2 section 12) go one encrypted file each, outside the weekly pack: files never change, so each is
# sent once, and those deleted for good more than KEEP_DAYS ago are removed there. Names are content hashes. A
# picture step that fails leaves the pack uploaded; the status then says so.
IMAGES_DIR="$APP_DIR/data/images"
SNAP="$WORK/$(basename "$NEWEST")"
if [ -d "$IMAGES_DIR" ] && [ -n "$(sqlite3 "$SNAP" "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'images'" 2>/dev/null)" ]; then
  STEP="listing the pictures already at $REMOTE/images"
  THERE="$(rclone lsf "$REMOTE/images" 2>/dev/null || true)"
  STEP="sending the pictures"
  SEND_FAIL=0
  # Only live pictures (rows not deleted for good), never a stray file nor the store's tmp folder.
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    name="$(basename "$f")"
    grep -qxF "$name.age" <<<"$THERE" && continue
    # A live row whose file is missing here is the nightly check's to report; there is nothing to send.
    [ -f "$IMAGES_DIR/$f" ] || continue
    if ! { age -R "$RECIPIENT_FILE" -o "$WORK/$name.age" "$IMAGES_DIR/$f" && rclone copyto "$WORK/$name.age" "$REMOTE/images/$name.age"; }; then SEND_FAIL=1; fi
    rm -f "$WORK/$name.age"
  done < <(sqlite3 "$SNAP" "SELECT substr(id, 1, 2) || '/' || id || '.' || CASE type WHEN 'jpeg' THEN 'jpg' ELSE type END FROM images WHERE removed_at IS NULL" 2>/dev/null)
  STEP="removing pictures deleted for good more than $KEEP_DAYS days ago from $REMOTE/images"
  GONE_FAIL=0
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    grep -qxF "$name.age" <<<"$THERE" || continue
    rclone deletefile "$REMOTE/images/$name.age" --drive-use-trash=false || GONE_FAIL=1
  done < <(sqlite3 "$SNAP" "SELECT id || '.' || CASE type WHEN 'jpeg' THEN 'jpg' ELSE type END FROM images WHERE removed_at IS NOT NULL AND removed_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-$KEEP_DAYS days')" 2>/dev/null)
  if [ "$SEND_FAIL" = 1 ]; then WARN="${WARN:+$WARN; }uploaded, but the pictures could not all be sent"; fi
  if [ "$GONE_FAIL" = 1 ]; then WARN="${WARN:+$WARN; }uploaded, but old pictures could not all be removed"; fi
fi

DONE=1
echo "offsite: uploaded $NAME to $REMOTE"
