#!/usr/bin/env bash
# The privacy check over a finished release folder (scripts/publish/build-apps.sh), before anything is uploaded. It
# opens what ships: the dmg (attached read-only, always detached on exit), the Mac update archive (*.app.tar.gz) and
# the Windows installer (*.exe, unpacked with 7z), and reads the small files beside them as they are.
#   - In every file: the build Mac's home path ($HOME, and the same with \ for /), as a build would leave it; in a
#     binary file also with its NUL bytes taken out, which finds it written as UTF-16 text (Windows paths).
#   - In BrainAI's own text files: no word from the denylist (one per line, # comments and blank lines skipped,
#     matched ignoring case) and no key-shaped string (src/scripts/secretScan.ts, the publish gate's scanner). They
#     are the server's dist/, its package.json, ui/, install-app.ps1, latest.json and release-notes.md.
#   - The shell executable (Contents/MacOS/brainai, brainai.exe): the key scan, over its printable strings (so a
#     "line" there is a line of those strings), and the home path, but not the denylist. BrainAI's own text in it
#     comes from desktop/src-tauri/src, desktop/ui and tauri.conf.json, which the publish gate already checks; the
#     rest is the Rust crates it links, whose data tables (time-zone place names) and joined string constants would
#     be false findings.
#   - Third-party files (node_modules/, Node, the VC runtime) are checked for the home path only: their text comes
#     from their registries, and place names in time-zone data would be false findings.
# Prints the file (artifact/path inside it) and line and "a denylisted word" / "a build path" / "a key-shaped
# string", never the word, the path or the key, as the publish gate does (check-public-tree.sh).
# Usage: scripts/publish/check-release-files.sh <denylist> <release-dir>
# Exit 0: clean. 1: a finding. 2: wrong use (no or empty denylist, no folder, a missing tool, an archive that will not
# open, a file or folder that cannot be read: what cannot be read is never passed as clean).
set -uo pipefail

SELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ "$#" -eq 2 ] || { echo "Usage: check-release-files.sh <denylist> <release-dir>" >&2; exit 2; }
DENYLIST="$1" DIR="$2"
[ -f "$DENYLIST" ] || { echo "No denylist file at the path given" >&2; exit 2; }
[ -r "$DENYLIST" ] || { echo "Cannot read the denylist" >&2; exit 2; }
[ -d "$DIR" ] || { echo "No release folder at the path given" >&2; exit 2; }
DIR="$(cd "$DIR" 2>/dev/null && pwd)" && [ -n "$DIR" ] && [ -r "$DIR" ] || { echo "Cannot open the release folder" >&2; exit 2; }
# The home path is the build path to find: a missing or root one would match everything (or nothing useful).
case "${HOME:-}" in ""|/) echo "HOME is not set to a home folder: it is the build path to look for" >&2; exit 2 ;; esac
HOME_PATH="${HOME%/}"
HOME_BACK="$(printf '%s' "$HOME_PATH" | tr '/' '\\')"

WORK="$(mktemp -d)" && [ -n "$WORK" ] || { echo "Could not make a temporary folder" >&2; exit 2; }
MOUNTS=()
cleanup() {
  for mp in ${MOUNTS[@]+"${MOUNTS[@]}"}; do
    hdiutil detach -quiet "$mp" 2>/dev/null || hdiutil detach -quiet -force "$mp" 2>/dev/null || echo "Could not detach $mp: detach it by hand" >&2
  done
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 2' INT TERM

# The denylist, cleaned: no comments, no blank lines (a blank pattern would match everything), no Windows line ends.
# A release is never checked against an empty list: that would pass anything.
tr -d '\r' < "$DENYLIST" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | grep -v '^#' | grep -v '^$' > "$WORK/terms" || true
[ -s "$WORK/terms" ] || { echo "The denylist has no words: give the real one" >&2; exit 2; }

SEVEN=""
command -v 7z >/dev/null 2>&1 && SEVEN=7z
[ -z "$SEVEN" ] && command -v 7zz >/dev/null 2>&1 && SEVEN=7zz

FOUND=0
finding() { echo "$1"; FOUND=1; }
# A path to print: as it is, or every letter hidden when the path itself holds a denylisted word.
show_path() {
  if printf '%s\n' "$1" | grep -qiF -f "$WORK/terms"; then printf '%s' "$1" | tr -c '/.:0-9' '?'; else printf '%s' "$1"; fi
}

# Stops the check: what cannot be read is never passed as clean. The message names no raw path.
fail() { echo "$1" >&2; exit 2; }

# BrainAI's own text files, by their path inside an artifact (or in the folder).
is_own() {
  case "/$1" in */node_modules/*) return 1 ;; esac
  case "/$1" in
    */server/dist/*|*/server/package.json|*/server-windows/dist/*|*/server-windows/package.json|*/ui/*) return 0 ;;
    */install-app.ps1|*/latest.json|*/release-notes.md) return 0 ;;
  esac
  return 1
}
# The shell executable.
is_exe() { case "/$1" in */Contents/MacOS/brainai|*/brainai.exe) return 0 ;; esac; return 1; }

# Each root to check: "<label>|<folder>". The small files are checked in a copy of their own, so nothing else
# (the archives) is read as text.
mkdir -p "$WORK/roots/files"
ROOTS=()
n=0
for f in "$DIR"/* "$DIR"/.[!.]*; do
  # A pattern that matched nothing; anything else (a broken link too) is an entry of the folder.
  [ -e "$f" ] || [ -L "$f" ] || continue
  name="${f##*/}"
  n=$((n + 1))
  shown="$(show_path "$name")"
  # build-apps.sh makes a flat folder of plain files: a link, a folder or anything else would go unchecked.
  [ ! -L "$f" ] && [ -f "$f" ] || fail "$shown is not a plain file: a release folder holds only the release files"
  [ -r "$f" ] || fail "Cannot read $shown"
  case "$name" in
    *.dmg)
      command -v hdiutil >/dev/null 2>&1 || fail "hdiutil is missing: run the check on a Mac"
      mp="$WORK/mnt-$n"
      mkdir "$mp" || fail "Could not make a mount point"
      hdiutil attach -quiet -readonly -nobrowse -noautoopen -mountpoint "$mp" "$f" >/dev/null 2>&1 || fail "Could not open $shown"
      MOUNTS+=("$mp")
      ROOTS+=("$name|$mp") ;;
    *.app.tar.gz|*.tar.gz)
      mkdir "$WORK/x-$n" || fail "Could not make a folder to unpack in"
      tar -xzf "$f" -C "$WORK/x-$n" 2>/dev/null || fail "Could not unpack $shown"
      ROOTS+=("$name|$WORK/x-$n") ;;
    *.exe)
      [ -n "$SEVEN" ] || fail "7z is missing: brew install p7zip"
      mkdir "$WORK/x-$n" || fail "Could not make a folder to unpack in"
      "$SEVEN" x -y -bd -o"$WORK/x-$n" "$f" >/dev/null 2>&1 || fail "Could not unpack $shown"
      ROOTS+=("$name|$WORK/x-$n") ;;
    *)
      cp "$f" "$WORK/roots/files/" 2>/dev/null || fail "Cannot read $shown" ;;
  esac
done
[ "$n" -gt 0 ] || fail "The release folder is empty"
ROOTS+=("|$WORK/roots/files")

# Binary as secretScan.ts decides it: a NUL byte in the first 8000.
is_binary() { [ "$(head -c 8000 "$1" | wc -c)" != "$(head -c 8000 "$1" | LC_ALL=C tr -d '\000' | wc -c)" ]; }
label() { if [ -n "$1" ]; then printf '%s/%s' "$1" "$2"; else printf '%s' "$2"; fi; }

# The key scan over a tree of text copies; its finds are printed against the artifact.
key_scan() {
  local name="$1" tree="$2"
  [ -d "$tree" ] || return 0
  if ! (cd "$SELF_ROOT" && node --import tsx src/scripts/secretScan.ts "$tree") > "$WORK/secrets" 2>&1; then
    grep -q ': a key-shaped string' "$WORK/secrets" || fail "The secret scan could not run on $(show_path "${name:-the loose files}")"
    while IFS= read -r line; do finding "$(show_path "$(label "$name" "${line%%:*}")"):${line#*:}"; done < <(grep ': a key-shaped string' "$WORK/secrets")
  fi
}

for root in "${ROOTS[@]}"; do
  name="${root%%|*}" top="${root#*|}"
  where="$(show_path "${name:-the loose files}")"
  # Every regular file (links are not followed: the dmg's Applications link points at the build Mac).
  (cd "$top" && find . -type f -print0) > "$WORK/list" 2>/dev/null || fail "Cannot list every file in $where"
  # The home path, in every file (-a: binary files too). Only file:line is kept, so the path is never printed.
  # grep -r follows no links inside the tree; exit 2 means a file it could not read.
  (cd "$top" && LC_ALL=C grep -rHnaF -e "$HOME_PATH" -e "$HOME_BACK" .) > "$WORK/home-hits" 2>/dev/null
  [ $? -le 1 ] || fail "Cannot read every file in $where"
  cut -d: -f1,2 "$WORK/home-hits" | sed 's|^\./||' | sort -u > "$WORK/home-lines"
  cut -d: -f1 "$WORK/home-lines" | sort -u > "$WORK/home-files"
  while IFS= read -r hit; do
    finding "$(show_path "$(label "$name" "${hit%:*}")"):${hit##*:}: a build path"
  done < "$WORK/home-lines"
  # Own text files copied into own/, executables' printable strings into exe/ (the key scan only).
  key="$(printf '%s' "${name:-loose files}" | tr -c 'A-Za-z0-9._-' '_')"
  own="$WORK/own/$key" exe="$WORK/exe/$key"
  while IFS= read -r -d '' p; do
    rel="${p#./}"
    shown="$(show_path "$(label "$name" "$rel")")"
    [ -r "$top/$rel" ] || fail "Cannot read $shown"
    # A binary file once more with its NUL bytes taken out: a home path written as UTF-16 text.
    if is_binary "$top/$rel" && ! grep -qxF "$rel" "$WORK/home-files"; then
      LC_ALL=C tr -d '\000' < "$top/$rel" | LC_ALL=C grep -qaF -e "$HOME_PATH" -e "$HOME_BACK"
      st=("${PIPESTATUS[@]}")
      [ "${st[0]}" = 0 ] && [ "${st[1]}" -le 1 ] || fail "Cannot read $shown"
      [ "${st[1]}" = 0 ] && finding "$shown: a build path (as UTF-16 text)"
    fi
    if is_exe "$rel"; then
      mkdir -p "$exe/$(dirname "$rel")" || fail "Could not make a folder for the scan"
      LC_ALL=C tr -c '[:print:]\t' '\n' < "$top/$rel" | LC_ALL=C grep -aE '.{6,}' > "$exe/$rel"
      st=("${PIPESTATUS[@]}")
      [ "${st[0]}" = 0 ] && [ "${st[1]}" -le 1 ] || fail "Cannot read $shown"
    elif is_own "$rel"; then
      mkdir -p "$own/$(dirname "$rel")" || fail "Could not make a folder for the scan"
      cp "$top/$rel" "$own/$rel" 2>/dev/null || fail "Cannot read $shown"
      printf '%s\n' "$rel" | grep -qiF -f "$WORK/terms" && finding "$shown: a file name holds a denylisted word"
    fi
  done < "$WORK/list"
  if [ -d "$own" ]; then
    (cd "$own" && LC_ALL=C grep -rnaiF -f "$WORK/terms" .) > "$WORK/word-hits" 2>/dev/null
    [ $? -le 1 ] || fail "Cannot read every own file of $where"
    while IFS= read -r hit; do
      finding "$(show_path "$(label "$name" "${hit%:*}")"):${hit##*:}: a denylisted word"
    done < <(cut -d: -f1,2 "$WORK/word-hits" | sed 's|^\./||' | sort -u)
  fi
  key_scan "$name" "$own"
  key_scan "$name" "$exe"
done

if [ "$FOUND" = 0 ]; then
  echo "The release files are clean ($(ls -A "$DIR" | wc -l | tr -d ' ') files in $DIR)."
  exit 0
fi
exit 1
