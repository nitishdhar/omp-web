"use strict";
// GET|HEAD /a/<cap>/<slug>/<path...>: artifact files behind a capability
// link. The cap is the only credential, so server.js answers this before
// token auth. Every failure is the same 404 so a guessed URL reveals nothing
// about which part was wrong.
const fs = require("fs");
const { capMatches, readManifest, resolveServed } = require("./artifact-store");

// `sandbox` without allow-same-origin gives the page an opaque origin even
// when opened directly in a tab: it cannot read omp-web's localStorage or
// cookies, and its /api calls carry no token. Its own fetch('./data.json') is
// therefore cross-origin, hence Access-Control-Allow-Origin: *.
const SECURITY_HEADERS = {
  "content-security-policy":
    "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; "
    + "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self'; "
    + "img-src 'self' data: blob:; frame-ancestors 'self'",
  "access-control-allow-origin": "*",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
};

function notFound(req, res) {
  res.writeHead(404, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" });
  res.end(req.method === "HEAD" ? undefined : "not found");
}

// -> [cap, slug, ...decoded segments] or null. The raw pathname is split
// before decoding so an encoded "/" can never form a separator.
function parsePath(pathname) {
  const raw = pathname.split("/").slice(2); // drop "" and "a"
  try {
    return raw.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

async function handleArtifact(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return notFound(req, res);
  const parts = parsePath(url.pathname);
  if (!parts || parts.length < 2) return notFound(req, res);
  const [cap, slug, ...rest] = parts;
  if (!capMatches(slug, cap) || !readManifest(slug).manifest) return notFound(req, res);
  if (parts.length === 2) {
    // Relative URLs inside the page (./data.json) only keep the cap when the
    // document URL ends in a slash.
    res.writeHead(308, { ...SECURITY_HEADERS, location: `${url.pathname}/${url.search}` });
    return res.end();
  }
  // A trailing slash (empty last segment) asks for the entry only at the root.
  const segments = rest.length === 1 && rest[0] === "" ? [] : rest;
  const file = await resolveServed(slug, segments);
  if (!file) return notFound(req, res);
  const etag = `"${file.stat.size.toString(16)}-${Math.trunc(file.stat.mtimeMs).toString(16)}"`;
  const headers = { ...SECURITY_HEADERS, etag, "content-type": file.contentType };
  const match = req.headers["if-none-match"];
  if (match && match.split(",").some((value) => value.trim().replace(/^W\//, "") === etag)) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers["content-length"] = file.stat.size;
  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    return res.end();
  }
  const stream = fs.createReadStream(file.filePath);
  stream.once("error", () => {
    if (!res.headersSent) notFound(req, res);
    else res.destroy();
  });
  stream.once("open", () => res.writeHead(200, headers));
  stream.pipe(res);
}

module.exports = { handleArtifact, SECURITY_HEADERS };
