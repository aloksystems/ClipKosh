#!/usr/bin/env bash
# ClipKosh public tunnel via Cloudflare (works even while Altare's inbound network is down).
set -e
cd "$(dirname "$0")"

echo "==> 1. Ensuring server runs on port 3000..."
if ! curl -s http://localhost:3000/ -o /dev/null; then
  PORT=3000 bash vps-run.sh
  sleep 3
fi
curl -s http://localhost:3000/ -o /dev/null -w "Home HTTP %{http_code}\n"

echo ""
echo "==> 2. Installing cloudflared..."
CLOUDFLARED_BIN=/usr/local/bin/cloudflared
if [ ! -x "$CLOUDFLARED_BIN" ]; then
  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o "$CLOUDFLARED_BIN"
  chmod +x "$CLOUDFLARED_BIN"
fi
"$CLOUDFLARED_BIN" --version

echo ""
echo "==> 3. Starting Cloudflare tunnel to localhost:3000..."
"$CLOUDFLARED_BIN" tunnel --url http://localhost:3000 --no-autoupdate > tunnel.log 2>&1 &
echo $! > tunnel.pid
sleep 8
echo "==> Tunnel log:"
cat tunnel.log
