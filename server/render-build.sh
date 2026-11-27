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

echo "==> yt-dlp (YouTube) — force latest (YouTube changes often)"
pip3 install -q -U yt-dlp
yt-dlp --version

echo "==> yt-dlp EJS challenge solver (SABR / signature solving)"
pip3 install -q yt-dlp-ejs

echo "==> YouTube PO Token provider (bgutil) — optional, mitigates datacenter-IP bot checks"
# Pin plugin and provider to the same release so they interoperate.
pip3 install -q -U "bgutil-ytdlp-pot-provider==2.0.2" || echo "POT_PLUGIN_PIP_FAILED"
POT_DIR="${HOME}/bgutil-ytdlp-pot-provider"
if [ ! -d "${POT_DIR}/server/build" ]; then
  git clone --depth 1 --single-branch --branch 2.0.2 \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "${POT_DIR}" \
    >/dev/null 2>&1 || echo "POT_CLONE_FAILED"
  if [ -d "${POT_DIR}/server" ]; then
    ( cd "${POT_DIR}/server" && npm ci >/dev/null 2>&1 && npx tsc ) \
      && echo "POT_PROVIDER_BUILT" || echo "POT_PROVIDER_BUILD_FAILED"
  fi
else
  echo "POT_PROVIDER_ALREADY_BUILT"
fi
echo "POT server_home candidate: ${POT_DIR}/server"

echo "==> ffmpeg check (needed for DASH merge + MP3)"
(command -v ffmpeg && ffmpeg -version | head -1) || echo "FFMPEG_MISSING_ON_PATH"
echo "==> imageio-ffmpeg fallback"
pip3 install -q imageio-ffmpeg
python -c "import imageio_ffmpeg as i; print('imageio ffmpeg:', i.get_ffmpeg_exe())"
