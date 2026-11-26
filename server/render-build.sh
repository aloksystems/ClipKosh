#!/usr/bin/env bash
# Build script for Render (run from the server/ root). Installs everything the
# app needs at runtime: Node deps, Puppeteer Chrome (Instagram/Facebook),
# ffmpeg (MP3 audio transcoding), and yt-dlp (YouTube).
set -euo pipefail

echo "==> npm install"
npm install

echo "==> Puppeteer Chrome (Instagram/Facebook extraction)"
export PUPPETEER_CACHE_DIR="/opt/render/project/.cache/puppeteer"
mkdir -p "$PUPPETEER_CACHE_DIR"
npx puppeteer browsers install chrome

echo "==> System deps: ffmpeg + Chromium shared libraries"
apt-get update -qq
apt-get install -y -qq \
  ffmpeg \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2

echo "==> yt-dlp (YouTube)"
pip3 install -q yt-dlp
yt-dlp --version
