#!/bin/bash
# Installs the brain's folder reporter on this Mac: stores the device token (created in the brain's
# Settings › Devices), writes a launchd job that runs every 15 minutes with the brain's address, and sends a first
# report. The reporter also keeps the Claude Code skills you share in step.
# Usage: scripts/mac/install-folder-report.sh --url https://your-brain.example            (asks for the token)
#        scripts/mac/install-folder-report.sh --url https://your-brain.example <token>    (token in shell history)
#        scripts/mac/install-folder-report.sh --url https://your-brain.example            (again: keeps the stored token)
set -euo pipefail
URL=""
TOKEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:-}"; shift; [ $# -gt 0 ] && shift ;;
    --url=*) URL="${1#--url=}"; shift ;;
    *) TOKEN="$1"; shift ;;
  esac
done
URL="${URL%/}"
if [ -z "$URL" ]; then
  echo "Give your brain's address: install-folder-report.sh --url https://your-brain.example [token]" >&2
  exit 64
fi
if [[ ! "$URL" =~ ^https://[^/[:space:]]+$ && ! "$URL" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]+)?$ ]]; then
  echo "The address must be https:// (or http://localhost while testing), with no path: $URL" >&2
  exit 64
fi
# A brain answers its protected-resource metadata; anything else is the wrong address.
if ! curl -fsS --max-time 15 "$URL/.well-known/oauth-protected-resource/mcp" 2>/dev/null | grep -q '"resource"'; then
  echo "$URL doesn't answer like a brain (no /.well-known/oauth-protected-resource/mcp): check the address." >&2
  exit 65
fi

TOKEN_FILE="$HOME/.config/brain/device-token"
if [ -z "$TOKEN" ] && [ -s "$TOKEN_FILE" ]; then
  TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  echo "Using the device token already stored in $TOKEN_FILE."
fi
if [ -z "$TOKEN" ]; then
  read -rsp "Device token from Settings › Devices: " TOKEN
  echo
fi
if [[ ! "$TOKEN" =~ ^brain_dev_[A-Za-z0-9_-]{43}$ ]]; then
  echo "That is not a device token (it starts with brain_dev_). Create one in the brain's Settings › Devices." >&2
  exit 64
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/brain-folder-report.py"
PYTHON="$(command -v python3 || true)"
if [ -z "$PYTHON" ]; then
  echo "python3 is not installed: install Xcode's command line tools (xcode-select --install) and run this again." >&2
  exit 69
fi
# Paths go into an XML plist.
xml() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }
LABEL="org.brain.folder-report"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/brain-folder-report.log"

mkdir -p "$HOME/.config/brain"
umask 077
printf '%s\n' "$TOKEN" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
umask 022

# The job's name before version 1.0: removed, so two jobs never report at once.
OLD_LABEL="com.example.brain-folder-report"
launchctl bootout "gui/$(id -u)/$OLD_LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$OLD_LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$(xml "$PYTHON")</string><string>$(xml "$SCRIPT")</string></array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string>
    <key>BRAIN_URL</key><string>$(xml "$URL")</string>
  </dict>
</dict>
</plist>
PLIST
chmod 644 "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# Right after a bootout, bootstrap can fail once with "Input/output error": wait and try again.
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || { sleep 2; launchctl bootstrap "gui/$(id -u)" "$PLIST"; }
echo "Installed $LABEL for $URL (every 15 minutes, log: $LOG). First report:"
BRAIN_URL="$URL" "$PYTHON" "$SCRIPT" && echo "OK: the brain has the report." || echo "The first report failed; see the message above."
