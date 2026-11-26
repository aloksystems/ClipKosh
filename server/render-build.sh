#!/usr/bin/env bash
# Build script for Render (run from the server/ root). Installs everything the
# app needs at runtime: Node deps, Puppeteer Chrome (Instagram/Facebook),
# ffmpeg (MP3 audio transcoding), and yt-dlp (YouTube).
set -euo pipefail

echo "==> npm install"
npm install

echo "==> Puppeteer Chrome (Instagram/Facebook extraction)"
# Keep the browser cache inside the repo (../ relative to the server/ root) so
# it survives into runtime and matches what the app computes at startup.
CACHE_DIR="$(cd .. && pwd)/.cache/puppeteer"
export PUPPETEER_CACHE_DIR="$CACHE_DIR"
mkdir -p "$CACHE_DIR"
npx puppeteer browsers install chrome

# Note: Render's free build image is not root and mounts dpkg dirs read-only,
# so apt-get cannot install system packages here. The base image already ships
# ffmpeg and Chromium's shared libraries; we verify Chrome's deps below.

echo "==> Checking Chrome shared-library dependencies"
CHROME_BIN=$(find "$CACHE_DIR" -type f -name chrome -path "*chrome-linux64*" | head -1)
echo "chrome bin: $CHROME_BIN"
ldd "$CHROME_BIN" 2>/dev/null | grep -i "not found" || echo "ALL_CHROME_LIBS_PRESENT"

echo "==> yt-dlp (YouTube)"
pip3 install -q yt-dlp
yt-dlp --version
