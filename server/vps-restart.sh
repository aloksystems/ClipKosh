#!/usr/bin/env bash
# ClipKosh — stop then start the server (for applying new deploys).
# Usage: sudo bash vps-restart.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$APP_DIR/server"
PIDFILE="$SERVER_DIR/server.pid"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Stopping pid $(cat "$PIDFILE")"
  kill "$(cat "$PIDFILE")"
  sleep 1
fi
rm -f "$PIDFILE"

exec bash "$SERVER_DIR/vps-run.sh"
