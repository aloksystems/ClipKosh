#!/usr/bin/env bash
# ClipKosh — start the server in the background on the VPS.
# Usage: sudo bash vps-run.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$APP_DIR/server"
PORT="${PORT:-3000}"

cd "$SERVER_DIR"

# Prefer the PO-token provider + impersonate for fewer bot-checks.
export YT_BGUTIL_HOME="$HOME/bgutil-ytdlp-pot-provider/server"
export YT_IMPERSONATE="${YT_IMPERSONATE:-chrome}"
export PUPPETEER_CACHE_DIR="$APP_DIR/.cache/puppeteer"

LOG="$SERVER_DIR/server.log"
PIDFILE="$SERVER_DIR/server.pid"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Server already running (pid $(cat "$PIDFILE")). Restart with: sudo bash vps-restart.sh"
  exit 0
fi

echo "==> Starting ClipKosh on port $PORT"
nohup env PORT="$PORT" node index.js >"$LOG" 2>&1 &
echo $! > "$PIDFILE"

sleep 3
if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Started pid $(cat "$PIDFILE"). Log: $LOG"
else
  echo "FAILED to start. Last log lines:"
  tail -n 20 "$LOG" || true
  exit 1
fi
