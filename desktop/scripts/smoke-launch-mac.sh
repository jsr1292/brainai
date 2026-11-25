#!/usr/bin/env bash
# Launch check of a built Mac app: starts BrainAI.app's own binary with HOME, CFFIXED_USER_HOME and TMPDIR in a
# temporary folder, waits, and fails if the app has exited (a crash at start) or its server never said it was listening.
# The window opens for a few seconds on this Mac's screen, so run it from a logged-in desktop session (not over ssh).
# HOME moves BrainAI's data, logs, config and login item; CFFIXED_USER_HOME moves what macOS keeps by bundle id
# (WebKit storage, caches, preferences), so the installed app's own storage is not touched. The app is stopped and the
# folder removed at the end; its server stops by itself when the app is gone (it watches the app's stdin).
# BrainAI runs one copy at a time (a fixed socket that HOME does not move), so the check refuses while one is open.
#
#   desktop/scripts/smoke-launch-mac.sh <path/to/BrainAI.app> [seconds, default 25]
#
# 1.10.4 shipped with a crash a second after start (wry's url() on a page not yet loaded); this check would have
# stopped that release.
set -euo pipefail

APP="${1:-}"
WAIT="${2:-25}"
[ -d "$APP" ] || { echo "Usage: smoke-launch-mac.sh <path/to/BrainAI.app> [seconds]" >&2; exit 2; }
BIN="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist" 2>/dev/null || true)"
BIN="$APP/Contents/MacOS/${BIN:-brainai}"
[ -x "$BIN" ] || { echo "No app binary at $BIN" >&2; exit 2; }
if pgrep -qf '\.app/Contents/MacOS/brainai'; then
  echo "Quit BrainAI first: a BrainAI that is already open takes over a second launch, so this check cannot run" >&2
  exit 2
fi
[ -z "${SSH_CONNECTION:-}" ] || echo "Note: over ssh the app may not reach the screen; run this from the Mac's own session if it fails." >&2

T="$(mktemp -d)"
mkdir -p "$T/home/tmp"
PID=""
cleanup() {
  if [ -n "$PID" ]; then
    pkill -TERM -P "$PID" 2>/dev/null || true
    kill -TERM "$PID" 2>/dev/null || true
    sleep 2
    pkill -KILL -P "$PID" 2>/dev/null || true
    kill -KILL "$PID" 2>/dev/null || true
  fi
  rm -rf "$T"
}
trap cleanup EXIT

env -u CLAUDE_CONFIG_DIR -u CODEX_HOME HOME="$T/home" CFFIXED_USER_HOME="$T/home" TMPDIR="$T/home/tmp" RUST_BACKTRACE=1 "$BIN" > "$T/out.log" 2>&1 &
PID=$!

for _ in $(seq 1 "$WAIT"); do
  sleep 1
  if ! kill -0 "$PID" 2>/dev/null; then
    wait "$PID" 2>/dev/null && CODE=0 || CODE=$?
    if [ "$CODE" = 0 ] && [ ! -s "$T/out.log" ]; then
      echo "FAIL  the app exited at once with no output: another BrainAI probably answered (quit it and run again)" >&2
      PID=""
      exit 1
    fi
    echo "FAIL  the app exited within ${WAIT} s of starting (exit $CODE)" >&2
    grep -iE -A2 'panick|error' "$T/out.log" | head -20 >&2 || tail -20 "$T/out.log" >&2
    PID=""
    exit 1
  fi
done

LOG="$(find "$T/home/Library/Application Support" -name server.log -print -quit 2>/dev/null || true)"
if [ -z "$LOG" ] || ! grep -q 'listening' "$LOG"; then
  echo "FAIL  the app is running but its server never said it was listening" >&2
  [ -n "$LOG" ] && tail -20 "$LOG" >&2
  exit 1
fi
echo "ok    the app stayed up ${WAIT} s and its server is listening"
