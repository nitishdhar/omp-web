"use strict";

// Chat-mode HTTP endpoints. All requests arrive here already authenticated
// (the token gate lives in server.js before handleApi is called).
//
// GET  /api/sessions/:id/chat?from=<byte>  -> { transcript, items, derived }
// POST /api/sessions/:id/chat              -> 202 { ok: true }
// POST /api/sessions/:id/chat/keys         -> 202 { ok: true }

const { execFile } = require("child_process");
const config = require("../config");
const sessions = require("../sessions");
const { resolveTranscript } = require("../transcripts");
const { sendJson, sendError, readBody } = require("./util");
const { readFrom } = require("../transcript-read");
const { project } = require("../chat-project");

// Exact-cursor projection checkpoints are bounded independently per session,
// across the process, and by age. Reading a checkpoint refreshes its LRU
// position so concurrently advancing clients do not invalidate one another.
const carryMap = new Map();
const MAX_SESSION_CHECKPOINTS = 64;
const MAX_GLOBAL_CHECKPOINTS = 512;
const MAX_CHECKPOINT_AGE_MS = 30 * 60 * 1000;
let carryCount = 0;

function clearCarry(id) {
  const checkpoints = carryMap.get(id);
  if (!checkpoints) return;
  carryCount -= checkpoints.size;
  carryMap.delete(id);
}

function pruneExpiredCarry(now = Date.now()) {
  for (const [id, checkpoints] of carryMap) {
    for (const [cursor, carry] of checkpoints) {
      if (now - carry.storedAt > MAX_CHECKPOINT_AGE_MS) {
        checkpoints.delete(cursor);
        carryCount--;
      }
    }
    if (!checkpoints.size) carryMap.delete(id);
  }
}

function getCarry(id, cursor) {
  pruneExpiredCarry();
  const checkpoints = carryMap.get(id);
  const carry = checkpoints && checkpoints.get(cursor);
  if (!carry) return null;
  checkpoints.delete(cursor);
  checkpoints.set(cursor, carry);
  carry.lastUsedAt = Date.now();
  return carry;
}

function evictGlobalCarry() {
  while (carryCount > MAX_GLOBAL_CHECKPOINTS) {
    let oldest = null;
    for (const [id, checkpoints] of carryMap) {
      const first = checkpoints.entries().next().value;
      if (!first) continue;
      const [cursor, carry] = first;
      if (!oldest || carry.lastUsedAt < oldest.carry.lastUsedAt) {
        oldest = { id, cursor, carry };
      }
    }
    if (!oldest) break;
    const checkpoints = carryMap.get(oldest.id);
    checkpoints.delete(oldest.cursor);
    carryCount--;
    if (!checkpoints.size) carryMap.delete(oldest.id);
  }
}

function setCarry(id, cursor, carry) {
  pruneExpiredCarry();
  let checkpoints = carryMap.get(id);
  if (!checkpoints) {
    checkpoints = new Map();
    carryMap.set(id, checkpoints);
  }
  if (checkpoints.delete(cursor)) carryCount--;
  const now = Date.now();
  checkpoints.set(cursor, Object.assign(carry, { storedAt: now, lastUsedAt: now }));
  carryCount++;
  while (checkpoints.size > MAX_SESSION_CHECKPOINTS) {
    checkpoints.delete(checkpoints.keys().next().value);
    carryCount--;
  }
  evictGlobalCarry();
}

// Read the @omp_transcript tmux user-option for the given session. Returns ""
// when the option is unset or the session does not exist. The existing
// resolveTranscript() function handles the rest of the lookup chain.
function readTranscriptOption(sessionTarget) {
  return new Promise((resolve) => {
    execFile(
      config.tmuxBin,
      ["-L", config.tmuxSocket, "show-option", "-t", sessionTarget, "-v", "@omp_transcript"],
      { encoding: "utf8" },
      (err, stdout) => resolve(err ? "" : stdout.trim())
    );
  });
}

async function readJson(req, badCode) {
  try {
    return JSON.parse((await readBody(req)) || "{}");
  } catch (e) {
    if (e instanceof SyntaxError) e.code = badCode;
    throw e;
  }
}
async function requireChatSession(id) {
  const session = await sessions.get(id);
  if (!session) {
    const error = new Error("session not found");
    error.code = "ENOSESSION";
    throw error;
  }
  if (session.type === "shell") {
    const error = new Error("chat is unavailable because OMP is not running");
    error.code = "EBADSESSIONTYPE";
    throw error;
  }
  return session;
}

// The transcript names a runtime model only when a reply completes, and OMP
// does not reliably write model_change at startup. So after a reload the rail
// showed either nothing ("claude profile" — a cross-profile fork ends in
// session_exit) or the previous runtime's model as if it were current (a
// same-profile resume has no exit record). omp-web chose the launch model
// itself and stamped when, so until the transcript names a model *after* that
// stamp, show the launch model, marked as configured rather than observed.
// Response only — never carried state — so the first real record replaces it.
function applyLaunchIdentity(derived, sess) {
  const launchedAt = Number(sess.launchedAt) || 0;
  // Only a reload records what it launched. A create/restore resumes with no
  // --model, so OMP continues on the transcript's own model and the profile
  // default would be a guess — a restored openai session showed gpt-6-sol
  // while running gpt-5.6-terra.
  if (!launchedAt) return;
  // tmux, not the transcript, knows whether OMP is running. The old runtime
  // writes its session_exit just *after* a reload replaces the pane, so a
  // transcript exit cannot be ordered against the launch stamp.
  if (derived.exited && sess.status === "shell") return;
  const observedAt = Date.parse(derived.modelAt || "") || 0;
  const stale = Boolean(derived.model && launchedAt && observedAt < launchedAt);
  if (derived.model && !stale) return;
  const launch = sessions.launchIdentityFor(derived.profile, sess.launchModel);
  if (!launch) return;
  derived.model = launch.model;
  derived.provider = launch.provider || (stale ? null : derived.provider);
  derived.effort = launch.effort || (stale ? null : derived.effort);
  derived.modelSource = "launch";
}

async function handleChat(req, res, sub, url) {
  // sub: ["sessions", <id>, "chat", ...]
  const id = sub[1];

  // --- GET /api/sessions/:id/chat?from=<byte> --------------------------------
  if (req.method === "GET" && sub.length === 3) {
    try {
      // Validate from= parameter.
      const fromParam = url.searchParams.get("from");
      let from = 0;
      if (fromParam !== null && fromParam !== "") {
        const n = Number(fromParam);
        if (!Number.isSafeInteger(n) || n < 0) {
          const e = new Error("from must be a non-negative integer");
          e.code = "EBADFROM";
          throw e;
        }
        from = n;
      }

      const sess = await requireChatSession(id);

      // Locate the transcript the same way the rest of the server does.
      const stored = await readTranscriptOption(sessions.tmuxPane(id));
      const file = resolveTranscript(id, sess.profile, stored);
      if (!file) {
        const e = new Error("no transcript found for session");
        e.code = "ENOTRANSCRIPT";
        throw e;
      }

      pruneExpiredCarry();
      const checkpoints = carryMap.get(id);
      const known = checkpoints && checkpoints.values().next().value;
      const fileChanged = Boolean(known && known.file !== file);
      if (fileChanged) clearCarry(id);

      const foundCarry = fileChanged ? null : getCarry(id, from);
      // from=0 normally requests a full replay. While scanning an oversized
      // first record, the anchored scan checkpoint is safe to resume at the
      // same proven newline boundary.
      const carry = from === 0 && !(foundCarry && foundCarry.oversize) ? null : foundCarry;
      const fullReplay = from === 0 && !carry;
      const coldCarry = !carry && from > 0;
      // A checkpoint is valid only for its exact byte cursor and transcript.
      // A new client can reuse an existing cursor without disturbing clients
      // already reading later pages.
      const mustReset = fullReplay || fileChanged || coldCarry;
      const read = await readFrom(
        file,
        mustReset ? 0 : from,
        mustReset ? null : carry.anchor,
        mustReset ? null : carry.oversize
      );
      const { entries, nextByte, anchor } = read;
      const reset = read.reset || mustReset;

      // Anchor mismatch means an in-place rewrite invalidated every checkpoint
      // for this transcript, not only the requesting client's cursor.
      if (read.reset && !mustReset) clearCarry(id);

      const prev = reset ? undefined : carry.state;
      const { items, derived, state } = project(entries, prev);
      if (read.scan && read.scan.omittedRecords) {
        items.unshift({
          id: `transcript-oversize:${read.scan.oversizeRecordStart}`,
          at: null,
          kind: "notice",
          attribution: "transcript",
          text: `${read.scan.omittedRecords} oversized transcript record${read.scan.omittedRecords === 1 ? "" : "s"} ${read.scan.omittedRecords === 1 ? "was" : "were"} not projected (${read.scan.omittedBytes} bytes). The complete record remains available in Terminal mode.`,
        });
      } else if (read.scan && read.scan.pendingOversizeBytes) {
        items.unshift({
          id: `transcript-oversize:${read.scan.oversizeRecordStart}`,
          at: null,
          kind: "notice",
          attribution: "transcript",
          text: `Scanning an oversized transcript record (${read.scan.pendingOversizeBytes} bytes checked). It has not been projected.`,
        });
      }
      if (read.scan && read.scan.malformedRecords) {
        items.unshift({
          id: `transcript-malformed:${nextByte}`,
          at: null,
          kind: "notice",
          attribution: "transcript",
          text: `${read.scan.malformedRecords} malformed transcript record${read.scan.malformedRecords === 1 ? "" : "s"} ${read.scan.malformedRecords === 1 ? "was" : "were"} skipped.`,
        });
      }
      // Session metadata is current even before the destination profile emits
      // its first assistant/model record.
      derived.profile = sess.profile || "default";
      if (sess.runtimeActivity === "compaction") {
        derived.activity = {
          toolName: null,
          intent: "Compacting context…",
          startedAt: null,
        };
      }
      // A reasoning headline is only better than "Thinking" while no tool is
      // running; a live tool is the more specific answer to "what now".
      else if (sess.thinking && derived.activity && !derived.activity.toolName) {
        derived.activity = { ...derived.activity, intent: sess.thinking, thinking: true };
      }
      // Some resumed runtimes emit model metadata without repeating their
      // thinking-level event. A profile-derived value is revalidated against
      // the complete live provider/model identity on every runtime change.
      if (!derived.exited && (!derived.effort || state.effortSource === "profile")) {
        const configuredEffort = sessions.configuredEffortFor(
          derived.profile,
          derived.model,
          derived.provider
        );
        state.effort = configuredEffort || null;
        state.effortSource = configuredEffort ? "profile" : null;
        derived.effort = state.effort;
      }
      applyLaunchIdentity(derived, sess);
      setCarry(id, nextByte, { file, anchor, state, oversize: read.oversize || null });

      return sendJson(res, 200, {
        transcript: { nextByte, reset, scan: read.scan },
        items,
        derived,
      });
    } catch (e) {
      if (e.code === "ENOSESSION" || e.code === "ENOTRANSCRIPT") clearCarry(id);
      return sendError(res, e);
    }
  }

  // --- POST /api/sessions/:id/chat  { text } ---------------------------------
  if (req.method === "POST" && sub.length === 3) {
    try {
      const body = await readJson(req, "EBADTEXT");
      await requireChatSession(id);
      await sessions.sendText(id, typeof body.text === "string" ? body.text : "");
      return sendJson(res, 202, { ok: true });
    } catch (e) {
      return sendError(res, e);
    }
  }

  // --- POST /api/sessions/:id/chat/keys  { keys } ----------------------------
  if (req.method === "POST" && sub[3] === "keys" && sub.length === 4) {
    try {
      const body = await readJson(req, "EBADKEYS");
      await requireChatSession(id);
      await sessions.sendKeys(id, body.keys);
      return sendJson(res, 202, { ok: true });
    } catch (e) {
      return sendError(res, e);
    }
  }

  // Unknown sub-path under /chat.
  const error = new Error("not found");
  error.code = "ENOTFOUND";
  return sendError(res, error);
}

module.exports = { handleChat };
