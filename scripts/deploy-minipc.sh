#!/usr/bin/env bash
# Deploys main to the mini PC, run on the Mac:
#   scripts/deploy-minipc.sh [--dry-run] [--force-untested]
# Refuses when the working tree is dirty, when you are not on main, or when HEAD is not recorded green (run
# scripts/test-and-record.sh; --force-untested skips that check). Then: git push minipc main; on the server a copy
# of the database (data/memory-pre-<version>-<date>-<time>-<sha>.db, mode 600, never overwritten), git pull --ff-only and docker compose up -d --build;
# then it waits up to 2 minutes and checks the running version, schema version, that the app is Up, that the last
# 2 minutes of logs hold no error or fatal line, and that POST /mcp without a token answers 401. If a check fails it
# prints the rollback steps. --dry-run prints every command (local and remote) and runs none.
# The target is read from git config (git config brainai.deploy.ssh <user>@<server>; git config brainai.deploy.url
# https://<your-domain>) or the environment (DEPLOY_SSH, DEPLOY_URL). Also: DEPLOY_REMOTE_DIR (default memory),
# DEPLOY_WAIT (seconds, 120), DEPLOY_POLL (seconds between polls, 5).
set -uo pipefail

SSH_HOST="${DEPLOY_SSH:-}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-memory}"
URL="${DEPLOY_URL:-}"
WAIT="${DEPLOY_WAIT:-120}"
POLL="${DEPLOY_POLL:-5}"
DRY=0
FORCE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1;;
    --force-untested) FORCE=1;;
    -h|--help) sed -n 2,12p "$0"; exit 0;;
    *) echo "deploy: unknown option $a" >&2; exit 2;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
. scripts/lib/green.sh

[ -n "$SSH_HOST" ] || SSH_HOST="$(git config brainai.deploy.ssh || true)"
[ -n "$URL" ] || URL="$(git config brainai.deploy.url || true)"
if [ -z "$SSH_HOST" ]; then echo "deploy: no server set. Run once: git config brainai.deploy.ssh <user>@<server>  (or set DEPLOY_SSH)" >&2; exit 2; fi
if [ -z "$URL" ]; then echo "deploy: no public address set. Run once: git config brainai.deploy.url https://<your-domain>  (or set DEPLOY_URL)" >&2; exit 2; fi

VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -n 1)"
SHA="$(git rev-parse HEAD)"
STAMP="$(date +%Y%m%d-%H%M%S)"
PRE="data/memory-pre-$VERSION-$STAMP-$(printf '%.7s' "$SHA").db"

# Each refusal; in a dry run they are only listed, so the plan can still be read.
refuse() {
  if [ "$DRY" = 1 ]; then echo "[dry-run] would refuse: $1"; else echo "deploy: $1" >&2; exit 1; fi
}
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || refuse "you are not on main (git push minipc main would push a different commit than HEAD)"
if tree_dirty; then refuse "the working tree has uncommitted changes"; fi
if [ "$FORCE" = 1 ]; then
  echo "deploy: WARNING --force-untested: deploying $SHA without recorded passing tests" >&2
elif ! is_green "$SHA"; then
  refuse "$SHA is not recorded green; run scripts/test-and-record.sh (or use --force-untested)"
fi

# Runs a command on the server, from the clone's folder.
remote() {
  if [ "$DRY" = 1 ]; then echo "[dry-run] ssh $SSH_HOST: cd $REMOTE_DIR && $1"; return 0; fi
  ssh -n "$SSH_HOST" "cd '$REMOTE_DIR' && $1"
}
local_cmd() {
  if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; return 0; fi
  "$@"
}

PREV="<previous sha>"
if [ "$DRY" = 1 ]; then
  remote "git rev-parse HEAD"
else
  PREV="$(remote "git rev-parse HEAD")" || { echo "deploy: cannot reach $SSH_HOST over ssh" >&2; exit 1; }
fi
echo "deploy: version $VERSION ($SHA), server is now at $PREV"

SCHEMA_CMD="sqlite3 -readonly data/memory.db 'SELECT version FROM schema_version'"
# A server left on a detached HEAD (an old rollback) would not take git pull --ff-only: stop before changing anything.
if [ "$DRY" = 1 ]; then
  remote "git symbolic-ref -q HEAD   # must be a branch, not a detached HEAD"
else
  remote "git symbolic-ref -q HEAD" >/dev/null || { echo "deploy: the server's clone is on a detached HEAD (a rollback?). On the server run 'git checkout main' first; nothing was changed." >&2; exit 1; }
fi
if [ "$DRY" = 1 ]; then remote "$SCHEMA_CMD   # schema before"; SCHEMA_BEFORE="?"; else SCHEMA_BEFORE="$(remote "$SCHEMA_CMD" 2>/dev/null | tr -d '\r\n ')"; echo "deploy: schema_version before: ${SCHEMA_BEFORE:-unknown}"; fi

rollback() {
  local after note
  after="$(remote "$SCHEMA_CMD" 2>/dev/null | tr -d '\r\n ')"
  if [ -z "$after" ] || [ -z "$SCHEMA_BEFORE" ]; then note="The schema version could not be compared (before: ${SCHEMA_BEFORE:-unknown}, now: ${after:-unknown}): treat the database as changed and do step 2."
  elif [ "$after" != "$SCHEMA_BEFORE" ]; then note="The schema CHANGED ($SCHEMA_BEFORE -> $after): do step 2, the old code cannot use the new schema."
  else note="The schema did not change ($SCHEMA_BEFORE): skip step 2, the database needs no restore."; fi
  cat >&2 <<R

deploy: a check failed. To go back (run on the Mac):
  ssh $SSH_HOST
  cd $REMOTE_DIR
$note
1. docker compose stop app
2. Only if the schema changed: keep the broken database aside and put the pre-deploy copy back
     mv data/memory.db data/memory.db.broken-$STAMP
     mv data/memory.db-wal data/memory.db.broken-$STAMP-wal 2>/dev/null; mv data/memory.db-shm data/memory.db.broken-$STAMP-shm 2>/dev/null
     cp $PRE data/memory.db
     sqlite3 data/memory.db 'PRAGMA integrity_check'    # must print ok
     chown <PUID>:<PGID> data/memory.db                  # the values in .env
3. git checkout main && git reset --hard $PREV
4. docker compose up -d --build
Everything saved since the copy was made is lost on a restore; the app also keeps its own copy in data/pre-migrate/.
R
}

if [ "$FORCE" = 1 ]; then
  # The pre-push hook would run the tests again; the owner already said not to.
  if [ "$DRY" = 1 ]; then echo "[dry-run] BRAINAI_SKIP_TESTS=1 git push minipc main"; else BRAINAI_SKIP_TESTS=1 git push minipc main; fi
else
  local_cmd git push minipc main
fi ||  { echo "deploy: the push failed (the pre-push hook or the remote); nothing changed on the server" >&2; exit 1; }
remote "test ! -e '$PRE' && (umask 077 && sqlite3 data/memory.db \".backup '$PRE'\") && chmod 600 '$PRE'" || { echo "deploy: could not copy the database; the server was not touched further" >&2; exit 1; }
remote "git pull --ff-only" || { echo "deploy: git pull --ff-only failed on the server; the code there is unchanged" >&2; exit 1; }
if [ "$DRY" = 1 ]; then remote "git rev-parse HEAD   # must equal $SHA"; else
  GOT="$(remote "git rev-parse HEAD" 2>/dev/null | tr -d '\r\n ')"
  if [ "$GOT" != "$SHA" ]; then
    echo "deploy: after the pull the server is at '${GOT:-unknown}', not the pushed $SHA; not building it. Put the code back with, on the server in $REMOTE_DIR: git checkout main && git reset --hard $PREV" >&2
    exit 1
  fi
fi
remote "docker compose up -d --build" || { echo "deploy: docker compose up failed" >&2; rollback; exit 1; }

VERSION_CMD="docker compose exec -T app node -p \"require('./package.json').version\""
PS_CMD="docker compose ps app"
# Exit 0: matching lines printed. 1: none. 3: the logs could not be read.
LOGS_CMD="L=\"\$(docker compose logs --since 2m app 2>&1)\" || exit 3; printf '%s\\n' \"\$L\" | grep -Ei 'error|fatal'"
CURL_CMD="curl -s -o /dev/null -m 10 -w '%{http_code}' -X POST $URL/mcp"

if [ "$DRY" = 1 ]; then
  echo "[dry-run] then poll up to ${WAIT}s for these:"
  remote "$VERSION_CMD   # must equal $VERSION"
  remote "$SCHEMA_CMD   # printed"
  remote "$PS_CMD   # app must be Up"
  remote "$LOGS_CMD   # must print nothing; any line is shown"
  echo "[dry-run] $CURL_CMD   # must print 401"
  exit 0
fi

# One pass over the checks that need the new app to be up; sets WHY to the first one that fails.
WHY=""
settled() {
  local v ps code
  v="$(remote "$VERSION_CMD" 2>/dev/null | tr -d '\r\n ')"
  [ "$v" = "$VERSION" ] || { WHY="the app reports version '${v:-none}', expected $VERSION"; return 1; }
  ps="$(remote "$PS_CMD" 2>/dev/null)"
  printf '%s\n' "$ps" | grep -Eq '(^| )(Up|running)( |$)' || { WHY="docker compose ps does not show the app as Up"; return 1; }
  code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' -X POST "$URL/mcp" 2>/dev/null)"
  [ "$code" = "401" ] || { WHY="POST $URL/mcp answered '${code:-nothing}', expected 401"; return 1; }
  return 0
}

echo "deploy: waiting up to ${WAIT}s for the new version ..."
waited=0
until settled; do
  if [ "$waited" -ge "$WAIT" ]; then echo "deploy: FAILED: $WHY" >&2; rollback; exit 1; fi
  sleep "$POLL"
  waited=$((waited + POLL))
done
echo "deploy: running version $VERSION, app is Up, /mcp answers 401"

SCHEMA="$(remote "$SCHEMA_CMD" 2>/dev/null | tr -d '\r\n ')"
echo "deploy: schema_version $SCHEMA"
ERRS="$(remote "$LOGS_CMD" 2>/dev/null)"; LOGS_RC=$?
if [ "$LOGS_RC" = 0 ] && [ -n "$ERRS" ]; then
  echo "deploy: FAILED: error or fatal lines in the last 2 minutes of logs:" >&2
  printf '%s\n' "$ERRS" >&2
  rollback
  exit 1
fi
if [ "$LOGS_RC" != 1 ]; then
  echo "deploy: WARNING the logs could not be read (exit $LOGS_RC), so errors were not checked; look with: docker compose logs --since 5m app" >&2
  echo "deploy: DONE $VERSION ($SHA), but the log check did not run. The copy taken before: $REMOTE_DIR/$PRE"
  exit 0
fi
echo "deploy: no error lines in the last 2 minutes of logs"
echo "deploy: DONE $VERSION ($SHA). The copy taken before: $REMOTE_DIR/$PRE"
