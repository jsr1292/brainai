#!/usr/bin/env bash
# The publish gate: builds the public tree (every tracked file of the git repo you run it in, minus docs/superpowers/)
# in out-dir and checks it before anything is published:
#   - no private file: .env (but .env.example), a database, a key file, the off-site recipient;
#   - no word from the denylist (one per line, # comments and blank lines skipped, matched ignoring case), in a file
#     or a file name. Prints the file and line and "a denylisted word", never the word, so the list stays private;
#   - no key-shaped string (src/scripts/secretScan.ts, which knows the detector tests' made-up keys);
#   - npm ci and npm test pass in a scratch copy of it (out-dir itself is never touched), unless --no-tests.
# Usage: scripts/publish/check-public-tree.sh <denylist> [out-dir] [--no-tests]
# out-dir must be new or empty (the gate never deletes anything in it); without one, a temporary folder is used and
# removed afterwards. Exit 0: clean. 1: a finding. 2: wrong use.
set -uo pipefail

SELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DENYLIST="" OUT="" TESTS=1
for arg in "$@"; do
  case "$arg" in
    --no-tests) TESTS=0 ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) if [ -z "$DENYLIST" ]; then DENYLIST="$arg"; elif [ -z "$OUT" ]; then OUT="$arg"; else echo "Too many arguments" >&2; exit 2; fi ;;
  esac
done
[ -n "$DENYLIST" ] || { echo "Usage: check-public-tree.sh <denylist> [out-dir] [--no-tests]" >&2; exit 2; }
[ -f "$DENYLIST" ] || { echo "No denylist file at the path given" >&2; exit 2; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Run this inside the git repository to publish" >&2; exit 2; }
REPO="$(git rev-parse --show-toplevel)"

WORK="$(mktemp -d)" && [ -n "$WORK" ] || { echo "Could not make a temporary folder" >&2; exit 2; }
TEMP_OUT=0
if [ -z "$OUT" ]; then
  OUT="$WORK/tree"; TEMP_OUT=1
elif [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  echo "The output folder is not empty: give a new or empty one" >&2; rm -rf "$WORK"; exit 2
fi
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$OUT" 2>/dev/null && OUT="$(cd "$OUT" && pwd)" && [ -n "$OUT" ] || { echo "Cannot use the output folder" >&2; exit 2; }

FOUND=0
finding() { echo "$1"; FOUND=1; }
# A path to print: as it is, or every letter hidden when the path itself holds a denylisted word.
show_path() {
  if [ -s "$WORK/terms" ] && printf '%s\n' "$1" | grep -qiF -f "$WORK/terms"; then printf '%s' "$1" | tr -c '/.' '?'; else printf '%s' "$1"; fi
}

# The denylist, cleaned: no comments, no blank lines (a blank pattern would match everything), no Windows line ends.
tr -d '\r' < "$DENYLIST" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | grep -v '^#' | grep -v '^$' > "$WORK/terms" || true

# The public files: tracked, present, and outside docs/superpowers/.
(cd "$REPO" && git ls-files -z) | tr '\0' '\n' | grep -v '^docs/superpowers/' > "$WORK/all" || true
: > "$WORK/files"
while IFS= read -r f; do [ -f "$REPO/$f" ] && printf '%s\n' "$f" >> "$WORK/files"; done < "$WORK/all"

while IFS= read -r f; do
  base="${f##*/}"
  case "$base" in
    .env.example) ;;
    .env|.env.*|*.db|*.db-wal|*.db-shm|*.sqlite|*.sqlite3|*key*.txt|offsite-recipient.txt|*.pem|id_rsa*|id_ed25519*|id_ecdsa*)
      finding "$(show_path "$f"): a private file" ;;
  esac
done < "$WORK/files"

(cd "$REPO" && tar -cf - -T "$WORK/files") | (cd "$OUT" && tar -xf -) || { echo "Could not copy the public tree" >&2; exit 2; }

if [ -s "$WORK/terms" ]; then
  # -a: binary files too. Only file:line is kept, so the word itself is never printed.
  while IFS= read -r hit; do
    finding "$(show_path "${hit%:*}"):${hit##*:}: a denylisted word"
  done < <(cd "$OUT" && grep -rnaiF -f "$WORK/terms" . | cut -d: -f1,2 | sed 's|^\./||' | sort -u)
  while IFS= read -r f; do
    printf '%s\n' "$f" | grep -qiF -f "$WORK/terms" && finding "$(show_path "$f"): a file name holds a denylisted word"
  done < "$WORK/files"
fi

if ! (cd "$SELF_ROOT" && node --import tsx src/scripts/secretScan.ts "$OUT") > "$WORK/secrets" 2>&1; then
  if [ -s "$WORK/secrets" ]; then while IFS= read -r line; do finding "$(show_path "${line%%:*}"):${line#*:}"; done < "$WORK/secrets"; else finding "The secret scan could not run"; fi
fi

if [ "$FOUND" = 0 ] && [ "$TESTS" = 1 ]; then
  echo "Running npm ci and npm test in a scratch copy of the public tree..."
  # A scratch copy, so out-dir stays exactly the files checked above: the test run leaves node_modules, caches and
  # compiled files behind, which nobody would have scanned.
  TEST_TREE="$WORK/test-tree"
  mkdir "$TEST_TREE" && (cd "$OUT" && tar -cf - .) | (cd "$TEST_TREE" && tar -xf -) || finding "Could not make the scratch copy for the tests"
  if [ "$FOUND" = 0 ] && ! (cd "$TEST_TREE" && npm ci --no-audit --no-fund > "$WORK/npm-ci.log" 2>&1); then tail -20 "$WORK/npm-ci.log"; finding "npm ci failed"; fi
  if [ "$FOUND" = 0 ] && ! (cd "$TEST_TREE" && npm test > "$WORK/npm-test.log" 2>&1); then grep -E '^not ok|ℹ (pass|fail)' "$WORK/npm-test.log" | tail -20; finding "npm test failed"; fi
fi

if [ "$FOUND" = 0 ]; then
  echo "The public tree is clean ($(wc -l < "$WORK/files" | tr -d ' ') files)."
  [ "$TEMP_OUT" = 0 ] && echo "It is in $OUT"
  exit 0
fi
exit 1
