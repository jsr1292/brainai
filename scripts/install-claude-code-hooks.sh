#!/bin/sh
# Builds the shared-memory hooks and copies them to this Mac (server users; the desktop app does this itself from
# Settings > Tools on this computer). Run again after changing src/hooks. Wiring them up: docs/CLIENTS.md.
#   Claude Code: ~/.claude/hooks/memory-start.mjs (SessionStart), memory-save.mjs (Stop and PreCompact)
#   Codex, Cursor: ~/.brainai/hooks/memory-nudge.mjs (Stop and PostToolUse / stop and postToolUse)
set -eu
cd "$(dirname "$0")/.."
npm run build >/dev/null
mkdir -p "$HOME/.claude/hooks" "$HOME/.brainai/hooks"
cp dist/hooks/memoryStart.js "$HOME/.claude/hooks/memory-start.mjs"
cp dist/hooks/memorySave.js "$HOME/.claude/hooks/memory-save.mjs"
cp dist/hooks/memoryNudge.js "$HOME/.brainai/hooks/memory-nudge.mjs"
echo "Installed memory-start.mjs and memory-save.mjs in $HOME/.claude/hooks, and memory-nudge.mjs in $HOME/.brainai/hooks"
cat <<MSG

Add these to the tools' hook files if they are not there yet (docs/CLIENTS.md, "Hooks"):
  ~/.claude/settings.json  "hooks": SessionStart -> node $HOME/.claude/hooks/memory-start.mjs
                                    Stop, PreCompact -> node $HOME/.claude/hooks/memory-save.mjs
  ~/.codex/hooks.json      "hooks": Stop, PostToolUse -> node $HOME/.brainai/hooks/memory-nudge.mjs codex   (then /hooks in Codex, to trust them)
  ~/.cursor/hooks.json     "hooks": stop, postToolUse -> node $HOME/.brainai/hooks/memory-nudge.mjs cursor
MSG
