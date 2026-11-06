#!/bin/sh
# Builds the shared-memory hooks for Claude Code and copies them to ~/.claude/hooks on this Mac.
# Run again after changing src/hooks. They are wired up in ~/.claude/settings.json (docs/CLIENTS.md).
set -eu
cd "$(dirname "$0")/.."
npm run build >/dev/null
mkdir -p "$HOME/.claude/hooks"
cp dist/hooks/memoryStart.js "$HOME/.claude/hooks/memory-start.mjs"
cp dist/hooks/memorySave.js "$HOME/.claude/hooks/memory-save.mjs"
echo "Installed memory-start.mjs and memory-save.mjs in $HOME/.claude/hooks"
