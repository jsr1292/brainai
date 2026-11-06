#!/usr/bin/env bash
# Nightly copy of the bare git repos on this server (~/git) to each folder in GIT_COPY_DIRS (overlay/scripts.env).
# Mirrors with rsync --delete, but only into its own git-backups folders, and only when it finds at least one
# repo: a missing or empty ~/git never wipes the copies. One repo gone from ~/git is removed from the copies too, but
# when several are gone at once (~/git lost and re-created, say) that copy is left as it is and the run fails, unless
# ALLOW_MANY_GONE=1 says the removal is meant. A repo that fails git fsck is not copied over its last good copy.
# A copy dir whose drive is not mounted is skipped. With no copy dirs set it copies nothing and says so.
set -uo pipefail

GIT_DIR_ROOT="${GIT_DIR_ROOT:-$HOME/git}"
# The folders the repos are copied to: COPY_DIRS when given, else GIT_COPY_DIRS from the owner's overlay; none unless set.
GIVEN_COPY_DIRS="${COPY_DIRS:-}"
unset COPY_DIRS
# The owner's settings (overlay/scripts.env), read as KEY=value text; the environment wins.
. "$(dirname "${BASH_SOURCE[0]}")/lib/overlay.sh"
brain_overlay
COPY_DIRS="${GIVEN_COPY_DIRS:-${GIT_COPY_DIRS:-}}"
SKIP_MOUNT_CHECK="${SKIP_MOUNT_CHECK:-0}"
ALLOW_MANY_GONE="${ALLOW_MANY_GONE:-0}"
# What happened, for Settings › Backups and health.
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATUS_FILE="${STATUS_FILE:-$APP_DIR/data/git-backup-status.json}"
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
json() { printf '%s' "$1" | tr '\n\r\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
status() { # ok detail
  [ -d "$(dirname "$STATUS_FILE")" ] || return 0
  printf '{"at":"%s","ok":%s,"detail":"%s"}' "$(stamp)" "$1" "$(json "$2")" > "$STATUS_FILE.tmp" && mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}

# No copy folders set: nothing to copy, which is a choice, not a failure (as the nightly backup with no COPY_DIRS).
if [ -z "${COPY_DIRS//[[:space:]]/}" ]; then
  msg="no copy folders set (GIT_COPY_DIRS in overlay/scripts.env): the repos stay in $GIT_DIR_ROOT only"
  echo "$(stamp) backup-git: $msg"
  status true "$msg"
  exit 0
fi

shopt -s nullglob
repos=("$GIT_DIR_ROOT"/*.git)
if [ ! -d "$GIT_DIR_ROOT" ] || [ "${#repos[@]}" -eq 0 ]; then
  echo "$(stamp) backup-git: no repos in $GIT_DIR_ROOT, nothing copied" >&2
  status false "no repos in $GIT_DIR_ROOT, nothing copied"
  exit 1
fi

# A repo that fails git fsck is not copied: its last good copy is kept, and the run says which repo to look at.
bad=()
excludes=()
for r in "${repos[@]}"; do
  name="$(basename "$r")"
  if ! git --git-dir="$r" fsck --no-progress >/dev/null 2>&1; then
    echo "$(stamp) backup-git: $name failed git fsck, its copies were left as they were" >&2
    bad+=("$name")
    excludes+=(--exclude "/$name")
  fi
done
good=$(( ${#repos[@]} - ${#bad[@]} ))
problem="${bad[*]:+; failed git fsck, old copy kept: ${bad[*]}}"

ok=0
total=0
missed=
for dir in $COPY_DIRS; do
  total=$((total + 1))
  parent="$(dirname "$dir")"
  if [ "$SKIP_MOUNT_CHECK" != "1" ] && ! mountpoint -q "$parent" 2>/dev/null; then
    echo "$(stamp) backup-git: $parent is not mounted, skipped $dir" >&2
    missed="${missed:+$missed, }$dir (not mounted)"
    continue
  fi
  # Repos the copy has that ~/git no longer has: more than one at once is not mirrored away.
  gone=()
  for r in "$dir"/*.git; do [ -e "$GIT_DIR_ROOT/$(basename "$r")" ] || gone+=("$(basename "$r")"); done
  if [ "${#gone[@]}" -gt 1 ] && [ "$ALLOW_MANY_GONE" != "1" ]; then
    echo "$(stamp) backup-git: ${#gone[@]} repos in $dir are gone from $GIT_DIR_ROOT (${gone[*]}), $dir left as it was" >&2
    missed="${missed:+$missed, }$dir (${#gone[@]} repos gone from $GIT_DIR_ROOT, kept: ${gone[*]}; ALLOW_MANY_GONE=1 removes them)"
    continue
  fi
  if mkdir -p "$dir" && rsync -a --delete ${excludes[@]+"${excludes[@]}"} "$GIT_DIR_ROOT/" "$dir/"; then
    echo "$(stamp) backup-git: copied $good repos to $dir"
    ok=$((ok + 1))
  else
    echo "$(stamp) backup-git: copying to $dir failed" >&2
    missed="${missed:+$missed, }$dir (failed)"
  fi
done
if [ "$ok" -gt 0 ]; then
  status "$([ "$ok" -eq "$total" ] && [ "${#bad[@]}" -eq 0 ] && echo true || echo false)" "copied $good repos to $ok of $total places${missed:+; missed: $missed}$problem"
  [ "${#bad[@]}" -eq 0 ] || exit 1
else
  status false "every copy failed or was skipped: $missed$problem"
  exit 1
fi
