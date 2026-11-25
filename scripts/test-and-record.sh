#!/bin/sh
# Runs typecheck and the tests; when both pass on a clean tree, records HEAD as green in .git/brainai-green, so
# pushing or deploying the same commit later does not run them again (scripts/hooks/pre-push, scripts/deploy-minipc.sh).
set -e
cd "$(git rev-parse --show-toplevel)"
. scripts/lib/green.sh
clean_git_env
# The sha and the clean tree are checked before the tests, and HEAD again after: what passed is what is recorded.
sha="$(git rev-parse HEAD)"
clean=1
if tree_dirty; then clean=0; fi
npm run typecheck
npm test
if [ "$clean" = 0 ] || tree_dirty; then
  echo "test-and-record: tests passed, but there are uncommitted or untracked changes, so no commit was recorded green." >&2
  exit 0
fi
if [ "$(git rev-parse HEAD)" != "$sha" ]; then
  echo "test-and-record: HEAD moved while the tests ran, so nothing was recorded." >&2
  exit 1
fi
record_green "$sha"
echo "test-and-record: $sha recorded green."
