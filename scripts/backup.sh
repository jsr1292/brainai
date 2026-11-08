#!/usr/bin/env bash
# Nightly backup of the memory database: a consistent snapshot (sqlite3 .backup,
# safe while the app is writing) without the sign-in data, verified, then copied to each copy dir.
# Only ever writes memory-YYYY-MM-DD.db files, and only prunes memory-*.db files. Pictures (data/images) are copied
# next to each copy with rsync --ignore-existing (files never change), checked against their rows, and removed from
# the copies only 30 days after Delete for good; data/images itself is never touched.
set -euo pipefail

# The clone this script lives in (scripts/..), wherever it was cloned; APP_DIR overrides.
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# The owner's settings (overlay/scripts.env), read as KEY=value text; the environment wins.
. "$(dirname "${BASH_SOURCE[0]}")/lib/overlay.sh"
brain_overlay
# The folders each night's copy goes to besides backups/ (other drives): none unless set.
COPY_DIRS="${COPY_DIRS:-}"
KEEP_DAYS="${KEEP_DAYS:-30}"
SKIP_MOUNT_CHECK="${SKIP_MOUNT_CHECK:-0}"

BACKUP_DIR="$APP_DIR/backups"
NAME="memory-$(date +%F).db"
BACKUP="$BACKUP_DIR/$NAME"
# What happened, for the dashboard (src/backupStatus.ts reads it): written at exit, whatever the outcome.
STATUS_FILE="$APP_DIR/data/backup-status.json"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SNAPSHOT_OK=0
COPIES=""
COUNTS=""
PICTURES=""
IMAGES_DIR="$APP_DIR/data/images"

# Text for a JSON string: backslashes and quotes escaped, line breaks and tabs turned into spaces.
json() { printf '%s' "$1" | tr '\n\r\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
record_copy() { # where result [detail]
  local entry="{\"where\":\"$(json "$1")\",\"result\":\"$2\"${3:+,\"detail\":\"$(json "$3")\"}}"
  COPIES="${COPIES:+$COPIES,}$entry"
}
finish() {
  if [ -n "$TMP" ]; then rm -f -- "$TMP" "$TMP-wal" "$TMP-shm" "$TMP-journal"; fi
  # Only this run's own lock goes.
  if [ "$(cat "$LOCK/pid" 2>/dev/null || true)" = "$$" ]; then rm -rf "$LOCK"; fi
  if [ -d "$APP_DIR/data" ]; then
    if [ "$SNAPSHOT_OK" = "1" ]; then
      printf '{"at":"%s","ok":true,"copies":[%s]%s%s}' "$STARTED" "$COPIES" "$COUNTS" "$PICTURES" > "$STATUS_FILE.tmp"
    else
      printf '{"at":"%s","ok":false,"error":"the snapshot could not be made or checked"}' "$STARTED" > "$STATUS_FILE.tmp"
    fi
    mv "$STATUS_FILE.tmp" "$STATUS_FILE"
  fi
}

mkdir -p "$BACKUP_DIR"
# One backup at a time (audit F10): a lock folder made atomically, holding the running backup's pid. take_lock
# returns 0 (taken), 2 (another backup holds it: this run does nothing) or 1 (it could not be taken: a failed backup).
# A lock whose pid is gone is moved aside atomically, so two runs can never both take it over; one with no pid yet is
# being taken right now unless it has been empty for a minute.
LOCK="$BACKUP_DIR/.backup.lock"
take_lock() {
  [ -w "$BACKUP_DIR" ] || return 1
  if mkdir "$LOCK" 2>/dev/null; then echo "$$" > "$LOCK/pid" || return 1; return 0; fi
  [ -d "$LOCK" ] || return 1
  local pid
  pid="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    [ -n "$(find "$LOCK" -maxdepth 0 -mmin -1 2>/dev/null)" ] && return 2
  elif kill -0 "$pid" 2>/dev/null || kill -0 "$pid" 2>&1 | grep -qi 'not permitted'; then
    return 2
  fi
  mv "$LOCK" "$LOCK.stale.$$" 2>/dev/null || return 2
  rm -rf "$LOCK.stale.$$"
  mkdir "$LOCK" 2>/dev/null || return 2
  echo "$$" > "$LOCK/pid" || return 1
}
TMP=""
trap finish EXIT
lock=0
take_lock || lock=$?
if [ "$lock" = 2 ]; then
  echo "backup: another backup is running; this one does nothing" >&2
  trap - EXIT
  exit 0
fi
if [ "$lock" != 0 ]; then
  echo "backup: could not take the backup lock in $BACKUP_DIR (is it writable?)" >&2
  exit 1
fi
# Holding the lock, nothing else is using these: what a killed run left (its snapshot may not be stripped yet).
find "$BACKUP_DIR" -maxdepth 1 \( -name '.memory-*' -o -name '.backup.lock.stale.*' \) -exec rm -rf -- {} + 2>/dev/null || true
# Built under a temporary name of its own (mktemp) and moved into place only once stripped and checked, so a failed
# run never leaves a half-stripped file that looks like a backup.
TMP="$(mktemp "$BACKUP_DIR/.memory-XXXXXX")"
rm -f -- "$TMP" "$TMP-wal" "$TMP-shm" "$TMP-journal"
sqlite3 "$APP_DIR/data/memory.db" ".backup '$TMP'"
# No sign-in data in a backup (scripts/strip-signin.sh).
"$(dirname "$0")/strip-signin.sh" "$TMP"

result="$(sqlite3 "$TMP" 'PRAGMA integrity_check')"
if [ "$result" != "ok" ]; then
  echo "backup: integrity_check failed for $BACKUP: $result" >&2
  exit 1
fi
# What the checked copy holds, so Settings can show that a backup really has the facts and pages.
# A count that fails is left out rather than shown as a real-looking zero.
if FACTS="$(sqlite3 "$TMP" 'SELECT count(*) FROM memories WHERE deleted_at IS NULL' 2>/dev/null)" \
  && PAGES="$(sqlite3 "$TMP" 'SELECT count(*) FROM pages WHERE deleted_at IS NULL' 2>/dev/null)" \
  && [[ "$FACTS" =~ ^[0-9]+$ && "$PAGES" =~ ^[0-9]+$ ]]; then
  HAS_IMAGES="$(sqlite3 "$TMP" "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'images'" 2>/dev/null || true)"
  if [ "$HAS_IMAGES" = "1" ] && IMAGES="$(sqlite3 "$TMP" 'SELECT count(*) FROM images WHERE removed_at IS NULL' 2>/dev/null)" && [[ "$IMAGES" =~ ^[0-9]+$ ]]; then
    COUNTS=",\"counts\":{\"facts\":$FACTS,\"pages\":$PAGES,\"images\":$IMAGES}"
  else
    COUNTS=",\"counts\":{\"facts\":$FACTS,\"pages\":$PAGES}"
  fi
fi
mv "$TMP" "$BACKUP"
SNAPSHOT_OK=1
echo "backup: wrote $BACKUP (integrity ok)"

# Picture files as <2 hex>/<id>.<ext>, from the checked copy's rows: $1 is a WHERE clause.
picture_files() {
  sqlite3 "$BACKUP" "SELECT substr(id, 1, 2) || '/' || id || '.' || CASE type WHEN 'jpeg' THEN 'jpg' ELSE type END FROM images WHERE $1" 2>/dev/null
}
HAS_IMAGES="$(sqlite3 "$BACKUP" "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'images'" 2>/dev/null || true)"
if [ "$HAS_IMAGES" = "1" ]; then
  # Missing: a live row whose file isn't there. Stray: a file no row names (images/tmp is the store's own).
  MISSING=0
  while IFS= read -r f; do
    [ -n "$f" ] && [ ! -f "$IMAGES_DIR/$f" ] && MISSING=$((MISSING + 1))
  done < <(picture_files 'removed_at IS NULL')
  STRAY=0
  if [ -d "$IMAGES_DIR" ]; then
    KNOWN="$(picture_files '1')"
    while IFS= read -r f; do
      [ -n "$f" ] && ! grep -qxF "$f" <<<"$KNOWN" && STRAY=$((STRAY + 1))
    done < <(cd "$IMAGES_DIR" && find . -mindepth 2 -maxdepth 2 -type f ! -path './tmp/*' | sed 's|^\./||')
  fi
  PICTURES=",\"pictures\":{\"missing\":$MISSING,\"stray\":$STRAY}"
fi

# Copies the picture files a copy dir doesn't have yet, then removes from it the ones deleted for good more than
# KEEP_DAYS ago. Nothing to copy (no pictures yet) makes no folder.
copy_pictures() {
  local dir="$1"
  [ "$HAS_IMAGES" = "1" ] || return 0
  if [ -d "$IMAGES_DIR" ] && [ -n "$(cd "$IMAGES_DIR" && find . -mindepth 2 -maxdepth 2 -type f ! -path './tmp/*' | head -1)" ]; then
    mkdir -p "$dir/images" && rsync -a --ignore-existing --exclude 'tmp/' "$IMAGES_DIR/" "$dir/images/" || return 1
  fi
  [ -d "$dir/images" ] || return 0
  while IFS= read -r f; do
    [ -n "$f" ] && rm -f "$dir/images/$f"
  done < <(picture_files "removed_at IS NOT NULL AND removed_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-$KEEP_DAYS days')")
  return 0
}

prune() {
  find "$1" -maxdepth 1 -type f -name 'memory-*.db' -mtime "+$KEEP_DAYS" -delete
}

prune "$BACKUP_DIR"

# Each copy dir is independent: a failed copy is reported, the other dirs still get theirs, and only dirs
# whose copy succeeded are pruned. The script exits non-zero at the end if any copy failed.
status=0
for dir in $COPY_DIRS; do
  if [ "$SKIP_MOUNT_CHECK" != "1" ] && ! mountpoint -q "$(dirname "$dir")"; then
    echo "backup: $(dirname "$dir") is not mounted, skipping $dir" >&2
    record_copy "$dir" skipped "not mounted"
    continue
  fi
  { mkdir -p "$dir" && cp "$BACKUP" "$dir/$NAME"; } || {
    echo "backup: could not copy to $dir" >&2
    record_copy "$dir" failed "could not copy"
    status=1
    continue
  }
  prune "$dir" || { echo "backup: could not prune $dir" >&2; status=1; }
  copy_pictures "$dir" || {
    echo "backup: could not copy the pictures to $dir" >&2
    record_copy "$dir" failed "pictures could not be copied"
    status=1
    continue
  }
  record_copy "$dir" copied
  echo "backup: copied to $dir/$NAME"
done
exit "$status"
