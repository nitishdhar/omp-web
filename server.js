"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { StringDecoder } = require("string_decoder");
const pty = require("node-pty");
const { WebSocketServer } = require("ws");
const config = require("./config");
// Token is opt-in: no configured token means an open console. That is only
// acceptable on loopback, where the OS user boundary still applies — an open
// console on a LAN address answers to anyone who can reach the port.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
if (!config.token && !LOOPBACK_HOSTS.has(config.host)) {
  console.error("omp-web: refusing to run without an access token on a non-loopback address. Set OMP_WEB_TOKEN (or run setup --token), or bind the loopback default.");
  process.exit(1);
}
if (!config.token) {
  console.error("omp-web: no access token configured — console is OPEN to the local machine. Run setup --token or set OMP_WEB_TOKEN to require one.");
}
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  console.error("omp-web: OMP_WEB_PORT must be an integer between 1 and 65535.");
  process.exit(1);
}
try {
  if (!fs.statSync(config.workspaceRoot).isDirectory()) throw new Error("not a directory");
} catch {
  console.error("omp-web: workspace directory is unavailable. Run setup or set OMP_WEB_WORKSPACE to an existing directory.");
  process.exit(1);
}
const sessions = require("./sessions");
const { handleApi } = require("./api/routes");
const { sendJson, sendError, listProfiles } = require("./api/util");

const PUBLIC = path.join(__dirname, "public");
const PUBLIC_REAL = fs.realpathSync(PUBLIC);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function tokenOk(reqUrl, headers) {
  if (!config.token) return true;
  const t = reqUrl.searchParams.get("token") || headers["x-omp-web-token"];
  return t === config.token;
}

function originOk(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // Native clients still authenticate with the token.
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.origin === origin
      && parsed.host === req.headers.host;
  } catch {
    return false;
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("bad request");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  if (pathname.includes("\0")) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("bad request");
    return;
  }

  const requested = path.resolve(PUBLIC, `.${pathname}`);
  let filePath;
  try {
    filePath = await fs.promises.realpath(requested);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
    return;
  }
  if (!isInside(PUBLIC_REAL, filePath)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  try {
    const buf = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const headers = { "content-type": MIME[ext] || "application/octet-stream" };
    // Never let the app shell/logic go stale (a mismatched index.html + app.js
    // breaks wiring). The shell itself is never stored: a tab that cached an
    // old index.html against new modules half-wires (handlers run, DOM ids
    // missing) and no-cache still allowed that through. Vendored libs are
    // content-stable and may be cached.
    if (ext === ".html" && !filePath.includes(`${path.sep}vendor${path.sep}`)) {
      headers["cache-control"] = "no-store";
    } else if ([".js", ".css", ".webmanifest"].includes(ext) && !filePath.includes(`${path.sep}vendor${path.sep}`)) {
      headers["cache-control"] = "no-cache";
    }
    res.writeHead(200, headers);
    res.end(buf);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      if (!originOk(req)) {
        return sendJson(res, 403, { error: "cross-origin requests are not allowed", code: "EORIGIN" });
      }
      if (!tokenOk(url, req.headers)) {
        return sendJson(res, 401, { error: "unauthorized", code: "EAUTH" });
      }
      return await handleApi(req, res, url);
    }
    // Static shell (index/app.js/css/vendor/manifest/icon) is public — it holds
    // no secrets. Session data lives behind /api and /ws, which the client
    // authenticates with the token it persists from the first tokened visit.
    return await serveStatic(req, res, url);
  } catch (error) {
    return sendError(res, error);
  }
});

// ---- WebSocket PTY bridge -------------------------------------------------
// Each client connection spawns its own `tmux attach` PTY into the requested
// session. Multiple clients may attach to one session simultaneously; closing
// a socket detaches only that client — the session keeps running.
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== "/ws" || !originOk(req) || !tokenOk(url, req.headers)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, url));
});

const OUTPUT_HIGH_WATER = 1024 * 1024;
const OUTPUT_LOW_WATER = 512 * 1024;
const EARLY_INPUT_LIMIT = 64 * 1024;

function terminalDimension(value, minimum, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

wss.on("connection", async (ws, req, url) => {
  const id = url.searchParams.get("id");
  const cols = terminalDimension(url.searchParams.get("cols"), 20, 100, 500);
  const rows = terminalDimension(url.searchParams.get("rows"), 5, 30, 200);
  const acknowledgedFlow = url.searchParams.get("flow") === "ack";
  const decoder = new StringDecoder("utf8");
  let term = null;
  let dataSubscription = null;
  let exitSubscription = null;
  let closed = false;
  let outstanding = 0;
  let paused = false;
  let termExited = false;
  let earlyBytes = 0;
  let earlyResize = null;
  const earlyInput = [];

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { dataSubscription?.dispose(); } catch {}
    try { exitSubscription?.dispose(); } catch {}
    try { term?.kill(); } catch {}
  };

  const sendControlError = (message) => {
    if (closed || ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify({ t: "error", m: message })); } catch {}
  };

  const failConnection = (message) => {
    sendControlError(message);
    cleanup();
    try { ws.close(); } catch {}
  };

  const sendOutput = (text) => {
    if (!text || closed || ws.readyState !== ws.OPEN) return;
    const bytes = Buffer.byteLength(text, "utf8");
    if (acknowledgedFlow) outstanding += bytes;
    try {
      ws.send(text, (error) => {
        if (error) {
          cleanup();
          try { ws.close(); } catch {}
        }
      });
    } catch {
      cleanup();
      try { ws.close(); } catch {}
      return;
    }
    if (acknowledgedFlow && !termExited && !paused && outstanding >= OUTPUT_HIGH_WATER) {
      try {
        term.pause();
        paused = true;
      } catch {
        failConnection("terminal flow control failed");
      }
    }
  };

  const handleMessage = (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === "ack" && acknowledgedFlow) {
      const bytes = Number(msg.bytes);
      if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
      outstanding -= Math.min(bytes, outstanding);
      if (paused && outstanding <= OUTPUT_LOW_WATER) {
        try {
          term.resume();
          paused = false;
        } catch {
          failConnection("terminal flow control failed");
        }
      }
      return;
    }
    if (!term) {
      if (msg.t === "r") {
        earlyResize = msg;
        return;
      }
      if (msg.t !== "i" || typeof msg.d !== "string") return;
      const bytes = Buffer.byteLength(msg.d, "utf8");
      if (earlyBytes + bytes > EARLY_INPUT_LIMIT) {
        failConnection("terminal is not ready");
        return;
      }
      earlyBytes += bytes;
      earlyInput.push(msg);
      return;
    }
    if (msg.t === "i" && typeof msg.d === "string") {
      try {
        term.write(msg.d);
      } catch {
        failConnection("failed to write terminal input");
      }
    } else if (msg.t === "r") {
      try {
        term.resize(
          terminalDimension(msg.cols, 20, 100, 500),
          terminalDimension(msg.rows, 5, 30, 200)
        );
      } catch {
        failConnection("failed to resize terminal");
      }
    }
  };

  ws.on("message", handleMessage);
  ws.once("error", () => {
    cleanup();
    try { ws.close(); } catch {}
  });
  ws.once("close", cleanup);

  let found = false;
  try {
    if (id) {
      await sessions.resolvePane(id);
      found = true;
    }
  } catch {
    found = false;
  }
  if (closed) return;
  if (!found) {
    sendControlError("session not found");
    ws.close();
    return;
  }

  try {
    term = pty.spawn(
      config.tmuxBin,
      ["-L", config.tmuxSocket, "attach-session", "-t", sessions.tmuxName(id)],
      {
        name: "xterm-256color",
        cols,
        rows,
        cwd: process.env.HOME,
        env: process.env,
        encoding: null,
      }
    );
  } catch {
    sendControlError("failed to attach");
    ws.close();
    return;
  }
  if (closed) {
    try { term.kill(); } catch {}
    return;
  }

  dataSubscription = term.onData((data) => {
    const text = decoder.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
    sendOutput(text);
  });
  exitSubscription = term.onExit(() => {
    termExited = true;
    const final = decoder.end();
    sendOutput(final);
    if (!closed && ws.readyState === ws.OPEN) ws.close();
  });

  try {
    if (earlyResize) {
      term.resize(
        terminalDimension(earlyResize.cols, 20, 100, 500),
        terminalDimension(earlyResize.rows, 5, 30, 200)
      );
    }
    for (const message of earlyInput) term.write(message.d);
  } catch {
    sendControlError("failed to initialize terminal");
    ws.close();
  }
});

// Safety net: a single PTY/socket mishap must never take down the console.
process.on("uncaughtException", (e) => console.error("[uncaught]", e.message));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e && e.message));

server.on("error", (error) => {
  console.error(error.code === "EADDRINUSE"
    ? `omp-web: port ${config.port} is already in use. Open the existing instance or choose another OMP_WEB_PORT.`
    : `omp-web: failed to listen (${error.code || "unknown error"}). Check OMP_WEB_HOST and OMP_WEB_PORT.`);
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  console.log(`omp-web listening on http://${config.host}:${config.port}`);
  console.log(`workspace: ${config.workspaceRoot}`);
  console.log(`profiles:  ${listProfiles().join(", ")}`);
  if (config.token) console.log("auth: token required");
  else console.log("auth: OPEN — no access token (loopback only)");
});
