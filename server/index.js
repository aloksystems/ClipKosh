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
const { execFile } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

// Frontend lives in <project>/public; only that folder is exposed publicly.
const publicDir = path.join(__dirname, "..", "public");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36";

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

/** Resolve a direct YouTube stream URL via yt-dlp (best mp4 ≤1080p). */
function ytDlpUrl(videoUrl) {
  return new Promise((resolve) => {
    execFile(
      "yt-dlp",
      [
        "--no-warnings",
        "--skip-download",
        "--print",
        "%(url)s",
        "-f",
        "mp4[height<=1080]/best[ext=mp4]",
        videoUrl,
      ],
      { timeout: 90000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return resolve(null);
        const line = String(stdout || "").trim().split("\n")[0];
        resolve(/^https?:\/\//.test(line) ? line : null);
      }
    );
  });
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
    const dl = await ytDlpUrl(pageUrl);
    if (dl) {
      return {
        video: dl,
        thumb: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg",
      };
    }
    const err = new Error(
      "YouTube requires the 'yt-dlp' tool on the server. Install it: pip install yt-dlp"
    );
    err.code = "YTDLP_MISSING";
    throw err;
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
    res.json({
      platform,
      title: PLATFORM_TITLES[platform] || "Media",
      mimeType: "video/mp4",
      thumbnail: media.thumb,
      sizeBytes,
      downloadUrl: base + "/api/download?url=" + encodeURIComponent(media.video),
    });
  } catch (err) {
    if (err && err.code === "YTDLP_MISSING") {
      return res.status(501).json({ error: err.message });
    }
    res.status(500).json({ error: err.message || "Server error." });
  }
});

// Lightweight health check — lets the frontend (or any tunnel) confirm the
// API is reachable vs. hitting a static file server.
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "clipkosh" });
});

app.get("/api/download", async (req, res) => {
  const mediaUrl = req.query.url;
  if (!mediaUrl) return res.status(400).send("Missing url parameter.");

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

const server = app.listen(PORT, () => {
  console.log("ClipKosh running → http://localhost:" + PORT);
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
