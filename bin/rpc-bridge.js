#!/usr/bin/env node
"use strict";
// Runs one `omp --mode rpc-ui --no-ui` child for an omp-web session. It lives
// in the session's tmux pane (respawn-pane), so tmux owns it and omp-web
// server restarts leave the conversation running. The server talks to it over
// a private Unix socket; status reaches tmux the same way the TUI extension
// publishes it.
//
// Usage: rpc-bridge.js <socket> -- <omp argv...>
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { createThinkingTracker } = require("../extensions/thinking-headline.cjs");

const TARGET = /^=omp_[A-Za-z0-9_-]{1,40}:$/;
const SOCKET = /^[A-Za-z0-9_.-]{1,64}$/;
const STATUS_VALUES = new Set(["starting", "idle", "working", "waiting", "done"]);
const UI_METHODS = new Set(["select", "confirm", "input", "editor"]);
const HEARTBEAT_MS = 30_000;
// Mirror of sessions/status.js and extensions/session-status.mjs.
const RECENT_DONE_MS = 5 * 60_000;
const WRITE_TIMEOUT_MS = 1_500;
const READY_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;
const KILL_GRACE_MS = 3_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;
const UI_TITLE_MAX = 500;
const UI_OPTION_MAX = 200;
const UI_OPTIONS_MAX = 24;
const UI_PLACEHOLDER_MAX = 200;
const UI_ID_MAX = 128;

const argv = process.argv.slice(2);
if (argv.length < 3 || argv[1] !== "--") {
  process.stderr.write("usage: rpc-bridge.js <socket> -- <omp argv...>\n");
  process.exit(2);
}
const socketPath = argv[0];
const [ompBin, ...ompArgs] = argv.slice(2);
const target = process.env.OMP_WEB_STATUS_TARGET || "";
const tmuxSocket = process.env.OMP_WEB_TMUX_SOCKET || "omp-web";
const tmuxBin = process.env.OMP_WEB_TMUX_BIN || "tmux";
const canPublish = TARGET.test(target) && SOCKET.test(tmuxSocket);
const idleMinutes = Number(process.env.OMP_WEB_RPC_IDLE_MINUTES);
const idleMs = (Number.isFinite(idleMinutes) && idleMinutes > 0 ? idleMinutes : 10) * 60_000;

// The pane PTY disappears on kill-session; a write to it must not crash the
// bridge before it has closed omp's stdin.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

function say(line) {
  try { process.stdout.write(`${line}\n`); } catch {}
}

// ---- tmux status ------------------------------------------------------------
let writes = Promise.resolve();
let current = "starting";
let currentActivity = "";
let doneAt = 0;
let written = { status: null, activity: null };

function tmuxSet(pairs) {
  if (!canPublish) return writes;
  const args = ["-L", tmuxSocket];
  pairs.forEach(([option, value], index) => {
    if (index) args.push(";");
    if (value === null) args.push("set-option", "-t", target, "-u", option);
    else args.push("set-option", "-t", target, option, value);
  });
  const run = () => new Promise((resolve) => {
    execFile(tmuxBin, args, { timeout: WRITE_TIMEOUT_MS }, (error) => resolve(!error));
  });
  writes = writes.then(run, run);
  return writes;
}

function publish(status, force = false, activity = currentActivity) {
  if (!STATUS_VALUES.has(status)) return writes;
  if (status !== "done") doneAt = 0;
  if (!force && written.status === status && written.activity === activity) return writes;
  current = status;
  currentActivity = activity;
  return tmuxSet([
    ["@omp_status", status],
    ["@omp_status_at", String(Date.now())],
    ["@omp_activity", activity],
  ]).then((ok) => {
    // A failed write is retried on the next transition instead of being
    // deduplicated away until the heartbeat.
    if (ok) written = { status, activity };
  });
}

function markDone() {
  doneAt = Date.now();
  void publish("done", false, "");
}

const thinking = createThinkingTracker((text) => {
  void tmuxSet([["@omp_thinking", text], ["@omp_thinking_at", String(Date.now())]]);
});

// ---- pending question (ask tool) ----------------------------------------------
const state = { ready: false, streaming: false, settled: true, model: null, thinkingLevel: null, ui: null };
let uiOptions = [];
let uiTimer = null;
let uiRawId = null;
// The ask tool asks for free text in a second `editor` request after "Other"
// is chosen. The web card collects the text up front; hold it here and answer
// that follow-up without ever showing it.
let freeText = null;

function clean(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, max);
}

function setUi(frame) {
  const options = Array.isArray(frame.options) ? frame.options.slice(0, UI_OPTIONS_MAX) : [];
  uiOptions = options.map((option) => String(option));
  // The raw id is what omp matches; only the cleaned copy leaves the bridge.
  uiRawId = String(frame.id);
  const ui = {
    id: clean(frame.id, UI_ID_MAX),
    method: frame.method,
    title: clean(frame.title, UI_TITLE_MAX),
    options: options.map((option) => clean(option, UI_OPTION_MAX)),
  };
  if (frame.message) ui.message = clean(frame.message, UI_TITLE_MAX);
  if (frame.placeholder) ui.placeholder = clean(frame.placeholder, UI_PLACEHOLDER_MAX);
  state.ui = ui;
  clearTimeout(uiTimer);
  uiTimer = null;
  // omp resolves a timed-out dialog locally without telling the host.
  if (Number.isFinite(frame.timeout) && frame.timeout > 0) {
    uiTimer = setTimeout(() => clearUi(uiRawId), frame.timeout);
  }
  void tmuxSet([["@omp_ui", JSON.stringify(ui)]]);
  void publish("waiting");
}

function clearUi(rawId = null) {
  if (!state.ui || (rawId !== null && uiRawId !== rawId)) return;
  uiRawId = null;
  state.ui = null;
  uiOptions = [];
  clearTimeout(uiTimer);
  uiTimer = null;
  void tmuxSet([["@omp_ui", null]]);
  if (current === "waiting") void publish(state.streaming ? "working" : "idle");
}

// ---- omp child -----------------------------------------------------------------
void publish("starting", true);
const child = spawn(ompBin, ompArgs, { stdio: ["pipe", "pipe", "inherit"] });
child.stdin.on("error", () => {});
let exited = false;
let seq = 0;
const pending = new Map();
let readyWaiters = [];
let lastActivityAt = Date.now();
let lastResult = null;

function send(frame) {
  if (exited || child.stdin.destroyed || child.stdin.writableEnded) return false;
  child.stdin.write(`${JSON.stringify(frame)}\n`);
  return true;
}

function command(type, fields = {}) {
  return new Promise((resolve, reject) => {
    const id = `bridge-${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(bridgeError("ERUNNER", `omp did not answer ${type}`));
    }, COMMAND_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    if (!send({ ...fields, id, type })) {
      clearTimeout(timer);
      pending.delete(id);
      reject(bridgeError("ERUNNER", "omp is not running"));
    }
  });
}

function bridgeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function refreshState() {
  try {
    const response = await command("get_state");
    const data = response.success && response.data;
    if (!data) return;
    if (data.model && data.model.provider && data.model.id) state.model = `${data.model.provider}/${data.model.id}`;
    if (typeof data.thinkingLevel === "string") state.thinkingLevel = data.thinkingLevel;
  } catch {}
}

function whenReady() {
  if (state.ready) return Promise.resolve();
  if (exited) return Promise.reject(bridgeError("ERUNNER", "omp exited"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(bridgeError("ERUNNER", "omp did not start in time")), READY_TIMEOUT_MS);
    readyWaiters.push((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

function releaseReadyWaiters(error) {
  const waiters = readyWaiters;
  readyWaiters = [];
  for (const waiter of waiters) waiter(error);
}

// A stuck startup would otherwise hold the session at "starting" with both
// processes alive; every later send would wait out its own timeout first.
const readyDeadline = setTimeout(() => {
  if (state.ready || stopping) return;
  say("omp did not start in time; stopping.");
  releaseReadyWaiters(bridgeError("ERUNNER", "omp did not start in time"));
  void stop();
}, READY_TIMEOUT_MS);
readyDeadline.unref?.();

function turnEnded() {
  freeText = null;
  thinking.clear();
  clearUi();
  lastActivityAt = Date.now();
}

function handleFrame(frame) {
  switch (frame.type) {
    case "ready":
      state.ready = true;
      void publish("idle", true, "");
      say("omp is running for Chat. It stops after a quiet spell; Terminal opens the full TUI.");
      // Full partial-message snapshots on every delta are wasted work here;
      // the headline needs only the deltas.
      send({ id: "bridge-filter", type: "set_event_filter", events: null, messageUpdates: "delta" });
      void refreshState();
      releaseReadyWaiters(null);
      return;
    case "response": {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      clearTimeout(entry.timer);
      entry.resolve(frame);
      return;
    }
    case "agent_start":
      state.streaming = true;
      state.settled = false;
      void publish("working", false, "");
      return;
    case "agent_end":
      thinking.clear();
      if (frame.yielded === false || (frame.yielded === undefined && frame.isTerminal === false)) {
        void publish("working", false, "");
        return;
      }
      state.streaming = false;
      lastActivityAt = Date.now();
      return;
    case "prompt_result":
      lastResult = frame.status;
      state.settled = frame.sessionSettled === true;
      if (frame.status === "completed") {
        if (state.settled) {
          turnEnded();
          markDone();
        }
        return;
      }
      turnEnded();
      void publish("idle", false, "");
      return;
    case "session_settled":
      state.settled = true;
      state.streaming = false;
      turnEnded();
      if (current === "working" || current === "waiting") {
        if (lastResult === "completed") markDone();
        else void publish("idle", false, "");
      }
      return;
    case "auto_compaction_start":
      void publish("working", false, "compaction");
      return;
    case "auto_compaction_end":
      void publish("working", true, "");
      return;
    case "auto_retry_start":
      void publish("working", false, "");
      return;
    case "model_changed":
    case "thinking_level_changed":
      void refreshState();
      return;
    case "message_update":
      thinking.update(frame.assistantMessageEvent);
      return;
    case "message_end":
      thinking.clear();
      return;
    case "extension_ui_request":
      handleUiRequest(frame);
      return;
    case "notice":
      if (frame.level === "error") process.stderr.write(`omp: ${clean(frame.message, 500)}\n`);
      return;
    default:
  }
}

function handleUiRequest(frame) {
  if (frame.method === "cancel") {
    clearUi(frame.targetId);
    return;
  }
  if (!UI_METHODS.has(frame.method) || typeof frame.id !== "string") return;
  if (frame.method === "editor" && freeText !== null) {
    const text = freeText;
    freeText = null;
    send({ type: "extension_ui_response", id: frame.id, value: text });
    return;
  }
  setUi(frame);
}

let stdoutBuffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  let newline;
  while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
    const line = stdoutBuffer.slice(0, newline);
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line.trim()) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame && typeof frame === "object") handleFrame(frame);
  }
});

// ---- lifecycle -----------------------------------------------------------------
let stopping = null;
let exitCode = 0;
const exitWaiters = [];

function stop() {
  if (stopping) return stopping;
  stopping = new Promise((resolve) => exitWaiters.push(resolve));
  // Closing stdin is omp's documented clean shutdown: it drains accepted
  // commands, disposes the session, and exits 0.
  try { child.stdin.end(); } catch {}
  const term = setTimeout(() => {
    try { child.kill("SIGTERM"); } catch {}
    const kill = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, KILL_GRACE_MS);
    kill.unref();
  }, STOP_GRACE_MS);
  term.unref();
  return stopping;
}

child.on("error", (error) => {
  process.stderr.write(`omp-web: could not start omp: ${error.message}\n`);
  exitCode = 1;
  void finish();
});
child.on("exit", (code, signal) => {
  if (code && !stopping) process.stderr.write(`omp exited (${code})\n`);
  else if (signal && !stopping) process.stderr.write(`omp exited (${signal})\n`);
  exitCode = code || 0;
  void finish();
});

let finished = false;
async function finish() {
  if (finished) return;
  finished = true;
  exited = true;
  clearInterval(heartbeat);
  clearInterval(idleCheck);
  releaseReadyWaiters(bridgeError("ERUNNER", "omp exited"));
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.resolve({ id, type: "response", success: false, error: "omp exited" });
  }
  pending.clear();
  try { server.close(); } catch {}
  try { fs.unlinkSync(socketPath); } catch {}
  thinking.clear();
  clearUi();
  await publish("idle", true, "");
  await Promise.race([writes, new Promise((resolve) => setTimeout(resolve, WRITE_TIMEOUT_MS))]);
  for (const resolve of exitWaiters.splice(0)) resolve();
  // Let stop requesters receive their response before the process ends.
  setTimeout(() => process.exit(exitCode), 50);
}

for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"]) {
  process.on(signal, () => void stop());
}

const heartbeat = setInterval(() => {
  if (current === "done" && Date.now() - doneAt >= RECENT_DONE_MS) {
    void publish("idle", true, "");
    return;
  }
  void publish(current, true);
}, HEARTBEAT_MS);

// Idle stop frees the process once nothing can wake the session and nobody
// has asked for anything; the next Chat send starts omp again.
const idleCheck = setInterval(() => {
  if (!state.ready || stopping || !state.settled || state.streaming || state.ui || pending.size) return;
  if (Date.now() - lastActivityAt < idleMs) return;
  say("omp stopped after being idle.");
  void stop();
}, Math.min(15_000, Math.max(1_000, idleMs / 4)));

// ---- socket API ----------------------------------------------------------------
async function handleRequest(request) {
  lastActivityAt = Date.now();
  const op = request && request.op;
  if (op === "state") {
    return { ...state, stopping: Boolean(stopping) };
  }
  if (op === "stop") {
    await stop();
    return null;
  }
  if (stopping) throw bridgeError("ESTOPPING", "omp is stopping");
  await whenReady();
  if (op === "prompt") {
    const text = request.text;
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
      throw bridgeError("EBADTEXT", "text must be a non-empty string within the size limit");
    }
    // A send during a running turn steers it, which is what Enter does in the TUI.
    const fields = { message: text };
    if (state.streaming) fields.streamingBehavior = "steer";
    // Mark the turn busy before sending: a fast prompt_result (a local slash
    // command, a pre-dispatch failure) can arrive in the same stdout chunk as
    // the ack, and a post-ack update would then pin the session at working.
    const wasSettled = state.settled;
    state.settled = false;
    void publish("working", false, "");
    const response = await command("prompt", fields);
    if (!response.success) {
      // Not admitted. omp writes this prompt's prompt_result after the error
      // response, so restoring here cannot undo a later result.
      state.settled = wasSettled;
      void publish(state.streaming ? "working" : "idle", false, "");
      throw bridgeError("ERUNNER", clean(response.error || "prompt failed", 500));
    }
    if (response.data && response.data.agentInvoked === false && !state.streaming) {
      state.settled = true;
      void publish("idle", false, "");
    }
    return null;
  }
  if (op === "abort") {
    const response = await command("abort");
    if (!response.success) throw bridgeError("ERUNNER", clean(response.error || "abort failed", 500));
    return null;
  }
  if (op === "model") {
    if (typeof request.provider !== "string" || !request.provider || typeof request.modelId !== "string" || !request.modelId) {
      throw bridgeError("EBADMODEL", "provider and modelId are required");
    }
    const model = await command("set_model", { provider: request.provider, modelId: request.modelId });
    if (!model.success) throw bridgeError("EBADMODEL", clean(model.error || "model switch failed", 500));
    if (typeof request.level === "string" && request.level) {
      const level = await command("set_thinking_level", { level: request.level });
      if (!level.success) throw bridgeError("EBADEFFORT", clean(level.error || "effort switch failed", 500));
    }
    await refreshState();
    return { model: state.model, thinkingLevel: state.thinkingLevel };
  }
  if (op === "answer") return answer(request);
  throw bridgeError("EBADOP", "unknown op");
}

function answer(request) {
  const ui = state.ui;
  if (!ui || typeof request.requestId !== "string" || request.requestId !== ui.id) {
    throw bridgeError("ECONFLICT", "that question is no longer waiting for an answer");
  }
  const response = { type: "extension_ui_response", id: uiRawId };
  if (request.cancelled === true) {
    response.cancelled = true;
  } else if (ui.method === "confirm") {
    if (typeof request.confirmed !== "boolean") throw bridgeError("EBADANSWER", "confirmed must be true or false");
    response.confirmed = request.confirmed;
  } else {
    if (typeof request.value !== "string" || Buffer.byteLength(request.value, "utf8") > MAX_TEXT_BYTES) {
      throw bridgeError("EBADANSWER", "value must be a string within the size limit");
    }
    response.value = request.value;
    if (ui.method === "select") {
      // The card shows cleaned labels; omp matches the originals.
      const index = ui.options.indexOf(request.value);
      if (index >= 0) {
        response.value = uiOptions[index];
      } else {
        const other = uiOptions.findLast((option) => /^other\b/i.test(option));
        if (other !== undefined) {
          freeText = request.value;
          response.value = other;
        }
      }
    }
  }
  send(response);
  clearUi();
  if (current === "idle" || current === "waiting") void publish("working");
  return null;
}

const previousUmask = process.umask(0o177);
fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
try { fs.unlinkSync(socketPath); } catch {}
// The socket listens before omp is ready so the server can tell "starting"
// from "not running"; ops other than state wait for ready.
const server = net.createServer((connection) => {
  let buffer = "";
  let handled = false;
  connection.setEncoding("utf8");
  connection.on("error", () => {});
  connection.on("data", (chunk) => {
    if (handled) return;
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) {
      if (buffer.length > MAX_REQUEST_BYTES) {
        handled = true;
        connection.end(`${JSON.stringify({ ok: false, code: "EBADREQUEST", error: "request too large" })}\n`);
      }
      return;
    }
    handled = true;
    let request;
    try {
      request = JSON.parse(buffer.slice(0, newline));
    } catch {
      connection.end(`${JSON.stringify({ ok: false, code: "EBADREQUEST", error: "malformed request" })}\n`);
      return;
    }
    Promise.resolve()
      .then(() => handleRequest(request))
      .then(
        (data) => ({ ok: true, data }),
        (error) => ({ ok: false, code: error.code || "ERUNNER", error: error.message || "request failed" })
      )
      .then((reply) => {
        if (!connection.destroyed) connection.end(`${JSON.stringify(reply)}\n`);
      });
  });
});
server.on("error", (error) => {
  process.stderr.write(`omp-web: bridge socket failed: ${error.message}\n`);
  void stop();
});
server.listen(socketPath, () => {
  process.umask(previousUmask);
  try { fs.chmodSync(socketPath, 0o600); } catch {}
});
