#!/usr/bin/env node
/**
 * make-cookies-b64.js
 *
 * Reads a Netscape cookies.txt, keeps ONLY the essential YouTube session
 * cookies that yt-dlp needs for age/sign-in verification, and prints a compact
 * base64 blob. This compact value can be set as the single-line
 * YOUTUBE_COOKIES_B64 Render env variable without exceeding Render's
 * shell-command size limit (the full cookie file is too large and breaks
 * deploys with "argument list too long").
 *
 * Usage:
 *   node make-cookies-b64.js <source cookies.txt> [outputBase64File]
 *
 * If no output file is given, the base64 is printed to stdout.
 */

const fs = require("fs");

// Cookie names that matter for YouTube sign-in / age verification.
// Everything else (session noise) is dropped to keep the blob small.
const KEEP = new Set([
  "SID",
  "SSID",
  "HSID",
  "APISID",
  "SAPISID",
  "__Secure-1PAPISID",
  "__Secure-3PAPISID",
  "__Secure-1PSID",
  "__Secure-3PSID",
  "LOGIN_INFO",
  "__Secure-1PSIDTS",
  "__Secure-3PSIDTS",
  "PREF",
  "VISITOR_INFO1_LIVE",
  "VISITOR_PRIVACY_METADATA",
  "YSC",
  "SIDCC",
  "__Secure-1PSIDCC",
  "__Secure-3PSIDCC",
  "__Secure-YNID",
  "__Secure-ROLLOUT_TOKEN",
]);

function main() {
  const src = process.argv[2];
  if (!src) {
    console.error("Usage: node make-cookies-b64.js <cookies.txt> [outputBase64File]");
    process.exit(1);
  }

  const lines = fs.readFileSync(src, "utf8").split(/\r?\n/);
  const kept = ["# Netscape HTTP Cookie File"];
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length >= 7 && KEEP.has(parts[5])) kept.push(line);
  }

  const b64 = Buffer.from(kept.join("\n") + "\n", "utf8").toString("base64");
  const dest = process.argv[3];
  if (dest) {
    fs.writeFileSync(dest, b64);
    console.log("Wrote " + dest + " (" + b64.length + " base64 chars)");
  } else {
    process.stdout.write(b64 + "\n");
  }
}

main();
