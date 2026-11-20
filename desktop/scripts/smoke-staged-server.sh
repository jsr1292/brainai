#!/usr/bin/env bash
# Smoke test of a staged server (stage-server.sh), run the way the app runs it: local mode, the app's environment, a
# temporary data folder and a free port. Checks that it listens, proves itself as ours (/app/hello), hands the window
# a ticket and a session, serves the pages, answers an MCP round trip (initialize, tools/list, remember, recall) with
# the key the app gives Claude's desktop app, loads a search model and stores a vector, and that dist/cli.js and a hook
# run. Nothing outside a temporary folder is touched (HOME is the temporary folder too).
#
#   desktop/scripts/smoke-staged-server.sh [server-folder] [node-binary]
#
# Defaults: the staged Mac server and its Node. For the model check give SMOKE_E5_DIR, a folder holding the files of the
# Light model (Xenova/multilingual-e5-small: config.json, tokenizer.json, tokenizer_config.json, onnx/model_quantized.onnx);
# without it that check is skipped (SMOKE_REQUIRE_MODEL=1 makes that a failure). The Windows server cannot run here.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER="${1:-$ROOT/desktop/src-tauri/resources/server}"
NODE="${2:-$ROOT/desktop/src-tauri/binaries/node-aarch64-apple-darwin}"
[ -f "$SERVER/dist/index.js" ] || { echo "No staged server at $SERVER (run desktop/scripts/stage-server.sh)" >&2; exit 1; }
[ -x "$NODE" ] || NODE="$(command -v node)"

T="$(mktemp -d)"
SERVER_PID=""; HOLD_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$HOLD_PID" ] && kill "$HOLD_PID" 2>/dev/null || true
  rm -rf "$T"
}
trap cleanup EXIT
pass() { echo "ok    $1"; }
fail() { echo "FAIL  $1" >&2; [ -f "$T/log" ] && { echo "--- server log ---" >&2; tail -30 "$T/log" >&2; }; exit 1; }

PORT="$("$NODE" -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
KEY="smoke-$("$NODE" -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
B="http://localhost:$PORT"
mkdir -p "$T/home" "$T/tmp" "$T/models"

# The environment the app passes (desktop/src-tauri/src/server.rs env()), with an anonymous pipe on stdin that the
# server watches: this script's `sleep` holds its write end, as the app does, and killing it closes the pipe.
{
  sh -c 'echo $$ > "$1"; exec sleep 3600' _ "$T/hold" | \
  sh -c 'echo $$ > "$1"; cd "$2" && shift 2 && exec "$@"' _ "$T/pid" "$SERVER" env -i HOME="$T/home" LOCAL_MODE=true HOST=127.0.0.1 PORT="$PORT" PUBLIC_URL="$B" \
      DATA_DIR="$T/data" BACKUP_DIR="$T/backups" OVERLAY_DIR="$T/overlay" MODEL_DIR="$T/models" APP_SECRET="$KEY" \
      APP_PARENT=stdin NODE_ENV=production TRUST_CF_CONNECTING_IP=false TOOL_PATH=/usr/bin:/bin TMPDIR="$T/tmp" \
      "$NODE" dist/index.js > "$T/log" 2>&1
} 2>/dev/null &
for _ in $(seq 20); do [ -s "$T/pid" ] && [ -s "$T/hold" ] && break; sleep 0.1; done
SERVER_PID="$(cat "$T/pid")"
HOLD_PID="$(cat "$T/hold")"

# The Light model, copied where the app keeps its models, before the server looks for it.
E5="${SMOKE_E5_DIR:-}"
[ -n "$E5" ] && { mkdir -p "$T/models/Xenova" && cp -R "$E5" "$T/models/Xenova/multilingual-e5-small"; }

CHALLENGE="$(printf 'ab%.0s' $(seq 32))"
for _ in $(seq 60); do
  kill -0 "$SERVER_PID" 2>/dev/null || fail "the server stopped while starting"
  curl -fs "$B/app/hello?challenge=$CHALLENGE" -o "$T/hello" 2>/dev/null && break
  sleep 0.5
done
[ -s "$T/hello" ] || fail "the server did not listen in 30 s"
pass "listens on port $PORT"

PROOF="$("$NODE" -e "console.log(require('crypto').createHmac('sha256', process.argv[2]).update(process.argv[1]).digest('hex'))" "$CHALLENGE" "$KEY")"
grep -q "$PROOF" "$T/hello" || fail "/app/hello did not prove the app key"
pass "/app/hello proof is right"

json() { "$NODE" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s);const r=process.argv[1].split('.').reduce((a,k)=>a?.[k],v);console.log(r===undefined?'':r)}catch{console.log('')}})" "$1"; }
TICKET="$(curl -fs -X POST -H "X-App-Key: $KEY" "$B/app/ticket" | json ticket)"
[ -n "$TICKET" ] || fail "no ticket from /app/ticket"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-App-Key: wrong' "$B/app/ticket")" != 200 ] || fail "/app/ticket accepted a wrong key"
[ "$(curl -s -c "$T/jar" -o /dev/null -w '%{http_code}' "$B/app/open?ticket=$TICKET")" = 303 ] || fail "/app/open did not start a session"
pass "ticket and window session"

for p in / /settings /pages; do
  code="$(curl -s -b "$T/jar" -L -o "$T/page" -w '%{http_code}' "$B$p")"
  [ "$code" = 200 ] && grep -q '<html' "$T/page" || fail "page $p answered $code"
done
for s in app.js style.css i18n.js; do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$B/static/$s")" = 200 ] || fail "static file $s is not served"
done
pass "pages / /settings /pages and static files load"

# The key the app gives Claude's desktop app (Settings > Connect), in the temporary home.
[ "$(curl -s -b "$T/jar" -X POST -H "Origin: $B" -o /dev/null -w '%{http_code}' "$B/settings/tools/claude-desktop/connect")" = 303 ] || fail "could not make a connection key"
TOKEN="$("$NODE" -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).token)" "$T/data/claude-desktop-key")"
mcp() { curl -fs -X POST "$B/mcp" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$1"; }
mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' | grep -q '"serverInfo"' || fail "MCP initialize"
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -q '"name":"recall"' || fail "MCP tools/list has no recall"
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"remember","arguments":{"project":"smoke","kind":"decision","content":"The pelican is a large seabird with a throat pouch for catching fish."}}}' | grep -q 'Saved' || fail "MCP remember"
mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"recall","arguments":{"query":"avian with a pouch"}}}' | grep -q 'pelican' || fail "MCP recall did not find what was remembered"
pass "MCP: initialize, tools/list, remember, recall"

if [ -n "$E5" ]; then
  [ "$(curl -s -b "$T/jar" -X POST -H "Origin: $B" -d 'mode=custom&search=e5&rerank=none' -o /dev/null -w '%{http_code}' "$B/welcome/models")" = 303 ] || fail "could not choose the model"
  ready=""
  for _ in $(seq 60); do
    [ "$(curl -s -b "$T/jar" "$B/models/progress" | json searchReady)" = true ] && { ready=1; break; }
    [ "$(curl -s -b "$T/jar" "$B/models/progress" | json failed)" = true ] && fail "the search model failed to load"
    sleep 1
  done
  [ -n "$ready" ] || fail "the search model did not become ready"
  mcp '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"remember","arguments":{"project":"smoke","kind":"decision","content":"Whales are marine mammals that breathe air."}}}' | grep -q 'Saved' || fail "MCP remember with the model"
  sleep 3
  N="$(cd "$SERVER" && "$NODE" -e "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});console.log(db.prepare('select count(*) n from memories where embedding is not null').get().n)" "$T/data/memory.db")"
  [ "$N" -ge 1 ] || fail "no memory has a vector"
  mcp '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"recall","arguments":{"query":"sea creature that needs oxygen"}}}' | grep -q 'Whales' || fail "recall by meaning did not find the whale memory"
  pass "search model loads, $N memories hold vectors, recall by meaning works"
elif [ "${SMOKE_REQUIRE_MODEL:-0}" = 1 ]; then fail "SMOKE_E5_DIR is not set"
else echo "skip  search model (set SMOKE_E5_DIR to a multilingual-e5-small folder)"; fi

# The CLI the uninstaller runs (DATA_DIR is the app-data folder there) and the usage text.
echo "{\"port\":$PORT}" > "$T/brainai.json"
( cd "$SERVER" && env -i HOME="$T/home" DATA_DIR="$T" "$NODE" dist/cli.js disconnect-tools ) || fail "cli disconnect-tools"
[ ! -e "$T/data/claude-desktop-key" ] || fail "disconnect-tools left the key"
USAGE="$(cd "$SERVER" && env -i HOME="$T/home" DATA_DIR="$T/data" "$NODE" dist/cli.js --help 2>&1 || true)"
case "$USAGE" in "Usage: cli"*) ;; *) fail "cli usage" ;; esac
HOOK="$(cd "$SERVER" && echo '{}' | env -i HOME="$T/home" "$NODE" dist/hooks/memoryStart.js)"
case "$HOOK" in *SessionStart*) ;; *) fail "memoryStart hook" ;; esac
pass "cli disconnect-tools, cli usage, hook"

# Closing the pipe stops the server (APP_PARENT=stdin).
kill "$HOLD_PID" 2>/dev/null || true; HOLD_PID=""
for _ in $(seq 40); do kill -0 "$SERVER_PID" 2>/dev/null || { SERVER_PID=""; break; }; sleep 0.5; done
[ -z "$SERVER_PID" ] || fail "the server did not stop when its stdin closed"
pass "stops when the app's pipe closes"
echo "Smoke test passed."
