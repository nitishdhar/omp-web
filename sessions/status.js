"use strict";
// Pure status-derivation core for sessions.js (which owns the `@omp_*` parse
// context in sessionFromLine). No tmux calls here: every function below is
// deterministic given its inputs, so the precedence can be unit-checked with
// `node -e` and no tmux server.
const fs = require("fs");
const path = require("path");
const config = require("../config");

const SESSION_STATUSES = new Set(["starting", "idle", "working", "waiting", "done", "shell"]);
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "fish"]);
const STATUS_STALE_MS = 90_000;
const THINKING_STALE_MS = 15_000;
const RECENT_DONE_MS = 5 * 60_000;
const TRANSCRIPT_STATUS_TAIL_BYTES = 128 * 1024;
const TRANSCRIPT_STATUS_CACHE_LIMIT = 128;
const transcriptStatusCache = new Map();

function transcriptEntryStatus(entry, fallbackAt) {
  if (!entry || typeof entry !== "object") return null;
  const message = entry.message && typeof entry.message === "object" ? entry.message : null;
  const messageAt = Number(message && message.timestamp);
  const parsedAt = Date.parse(entry.timestamp);
  const statusAt = Number.isFinite(messageAt) && messageAt > 0
    ? messageAt
    : (Number.isFinite(parsedAt) ? parsedAt : fallbackAt);

  if (entry.type === "custom") {
    if (entry.customType === "session_exit") return { status: "idle", statusAt };
    if (entry.customType === "tool_execution_start") {
      return {
        status: entry.data && entry.data.toolName === "ask" ? "waiting" : "working",
        statusAt,
      };
    }
    return null;
  }
  if (entry.type !== "message" || !message) return null;
  if (message.role === "user" || message.role === "toolResult") {
    return { status: "working", statusAt };
  }
  if (message.role !== "assistant") return null;

  const toolCalls = Array.isArray(message.content)
    ? message.content.filter((block) => block && block.type === "toolCall")
    : [];
  if (toolCalls.some((block) => block.name === "ask")) {
    return { status: "waiting", statusAt };
  }
  if (toolCalls.length) {
    return { status: "working", statusAt };
  }
  if (message.stopReason === "stop") {
    return { status: "done", statusAt };
  }
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return { status: "idle", statusAt };
  }
  return { status: "working", statusAt };
}

function transcriptSessionStatus(file) {
  if (!file) return { status: "unknown", statusAt: 0 };
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { status: "unknown", statusAt: 0 };
  }

  const cached = transcriptStatusCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.result;
  }

  const length = Math.min(stat.size, TRANSCRIPT_STATUS_TAIL_BYTES);
  const start = stat.size - length;
  const buffer = Buffer.allocUnsafe(length);
  let bytesRead = 0;
  let fd;
  try {
    fd = fs.openSync(file, "r");
    bytesRead = fs.readSync(fd, buffer, 0, length, start);
  } catch {
    return { status: "unknown", statusAt: 0 };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  let text = buffer.subarray(0, bytesRead).toString("utf8");
  if (start > 0) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
  }
  let result = { status: "unknown", statusAt: 0 };
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const projected = transcriptEntryStatus(JSON.parse(line), Math.trunc(stat.mtimeMs));
      if (projected) result = projected;
    } catch {}
  }

  transcriptStatusCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, result });
  if (transcriptStatusCache.size > TRANSCRIPT_STATUS_CACHE_LIMIT) {
    transcriptStatusCache.delete(transcriptStatusCache.keys().next().value);
  }
  return result;
}
function settledTranscriptSessionStatus(file) {
  const result = transcriptSessionStatus(file);
  if (result.status !== "done") return result;
  const age = Date.now() - result.statusAt;
  return age >= 0 && age <= RECENT_DONE_MS
    ? result
    : { status: "idle", statusAt: result.statusAt };
}

// Precedence: live pane identity > fresh heartbeat (<=STATUS_STALE_MS) >
// transcript tail > idle. Truth table (agent type; T = settled tail):
// starting x fresh -> starting | starting x stale -> T
// working/waiting/done x fresh -> published | x stale -> T
// idle x fresh -> done iff T is done else idle | idle x stale -> T
// published shell (fresh or stale) -> shell; shell type -> shell always
// unknown/other published -> never fresh -> T
// Stale + pane foreground is OMP itself, a shell, or empty -> T (no exit
// evidence); stale + any other foreground command -> shell (OMP is gone).
// rpc runner: the pane only ever holds the bridge or the idle `tail` holder,
// never a user shell, so it is never `shell`. The bridge heartbeats while it
// runs; without a fresh beat nothing is running, so a tail that still reads
// working/waiting (a turn cut short) settles to idle.
function normalizedSessionStatus(sessionType, status, statusAt, paneCommand, transcript, runner = null) {
  const timestamp = Number(statusAt) || 0;
  if (sessionType === "shell") return { status: "shell", statusAt: timestamp };
  const age = Date.now() - timestamp;
  const fresh = SESSION_STATUSES.has(status) && timestamp && age >= 0 && age <= STATUS_STALE_MS;
  if (runner === "rpc") return rpcSessionStatus(status, timestamp, fresh, transcript);
  if (fresh && status === "starting") return { status: "starting", statusAt: timestamp };
  if (status === "shell") return { status: "shell", statusAt: timestamp };
  if (fresh && status !== "idle") return { status, statusAt: timestamp };
  const transcriptStatus = settledTranscriptSessionStatus(transcript);
  if (fresh) {
    return transcriptStatus.status === "done"
      ? transcriptStatus
      : { status: "idle", statusAt: timestamp };
  }
  // Wrapped panes keep a login-shell parent while OMP runs (architecture.md),
  // so a shell pane command proves nothing there — fall through to the
  // transcript. Only a non-shell foreground command is exit evidence.
  const base = paneCommand ? path.basename(String(paneCommand)) : "";
  if (base && base !== path.basename(config.ompBin) && !SHELL_COMMANDS.has(base)) {
    return { status: "shell", statusAt: timestamp };
  }
  return transcriptStatus;
}

function rpcSessionStatus(status, timestamp, fresh, transcript) {
  if (fresh && status !== "idle" && status !== "shell") return { status, statusAt: timestamp };
  const transcriptStatus = settledTranscriptSessionStatus(transcript);
  if (transcriptStatus.status === "done") return transcriptStatus;
  if (fresh || transcriptStatus.status !== "idle") {
    return { status: "idle", statusAt: Math.max(timestamp, transcriptStatus.statusAt) };
  }
  return transcriptStatus;
}

module.exports = {
  SESSION_STATUSES,
  SHELL_COMMANDS,
  STATUS_STALE_MS,
  THINKING_STALE_MS,
  RECENT_DONE_MS,
  TRANSCRIPT_STATUS_TAIL_BYTES,
  transcriptEntryStatus,
  transcriptSessionStatus,
  settledTranscriptSessionStatus,
  normalizedSessionStatus,
};
