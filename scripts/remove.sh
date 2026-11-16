#!/usr/bin/env bash
# Removes a BrainAI install from a server, after keeping one saved copy of the brain. Order: save a copy (a failed
# save stops everything), show what will go and ask for the word "remove", remove it, then ask about each outside copy
# one at a time (default keep), then print the checklist of what only the owner can remove. It only ever touches
# what BrainAI wrote: its own crontab lines, containers, its git folder and the files it exported. Answers come
# from stdin (prompts print even when it is not a terminal). It deletes its own folder, so it first runs again from a
# copy in a temp folder. Settings as the other scripts: overlay/scripts.env (COPY_DIRS, GIT_COPY_DIRS, OFFSITE_REMOTE).
set -uo pipefail

if [ -z "${REMOVE_STAGE2:-}" ]; then
  # rm -rf follows the clone's path, so an inherited APP_DIR must be the clone this script lives in, and the path used
  # from here on is the physical one (a symlink would otherwise be removed instead of the clone).
  SELF_LOGICAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
  if [ -n "${APP_DIR:-}" ] && ! [ "$APP_DIR" -ef "$SELF_DIR" ]; then
    echo "Refusing: APP_DIR ($APP_DIR) is not the clone this script lives in ($SELF_DIR)."
    echo "Nothing was removed."
    exit 1
  fi
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/brainai-remove.XXXXXX")" || exit 1
  cp "${BASH_SOURCE[0]}" "$TMP/remove.sh" || exit 1
  # The other spellings of the clone's path: the owner's crontab lines may use any of them.
  export REMOVE_APP_DIR="$SELF_DIR" REMOVE_APP_ALIASES="$SELF_LOGICAL"$'\n'"${APP_DIR:-}" REMOVE_STAGE2=1 REMOVE_TMP="$TMP"
  exec bash "$TMP/remove.sh" "$@"
fi
# Stage 2 trusts nothing it inherited: it must be the copy stage 1 made, in the system temp folder, for a clone that
# holds this very script. Until then there is no trap, so a forged REMOVE_TMP deletes nothing.
refuse() { echo "Refusing: $1"; echo "Nothing was removed."; exit 1; }
SELF="${BASH_SOURCE[0]}"
TMP_ROOT="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)"
{ [ -n "${REMOVE_TMP:-}" ] && [ -d "$REMOVE_TMP" ] && [ ! -L "$REMOVE_TMP" ] && [ "$SELF" -ef "$REMOVE_TMP/remove.sh" ] \
  && [ "$(cd "$(dirname "$REMOVE_TMP")" 2>/dev/null && pwd -P)" = "$TMP_ROOT" ]; } || refuse "this is not the temporary copy made for this run."
case "$(basename "$REMOVE_TMP")" in brainai-remove.??????) ;; *) refuse "this is not the temporary copy made for this run." ;; esac
trap 'rm -rf "$REMOVE_TMP"' EXIT
stop() { echo "$1"; echo "Nothing was removed."; exit "${2:-1}"; }
[ -n "${REMOVE_APP_DIR:-}" ] && [ -d "$REMOVE_APP_DIR" ] || stop "Refusing: the clone to remove is missing."
APP_DIR="$(cd "$REMOVE_APP_DIR" && pwd -P)"
cmp -s "$APP_DIR/scripts/remove.sh" "$SELF" || stop "Refusing: $APP_DIR does not hold this script."
# Never the root or the home folder, however they are spelled (symlinks resolved).
HOME_PHYS="$(cd "$HOME" 2>/dev/null && pwd -P)"
{ [ "$APP_DIR" != / ] && [ "$APP_DIR" != "$HOME_PHYS" ]; } || stop "Refusing to remove $APP_DIR."
# Root's crontab and home folder are not the owner's.
OWNER="$(stat -Lc %U "$APP_DIR" 2>/dev/null || stat -Lf %Su "$APP_DIR" 2>/dev/null)"
if [ "$(id -u)" = 0 ] && [ -n "$OWNER" ] && [ "$OWNER" != root ]; then stop "Run this as $OWNER, not with sudo."; fi
# The spellings of the clone's path that really are the clone (checked, as they came from the environment).
APP_NAMES=("$APP_DIR")
while IFS= read -r n; do
  [ -n "$n" ] && [ "$n" -ef "$APP_DIR" ] && APP_NAMES+=("$n")
done <<< "${REMOVE_APP_ALIASES:-}"

. "$APP_DIR/scripts/lib/overlay.sh" || exit 1
brain_overlay
GIT_DIR_ROOT="${GIT_DIR_ROOT:-$HOME/git}"
EXPORT_DIR="${EXPORT_DIR:-$HOME/brain-export}"
BARE="$GIT_DIR_ROOT/brain-export.git"
REMOTE="${OFFSITE_REMOTE:-gdrive:memory-backups}"
SKIP_MOUNT_CHECK="${SKIP_MOUNT_CHECK:-0}"
COMPOSE=(docker compose -f "$APP_DIR/docker-compose.yml")

ask() { # question -> true only for y or Y
  local a=""
  printf '%s [y/N] ' "$1"
  read -r a || true
  [ -z "$a" ] && echo
  [ "$a" = "y" ] || [ "$a" = "Y" ]
}

# 1. The saved copy, kept at ~ and named for the owner to fetch. save-copy refuses a folder inside the data folder
# (/app/data in the container), so it writes into a fresh folder of the home mounted at /saved: the container runs as
# PUID:PGID, so the files are the owner's, and the later move is a rename on the same disk. Always a one-off
# container, whether the app runs or not (SQLite takes two processes on one database).
echo "Saving a copy of your brain first..."
SAVE_TMP="$(mktemp -d "$HOME/.brainai-save.XXXXXX")" || stop "Could not make a folder in $HOME for the save."
# Only ever removed while empty: a save that fails cleans up after itself, and a copy that could not be moved stays.
trap 'rm -rf "$REMOVE_TMP"; rmdir "$SAVE_TMP" 2>/dev/null' EXIT
OUT="$("${COMPOSE[@]}" run --rm -v "$SAVE_TMP:/saved" app node dist/cli.js save-copy /saved </dev/null)" || stop "The save failed."
# The last line is the folder as the container saw it (/saved/<name>).
NAME="$(basename "$(printf '%s\n' "$OUT" | tail -n 1)")"
# The brain is intact, so a temporary copy that may hold clear text goes before stopping.
case "$NAME" in "BrainAI saved "*) ;; *) rm -rf "$SAVE_TMP"; stop "The save did not make a folder." ;; esac
[ -d "$SAVE_TMP/$NAME" ] || { rm -rf "$SAVE_TMP"; stop "The save did not make a folder."; }
# The first free name: "BrainAI saved <day>", then " (2)", " (3)".
SAVED="$HOME/$NAME"
n=2
while [ -e "$SAVED" ]; do SAVED="$HOME/$NAME ($n)"; n=$((n + 1)); done
mv "$SAVE_TMP/$NAME" "$SAVED" || stop "Could not move the saved copy to $SAVED (it is at $SAVE_TMP/$NAME)."
rmdir "$SAVE_TMP" 2>/dev/null
echo "Your saved copy is at $SAVED. To fetch it, run this on your computer:"
echo "  scp -r \"$(id -un)@$(hostname):$SAVED\" ."
printf 'Press Enter once you have it on your computer (it also stays at %s). ' "$SAVED"
read -r _ || true
echo

# What BrainAI wrote in the crontab: lines whose command is one of its scripts in this clone.
has_job() { # crontab line, script name -> the line runs $APP_DIR/scripts/<name>.sh
  local cmd
  cmd="$(printf '%s' "$1" | awk '{ for (i = 6; i <= NF; i++) { printf "%s%s", $i, (i < NF ? " " : "") } }' | awk '{ print $1 }')"
  case "$cmd" in
    "~/"*) cmd="$HOME/${cmd#\~/}" ;;
    '$HOME/'*) cmd="$HOME/${cmd#\$HOME/}" ;;
    '${HOME}/'*) cmd="$HOME/${cmd#\$\{HOME\}/}" ;;
  esac
  local n
  for n in "${APP_NAMES[@]}"; do [ "$cmd" = "$n/scripts/$2.sh" ] && return 0; done
  return 1
}
# backup-git.sh copies ~/git: it is BrainAI's only while brain-export.git is all there is.
OTHER_REPOS=0
for r in "$GIT_DIR_ROOT"/*.git; do
  [ -d "$r" ] && [ "$r" != "$BARE" ] && OTHER_REPOS=1
done
JOBS="backup export-brain offsite"
[ "$OTHER_REPOS" = 0 ] && JOBS="$JOBS backup-git"
CRON_NOW="$(crontab -l 2>/dev/null </dev/null || true)"
CRON_KEEP=""
CRON_GO=0
KEPT_GIT_LINE=""
while IFS= read -r line; do
  if [ -z "$line" ]; then CRON_KEEP="${CRON_KEEP}"$'\n'; continue; fi
  drop=0
  case "$line" in '#'*) ;; *)
    for j in $JOBS; do has_job "$line" "$j" && drop=1; done
    [ "$OTHER_REPOS" = 1 ] && has_job "$line" backup-git && KEPT_GIT_LINE="$line" ;;
  esac
  if [ "$drop" = 1 ]; then CRON_GO=$((CRON_GO + 1)); else CRON_KEEP="${CRON_KEEP}${line}"$'\n'; fi
done <<< "$CRON_NOW"

# 2. What will go.
HAS_EXPORT=0
# Off-site copies are asked about only where they were set up (a key file or an OFFSITE_REMOTE), read before the clone goes.
OFFSITE_SET=0
{ [ -s "${OFFSITE_RECIPIENT_FILE:-$APP_DIR/offsite-recipient.txt}" ] || [ -n "${OFFSITE_REMOTE:-}" ]; } && OFFSITE_SET=1
[ -d "$EXPORT_DIR/.git" ] && HAS_EXPORT=1
echo "This will remove:"
[ "$CRON_GO" -gt 0 ] && echo "  * $CRON_GO scheduled job line(s) in your crontab that run BrainAI's scripts"
echo "  * the BrainAI containers and volumes, and BrainAI's own image"
[ -d "$BARE" ] && echo "  * $BARE"
[ "$HAS_EXPORT" = 1 ] && echo "  * the files BrainAI exported into $EXPORT_DIR (anything of yours there stays)"
echo "  * $APP_DIR, including its data folder"
echo "Your saved copy at $SAVED stays."
printf 'Type remove to go ahead: '
ANSWER=""
read -r ANSWER || true
[ "$ANSWER" = "remove" ] || { echo; stop "That was not the word remove." 0; }

# 3. Removing, in this order. The containers go before anything that is needed to go on (the clone holds the compose
# file), so a failed `down` stops here with a way to finish.
if [ "$CRON_GO" -gt 0 ]; then
  printf '%s' "$CRON_KEEP" | crontab - && echo "Removed $CRON_GO crontab line(s)." || echo "Could not change the crontab: remove BrainAI's lines yourself."
fi
if ! "${COMPOSE[@]}" down --rmi local --volumes </dev/null; then
  echo
  echo "docker compose down failed, so nothing more was removed (the crontab lines above are already gone)."
  echo "To finish: cd $APP_DIR && docker compose down, then run remove.sh again ($APP_DIR/scripts/remove.sh)."
  exit 1
fi
FAILED=0
if [ -d "$BARE" ]; then rm -rf "$BARE" || { echo "Could not remove $BARE."; FAILED=1; }; fi
if [ "$HAS_EXPORT" = 1 ]; then
  # Only what export-brain.sh writes there: README.md, .gitignore, the .md files under pages/ and facts/, every file under skills/,
  # and its .git. It commits the whole folder, so being tracked says nothing: the owner's notes and pictures stay.
  # find does not follow links, and a file whose folder still leads outside the export is skipped.
  EXPORT_PHYS="$(cd "$EXPORT_DIR" && pwd -P)"
  while IFS= read -r -d '' f; do
    parent="$(cd "$(dirname "$EXPORT_DIR/$f")" 2>/dev/null && pwd -P)" || continue
    case "$parent/" in "$EXPORT_PHYS"/*) ;; *) echo "Skipped $f: its folder leads outside $EXPORT_DIR."; FAILED=1; continue ;; esac
    rm -f "$EXPORT_DIR/$f" || FAILED=1
  done < <(
    [ -f "$EXPORT_DIR/README.md" ] && printf '%s\0' README.md
    [ -f "$EXPORT_DIR/.gitignore" ] && printf '%s\0' .gitignore
    cd "$EXPORT_DIR" && { find pages facts -type f -name '*.md' -print0 2>/dev/null; find skills -type f -print0 2>/dev/null; }
  )
  rm -rf "$EXPORT_DIR/.git" || FAILED=1
  find "$EXPORT_DIR/pages" "$EXPORT_DIR/facts" "$EXPORT_DIR/skills" -depth -type d -empty -delete 2>/dev/null
  rmdir "$EXPORT_DIR" 2>/dev/null
fi
cd / && rm -rf "$APP_DIR"
if [ -e "$APP_DIR" ]; then
  echo "Could not remove $APP_DIR: remove it yourself."
  FAILED=1
elif [ "$FAILED" = 0 ]; then
  echo "Removed BrainAI from this server."
else
  echo "Removed $APP_DIR; see above for what is left."
fi
echo

# 4. Outside copies: one question each, kept unless the answer is y.
shopt -s nullglob
for dir in ${COPY_DIRS:-}; do
  if [ "$SKIP_MOUNT_CHECK" != "1" ] && ! mountpoint -q "$(dirname "$dir")"; then echo "$(dirname "$dir") is not mounted: left $dir as it is."; continue; fi
  files=("$dir"/memory-*.db)
  [ "${#files[@]}" -gt 0 ] || continue
  newest="$(printf '%s\n' "${files[@]}" | sort | tail -n 1)"
  if ask "$dir holds ${#files[@]} nightly snapshot(s), newest $(basename "$newest"). Delete them?"; then
    rm -f "${files[@]}" && echo "Deleted."
  fi
done
for dir in ${GIT_COPY_DIRS:-}; do
  [ -d "$dir/brain-export.git" ] || continue
  if ask "$dir holds a copy of brain-export.git (last changed $(date -r "$dir/brain-export.git" +%F 2>/dev/null || echo unknown)). Delete it?"; then
    rm -rf "$dir/brain-export.git" && echo "Deleted."
  fi
done
if [ "$OFFSITE_SET" = 1 ] && ! command -v rclone >/dev/null 2>&1; then
  echo "Couldn't check the off-site copies on $REMOTE (rclone isn't installed): they are still there."
elif [ "$OFFSITE_SET" = 1 ]; then
  if PACKS="$(rclone lsf "$REMOTE" --include 'memory-*.tar.gz.age' </dev/null 2>/dev/null)"; then
    PACKS="$(printf '%s\n' "$PACKS" | grep -E '^memory-.*\.tar\.gz\.age$' | sort)"
    IMAGES="$(rclone lsf "$REMOTE/images" --include '*.age' </dev/null 2>/dev/null | grep -E '\.age$')"
    if [ -n "$PACKS" ] && ask "$REMOTE holds $(printf '%s\n' "$PACKS" | wc -l | tr -d ' ') off-site copy file(s), newest $(printf '%s\n' "$PACKS" | tail -n 1). Delete them?"; then
      rclone delete "$REMOTE" --include '/memory-*.tar.gz.age' --drive-use-trash=false </dev/null && echo "Deleted."
    fi
    if [ -n "$IMAGES" ] && ask "$REMOTE/images holds $(printf '%s\n' "$IMAGES" | wc -l | tr -d ' ') encrypted picture(s). Delete them?"; then
      rclone delete "$REMOTE" --include '/images/*.age' --drive-use-trash=false </dev/null && echo "Deleted."
    fi
  else
    echo "Couldn't check the off-site copies on $REMOTE (couldn't reach it): they are still there."
  fi
fi

# 5. What only the owner can remove, from the saved folder's README.
if [ -f "$SAVED/README.txt" ]; then
  echo
  sed -n '/^Things BrainAI could not remove:/,$p' "$SAVED/README.txt"
fi
if [ -n "$KEPT_GIT_LINE" ]; then
  echo
  if [ -e "$APP_DIR/scripts/backup-git.sh" ]; then
    echo "Your nightly copy of $GIT_DIR_ROOT (crontab line: $KEPT_GIT_LINE) runs BrainAI's backup-git.sh, which is still at $APP_DIR/scripts because that folder could not be removed: copy the script somewhere else and point the line at it, or remove the line."
  else
    echo "Your nightly copy of $GIT_DIR_ROOT (crontab line: $KEPT_GIT_LINE) ran BrainAI's backup-git.sh, which is gone now: copy the script somewhere else and point the line at it, or remove the line."
  fi
fi
