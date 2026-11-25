# Sourced by scripts/hooks/pre-push, scripts/test-and-record.sh and scripts/deploy-minipc.sh (POSIX sh).
# A commit is "green" once typecheck and the tests passed on it: its sha is appended to .git/brainai-green
# (in the shared git folder, so every worktree sees it). A sha says exactly which content passed.

# Git exports GIT_DIR and friends into hooks; left in place they make git commands in other folders (what the tests
# do in temp dirs) act on the real worktree.
clean_git_env() {
  # shellcheck disable=SC2046
  unset $(git rev-parse --local-env-vars 2>/dev/null) GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR GIT_PREFIX GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_QUARANTINE_PATH GIT_CONFIG GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_SHALLOW_FILE GIT_GRAFT_FILE GIT_IMPLICIT_WORK_TREE GIT_NO_REPLACE_OBJECTS GIT_REPLACE_REF_BASE
}
green_file() { printf '%s/brainai-green' "$(git rev-parse --git-common-dir)"; }
is_green() { f="$(green_file)"; [ -f "$f" ] && grep -qx "$1" "$f"; }
# Appended when missing; the file keeps its last 200 lines (oldest dropped, order kept).
record_green() {
  f="$(green_file)"
  is_green "$1" && return 0
  echo "$1" >> "$f" || return 1
  if [ "$(wc -l < "$f")" -gt 200 ]; then tail -n 200 "$f" > "$f.tmp.$$" && mv "$f.tmp.$$" "$f"; fi
}
# Changes to tracked files, or new files git does not ignore: a forgotten new module passes locally and breaks the server build.
tree_dirty() { [ -n "$(git status --porcelain)" ]; }
