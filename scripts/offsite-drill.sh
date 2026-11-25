#!/usr/bin/env bash
# Off-site restore drill, run by the owner on the Mac. Proves the newest weekly copy in Google Drive can really be
# opened with the private key: it finds the newest copy (over ssh, with rclone on the mini PC), streams it here
# (it is encrypted, so that is safe), decrypts it with your age key, unpacks it in a temporary folder, checks the
# database (integrity_check, facts and pages) and the Markdown export, compares the counts with the live server
# (a read-only query), says how old the copy is, wipes the temporary folder on every exit and prints PASS or FAIL.
#
#   scripts/offsite-drill.sh [--record] <age-identity-file>
#   pbpaste | scripts/offsite-drill.sh [--record] -        # key text from the clipboard: never written to disk
#
# Writes nothing to the server, except with --record (PASS or FAIL): data/offsite-drill.json, which the dashboard's
# backups panel shows. The key is never written to disk or printed. Needs age (brew install age) and sqlite3.
# The server is read from git config (git config brainai.deploy.ssh <user>@<server>, the same line the deploy uses) or
# DRILL_SSH / DEPLOY_SSH. Settings (environment): DRILL_REMOTE_DIR (the clone on the server,
# default memory), DRILL_RCLONE_REMOTE (default gdrive:memory-backups), DRILL_MAX_DAYS (default 8).
set -uo pipefail

SSH_HOST="${DRILL_SSH:-${DEPLOY_SSH:-$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." config brainai.deploy.ssh 2>/dev/null || true)}}"
REMOTE_DIR="${DRILL_REMOTE_DIR:-memory}"
RCLONE_REMOTE="${DRILL_RCLONE_REMOTE:-gdrive:memory-backups}"
MAX_DAYS="${DRILL_MAX_DAYS:-8}"
RECORD=0
IDENTITY=""

if [ -z "$SSH_HOST" ]; then echo "offsite-drill: no server set. Run once: git config brainai.deploy.ssh <user>@<server>  (or set DRILL_SSH)" >&2; exit 2; fi
usage() { echo "usage: scripts/offsite-drill.sh [--record] <age-identity-file | ->" >&2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --record) RECORD=1; shift;;
    -h|--help) usage; exit 0;;
    -) IDENTITY="-"; shift;;
    -*) echo "offsite-drill: unknown option $1" >&2; usage; exit 2;;
    *) [ -z "$IDENTITY" ] || { usage; exit 2; }; IDENTITY="$1"; shift;;
  esac
done
[ -n "$IDENTITY" ] || { usage; exit 2; }

if ! command -v age >/dev/null 2>&1; then
  echo "offsite-drill: age is not installed on this Mac. Install it with: brew install age" >&2
  exit 2
fi
if ! command -v sqlite3 >/dev/null 2>&1; then echo "offsite-drill: sqlite3 is not installed" >&2; exit 2; fi

KEY=""
if [ "$IDENTITY" = "-" ]; then
  if [ -t 0 ]; then
    echo "offsite-drill: '-' reads the key from a pipe (pbpaste | scripts/offsite-drill.sh -); on a terminal it would show the key as you type" >&2
    exit 2
  fi
  KEY="$(cat)"
  [ -n "$KEY" ] || { echo "offsite-drill: nothing came in on stdin (is the clipboard empty?)" >&2; exit 2; }
else
  [ -f "$IDENTITY" ] && [ -r "$IDENTITY" ] || { echo "offsite-drill: cannot read the key file $IDENTITY" >&2; exit 2; }
fi

WORK="$(mktemp -d)" || { echo "offsite-drill: cannot make a temporary folder" >&2; exit 2; }
cleanup() { rm -rf "$WORK"; KEY=""; }
trap cleanup EXIT
trap 'echo "offsite-drill: interrupted" >&2; exit 130' INT TERM HUP

FAILS=0
WARNS=0
LINES=""
NAME="(none)"
note() { LINES="$LINES$1"$'\n'; }
ok() { note "  ok    $1"; }
warn() { note "  warn  $1"; WARNS=$((WARNS + 1)); }
bad() { note "  FAIL  $1"; FAILS=$((FAILS + 1)); }
summary() {
  echo
  echo "Off-site restore drill"
  printf '%s' "$LINES"
  echo
  if [ "$FAILS" -gt 0 ]; then
    echo "FAIL: $FAILS check(s) failed. Do not rely on the off-site copy until this is fixed."
  elif [ "$WARNS" -gt 0 ]; then
    echo "PASS (with $WARNS warning(s)): the copy $NAME opens with your key and holds your memories."
  else
    echo "PASS: the copy $NAME opens with your key and holds your memories."
  fi
}
# --record: the result goes to the server (data/offsite-drill.json), PASS or FAIL, once the copy is known.
record_result() {
  [ "$RECORD" = 1 ] && [ "$NAME" != "(none)" ] || return 0
  local result=pass
  [ "$FAILS" -gt 0 ] && result=fail
  if printf '{"date":"%s","copy":"%s","result":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$NAME" "$result" \
    | ssh "$SSH_HOST" "cd '$REMOTE_DIR' && cat > data/offsite-drill.json.tmp && mv data/offsite-drill.json.tmp data/offsite-drill.json"; then
    ok "recorded the $result on the server (data/offsite-drill.json)"
  else
    warn "could not record the result on the server"
  fi
}
finish_fail() { bad "$1"; record_result; summary; exit 1; }

# Commands for the server run with ssh -n, so they never swallow this script's stdin.
remote() { ssh -n "$SSH_HOST" "$@"; }

echo "Looking for the newest copy in $RCLONE_REMOTE ..."
LISTING="$(remote "rclone lsf '$RCLONE_REMOTE' --files-only")" || finish_fail "could not list $RCLONE_REMOTE over ssh to $SSH_HOST"
FOUND="$(printf '%s\n' "$LISTING" | grep -E '^memory-[0-9]{4}-[0-9]{2}-[0-9]{2}\.tar\.gz\.age$' | sort | tail -n 1)"
[ -n "$FOUND" ] || finish_fail "no memory-YYYY-MM-DD.tar.gz.age copy in $RCLONE_REMOTE"
NAME="$FOUND"
ok "newest copy is $NAME"

COPY_DATE="${NAME#memory-}"; COPY_DATE="${COPY_DATE%.tar.gz.age}"
if [[ "$COPY_DATE" > "$(date -u +%F)" ]]; then
  bad "the copy is dated $COPY_DATE, which is in the future"
elif COPY_EPOCH="$(date -j -u -f '%Y-%m-%d' "$COPY_DATE" +%s 2>/dev/null || date -u -d "$COPY_DATE" +%s 2>/dev/null)"; then
  DAYS=$(( ($(date -u +%s) - COPY_EPOCH) / 86400 ))
  if [ "$DAYS" -gt "$MAX_DAYS" ]; then bad "the copy is $DAYS days old (weekly copies should be at most $MAX_DAYS)"; else ok "the copy is $DAYS day(s) old"; fi
else
  warn "could not work out how old the copy is"
fi

echo "Downloading $NAME (encrypted) ..."
remote "rclone cat '$RCLONE_REMOTE/$NAME'" > "$WORK/$NAME" || finish_fail "could not download $NAME"
[ -s "$WORK/$NAME" ] || finish_fail "the downloaded file is empty"
ok "downloaded $(wc -c < "$WORK/$NAME" | tr -d ' ') bytes"

echo "Decrypting ..."
if [ "$IDENTITY" = "-" ]; then
  printf '%s\n' "$KEY" | age -d -i - -o "$WORK/pack.tar.gz" "$WORK/$NAME" 2>"$WORK/age.err"
else
  age -d -i "$IDENTITY" -o "$WORK/pack.tar.gz" "$WORK/$NAME" 2>"$WORK/age.err"
fi || finish_fail "age could not decrypt the copy (wrong key?): $(head -c 300 "$WORK/age.err" | tr '\n' ' ')"
KEY=""
ok "decrypted with your key"

mkdir "$WORK/unpacked"
# Only plain files and folders, with no absolute or .. paths (no symlinks, hard links or devices).
tar -tzf "$WORK/pack.tar.gz" > "$WORK/names.txt" 2>/dev/null || finish_fail "the pack is not a readable tar file"
tar -tvzf "$WORK/pack.tar.gz" > "$WORK/verbose.txt" 2>/dev/null || finish_fail "the pack is not a readable tar file"
if grep -E '(^/|(^|/)\.\.(/|$))' "$WORK/names.txt" >/dev/null; then finish_fail "the pack holds unsafe paths; not unpacking"; fi
if grep -v -E '^[-d]' "$WORK/verbose.txt" >/dev/null; then finish_fail "the pack holds links or special files; not unpacking"; fi
tar -xzf "$WORK/pack.tar.gz" -C "$WORK/unpacked" 2>"$WORK/tar.err" || finish_fail "could not unpack the copy: $(head -c 300 "$WORK/tar.err" | tr '\n' ' ')"

if [ -n "$(find "$WORK/unpacked" -type l)" ] || [ -n "$(find "$WORK/unpacked" -type f -links +1)" ]; then finish_fail "the unpacked copy holds links; refusing to use it"; fi

DB="$(ls -1 "$WORK"/unpacked/memory-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].db 2>/dev/null | sort | tail -n 1)"
[ -n "$DB" ] || finish_fail "no memory-YYYY-MM-DD.db inside the copy"
INTEGRITY="$(sqlite3 "$DB" 'PRAGMA integrity_check' 2>&1)"
if [ "$INTEGRITY" = "ok" ]; then ok "database integrity_check: ok"; else finish_fail "database integrity_check said: $(printf '%s' "$INTEGRITY" | head -c 300 | tr '\n' ' ')"; fi

COUNT_FACTS='SELECT count(*) FROM memories WHERE deleted_at IS NULL'
COUNT_PAGES='SELECT count(*) FROM pages WHERE deleted_at IS NULL'
FACTS="$(sqlite3 "$DB" "$COUNT_FACTS" 2>/dev/null)"; PAGES="$(sqlite3 "$DB" "$COUNT_PAGES" 2>/dev/null)"
case "$FACTS$PAGES" in *[!0-9]*|"") finish_fail "could not count facts and pages in the copy";; esac
ok "copy holds $FACTS facts and $PAGES pages"

if [ -s "$WORK/unpacked/memory.md" ]; then ok "memory.md (Markdown export of the facts) is there"; else bad "memory.md is missing or empty"; fi
if [ -f "$WORK/unpacked/brain-export/README.md" ]; then ok "brain-export/ (pages and facts as Markdown) is there"; else warn "brain-export/ is missing from the copy (the pages are still in the database)"; fi

echo "Comparing with the live server (read-only) ..."
LIVE="$(remote "cd '$REMOTE_DIR' && sqlite3 -readonly data/memory.db \"$COUNT_FACTS; $COUNT_PAGES;\"")" || LIVE=""
LIVE_FACTS="$(printf '%s\n' "$LIVE" | sed -n 1p)"; LIVE_PAGES="$(printf '%s\n' "$LIVE" | sed -n 2p)"
if [[ "$LIVE_FACTS" =~ ^[0-9]+$ && "$LIVE_PAGES" =~ ^[0-9]+$ ]]; then
  ok "live server holds $LIVE_FACTS facts and $LIVE_PAGES pages (copy: $FACTS and $PAGES)"
  if { [ "$FACTS" -eq 0 ] && [ "$LIVE_FACTS" -gt 0 ]; } || { [ "$PAGES" -eq 0 ] && [ "$LIVE_PAGES" -gt 0 ]; }; then
    bad "the copy has no facts or no pages, but the live server has some"
  elif [ "$FACTS" -gt "$LIVE_FACTS" ] || [ "$PAGES" -gt "$LIVE_PAGES" ]; then
    warn "the copy holds more than the live server (something was deleted since; check it was meant)"
  fi
  if [ "$LIVE_FACTS" -gt 0 ] && [ $((FACTS * 100)) -lt $((LIVE_FACTS * 90)) ]; then warn "the copy holds less than 90% of the live facts ($FACTS of $LIVE_FACTS)"; fi
  if [ "$LIVE_PAGES" -gt 0 ] && [ $((PAGES * 100)) -lt $((LIVE_PAGES * 90)) ]; then warn "the copy holds less than 90% of the live pages ($PAGES of $LIVE_PAGES)"; fi
else
  warn "could not read the live counts over ssh, so the counts were not compared"
fi

record_result
summary
[ "$FAILS" -eq 0 ]
