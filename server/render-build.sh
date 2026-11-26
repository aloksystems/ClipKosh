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

echo "==> System deps: ffmpeg + Chromium shared libraries"
# Some Render build images mount /var/lib/apt read-only; keep apt's state and
# cache inside the writable project dir so updates/installs can succeed.
APT_DIR="$PWD/.apt"
mkdir -p "$APT_DIR/lists/partial" "$APT_DIR/cache/archives/partial"
APT_OPTS=(
  -o "Dir::State::lists=$APT_DIR/lists"
  -o "Dir::Cache=$APT_DIR/cache"
  -o "Dir::Cache::archives=$APT_DIR/cache/archives"
)
export DEBIAN_FRONTEND=noninteractive
apt-get "${APT_OPTS[@]}" update -qq
apt-get "${APT_OPTS[@]}" install -y -qq \
  ffmpeg \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2

echo "==> yt-dlp (YouTube)"
pip3 install -q yt-dlp
yt-dlp --version
