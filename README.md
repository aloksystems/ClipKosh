# ClipKosh 📸

A minimal, premium-looking downloader for **Instagram**, **Facebook** and **YouTube** videos. Dark aurora theme, glassmorphism UI, and a lightweight Node/Express backend proxy. Paste a share link, get a clean HD copy.

## Structure

```
.
├── public/           # Frontend (served by Express — the only exposed folder)
│   ├── index.html    #   markup
│   ├── styles.css    #   premium aurora/glass design
│   └── script.js     #   validation / loading / resolve logic
└── server/           # Backend proxy (never exposed publicly)
    ├── index.js      # Express server: static + resolve + download streaming
    └── package.json
```

## How it works

Browsers cannot fetch these media files directly (CORS + platform protections), so a small backend does it:

1. **`POST /api/resolve`** — detects the platform (Instagram / Facebook / YouTube), extracts the direct video URL plus real file size (HEAD), and returns it as JSON (with a `downloadUrl`).
2. **`GET /api/download?url=…`** — proxies/streams the video to the browser as an attachment. Supports HTTP **Range** requests, so the result card's inline `<video>` preview plays directly from the stream.
3. **`GET /api/thumb?url=…`** — optional image proxy that fetches thumbnails with the right referer (CDNs block hotlinking from other origins).
4. **`GET /api/download-yt?url=…&fmt=…&aud=…`** — YouTube video download via `yt-dlp` (the platform's direct googlevideo URLs are throttled/bot-protected, so downloads go through `yt-dlp`, which handles signatures, cookies, and DASH video+audio merging). Yields an MP4.
5. **`GET /api/download-audio-yt?url=…&fmt=…&abr=…`** — YouTube audio → MP3 via `yt-dlp` + ffmpeg transcode (abr 32–320).

Media extraction per platform:
- **Instagram** — headless Chromium render (Puppeteer) → static `og:video` / `video_versions` scrape → optional external resolver.
- **Facebook** — static `og:video` / JSON `playable_url` scrape, with a browser-render fallback.
- **YouTube** — the [yt-dlp](https://github.com/yt-dlp/yt-dlp) tool fetches the best mp4 stream (≤1080p). The server must have `yt-dlp` installed (see below). YouTube results also include an **MP3 audio** download (transcoded on the fly with ffmpeg).

## Run

```bash
cd server
npm install
npm start
```

Then open **http://localhost:3000**.

> **For YouTube support**, also install `yt-dlp` and make sure it's on the PATH:
> `pip install yt-dlp` (or drop `yt-dlp.exe` somewhere on PATH on Windows).
> Instagram and Facebook work without it.
>
> **Age-restricted / private YouTube videos:** set the `YOUTUBE_COOKIES` env
> variable to a cookies file path (e.g. exported via the "Get cookies.txt
> LOCALLY" browser extension) so `yt-dlp` can pass sign-in/age verification.
> Example: `set YOUTUBE_COOKIES=C:\path\to\cookies.txt`.
>
> On **Render (or any host where you can't upload a file easily)**, export the
> cookie file to a compact base64 and set the single-line `YOUTUBE_COOKIES_B64`
> env variable instead. Use the included helper so the value stays small —
> Render fails deploys with "argument list too long" if a full cookie file
> (~178 KB) is set as an env variable:
> ```powershell
> node server\make-cookies-b64.js D:\Downloads\cookies.txt D:\cookies-compact.b64
> ```
> Then paste the contents of `D:\cookies-compact.b64` (a single line) into the
> service's `YOUTUBE_COOKIES_B64` variable. The server decodes it and writes a
> temporary cookie file at startup.
>
> Without cookies, age-restricted videos return a clear "requires sign-in"
> message instead of silently failing. Note the bot-check ("sign in to confirm
> you're not a bot") is mostly IP-based, so cookies help with age/private videos
> but may not fully defeat the check on shared server IPs — the server retries
> once automatically for that case.

There is also a tiny **`GET /api/health`** endpoint (returns `{"ok":true}`). The frontend pings it on load and shows a small status badge in the footer — **API online / API offline** — so you can instantly tell whether the page you're viewing is talking to Express or to a static file server.

Download links are generated automatically from the host the request arrives on (so LAN and deployed URLs work without config). If you need to override the base, set **`BASE_URL`** (e.g. `set BASE_URL=https://your-domain.com`).

To plug in an external resolver API: `set RESOLVER_URL=https://your-resolver.example/api`.

### Performance / load tunables (all optional)

| Env var | Default | Effect |
| --- | --- | --- |
| `YT_IMPERSONATE` | *(off)* | e.g. `chrome` → passes `--impersonate chrome` to `yt-dlp` (strongly reduces YouTube bot-checks; needs the `curl_cffi` package installed). |
| `YT_RETRY_DELAY_MS` | `1000` | Pause between `yt-dlp` player-client fallback attempts. |
| `RESOLVE_CACHE_TTL_MS` | `300000` | How long a resolved YouTube result (formats/URLs) is reused so repeat lookups skip the slow `yt-dlp` walk. |
| `YT_MAX_CONCURRENCY` | `2` | Max simultaneous `yt-dlp`/`ffmpeg` child processes — keeps the server stable under bursts. |

The frontend also auto-starts processing the moment you paste a link (no need to press Download).

## Running it all the time + using it from your phone

Two things are usually needed: (1) have the server keep running even when you're not babysitting a terminal, and (2) reach it from your phone. These are **separate** problems — pick what fits.

### A. Keep the server running (no open terminal needed)

- **Windows (best/easy):** install [PM2](https://pm2.keymetrics.io/) and run it as a service so it starts on boot:
  ```bash
  cd server
  npm i -g pm2
  pm2 start index.js --name clipkosh
  pm2 save
  pm2 startup   # follow its instructions to auto-start on boot
  ```
- **Windows (no extra tools):** create a `start.bat` and put a shortcut in `shell:startup`:
  ```bat
  @echo off
  cd /d D:\Projects\Instagram-reel-downloader\server
  node index.js
  ```

### B. Reach it from your phone

- **Same Wi‑Fi (quick, free):** start the server, find your PC's LAN IP (`ipconfig` → IPv4, e.g. `192.168.1.5`), then on your phone open **`http://192.168.1.5:3000`**. No tunnel, no internet upload — just your home network.
- **From anywhere (production):** deploy to a free host that runs the app 24/7 and gives a public HTTPS URL. The repo already includes **[`render.yaml`](./render.yaml)** — on **Render**, create a **Web Service → point it at this repo (or upload the folder)** and it picks up the config automatically (start runs `npm start`, health check at `/api/health`). You get a URL like `https://your-app.onrender.com`. **[Railway](https://railway.app)** works similarly.
  - > **Important:** if you create the Web Service manually (New → Web Service), set **Root Directory** to `server` and **Build Command** to `bash render-build.sh`. `render.yaml` is only read for Blueprint (infra-as-code) deploys — a manually created service uses the dashboard settings instead. `render-build.sh` installs Puppeteer's Chromium into the in-app cache (so it ships with the runtime image), `yt-dlp`, and verifies Chrome's shared libraries.
  - Then open that URL on your phone — it works anywhere, even off your phone's Wi‑Fi.
  - > **Vercel caveat:** Vercel is serverless and cannot run Puppeteer/Chromium, so this backend (especially Instagram/YouTube) won't fit there. Stick with Render/Railway for the full app. If you ever separate the frontend from the API, the `public/` folder alone could be hosted on Vercel pointing at a Render API.

> The download links returned by the API use the current host automatically (or `BASE_URL` if set). If you deploy, always open the deployed URL (not `localhost`) so downloads work there too.

## Notes

- Only works for **public** content. Private/unavailable posts return a clean error.
- Respect each platform's [Terms of Service](https://help.instagram.com/581066165581870) and creators' rights — only download media you own or have permission to save.
- YouTube uses `yt-dlp`; be aware it's third-party tooling and subject to YouTube's terms.
- The Telegram/other platforms are not supported — add them in `detectPlatform()` + a new extractor if you want them.
