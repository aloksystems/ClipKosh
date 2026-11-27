#!/usr/bin/env bash
# ClipKosh VPS self-test: checks yt-dlp, starts the server, and tests YouTube resolve.
set -e
cd "$(dirname "$0")"

echo "==> 1. Checking yt-dlp (venv)..."
if [ -x "$HOME/.clipkosh-venv/bin/yt-dlp" ]; then
  echo "OK: $HOME/.clipkosh-venv/bin/yt-dlp"
else
  echo "WARN: yt-dlp not found in venv"
fi

echo ""
echo "==> 2. Starting server on port 3000..."
pkill -f "node index.js" || true
sleep 1
PORT=3000 bash vps-run.sh
sleep 3
curl -s http://localhost:3000/ -o /dev/null -w "Home HTTP %{http_code}\n"

echo ""
echo "==> 3. YouTube resolve tests..."
for V in jNQXAC9IVRw dQw4w9WgXcQ BaW_jenozKc; do
  echo "--- video $V ---"
  curl -s -X POST http://localhost:3000/api/resolve \
    -H "Content-Type: application/json" \
    --data "{\"url\":\"https://www.youtube.com/watch?v=$V\"}" \
    | head -c 600
  echo ""
done
echo "==> Done."
