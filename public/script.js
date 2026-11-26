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

  function showError(msg) {
    errorBox.textContent = msg;
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

    resultSection.hidden = false;
    resultSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function clearResult() {
    resultSection.hidden = true;
    currentDownloadUrl = "";
    dlLink.removeAttribute("href");
    preview.pause();
    preview.removeAttribute("src");
    preview.load();
  }

  function resolveReel(url) {
    setLoading(true);
    clearError();
    clearResult();

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 45000);

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
          showError(res.data.error);
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
