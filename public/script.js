(function () {
  "use strict";

  var RESOLVE_ENDPOINT = "/api/resolve";

  var form = document.getElementById("download-form");
  var input = document.getElementById("reel-url");
  var btn = document.getElementById("download-btn");
  var errorBox = document.getElementById("paste-error");
  var resultSection = document.getElementById("result");
  var preview = document.getElementById("preview");
  var titleEl = document.getElementById("result-title");
  var metaEl = document.getElementById("result-meta");
  var dlLink = document.getElementById("dl-link");
  var audioLink = document.getElementById("dl-audio");
  var qualityWrap = document.getElementById("quality-selects");
  var videoQuality = document.getElementById("video-quality");
  var audioQuality = document.getElementById("audio-quality");
  var copyBtn = document.getElementById("copy-link");
  var clearBtn = document.getElementById("clear-result");
  var sampleBtn = document.getElementById("sample-link");
  var toast = document.getElementById("toast");
  var yearEl = document.getElementById("year");
  var currentDownloadUrl = "";

  var SAMPLE_URL = "https://www.instagram.com/instagram/reel/DgLBIFYxY4O/";

  function prepareUrl(raw) {
    var s = String(raw || "").trim();
    if (!s) return null;
    // Strip decorations that sometimes wrap a copied link.
    s = s.replace(/^["'(<]+|["')>]+$/g, "");
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    return s;
  }

  function looksLikeSupported(url) {
    try {
      var h = new URL(url).hostname.toLowerCase();
      return (
        /(?:^|\.)instagram\.com$/.test(h) ||
        /(?:^|\.)facebook\.com$/.test(h) ||
        /(?:^|\.)fb\.watch$/.test(h) ||
        /(?:^|\.)youtube\.com$/.test(h) ||
        /(?:^|\.)youtu\.be$/.test(h)
      );
    } catch (e) {
      return /(?:^|\.)(?:instagram|facebook|youtube)\.com\//i.test(url);
    }
  }

  yearEl.textContent = new Date().getFullYear();

  function setLoading(on) {
    btn.classList.toggle("loading", on);
    btn.disabled = on;
    input.disabled = on;
  }

  // Human-readable hint for the server's yt-dlp detail codes.
  function ytDetailHint(detail) {
    switch (detail) {
      case "BOT":
        return "YouTube flagged this request as automated (bot check). Try again in a few minutes.";
      case "AGE":
        return "This video is age-restricted and needs sign-in cookies configured on the server.";
      case "REGION":
        return "This video isn't available in your region.";
      case "PRIVATE":
        return "Private videos can't be downloaded without the owner's access.";
      case "UNAVAILABLE":
        return "This video is unavailable or has been removed.";
      default:
        return "";
    }
  }

  function showError(msg, detail) {
    errorBox.innerHTML = "";
    errorBox.appendChild(document.createTextNode(msg));
    if (detail) {
      var hint = document.createElement("div");
      hint.className = "error-detail";
      hint.textContent = ytDetailHint(detail);
      errorBox.appendChild(hint);
    }
    errorBox.hidden = false;
  }

  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      toast.classList.remove("show");
    }, 2600);
  }

  function fmtSize(bytes) {
    if (!bytes || bytes <= 0) return "Size unknown";
    var units = ["B", "KB", "MB", "GB"];
    var i = 0;
    var n = bytes;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return n.toFixed(i === 0 ? 0 : 1) + " " + units[i];
  }

  function setResult(data) {
    currentDownloadUrl = data.downloadUrl || "";
    titleEl.textContent = data.title || "Instagram media";
    metaEl.textContent = [
      data.mimeType || "MP4",
      fmtSize(data.sizeBytes),
      "Live preview",
    ].filter(Boolean).join(" · ");

    dlLink.href = currentDownloadUrl;
    preview.src = currentDownloadUrl;

    if (data.audioDownloadUrl) {
      audioLink.href = data.audioDownloadUrl;
      audioLink.hidden = false;
    } else {
      audioLink.removeAttribute("href");
      audioLink.hidden = true;
    }

    setupQualitySelects(data);

    resultSection.hidden = false;
    resultSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function setupQualitySelects(data) {
    var videos = data.formats && data.formats.video ? data.formats.video : [];
    var audios = data.formats && data.formats.audio ? data.formats.audio : [];
    var isYt = (data.platform || "").toLowerCase() === "youtube";

    window.__ckVideos = videos;
    window.__ckAudios = audios;
    window.__ckPlatform = data.platform;
    window.__ckWatch = data.watch || "";

    // Video quality — only show when there's a real choice.
    var videoLabel = videoQuality.closest(".quality-select");
    if (videos.length > 1) {
      videoQuality.innerHTML = "";
      videos.forEach(function (v, i) {
        var opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = v.label + (v.hasAudio ? "" : " (needs audio merge)");
        videoQuality.appendChild(opt);
        if (v.id === data.formats.defVideoId) videoQuality.selectedIndex = i;
      });
      if (videoLabel) videoLabel.hidden = false;
    } else {
      videoQuality.innerHTML = "";
      if (videoLabel) videoLabel.hidden = true;
    }

    // MP3 bitrate — only meaningful for YouTube (separate audio tracks).
    // Instagram/Facebook videos already carry audio inside the MP4.
    var audioLabel = audioQuality.closest(".quality-select");
    if (isYt && audios.length) {
      audioQuality.innerHTML = "";
      audios.forEach(function (a, i) {
        var opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = a.label + (a.ext ? " (" + a.ext + ")" : "");
        audioQuality.appendChild(opt);
        if (a.id === data.formats.defAudioId) audioQuality.selectedIndex = i;
      });
      if (audioLabel) audioLabel.hidden = false;
    } else {
      audioQuality.innerHTML = "";
      if (audioLabel) audioLabel.hidden = true;
    }

    // Hide the whole row when there's nothing to choose.
    qualityWrap.hidden = videos.length <= 1 && !(isYt && audios.length);

    // Use onchange (not addEventListener) so repeated resolves never stack handlers.
    videoQuality.onchange = applyQualitySelections;
    audioQuality.onchange = applyQualitySelections;
    applyQualitySelections();
  }

  function selectedVideo() {
    var i = parseInt(videoQuality.value, 10);
    return (window.__ckVideos || [])[i] || null;
  }

  function selectedAudio() {
    var i = parseInt(audioQuality.value, 10);
    var list = window.__ckAudios || [];
    var a = list[i] || list[list.length - 1] || null;
    return a;
  }

  function applyQualitySelections() {
    var v = selectedVideo();
    if (!v) return;

    var isYt = window.__ckPlatform === "youtube";
    var watch = window.__ckWatch || "";
    var url;

    if (isYt) {
      url =
        "/api/download-yt?url=" +
        encodeURIComponent(watch) +
        "&fmt=" +
        encodeURIComponent(v.id);
      if (!v.hasAudio) {
        var a0 = selectedAudio();
        if (a0) url += "&aud=" + encodeURIComponent(a0.id);
      }
    } else {
      url = "/api/download?url=" + encodeURIComponent(v.url);
      if (!v.hasAudio) {
        var a1 = selectedAudio();
        var aUrl = a1 ? a1.url : "";
        if (aUrl) url += "&merge=1&audioUrl=" + encodeURIComponent(aUrl);
      }
    }
    dlLink.href = url;
    preview.src = url;
    currentDownloadUrl = url;

    var aSel = selectedAudio();
    if (aSel) {
      audioLink.href = isYt
        ? "/api/download-audio-yt?url=" +
          encodeURIComponent(watch) +
          "&fmt=" +
          encodeURIComponent(aSel.id) +
          "&abr=" +
          (aSel.abr || 192)
        : "/api/download-audio?url=" +
          encodeURIComponent(aSel.url) +
          "&abr=" +
          (aSel.abr || 192);
      audioLink.hidden = false;
    } else {
      audioLink.removeAttribute("href");
      audioLink.hidden = true;
    }
  }

  function clearResult() {
    resultSection.hidden = true;
    currentDownloadUrl = "";
    dlLink.removeAttribute("href");
    audioLink.removeAttribute("href");
    audioLink.hidden = true;
    qualityWrap.hidden = true;
    videoQuality.innerHTML = "";
    audioQuality.innerHTML = "";
    window.__ckVideos = null;
    window.__ckAudios = null;
    preview.pause();
    preview.removeAttribute("src");
    preview.load();
  }

  function resolveReel(url) {
    setLoading(true);
    clearError();
    clearResult();

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 120000);

    fetch(RESOLVE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url }),
      signal: controller.signal,
    })
      .then(function (r) {
        return r.text().then(function (text) {
          var data = null;
          try {
            data = JSON.parse(text);
          } catch (e) {
            data = null;
          }
          return { ok: r.ok, status: r.status, data: data || {} };
        });
      })
      .then(function (res) {
        clearTimeout(timer);
        if (res.ok && res.data && res.data.downloadUrl) {
          setResult(res.data);
          showToast("Media ready");
          return;
        }
        if (res.data && res.data.error) {
          showError(res.data.error, res.data.detail);
          return;
        }
        // A 404/401/405 with a non-JSON body almost always means the page is
        // being served as static files only — the backend routes don't exist.
        if (res.status === 404 || res.status === 401 || res.status === 405) {
          showError(
            "This page is being served as static files only, so the backend isn't reachable. " +
              "Start the server (cd server && npm start) and open http://localhost:3000."
          );
        } else {
          showError("Server could not resolve the reel. Please try again.");
        }
      })
      .catch(function (err) {
        clearTimeout(timer);
        if (err && err.name === "AbortError") {
          showError("Request timed out. The server may be busy — try again in a moment.");
        } else {
          console.error("[ClipKosh] resolve request failed:", err);
          showError(
            "Couldn't reach the server (network error). Make sure it's running (npm start on port 3000)."
          );
        }
      })
      .finally(function () {
        setLoading(false);
      });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var url = prepareUrl(input.value);
    if (!url) return showError("Please paste a link first.");

    if (!looksLikeSupported(url)) {
      return showError(
        "That doesn't look like an Instagram, Facebook, or YouTube link. Copy a share link and paste it here."
      );
    }

    resolveReel(url);
  });

  copyBtn.addEventListener("click", function () {
    if (!currentDownloadUrl) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(currentDownloadUrl).then(
        function () { showToast("Direct link copied"); },
        function () { showToast(currentDownloadUrl); }
      );
    } else {
      showToast(currentDownloadUrl);
    }
  });

  clearBtn.addEventListener("click", function () {
    clearResult();
    clearError();
    input.focus();
  });

  sampleBtn.addEventListener("click", function () {
    input.value = SAMPLE_URL;
    clearError();
    input.focus();
  });

  input.addEventListener("input", clearError);

  // Auto-start processing the moment a link is pasted (no need to press the
  // Download button). We wait one tick so the pasted value is actually in the
  // field first, and we debounce so pasting twice doesn't fire double requests.
  var pasteTimer = null;
  input.addEventListener("paste", function () {
    clearTimeout(pasteTimer);
    pasteTimer = setTimeout(function () {
      var url = prepareUrl(input.value);
      if (!url) return;
      if (!looksLikeSupported(url)) {
        clearError();
        return showError(
          "That doesn't look like an Instagram, Facebook, or YouTube link. Copy a share link and paste it here."
        );
      }
      resolveReel(url);
    }, 80);
  });

  // Show whether the API (Express backend) is actually reachable. If it shows
  // "API offline", the current URL is serving static files only, so the
  // backend isn't running there.
  var apiStatus = document.getElementById("api-status");
  function checkApi() {
    apiStatus.textContent = "API…";
    fetch("/api/health", { signal: AbortSignal.timeout(6000) })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("http " + r.status)); })
      .then(function () { apiStatus.textContent = "API online"; apiStatus.classList.add("ok"); })
      .catch(function () { apiStatus.textContent = "API offline"; apiStatus.classList.add("bad"); });
  }
  checkApi();
})();
