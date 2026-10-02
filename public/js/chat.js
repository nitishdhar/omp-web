"use strict";
// Chat mode controller: poll loop, byte cursor, mode lifecycle.
// tmux stays the single writer; this module reads the session JSONL and
// injects input via the backend's tmux send helpers — no second OMP process.

import { api } from "./api.js";
import { state } from "./state.js";
import { upsertItems, clearLog, removeItem, syncActivityNode, pinToTail, deliveredUserText } from "./chat/transcript.js";
export { refreshLanding } from "./chat/panels.js";
import { renderPanels, setChatLoading, setInterruptSession } from "./chat/panels.js";
import {
  activateComposer,
  editComposerDraft,
  resetComposerSession,
  beginInterruptRequest,
  endInterruptRequest,
  resetInterruptButton,
} from "./chat/composer.js";
import { sha256Hex } from "./chat/hash.js";

// Re-export composer controls so main.js has one chat-mode entry point.
export { activateComposer, wireComposer, setComposerEnabled, restoreLandingDraft } from "./chat/composer.js";

const POLL_MS = 1200;
// OpenClaw's pushed tool stream renders live work immediately. OMP's JSONL
// transcript is polling-only, so tighten the loop only while the derived turn
// activity says work is in flight; idle sessions retain the quieter cadence.
const ACTIVE_POLL_MS = 350;
const BACKOFF_CAP = 30000;
const NO_TRANSCRIPT_MS = 3000;
const MAX_TEXT_BYTES = 32 * 1024;
// A session writing faster than one poll round trip would keep the cold-open
// buffer open forever, so the quiet mount is time-bounded, never open-ended.
const CATCH_UP_MS = 1500;

let sessionId = null;
let byteCursor = 0;
let pollTimer = null;
let pollController = null;
let queuedPoll = null;
let pollGeneration = 0;
let optimisticSeq = 0;
let failCount = 0;
// A cold open replays the whole transcript in byte pages. Rendering each page
// repainted and re-pinned the log, which read as the view flying to the bottom;
// buffer the catch-up and mount it once, already at the tail.
let catchUpUntil = 0;
let pendingItems = [];
let pendingRestore = false;
const localUserItems = new Map();
// Latest user text per session, from sends and polled transcript echoes alike.
// regenerateLast resends it as a new turn after a session error, once the
// optimistic record has already been reconciled away.
const lastUserTextBySession = new Map();

function recordItem(record) {
  return {
    id: record.id,
    at: record.at,
    kind: "user",
    text: record.text,
    textHash: record.textHash || undefined,
    pending: record.pending || undefined,
    failed: record.failed || undefined,
    deliveryUnknown: record.deliveryUnknown || undefined,
    errorText: record.errorText || undefined,
    statusText: record.statusText || undefined,
  };
}

function ownsRecord(record) {
  return localUserItems.get(record.id) === record;
}

function showRecord(record) {
  if (ownsRecord(record) && sessionId === record.sessionId) upsertItems([recordItem(record)]);
}

function restoreLocalUserItems(id) {
  const items = [];
  for (const record of localUserItems.values()) {
    if (record.sessionId === id) items.push(recordItem(record));
  }
  if (items.length) upsertItems(items);
}

function clearLocalSession(id) {
  for (const [localId, record] of localUserItems) {
    if (record.sessionId !== id) continue;
    localUserItems.delete(localId);
    removeItem(localId);
  }
}

function comparableEchoText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}
function reconcileUserEchoes(items, id) {
  for (const item of items || []) {
    if (item.kind !== "user" || typeof item.textHash !== "string") continue;
    const itemAt = Date.parse(item.at);
    let match = null;
    let matchDistance = Infinity;
    for (const record of localUserItems.values()) {
      if (record.sessionId !== id) continue;
      const sameHash = record.textHash === item.textHash;
      // Native multiline paste may normalize indentation or line endings
      // before OMP records the message. Within this send's time window, a
      // whitespace-equivalent full preview is the same authoritative echo.
      const sameText = !item.truncated
        && comparableEchoText(record.text) === comparableEchoText(item.text);
      if (!sameHash && !sameText) continue;
      // Do not consume an older, identical transcript message during a reset.
      if (Number.isFinite(itemAt) && itemAt < record.createdAt - 5000) continue;
      let distance = 0;
      if (Number.isFinite(itemAt)) {
        distance = Infinity;
        for (const attempt of record.attemptedAt) {
          distance = Math.min(distance, Math.abs(itemAt - attempt));
        }
      }
      if (distance >= matchDistance) continue;
      match = record;
      matchDistance = distance;
    }
    if (!match) continue;
    localUserItems.delete(match.id);
    removeItem(match.id);
  }
}

async function attemptSend(record) {
  if (record.inFlight) return false;
  record.inFlight = true;
  record.pending = true;
  record.failed = false;
  record.deliveryUnknown = false;
  record.errorText = "";
  record.attemptedAt.push(Date.now());
  if (record.attemptedAt.length > 16) record.attemptedAt.shift();
  showRecord(record);

  // A session created from the landing composer is still `starting` for a few
  // seconds; its first message would otherwise fail as a hard error. Only the
  // startup window is retried, and only for this record's own message.
  const deadline = record.createdAt + 90_000;
  try {
    for (;;) {
      try {
        await api(`/sessions/${encodeURIComponent(record.sessionId)}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: record.text }),
        });
        break;
      } catch (error) {
        const starting = error?.status === 409 && error?.code === "EBUSY"
          && ownsRecord(record) && Date.now() < deadline;
        if (!starting) throw error;
        record.statusText = "Waiting for OMP to start…";
        showRecord(record);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        record.attemptedAt.push(Date.now());
        if (record.attemptedAt.length > 16) record.attemptedAt.shift();
      }
    }
    record.statusText = "";
    if (ownsRecord(record) && sessionId === record.sessionId) schedulePoll(0);
    return true;
  } catch (error) {
    record.statusText = "";
    if (!ownsRecord(record)) return false;
    // A fetch failure can occur after the server accepted the POST. Keep the
    // exact message reconcilable by hash and make any resend an explicit act.
    record.pending = false;
    record.failed = true;
    record.deliveryUnknown = error?.status == null;
    record.errorText = record.deliveryUnknown
      ? "Connection lost before delivery could be confirmed."
      : (error?.message || "Send failed");
    showRecord(record);
    return false;
  } finally {
    record.inFlight = false;
  }
}

// Restart or stop the poll when the tab's visibility changes.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    stopPoll();
  } else if (sessionId && state.mode === "chat") {
    schedulePoll(0);
  }
});

// ---- Public API -----------------------------------------------------------

export function enterChat(id, forceReset = false) {
  if (!id) {
    resetChat();
    return;
  }

  const changed = sessionId !== id;
  stopPoll();
  if (changed || forceReset) {
    clearLog();
    renderPanels(null);
    syncActivityNode();
    byteCursor = 0;
    failCount = 0;
    catchUpUntil = Date.now() + CATCH_UP_MS;
    pendingItems = [];
    setChatLoading(true);
  }
  if (forceReset) clearLocalSession(id);

  sessionId = id;
  setInterruptSession(true);
  if (changed || forceReset) resetInterruptButton();
  activateComposer(id, { reset: forceReset });
  if (changed || forceReset) restoreLocalUserItems(id);
  if (state.mode === "chat") schedulePoll(0);
}

export function leaveChat() {
  // Keep the active composer ownership/cursor so returning to Chat is seamless.
  stopPoll();
}

export function resetChat({ discardPrevious = true } = {}) {
  const previousId = sessionId;
  stopPoll();
  sessionId = null;
  setInterruptSession(false);
  resetInterruptButton();
  byteCursor = 0;
  failCount = 0;
  catchUpUntil = 0;
  pendingItems = [];
  pendingRestore = false;
  setChatLoading(false);
  if (previousId && discardPrevious) clearLocalSession(previousId);
  if (previousId && discardPrevious) lastUserTextBySession.delete(previousId);
  clearLog();
  renderPanels(null);
  syncActivityNode();
  activateComposer(null, { discardPrevious });
}

/** Invalidate a reloaded session's local epoch without selecting it. */
export function resetChatSession(id) {
  if (!id) return;
  if (sessionId === id) {
    enterChat(id, true);
    return;
  }
  clearLocalSession(id);
  resetComposerSession(id);
}

export async function sendChat(text) {
  if (!sessionId || typeof text !== "string" || !text.trim()) return false;

  const id = sessionId;
  const createdAt = Date.now();
  const record = {
    id: `local-user:${createdAt}:${++optimisticSeq}`,
    sessionId: id,
    text,
    textHash: "",
    at: new Date(createdAt).toISOString(),
    createdAt,
    attemptedAt: [],
    pending: true,
    failed: false,
    deliveryUnknown: false,
    errorText: "",
    inFlight: false,
  };
  localUserItems.set(record.id, record);
  showRecord(record);
  // A send is an explicit request to watch the reply: re-pin even if a system
  // scroll flipped followTail off while the keyboard was animating.
  pinToTail();

  try {
    const bytes = new TextEncoder().encode(text);
    record.byteLength = bytes.byteLength;
    if (record.byteLength > MAX_TEXT_BYTES) {
      record.pending = false;
      record.failed = true;
      record.errorText = "Message exceeds the 32 KiB send limit. Edit it before retrying.";
      showRecord(record);
      // The composer was already cleared before send, so the oversize text would
      // otherwise live only in the failed card. Reload it for editing instead
      // of leaving Retry with nothing it could resend.
      editComposerDraft(text, id);
      return false;
    }
    // Hash before POST so even a very fast transcript poll can reconcile the
    // optimistic full text with the server's bounded display text.
    record.textHash = await sha256Hex(bytes);
    showRecord(record);
    if (!ownsRecord(record)) return false;
  } catch (error) {
    record.pending = false;
    record.failed = true;
    record.errorText = error?.message || "Unable to prepare message";
    showRecord(record);
    return false;
  }

  lastUserTextBySession.set(id, text);
  return attemptSend(record);
}

export async function retryChat(id) {
  const record = localUserItems.get(id);
  if (!record || !record.failed || record.sessionId !== sessionId) return false;
  if (record.byteLength > MAX_TEXT_BYTES) {
    // Resending can never succeed while oversize, so keep the inline
    // explanation visible and put the text back in the composer for editing.
    record.errorText = "Message exceeds the 32 KiB send limit. Edit it before retrying.";
    showRecord(record);
    editComposerDraft(record.text, record.sessionId);
    return false;
  }
  return attemptSend(record);
}

export function editChat(id) {
  const record = localUserItems.get(id);
  if (record) {
    if (!record.failed || record.sessionId !== sessionId) return false;
    if (!editComposerDraft(record.text, record.sessionId)) return false;
    localUserItems.delete(id);
    removeItem(id);
    return true;
  }
  // A delivered turn has no local record: the resend is a new turn, so the
  // original stays while its text loads into the composer for editing.
  if (!sessionId) return false;
  const text = deliveredUserText(id);
  if (!text) return false;
  return editComposerDraft(text, sessionId);
}

export async function interruptChat() {
  if (!sessionId) return;
  const id = sessionId;
  const generation = pollGeneration;
  // Optimistic pending also covers direct callers (e.g. the Retry card's
  // retryInterrupt); the composer click already entered it, idempotently.
  beginInterruptRequest();
  try {
    await api(`/sessions/${encodeURIComponent(id)}/chat/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: ["Escape"] }),
    });
    if (sessionId !== id || pollGeneration !== generation) {
      resetInterruptButton();
      return;
    }
    endInterruptRequest(true);
  } catch (error) {
    if (sessionId === id && pollGeneration === generation) {
      endInterruptRequest(false);
      upsertItems([clientError("chat-interrupt-error", "Interrupt failed", error, { action: "retry-interrupt", sessionId: id })]);
    } else {
      resetInterruptButton();
    }
  }
}

// Resumption paths for transcript error cards (shared with slice C, which
// reuses these; the builder reaches them via window so no new emit/get names
// are needed and check:events stays balanced).
export function retryPollTurn(cardSessionId) {
  if (!sessionId || (cardSessionId && cardSessionId !== sessionId)) return false;
  // Drop the backoff so the next attempt goes out immediately; a successful
  // poll clears the card itself.
  failCount = 0;
  schedulePoll(0);
  return true;
}

export function retryInterrupt(cardSessionId) {
  if (!sessionId || (cardSessionId && cardSessionId !== sessionId)) return false;
  void interruptChat();
  return true;
}

export async function regenerateLast(cardSessionId) {
  const target = cardSessionId || sessionId;
  if (!target || target !== sessionId) return false;
  const text = lastUserTextBySession.get(target);
  if (!text) return false;
  return sendChat(text);
}

if (typeof window !== "undefined") {
  window.retryPollTurn = retryPollTurn;
  window.retryInterrupt = retryInterrupt;
  window.regenerateLast = regenerateLast;
}

// ---- Poll loop ------------------------------------------------------------
function stopPoll() {
  pollGeneration++;
  clearTimeout(pollTimer);
  pollTimer = null;
  queuedPoll = null;
  pollController?.abort();
}

function schedulePoll(delay) {
  if (!sessionId || state.mode !== "chat" || document.visibilityState === "hidden") return;
  const request = { generation: pollGeneration, delay };
  if (pollController) {
    if (!queuedPoll || queuedPoll.generation !== request.generation) {
      queuedPoll = request;
    } else {
      queuedPoll.delay = Math.min(queuedPoll.delay, delay);
    }
    return;
  }
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    doPoll(request.generation);
  }, delay);
}

function clientError(id, label, error, action) {
  const detail = error && error.message ? `: ${error.message}` : "";
  const item = {
    id,
    at: new Date().toISOString(),
    kind: "error",
    text: `${label}${detail}`,
  };
  if (action) item.action = action;
  return item;
}

async function doPoll(generation) {
  if (
    generation !== pollGeneration
    || pollController
    || !sessionId
    || state.mode !== "chat"
    || document.visibilityState === "hidden"
  ) return;

  const id = sessionId;
  const controller = new AbortController();
  pollController = controller;
  let nextDelay = null;

  try {
    const data = await api(
      `/sessions/${encodeURIComponent(id)}/chat?from=${byteCursor}`,
      { signal: controller.signal },
    );
    if (generation !== pollGeneration || sessionId !== id) return;

    failCount = 0;
    removeItem("chat-poll-error");
    const { transcript, items, derived } = data;
    if (transcript.reset) {
      clearLog();
      catchUpUntil = Date.now() + CATCH_UP_MS;
      pendingItems = [];
      pendingRestore = true;
    }
    reconcileUserEchoes(items, id);

    const previousByte = byteCursor;
    byteCursor = transcript.nextByte;
    const moreToRead = byteCursor > previousByte;
    if (moreToRead && Date.now() < catchUpUntil) {
      // Another page is already due; keep the DOM untouched so the transcript
      // appears once, at the tail, instead of scrolling past the reader.
      if (items?.length) pendingItems.push(...items);
      nextDelay = 0;
      return;
    }
    catchUpUntil = 0;
    setChatLoading(false);
    const batch = pendingItems.length ? pendingItems.concat(items || []) : items;
    pendingItems = [];
    for (const item of batch || []) {
      if (!item || typeof item !== "object") continue;
      if (item.kind === "user" && typeof item.text === "string" && item.text) {
        lastUserTextBySession.set(id, item.text);
      } else if (item.kind === "error" && !item.action) {
        // Server session errors carry no resumption path; the card retries by
        // resending the last user text as a new turn.
        item.action = { action: "regenerate", sessionId: id };
      }
    }
    if (batch?.length) upsertItems(batch);
    if (pendingRestore) {
      pendingRestore = false;
      restoreLocalUserItems(id);
    }
    if (derived) {
      renderPanels(derived);
      syncActivityNode();
    }
    nextDelay = moreToRead ? 0 : (derived?.activity ? ACTIVE_POLL_MS : POLL_MS);
  } catch (error) {
    if (
      generation !== pollGeneration
      || sessionId !== id
      || error?.name === "AbortError"
    ) return;

    if (error?.code === "ENOSESSION") {
      resetChat();
      return;
    }

    if (error?.code === "ENOTRANSCRIPT") {
      setChatLoading(false);
      clearLog();
      restoreLocalUserItems(id);
      byteCursor = 0;
      renderPanels(null);
      syncActivityNode();
      failCount = 0;
      nextDelay = NO_TRANSCRIPT_MS;
    } else {
      setChatLoading(false);
      failCount++;
      if (failCount === 1) {
        upsertItems([clientError("chat-poll-error", "Chat update failed", error, { action: "retry-poll", sessionId: id })]);
      }
      nextDelay = Math.min(POLL_MS * 2 ** (failCount - 1), BACKOFF_CAP);
    }
  } finally {
    if (pollController === controller) pollController = null;
    const queued = queuedPoll;
    queuedPoll = null;
    if (
      sessionId
      && state.mode === "chat"
      && document.visibilityState !== "hidden"
    ) {
      if (queued?.generation === pollGeneration) {
        schedulePoll(nextDelay == null ? queued.delay : Math.min(nextDelay, queued.delay));
      } else if (generation === pollGeneration && nextDelay != null) {
        schedulePoll(nextDelay);
      }
    }
  }
}
