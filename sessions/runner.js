"use strict";
// Pane commands for both agent runners and the client for the RPC bridge's
// Unix socket. No tmux calls here: sessions.js owns tmux and the per-session
// queue, this file owns what runs in the pane and how to talk to it.
const fs = require("fs");
const net = require("net");
const path = require("path");
const config = require("../config");
const { profileSessionDirFor, sessionDirFor, bestResumeSource } = require("../transcripts");

const BRIDGE = path.join(__dirname, "..", "bin", "rpc-bridge.js");
const OMP_ENV_BIN = path.join(__dirname, "..", "bin", "omp-env.js");
const RUN_DIR = path.join(config.ompWebHome, "run");
// sockaddr_un.sun_path is 104 bytes on macOS, 108 on Linux.
const MAX_SOCKET_PATH = 103;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CONVERSATION_SCAN_BYTES = 256 * 1024;
const RESUME_SCAN_FILES = 8;
const HOLDER_LINE = "Chat session. omp starts when you send a message.";

function runnerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function shellQuote(value) {
  const text = String(value);
  if (/[\x00-\x1f\x7f]/.test(text)) {
    throw runnerError("EBADARG", "command arguments cannot contain control characters");
  }
  return `'${text.replace(/'/g, `'\"'\"'`)}'`;
}

function shellCommand(args) {
  return args.map(shellQuote).join(" ");
}

// Keys passed to OMP enter the pane shell through `eval` of bin/omp-env.js's
// stdout, so only variable names appear in the pane command (and so in ps and
// tmux); the values exist only in the shell's and omp's environment. Names
// are validated ^[A-Z_][A-Z0-9_]*$ by api/omp-env.js, safe unquoted.
function ompEnvPrelude(names) {
  if (!names.length) return "";
  const resolver = shellCommand([
    "/usr/bin/env", `OMP_WEB_HOME=${config.ompWebHome}`, process.execPath, OMP_ENV_BIN, ...names,
  ]);
  return `eval "$(${resolver} </dev/null)"; `;
}

function recoverableAgentCommand(args, target, envNames = []) {
  const markShell = shellCommand([
    config.tmuxBin, "-L", config.tmuxSocket,
    "set-option", "-t", target, "@omp_status", "shell",
  ]);
  const flushInput = shellCommand([
    "/usr/bin/perl", "-MPOSIX=tcflush,TCIFLUSH", "-e",
    "defined(tcflush(STDIN, TCIFLUSH)) or exit 1",
  ]);
  // Revoke Chat first, then discard bytes accepted during OMP's exit race
  // before an interactive shell can read from the shared pane PTY.
  const recover = `${markShell} && ${flushInput} && exec "\${SHELL:-/bin/zsh}" -l`;
  // The fallback shell is interactive: drop the keys before it starts.
  const unset = envNames.length ? `unset ${envNames.join(" ")}; ` : "";
  const body = `${ompEnvPrelude(envNames)}${shellCommand(args)}; ${unset}${recover}; exec /usr/bin/tail -f /dev/null`;
  return `exec "\${SHELL:-/bin/zsh}" -lc ${shellQuote(body)}`;
}

// The holder is what an rpc pane shows while omp is not running: no shell to
// type into (Chat owns this session) and no memory beyond `tail`. Its pane
// command is `tail`, which sessions/status.js reads as "rpc holder".
function holderBody() {
  return `printf '%s\\n' ${shellQuote(HOLDER_LINE)}; exec /usr/bin/tail -f /dev/null`;
}

function holderPaneCommand() {
  return `exec /bin/sh -c ${shellQuote(holderBody())}`;
}

// Login shell for the same reason as recoverableAgentCommand: omp and its
// tools need the user's PATH. When the bridge exits (idle stop, stop op,
// crash) the pane falls back to the holder, never to an interactive shell.
function rpcPaneCommand(bridgeArgs, envNames = []) {
  const body = `${ompEnvPrelude(envNames)}${shellCommand(bridgeArgs)}; ${holderBody()}`;
  return `exec "\${SHELL:-/bin/zsh}" -lc ${shellQuote(body)}`;
}

function socketPath(id) {
  const file = path.join(RUN_DIR, `${id}.sock`);
  if (Buffer.byteLength(file) > MAX_SOCKET_PATH) {
    throw runnerError("ERUNNER", "OMP_WEB_HOME is too long for a Unix socket path");
  }
  return file;
}

function prepareSocket(id) {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(RUN_DIR, 0o700);
  // A socket file left by a bridge that died without cleanup would otherwise
  // look alive until a connect fails.
  try { fs.unlinkSync(socketPath(id)); } catch {}
}

// One JSON request line per connection, one JSON response line back. A
// connect failure means no bridge is listening (ENOBRIDGE): the socket file is
// missing, or stale after the bridge died.
function bridgeRequest(id, payload, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let connected = false;
    let settled = false;
    let buffer = "";
    const socket = net.createConnection(socketPath(id));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(runnerError(connected ? "ERUNNER" : "ENOBRIDGE", "omp did not answer in time")),
      timeoutMs
    );
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        if (buffer.length > MAX_RESPONSE_BYTES) finish(runnerError("ERUNNER", "oversized bridge response"));
        return;
      }
      try {
        finish(null, JSON.parse(buffer.slice(0, newline)));
      } catch {
        finish(runnerError("ERUNNER", "malformed bridge response"));
      }
    });
    socket.on("error", () => finish(runnerError(connected ? "ERUNNER" : "ENOBRIDGE", "omp is not running")));
    socket.on("close", () => finish(runnerError(connected ? "ERUNNER" : "ENOBRIDGE", "omp closed the connection")));
  });
}

// Resolves with the bridge's `data`, or throws its coded error.
async function bridgeOp(id, payload, timeoutMs) {
  const response = await bridgeRequest(id, payload, timeoutMs);
  if (response && response.ok) return response.data || null;
  const code = response && typeof response.code === "string" ? response.code : "ERUNNER";
  throw runnerError(code, String((response && response.error) || "omp rejected the request"));
}

function hasConversation(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(CONVERSATION_SCAN_BYTES);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).includes('"type":"message"');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Which transcript a live session continues when its runner (re)starts omp:
// the newest one in this profile's scope that holds a conversation. Unlike a
// tmux-loss restore, the current conversation is the one to keep even when it
// is short; bestResumeSource's size floor would drop a one-exchange chat and
// silently start a fresh one on the next send. Files without a message record
// are fresh launches and never win.
function resumeSourceFor(id, profile) {
  const candidates = [];
  for (const dir of [profileSessionDirFor(id, profile), sessionDirFor(id)]) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.endsWith(".sanitized.jsonl")) continue;
      const file = path.join(dir, entry.name);
      try {
        candidates.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
      } catch {}
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates.slice(0, RESUME_SCAN_FILES)) {
    if (hasConversation(candidate.file)) return candidate.file;
  }
  return bestResumeSource(id, profile);
}

module.exports = {
  BRIDGE,
  shellQuote,
  shellCommand,
  recoverableAgentCommand,
  holderPaneCommand,
  rpcPaneCommand,
  socketPath,
  prepareSocket,
  bridgeRequest,
  bridgeOp,
  resumeSourceFor,
};
