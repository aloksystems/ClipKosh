/**
 * ClipKosh — backend proxy.
 *
 * A tiny Express server that:
 *  1. Serves the frontend (static files from /public).
 *  2. POST /api/resolve — detects the source platform, extracts the direct
 *     video URL, and returns it as JSON.
 *  3. GET  /api/download?url=... — proxies/streams the video to the browser
 *     as an attachment download.
 *
 * Platforms:
 *  - Instagram: headless Chromium render (Puppeteer) + static og:video scrape.
 *  - Facebook:  static og:video / JSON "playable_url" scrape + browser fallback.
 *  - YouTube:   yt-dlp binary (best quality mp4); requires the tool installed.
 *
 * Run:  npm install && npm start  (inside /server)
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

// Frontend lives in <project>/public; only that folder is exposed publicly.
const publicDir = path.join(__dirname, "..", "public");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36";

const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
let FFMPEG_BIN = process.env.FFMPEG_PATH || null;

/*
 * YouTube anti-bot handling.
 *  - PO/POT token: modern youtube web/tv clients often demand a PO token. Provide
 *    one as "visitor_data:po_token" in YOUTUBE_PO_TOKEN (or base64 in
 *    YOUTUBE_PO_TOKEN_B64). When set, we pin player_client=web and inject the token.
 *  - Otherwise, on a bot-check we retry with less bot-strict player clients in
 *    turn: default → tv_embedded → android.
 */
let YT_PO_TOKEN = null;
{
  const raw = process.env.YOUTUBE_PO_TOKEN;
  if (raw && raw.includes(":")) YT_PO_TOKEN = raw.trim();
  else if (process.env.YOUTUBE_PO_TOKEN_B64) {
    try {
      const s = Buffer.from(process.env.YOUTUBE_PO_TOKEN_B64, "base64").toString("utf8");
      if (s.includes(":")) YT_PO_TOKEN = s.trim();
    } catch (_) { /* ignore malformed base64 */ }
  }
}

/*
 * bgutil PO Token provider (generation-script mode).
 * Installed by render-build.sh into $HOME/bgutil-ytdlp-pot-provider/server.
 * When present, the bgutil plugin will invoke that script to mint PO tokens,
 * which is the modern way to satisfy YouTube's bot/PO checks.
 */
const YT_BGUTIL_HOME =
  process.env.YT_BGUTIL_HOME ||
  path.join(os.homedir(), "bgutil-ytdlp-pot-provider", "server") ||
  null;

// Player-client fallback chain (empty string = default web).
// mweb is the client the bgutil PO token provider is designed to pair with.
const YT_CLIENTS = ["", "mweb", "tv_embedded", "android"];

/*
 * Optional tunables (all env-gated, sensible defaults when unset):
 *  - YT_IMPERSONATE:  e.g. "chrome" — pass --impersonate to yt-dlp (helps a
 *    lot against YouTube's bot check, but needs the curl_cffi package).
 *  - YT_RETRY_DELAY_MS: pause between player-client fallback attempts.
 *  - RESOLVE_CACHE_TTL_MS: how long a resolved YouTube result is reused.
 *  - YT_MAX_CONCURRENCY: max simultaneous yt-dlp/ffmpeg child processes.
 */
const YT_IMPERSONATE = process.env.YT_IMPERSONATE || "";
const YT_RETRY_DELAY_MS = Number(process.env.YT_RETRY_DELAY_MS) || 1000;
const RESOLVE_CACHE_TTL_MS =
  Number(process.env.RESOLVE_CACHE_TTL_MS) || 5 * 60 * 1000;
const resolveCache = new Map();
function cacheGet(key) {
  const hit = resolveCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  if (hit) resolveCache.delete(key);
  return undefined;
}
function cacheSet(key, value) {
  const now = Date.now();
  // Keep the map bounded: drop expired entries first, then hard-reset if huge.
  if (resolveCache.size > 2000) {
    for (const [k, v] of resolveCache) if (v.exp < now) resolveCache.delete(k);
    if (resolveCache.size > 2000) resolveCache.clear();
  }
  resolveCache.set(key, { value, exp: now + RESOLVE_CACHE_TTL_MS });
}

/* A tiny semaphore so heavy external jobs (yt-dlp/ffmpeg) never spawn more than
 * `max` at once — this is what keeps the server stable under bursts of requests. */
function makeLimiter(max) {
  let active = 0;
  const queue = [];
  function next() {
    if (active >= max || !queue.length) return;
    active++;
    const job = queue.shift();
    job().finally(() => {
      active--;
      next();
    });
  }
  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push(() => Promise.resolve().then(fn).then(resolve, reject));
      next();
    });
  };
}
const ytOpLimiter = makeLimiter(Number(process.env.YT_MAX_CONCURRENCY) || 2);

function ytPotArgs() {
  if (YT_BGUTIL_HOME && fs.existsSync(path.join(YT_BGUTIL_HOME, "build", "main.js"))) {
    return [
      "--extractor-args",
      "youtubepot-bgutilscript:server_home=" + YT_BGUTIL_HOME,
    ];
  }
  return [];
}

function ytAttemptArgs(clientIdx) {
  if (YT_PO_TOKEN) {
    return ["--extractor-args", "youtube:po_token=" + YT_PO_TOKEN];
  }
  const args = [];
  if (YT_IMPERSONATE) {
    args.push("--impersonate", YT_IMPERSONATE);
  }
  const client = YT_CLIENTS[clientIdx] || "";
  if (client) args.push("--extractor-args", "youtube:player_client=" + client);
  return args.concat(ytPotArgs());
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Puppeteer must find the Chrome installed during build. Render's build
// installs Chrome into the in-app cache (via render-build.sh) so it survives
// into the runtime image; keep runtime pointed at that same place.
if (!process.env.PUPPETEER_CACHE_DIR) {
  process.env.PUPPETEER_CACHE_DIR = path.join(
    __dirname,
    "..",
    ".cache",
    "puppeteer"
  );
}

/** Is the yt-dlp binary usable on this server? (memoized after first check) */
let ytdlpReadyPromise = null;
function hasYtDlp() {
  if (!ytdlpReadyPromise) {
    ytdlpReadyPromise = new Promise((resolve) => {
      execFile(YTDLP, ["--version"], { timeout: 15000 }, (err, stdout) => {
        resolve(!err && /^20\d\d\./.test(String(stdout || "").trim()));
      });
    });
  }
  return ytdlpReadyPromise;
}

app.use(express.json());
app.disable("x-powered-by");
app.use(express.static(publicDir));

/* ---------------- media extraction ---------------- */

/** Pull the first http(s) URL from a JSON video_versions block. */
function parseVideoUrlsFromHtml(html) {
  const urlSet = new Set();
  const blockMatch = html.match(/"video_versions":\s*\[([^]*?)\]/);
  const source = blockMatch ? blockMatch[1] : html;
  const re = /"url":"([^"]+)"/g;
  let m;
  while ((m = re.exec(source))) {
    const u = m[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
    if (/^https?:\/\//.test(u) && !urlSet.has(u)) urlSet.add(u);
  }
  return [...urlSet];
}

/** Static scrape: og:video / og:video:secure_url / video_url. */
function parseStatic(html) {
  const ogVideo = html.match(/property="og:video"\s+content="([^"]+)"/);
  if (ogVideo) return ogVideo[1];
  const ogSecure = html.match(/property="og:video:secure_url"\s+content="([^"]+)"/);
  if (ogSecure) return ogSecure[1];
  const videoUrl = html.match(/"video_url"\s*:\s*"([^"]+)"/);
  if (videoUrl) {
    return videoUrl[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  }
  return null;
}

/** Extract the thumbnail (display_url / og:image) from a page. */
function parseThumb(html) {
  const re = /"display_url":"([^"]+)"/;
  const m = html.match(re);
  if (m) {
    const u = m[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
    if (/^https?:\/\//.test(u)) return u;
  }
  const og = html.match(/property="og:image"\s+content="([^"]+)"/);
  return og ? og[1] : null;
}

/* ---------------- platform helpers ---------------- */

/** Which source does this URL belong to? Returns null if unsupported. */
function detectPlatform(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (e) {
    return null;
  }
  const h = u.hostname.toLowerCase();
  if (/(?:^|\.)instagram\.com$/.test(h)) return "instagram";
  if (/(?:^|\.)facebook\.com$/.test(h) || /(?:^|\.)fb\.watch$/.test(h)) return "facebook";
  if (/(?:^|\.)youtube\.com$/.test(h) || /(?:^|\.)youtu\.be$/.test(h)) return "youtube";
  return null;
}

/** Extract an 11-char YouTube video id from a URL. */
function ytId(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.hostname.toLowerCase() === "youtu.be") {
      return u.pathname.replace(/^\//, "").split("/")[0] || null;
    }
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = u.pathname.match(/^\/embed\/([\w-]{11})/);
    if (m) return m[1];
    const m2 = u.pathname.match(/^\/shorts\/([\w-]{11})/);
    if (m2) return m2[1];
  } catch (e) { /* ignore */ }
  return null;
}

/** Pull a Facebook video URL from an HTML/JSON blob (prefers HD). */
function parseFacebookVideo(html) {
  let m = html.match(/"playable_url_quality_hd":"([^"]+)"/);
  if (!m) m = html.match(/"playable_url":"([^"]+)"/);
  if (m) {
    const u = m[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
    if (/^https?:\/\//.test(u)) return u;
  }
  return parseStatic(html);
}

/**
 * Resolve where yt-dlp should read cookies from. Supports:
 *   - YOUTUBE_COOKIES / COOKIES_FILE   → a file path on the server
 *   - YOUTUBE_COOKIES_B64              → base64 of the full Netscape cookie file
 *     (easiest: paste into a single-line Render env variable)
 * Returns null when no cookies are configured.
 */
function resolveCookieFile() {
  const b64 = process.env.YOUTUBE_COOKIES_B64;
  if (b64) {
    console.log("[yt] YOUTUBE_COOKIES_B64 length:", b64.length);
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      const p = path.join(os.tmpdir(), "clipkosh-cookies-" + process.pid + ".txt");
      fs.writeFileSync(p, decoded);
      return p;
    } catch (e) {
      return null;
    }
  }

  const raw = process.env.YOUTUBE_COOKIES || process.env.COOKIES_FILE || null;
  if (!raw) return null;
  // Already a real file on disk — use it directly.
  if (fs.existsSync(raw)) return raw;
  // Inline Netscape cookie content → write it to a temp file.
  if (/^# Netscape/i.test(raw.trim()) || /\tyoutube\.com\t/.test(raw)) {
    const p = path.join(os.tmpdir(), "clipkosh-cookies-" + process.pid + ".txt");
    try {
      fs.writeFileSync(p, raw);
      return p;
    } catch (e) {
      return null;
    }
  }
  return raw;
}

const YT_COOKIES_FILE = resolveCookieFile();

// Prefer a combined (video+audio) direct-https MP4 so the download has sound and
// is a real file (never an m3u8 HLS manifest, which SABR accounts hand out).
const YT_VIDEO_FMT =
  "best[ext=mp4][protocol^=https][height<=1080]" +
  "/best[ext=mp4][protocol^=https]" +
  "/mp4[height<=1080][protocol^=https]" +
  "/best[ext=mp4]/mp4/best";
const YT_AUDIO_FMT =
  "bestaudio[ext=m4a][protocol^=https]/bestaudio[ext=m4a]/bestaudio";

/**
 * Run yt-dlp once with extra args (already includes --no-playlist/--no-warnings
 * /--skip-download). Returns { stdout, stderr }.
 */
function runYtDlp(extraArgs, videoUrl, opts) {
  opts = opts || {};
  const useCookies = opts.cookies !== false && YT_COOKIES_FILE;
  const args = ["--no-playlist", "--no-warnings", "--skip-download"];
  args.push(...extraArgs);
  if (useCookies) args.push("--cookies", YT_COOKIES_FILE);
  args.push(videoUrl);
  return ytOpLimiter(
    () =>
      new Promise((resolve) => {
        execFile(
          YTDLP,
          args,
          { timeout: 90000, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout, stderr) => {
            resolve({
              stdout: String(stdout || ""),
              stderr: String(stderr || ""),
              err,
            });
          }
        );
      })
  );
}

/**
 * Locate an ffmpeg binary. Priority: FFMPEG_PATH env → "ffmpeg" on PATH →
 * imageio-ffmpeg (pip) binary. Called once at startup.
 */
function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) {
    FFMPEG_BIN = process.env.FFMPEG_PATH;
    return Promise.resolve();
  }
  const onPath = new Promise((resolve) => {
    execFile("ffmpeg", ["-version"], { timeout: 5000 }, (e) => resolve(!e));
  });
  return onPath.then((ok) => {
    if (ok) {
      FFMPEG_BIN = "ffmpeg";
      return;
    }
    return new Promise((resolve) => {
      execFile(
        "python",
        ["-c", "import imageio_ffmpeg as i; print(i.get_ffmpeg_exe())"],
        { timeout: 10000 },
        (err, stdout) => {
          FFMPEG_BIN = !err && String(stdout).trim() ? String(stdout).trim() : "ffmpeg";
          resolve();
        }
      );
    });
  });
}

/** Fetch the full YouTube info JSON (one JS solve, faster than two runs). */
async function getYtInfo(videoUrl) {
  if (YT_PO_TOKEN) {
    const r = await runYtDlp(
      ["--js-runtime", "node", ...ytAttemptArgs(0), "--print-json"],
      videoUrl,
      { cookies: true }
    );
    if (classifyYtError(r.stderr).code !== "BOT") {
      if (r.err) return null;
      try {
        return JSON.parse(r.stdout.trim());
      } catch (e) {
        return null;
      }
    }
    return null;
  }
  // Attempts: web+cookies → web w/o cookies → tv_embedded → android.
  const attrs = [
    { client: 0, cookies: true },
    { client: 0, cookies: false },
    { client: 1, cookies: false },
    { client: 2, cookies: false },
  ];
  // No cookies configured → skip the redundant first attempt.
  const attempts = YT_COOKIES_FILE ? attrs : attrs.slice(1);
  for (const a of attempts) {
    const r = await runYtDlp(
      ["--js-runtime", "node", ...ytAttemptArgs(a.client), "--print-json"],
      videoUrl,
      { cookies: a.cookies }
    );
    if (classifyYtError(r.stderr).code !== "BOT") {
      if (r.err) return null;
      try {
        return JSON.parse(r.stdout.trim());
      } catch (e) {
        return null;
      }
    }
    // Transient bot-check — pause briefly before trying the next config.
    await sleep(YT_RETRY_DELAY_MS);
  }
  return null;
}

/** Only direct media URLs (never m3u8 HLS manifests) are downloadable. */
function isDirectFormat(f) {
  return (
    f &&
    /^https?:\/\//.test(f.url || "") &&
    !/\.m3u8(\?|$)/i.test(f.url) &&
    f.protocol !== "m3u8_native"
  );
}

/**
 * Build the selectable video/audio quality lists from yt-dlp's JSON.
 * Progressive formats combine audio+video; DASH video-only formats need an
 * ffmpeg merge with the best audio (handled by /api/download?merge=1).
 */
function buildFormats(info) {
  const fmts = (info && info.formats) || [];
  const video = [];
  const audio = [];
  const seenV = new Set();
  const seenA = new Set();

  for (const f of fmts) {
    if (!isDirectFormat(f)) continue;
    const hasV = f.vcodec && f.vcodec !== "none";
    const hasA = f.acodec && f.acodec !== "none";
    if (!hasV && !hasA) continue;

    if (hasV) {
      const h = f.height || f.width || 0;
      const key = "v" + (h || f.format_id);
      if (!seenV.has(key)) {
        seenV.add(key);
        video.push({
          id: String(f.format_id),
          label: h ? h + "p" : "video",
          height: h || null,
          ext: f.ext || "mp4",
          hasAudio: hasA,
          url: f.url,
        });
      }
    }

    if (hasA && !hasV) {
      if (!seenA.has(String(f.format_id))) {
        seenA.add(String(f.format_id));
        const abr = Math.round(Number(f.abr) || 0);
        audio.push({
          id: String(f.format_id),
          label: abr ? abr + " kbps" : "audio",
          abr,
          ext: f.ext || "m4a",
          url: f.url,
        });
      }
    }
  }

  video.sort((a, b) => (b.height || 0) - (a.height || 0));
  audio.sort((a, b) => (a.abr || 0) - (b.abr || 0));

  const defVideo =
    video.find((v) => v.hasAudio && v.height <= 1080) ||
    video.find((v) => v.ext === "mp4" && v.height <= 1080) ||
    video.find((v) => v.ext === "mp4") ||
    video[0] ||
    null;
  const defAudio = [...audio].sort((a, b) => (b.abr || 0) - (a.abr || 0))[0] || null;

  return {
    video,
    audio,
    defVideo,
    defAudio,
    defVideoId: defVideo ? defVideo.id : null,
    defAudioId: defAudio ? defAudio.id : null,
  };
}

/** Download a remote URL to a temp file (for ffmpeg transcode/merge). */
async function fetchToTemp(url, destPath) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: "https://www.youtube.com/",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const handle = await fsp.open(destPath, "w");
  try {
    for await (const chunk of res.body) {
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  const st = await fsp.stat(destPath);
  if (st.size === 0) throw new Error("Empty media stream");
  return st.size;
}

function tmpPath(prefix, ext) {
  return path.join(
    os.tmpdir(),
    prefix + "-" + crypto.randomBytes(5).toString("hex") + (ext || ".tmp")
  );
}

/** Stream a local file to the HTTP response, honoring backpressure. */
async function streamFile(filePath, res) {
  const handle = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(256 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buf);
      if (bytesRead === 0) break;
      const chunk = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
      if (!res.write(chunk)) {
        await new Promise((r) => res.once("drain", r));
      }
    }
    res.end();
  } finally {
    await handle.close();
  }
}

/**
 * Download a YouTube video/audio format via yt-dlp to a local temp file.
 * yt-dlp handles the 'n' signature, throttling, cookies, and DASH merging,
 * which raw fetches of googlevideo URLs do not (they hang/timed out).
 */
function downloadYtFormat(videoUrl, fmtSpec, outPath) {
  return downloadYtFormatTry(videoUrl, fmtSpec, outPath, 0);
}

/** yt-dlp download with PO-token support and retry on bot-check. */
async function downloadYtFormatTry(videoUrl, fmtSpec, outPath, clientIdx) {
  const useCookies = clientIdx === 0 && YT_COOKIES_FILE;
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--js-runtime",
    "node",
    ...ytAttemptArgs(clientIdx),
  ];
  if (useCookies) args.push("--cookies", YT_COOKIES_FILE);
  if (FFMPEG_BIN) args.push("--ffmpeg-location", FFMPEG_BIN);
  args.push("-f", fmtSpec, "-o", outPath);
  if (fmtSpec.includes("+")) args.push("--merge-output-format", "mp4");
  args.push(videoUrl);

  const r = await ytOpLimiter(
    () =>
      new Promise((resolve) => {
        execFile(
          YTDLP,
          args,
          { timeout: 300000, maxBuffer: 32 * 1024 * 1024 },
          (err, stdout, stderr) => {
            resolve({
              stdout: String(stdout || ""),
              stderr: String(stderr || ""),
              err,
            });
          }
        );
      })
  );

  if (!r.err) return r;
  const reason = classifyYtError(r.stderr).code;
  if (
    (reason === "BOT" || reason === "AGE") &&
    !YT_PO_TOKEN &&
    clientIdx < YT_CLIENTS.length - 1
  ) {
    await sleep(YT_RETRY_DELAY_MS);
    return downloadYtFormatTry(videoUrl, fmtSpec, outPath, clientIdx + 1);
  }
  return r;
}

/** Merge two direct streams (DASH video-only + audio) into one MP4. */
async function serveMerged(req, res, vUrl, aUrl) {
  const vTmp = tmpPath("ck-v", ".mp4");
  const aTmp = tmpPath("ck-a", ".m4a");
  const oTmp = tmpPath("ck-m", ".mp4");
  try {
    await Promise.all([fetchToTemp(vUrl, vTmp), fetchToTemp(aUrl, aTmp)]);
    await new Promise((resolve, reject) => {
      const ff = spawn(FFMPEG_BIN, [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        vTmp,
        "-i",
        aTmp,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-shortest",
        oTmp,
      ]);
      let errOut = "";
      ff.stderr.on("data", (d) => (errOut += d));
      ff.on("error", reject);
      ff.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error("ffmpeg merge failed (" + code + ") " + errOut))
      );
    });
    const st = await fsp.stat(oTmp);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="clipkosh.mp4"');
    res.setHeader("Content-Length", String(st.size));
    await streamFile(oTmp, res);
  } finally {
    await Promise.all(
      [vTmp, aTmp, oTmp].map((p) => fsp.rm(p, { force: true }).catch(() => {}))
    );
  }
}

/** Map yt-dlp stderr hints to a friendly, specific user message. */
function classifyYtError(stderr) {
  const s = stderr.toLowerCase();
  if (/sign in to confirm|confirm you'?re not a bot|captcha|bot check|automated request/i.test(s)) {
    return { code: "BOT", message: "YouTube flagged this request as automated (bot check). Please try again in a few minutes." };
  }
  if (/age-restricted|age restriction|signed out.*age|18\+ video/i.test(s)) {
    return { code: "AGE", message: "This video is age-restricted and needs sign-in cookies to resolve." };
  }
  if (/not available in your country|blocked.*country|playback.*country|geo-restricted|regional restriction/i.test(s)) {
    return { code: "REGION", message: "This video is not available in your region." };
  }
  if (/private video/i.test(s)) {
    return { code: "PRIVATE", message: "This video is private and can't be downloaded without access." };
  }
  if (/video unavailable|unavailable|has been removed|taken down/i.test(s)) {
    return { code: "UNAVAILABLE", message: "This video is unavailable or has been removed." };
  }
  return {
    code: "UNKNOWN",
    message: "Couldn't extract this YouTube video (it may be private, age/region-restricted, or unavailable).",
  };
}

/** Best-effort content length via a HEAD request. */
async function headLength(url) {
  try {
    const r = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": USER_AGENT, Referer: "https://www.instagram.com/" },
    });
    if (!r.ok) return 0;
    const len = parseInt(r.headers.get("content-length") || "0", 10);
    return Number.isFinite(len) ? len : 0;
  } catch (e) {
    return 0;
  }
}

/* Lazy shared headless browser. */
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    try {
      const puppeteer = require("puppeteer");
      browserPromise = puppeteer.launch({
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });
    } catch (e) {
      browserPromise = Promise.reject(e);
    }
  }
  return browserPromise;
}

/** Render a page in headless Chromium and return its final HTML. */
async function renderHtml(pageUrl, marker) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (marker) {
      await page
        .waitForFunction(
          (m) => document.documentElement.outerHTML.includes(m),
          { timeout: 30000 },
          marker
        )
        .catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 1500));
    return await page.evaluate(() => document.documentElement.outerHTML);
  } finally {
    await page.close().catch(() => {});
  }
}

async function extractWithBrowser(pageUrl) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    await page
      .waitForFunction(
        () => document.documentElement.outerHTML.includes("video_versions"),
        { timeout: 30000 }
      )
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    const html = await page.evaluate(() => document.documentElement.outerHTML);
    const fromBrowser = parseVideoUrlsFromHtml(html);
    let thumb = parseThumb(html);
    // The image CDN requires session cookies, so download the thumbnail inside the
    // rendered page (cookie-aware) and return it as a data URI.
    if (thumb) {
      const dataUri = await page
        .evaluate(async (u) => {
          try {
            const r = await fetch(u, { credentials: "include" });
            if (!r.ok) return null;
            const blob = await r.blob();
            return await new Promise((resolve) => {
              const fr = new FileReader();
              fr.onload = () => resolve(fr.result);
              fr.readAsDataURL(blob);
            });
          } catch (e) {
            return null;
          }
        }, thumb)
        .catch(() => null);
      if (dataUri) thumb = dataUri;
    }
    if (fromBrowser.length) return { video: fromBrowser[0], thumb };
    const staticUrl = parseStatic(html);
    if (staticUrl) return { video: staticUrl, thumb };
    return { video: null, thumb };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Extract a Facebook video URL. */
async function extractFacebook(pageUrl) {
  try {
    const res = await fetch(pageUrl, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (res.ok) {
      const html = await res.text();
      const v = parseFacebookVideo(html);
      if (v) return { video: v, thumb: parseThumb(html) };
    }
  } catch (e) { /* ignore */ }

  try {
    const html = await renderHtml(pageUrl, "playable_url");
    const v = parseFacebookVideo(html);
    if (v) return { video: v, thumb: parseThumb(html) };
  } catch (e) {
    console.warn("[clipkosh] facebook browser extraction failed:", e.message);
  }
  return null;
}

/** Instagram extraction chain: browser → static scrape → external resolver. */
async function extractInstagram(pageUrl) {
  try {
    const r = await extractWithBrowser(pageUrl);
    if (r.video) return r;
  } catch (e) {
    console.warn("[clipkosh] browser extraction failed:", e.message);
  }

  try {
    const res = await fetch(pageUrl, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (res.ok) {
      const html = await res.text();
      const staticUrl = parseStatic(html);
      if (staticUrl) return { video: staticUrl, thumb: parseThumb(html) };
    }
  } catch (e) { /* ignore */ }

  const resolver = process.env.RESOLVER_URL;
  if (resolver) {
    try {
      const r = await fetch(resolver, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: pageUrl }),
      });
      if (r.ok) {
        const data = await r.json();
        const mediaUrl = data.downloadUrl || (data.data && data.data[0]);
        if (mediaUrl && /^https?:\/\//.test(mediaUrl)) {
          return { video: mediaUrl, thumb: data.thumbnail || null };
        }
      }
    } catch (e) { /* ignore */ }
  }
  return null;
}

/**
 * Dispatch extraction based on the source platform.
 * Throws { code: "YTDLP_MISSING" } when YouTube requires yt-dlp and it's absent.
 */
async function extractMedia(pageUrl, platform) {
  if (platform === "instagram") return extractInstagram(pageUrl);
  if (platform === "facebook") return extractFacebook(pageUrl);
  if (platform === "youtube") {
    const id = ytId(pageUrl);
    if (!id) return null;

    const present = await hasYtDlp();
    if (!present) {
      const missing = new Error(
        "YouTube requires the 'yt-dlp' tool on the server (missing during build)."
      );
      missing.code = "YTDLP_MISSING";
      throw missing;
    }

    // Reuse a recent resolution for the same video — the expensive yt-dlp
    // walk (and any bot-check retries) only runs once per video per TTL.
    const cacheKey = "yt:" + id;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const info = await getYtInfo(pageUrl);
    if (!info) {
      // No usable info — figure out *why* so the user gets a specific message.
      const probe = await runYtDlp(["--js-runtime", "node", "--print", "%(url)s", "-f", YT_VIDEO_FMT], pageUrl);
      const reason = classifyYtError(probe.stderr);
      const blocked = new Error(reason.message);
      blocked.code = "YT_RESOLVE_FAILED";
      blocked.detail = reason.code;
      throw blocked;
    }

    const formats = buildFormats(info);
    if (!formats.defVideo) {
      const blocked = new Error(
        "Couldn't extract this YouTube video (it may be private, age/region-restricted, or unavailable)."
      );
      blocked.code = "YT_RESOLVE_FAILED";
      blocked.detail = "UNKNOWN";
      throw blocked;
    }

    const result = {
      video: formats.defVideo.url,
      thumb: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg",
      audioUrl: formats.defAudio ? formats.defAudio.url : null,
      formats,
    };
    cacheSet(cacheKey, result);
    return result;
  }
  return null;
}

/* ---------------- routes ---------------- */

const PLATFORM_TITLES = {
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
};

app.post("/api/resolve", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) {
      return res.status(400).json({ error: "url missing hai." });
    }

    const platform = detectPlatform(url);
    if (!platform) {
      return res.status(400).json({
        error: "That link isn't from Instagram, Facebook, or YouTube.",
      });
    }

    const media = await extractMedia(url, platform);
    if (!media || !media.video) {
      return res.status(422).json({
        error:
          "Couldn't reach the media (it may be private, removed, or the link is wrong).",
      });
    }

    const sizeBytes = await headLength(media.video);
    // Build download links from the public host/protocol the request came in on
    // (so LAN and Render's HTTPS proxy produce correct URLs), unless BASE_URL is
    // set. trust proxy is not enabled, so read the forwarded scheme explicitly.
    const proto =
      (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
      req.protocol;
    const base =
      process.env.BASE_URL || proto + "://" + req.get("host");
    const isYt = platform === "youtube";
    let downloadUrl, audioDownloadUrl;
    if (isYt && media.formats && media.formats.defVideoId) {
      const F = media.formats;
      const hasAV = F.defVideo && F.defVideo.hasAudio;
      downloadUrl =
        base +
        "/api/download-yt?url=" +
        encodeURIComponent(url) +
        "&fmt=" +
        encodeURIComponent(F.defVideoId) +
        (F.defAudioId && !hasAV
          ? "&aud=" + encodeURIComponent(F.defAudioId)
          : "");
      audioDownloadUrl = F.defAudioId
        ? base +
          "/api/download-audio-yt?url=" +
          encodeURIComponent(url) +
          "&fmt=" +
          encodeURIComponent(F.defAudioId) +
          "&abr=192"
        : null;
    } else {
      downloadUrl = base + "/api/download?url=" + encodeURIComponent(media.video);
      audioDownloadUrl = media.audioUrl
        ? base + "/api/download-audio?url=" + encodeURIComponent(media.audioUrl)
        : null;
    }
    res.json({
      platform,
      title: PLATFORM_TITLES[platform] || "Media",
      mimeType: "video/mp4",
      thumbnail: media.thumb,
      sizeBytes,
      downloadUrl,
      audioUrl: media.audioUrl || null,
      audioDownloadUrl,
      formats: media.formats || null,
      watch: isYt ? url : null,
    });
  } catch (err) {
    if (err && err.code === "YTDLP_MISSING") {
      return res.status(501).json({ error: err.message });
    }
    if (err && err.code === "YT_RESOLVE_FAILED") {
      return res.status(422).json({ error: err.message, detail: err.detail || null });
    }
    res.status(500).json({ error: err.message || "Server error." });
  }
});

// Lightweight health check — lets the frontend (or any tunnel) confirm the
// API is reachable vs. hitting a static file server.
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "clipkosh" });
});

/** YouTube download via yt-dlp (robust vs. throttled direct URLs). */
app.get("/api/download-yt", async (req, res) => {
  const watch = req.query.url;
  const fmt = req.query.fmt;
  const aud = req.query.aud;
  if (!watch || !fmt) return res.status(400).send("Missing url/fmt.");
  const spec = aud && aud !== fmt ? fmt + "+" + aud : fmt;
  const oTmp = tmpPath("ck-yt", ".mp4");
  try {
    const r = await downloadYtFormat(watch, spec, oTmp);
    if (r.err || !fs.existsSync(oTmp)) {
      return res
        .status(502)
        .send("Download failed: " + ((r.err && r.err.message) || "") + " " + r.stderr.slice(-400));
    }
    const st = await fsp.stat(oTmp);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="clipkosh.mp4"');
    res.setHeader("Content-Length", String(st.size));
    await streamFile(oTmp, res);
  } finally {
    await fsp.rm(oTmp, { force: true }).catch(() => {});
  }
});

/** YouTube audio → MP3 via yt-dlp + ffmpeg transcode. */
app.get("/api/download-audio-yt", async (req, res) => {
  const watch = req.query.url;
  const fmt = req.query.fmt;
  const abr = Math.min(320, Math.max(32, parseInt(req.query.abr, 10) || 192));
  if (!watch || !fmt) return res.status(400).send("Missing url/fmt.");
  const aTmp = tmpPath("ck-ya", ".m4a");
  const oTmp = tmpPath("ck-ymp3", ".mp3");
  try {
    const r = await downloadYtFormat(watch, fmt, aTmp);
    if (r.err || !fs.existsSync(aTmp)) {
      return res
        .status(502)
        .send("Audio extract failed: " + ((r.err && r.err.message) || "") + " " + r.stderr.slice(-400));
    }
    await new Promise((resolve, reject) => {
      const ff = spawn(FFMPEG_BIN, [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        aTmp,
        "-vn",
        "-b:a",
        abr + "k",
        oTmp,
      ]);
      let errOut = "";
      ff.stderr.on("data", (d) => (errOut += d));
      ff.on("error", reject);
      ff.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error("ffmpeg (" + code + ") " + errOut))
      );
    });
    const st = await fsp.stat(oTmp);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", 'attachment; filename="clipkosh.mp3"');
    res.setHeader("Content-Length", String(st.size));
    await streamFile(oTmp, res);
  } finally {
    await Promise.all(
      [aTmp, oTmp].map((p) => fsp.rm(p, { force: true }).catch(() => {}))
    );
  }
});

app.get("/api/download", async (req, res) => {
  const mediaUrl = req.query.url;
  if (!mediaUrl) return res.status(400).send("Missing url parameter.");

  // DASH video-only → merge with the chosen audio stream via ffmpeg.
  if (req.query.merge === "1" && req.query.audioUrl) {
    try {
      return await serveMerged(req, res, mediaUrl, req.query.audioUrl);
    } catch (err) {
      return res.status(502).send("Merge failed: " + (err.message || ""));
    }
  }

  try {
    const headers = {
      "User-Agent": USER_AGENT,
      Referer: "https://www.instagram.com/",
      Accept: "video/mp4,video/*,*/*;q=0.8",
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const remote = await fetch(mediaUrl, { headers });

    if (!remote.ok) {
      return res.status(remote.status).send("Could not fetch media.");
    }

    res.status(remote.status);
    res.setHeader("Content-Type", remote.headers.get("content-type") || "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="reel.mp4"');
    const cr = remote.headers.get("content-range");
    if (cr) res.setHeader("Content-Range", cr);
    const len = remote.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);

    for await (const chunk of remote.body) {
      res.write(chunk);
    }
    res.end();
  } catch (err) {
    res.status(500).send("Download failed: " + (err.message || ""));
  }
});

// Proxy thumbnail images (Instagram CDN blocks hotlinking from non-Instagram referers).
app.get("/api/thumb", async (req, res) => {
  const thumbUrl = req.query.url;
  if (!thumbUrl || !/^https?:\/\//.test(thumbUrl)) {
    return res.status(400).end();
  }
  try {
    const remote = await fetch(thumbUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Referer: "https://www.instagram.com/",
      },
    });
    if (!remote.ok) return res.status(remote.status).end();
    const ct = remote.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    for await (const chunk of remote.body) {
      res.write(chunk);
    }
    res.end();
  } catch (err) {
    res.status(502).end();
  }
});

// Audio download: fetches the requested audio stream to a temp file, transcodes
// it to MP3 at the requested bitrate with ffmpeg, then streams the result.
// Using a file-based pipeline (not a pipe) avoids premature-close/invalid
// responses that the old streaming ffmpeg pipe produced on Render.
app.get("/api/download-audio", async (req, res) => {
  const mediaUrl = req.query.url;
  if (!mediaUrl) return res.status(400).send("Missing url parameter.");

  const abr = parseInt(req.query.abr, 10);
  const kbps =
    Number.isFinite(abr) && abr > 0 ? Math.min(Math.max(abr, 32), 320) : 192;

  const srcTmp = tmpPath("ck-a-src", ".m4a");
  const outTmp = tmpPath("ck-a-out", ".mp3");
  try {
    await fetchToTemp(mediaUrl, srcTmp);
    await new Promise((resolve, reject) => {
      const ff = spawn(FFMPEG_BIN, [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        srcTmp,
        "-vn",
        "-ac",
        "2",
        "-b:a",
        kbps + "k",
        "-f",
        "mp3",
        outTmp,
      ]);
      let errOut = "";
      ff.stderr.on("data", (d) => (errOut += d));
      ff.on("error", reject);
      ff.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error("ffmpeg audio failed (" + code + ") " + errOut))
      );
    });
    const st = await fsp.stat(outTmp);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", 'attachment; filename="clipkosh-audio.mp3"');
    res.setHeader("Content-Length", String(st.size));
    await streamFile(outTmp, res);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return res.status(501).send("ffmpeg is not installed on the server (audio conversion unavailable).");
    }
    if (!res.headersSent) {
      res.status(502).send("Audio download failed: " + (err.message || ""));
    }
  } finally {
    await Promise.all(
      [srcTmp, outTmp].map((p) => fsp.rm(p, { force: true }).catch(() => {}))
    );
  }
});

resolveFfmpeg().then(() => {
  const server = app.listen(PORT, () => {
    console.log("ClipKosh running → http://localhost:" + PORT + " (ffmpeg: " + FFMPEG_BIN + ")");
  });
});

process.on("SIGINT", async () => {
  try {
    if (browserPromise) {
      const b = await browserPromise;
      await b.close().catch(() => {});
    }
  } finally {
    server.close(() => process.exit(0));
  }
});
