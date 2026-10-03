"use strict";
// Operator-configured panels: local web apps shown inside omp-web through a
// reverse proxy at /panels/<id>/. Nothing here knows about any specific app;
// the operator lists them in OMP_WEB_PANELS.
const http = require("http");
const crypto = require("crypto");
const config = require("../config");

const PANEL_ID = /^[a-z0-9-]+$/;
const FIELD_MAX = 40;
// Loopback only, origin only: a path, query, or credentials in the URL would
// make the mount point ambiguous, and any other host turns omp-web into an
// open relay onto the network.
const PANEL_URL = /^http:\/\/(127\.0\.0\.1|localhost):([1-9][0-9]{0,4})\/?$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const CONNECT_TIMEOUT_MS = 30_000;
const AUTH_COOKIE = "omp_web_panel";
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

const panels = new Map(); // id -> { id, label, hostname, port, host }
// Panel subrequests (scripts, CSS, fetches from the app's own code) cannot
// carry the token header, so they authenticate with a cookie derived from the
// token. Derived, not the token itself: a leaked panel cookie never unlocks
// /api or /ws, which accept only the token.
const cookieValue = config.token
  ? crypto.createHmac("sha256", config.token).update("omp-web-panels:v1").digest("hex")
  : "";
const agent = new http.Agent({ keepAlive: true });

function parsePanels(raw) {
  if (!raw || !raw.trim()) return [];
  let list;
  try {
    list = JSON.parse(raw);
  } catch (error) {
    throw new Error(`OMP_WEB_PANELS is not valid JSON (${error.message}).`);
  }
  if (!Array.isArray(list)) throw new Error("OMP_WEB_PANELS must be a JSON array of {\"id\",\"label\",\"url\"} objects.");
  const seen = new Set();
  return list.map((entry, index) => {
    const name = `OMP_WEB_PANELS entry ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${name} must be an object with "id", "label" and "url".`);
    }
    const { id, label, url } = entry;
    const where = typeof id === "string" && id ? `${name} ("${id}")` : name;
    if (typeof id !== "string" || !PANEL_ID.test(id) || id.length > FIELD_MAX) {
      throw new Error(`${where}: "id" must be 1-${FIELD_MAX} characters of a-z, 0-9 or "-".`);
    }
    if (seen.has(id)) throw new Error(`${where}: "id" is used by an earlier entry; ids must be unique.`);
    seen.add(id);
    if (typeof label !== "string" || !label.trim() || label.length > FIELD_MAX || CONTROL_CHARS.test(label)) {
      throw new Error(`${where}: "label" must be a non-empty string of at most ${FIELD_MAX} characters without control characters.`);
    }
    const match = typeof url === "string" ? url.match(PANEL_URL) : null;
    const port = match ? Number(match[2]) : 0;
    if (!match || port > 65535) {
      throw new Error(`${where}: "url" must be exactly http://127.0.0.1:<port> or http://localhost:<port> (no path, query, credentials or https).`);
    }
    return { id, label, hostname: match[1], port, host: `${match[1]}:${port}` };
  });
}

// Throws with an operator-facing message; server.js turns it into exit(1).
function configurePanels(raw) {
  panels.clear();
  for (const panel of parsePanels(raw)) panels.set(panel.id, panel);
}

// The browser needs only what it renders; the upstream URL stays server-side.
function publicPanels() {
  return [...panels.values()].map(({ id, label }) => ({ id, label }));
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Query pieces are filtered as raw text so everything the panel receives keeps
// its original encoding; URLSearchParams would re-serialize it.
function splitQuery(search) {
  let token = null;
  const kept = [];
  for (const piece of search.replace(/^\?/, "").split("&")) {
    if (!piece) continue;
    const eq = piece.indexOf("=");
    let name = eq === -1 ? piece : piece.slice(0, eq);
    try { name = decodeURIComponent(name.replace(/\+/g, " ")); } catch {}
    if (name === "token") {
      if (token === null) {
        try { token = decodeURIComponent((eq === -1 ? "" : piece.slice(eq + 1)).replace(/\+/g, " ")); } catch { token = ""; }
      }
    } else {
      kept.push(piece);
    }
  }
  return { token, query: kept.length ? `?${kept.join("&")}` : "" };
}

function splitCookies(header) {
  const own = [];
  const auth = [];
  for (const part of String(header || "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const name = eq === -1 ? trimmed : trimmed.slice(0, eq).trim();
    if (name === AUTH_COOKIE) auth.push(eq === -1 ? "" : trimmed.slice(eq + 1).trim());
    else own.push(trimmed);
  }
  return { own, auth };
}

// omp-web may sit behind a TLS-terminating proxy the operator trusts, so its
// forwarded proto wins over the plain-http socket it sees.
function effectiveProto(req) {
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (forwarded === "https" || forwarded === "http") return forwarded;
  return req.socket.encrypted ? "https" : "http";
}

function stripHopByHop(headers) {
  const named = String(headers.connection || "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name) || named.includes(name)) continue;
    out[name] = value;
  }
  return out;
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

function proxy(req, res, panel, upstreamPath, cookies, proto) {
  const headers = stripHopByHop(req.headers);
  delete headers["x-omp-web-token"];
  delete headers.cookie;
  if (cookies.own.length) headers.cookie = cookies.own.join("; ");
  headers.host = panel.host;
  headers["x-forwarded-host"] = req.headers.host || "";
  headers["x-forwarded-proto"] = proto;
  headers["x-forwarded-prefix"] = `/panels/${panel.id}`;

  const upstream = http.request({
    agent,
    hostname: panel.hostname,
    port: panel.port,
    method: req.method,
    path: upstreamPath,
    headers,
  });
  let connectTimer = null;
  const fail = () => {
    clearTimeout(connectTimer);
    if (!res.headersSent) sendText(res, 502, `Panel "${panel.label}" is not reachable.`);
    else res.destroy();
  };
  upstream.on("socket", (socket) => {
    if (!socket.connecting) return; // reused keep-alive socket
    connectTimer = setTimeout(() => upstream.destroy(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
    socket.once("connect", () => clearTimeout(connectTimer));
  });
  upstream.on("error", fail);
  upstream.on("response", (up) => {
    res.writeHead(up.statusCode, stripHopByHop(up.headers));
    up.on("error", () => res.destroy());
    up.on("aborted", () => res.destroy());
    up.pipe(res);
  });
  // The browser went away (tab closed, navigation): stop the upstream work.
  res.on("close", () => {
    clearTimeout(connectTimer);
    if (!res.writableFinished) upstream.destroy();
  });
  req.on("error", () => upstream.destroy());
  req.pipe(upstream);
}

// Runs after server.js's same-origin check.
function handlePanel(req, res, url) {
  const match = url.pathname.match(/^\/panels\/([^/]+)(\/.*)?$/);
  const panel = match ? panels.get(match[1]) : null;
  if (!panel) return sendText(res, 404, "not found");
  const rawSearch = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  // The app is mounted under a directory; without the slash its relative URLs
  // would resolve against /panels/.
  if (!match[2]) return sendText(res, 308, "redirecting", { location: `/panels/${panel.id}/${rawSearch}` });

  const { token: queryToken, query } = splitQuery(rawSearch);
  const cookies = splitCookies(req.headers.cookie);
  const proto = effectiveProto(req);
  if (config.token) {
    const headerToken = req.headers["x-omp-web-token"];
    const byQuery = queryToken !== null && safeEqual(queryToken, config.token);
    const authed = byQuery
      || (headerToken !== undefined && safeEqual(headerToken, config.token))
      || cookies.auth.some((value) => safeEqual(value, cookieValue));
    if (!authed) return sendText(res, 401, "unauthorized");
    // Swap the token for the cookie on the first navigation so the token
    // never sits in the panel's URL, history, or outgoing Referer.
    if (byQuery && (req.method === "GET" || req.method === "HEAD")) {
      const secure = proto === "https" ? "; Secure" : "";
      return sendText(res, 303, "redirecting", {
        location: `${url.pathname}${query}`,
        "set-cookie": `${AUTH_COOKIE}=${cookieValue}; Path=/panels/; HttpOnly; SameSite=Strict${secure}`,
      });
    }
  }
  return proxy(req, res, panel, `${match[2]}${query}`, cookies, proto);
}

module.exports = { configurePanels, publicPanels, handlePanel };
