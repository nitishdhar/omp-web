"use strict";
// Chat composer: wires #chat-input, #chat-send, #chat-interrupt.
// Emits intent events only — main.js owns the network actions.

import { el } from "../dom.js";
import { emit, state } from "../state.js";
import { CHAT_ATTACHMENT_ACCEPT, wireAttachments } from "../mobile-attachments.js";
import { repinTail } from "./transcript.js";
import { setInterruptPending } from "./panels.js";

const MAX_ROWS = 8;
const drafts = new Map();
let wired = false;
let composing = false;
let compositionOwner = null;
let activeSessionId = null;
let attachments = null;

function draftFor(id) {
  let draft = drafts.get(id);
  if (!draft) {
    draft = { text: "", cycle: 0 };
    drafts.set(id, draft);
  }
  return draft;
}

let sizerEl = null;

// An absolutely positioned mirror of the textarea's text box. It is out of
// flow, so measuring never changes #chat-log's height.
function inputSizer(input) {
  if (!sizerEl || !sizerEl.isConnected) {
    sizerEl = document.createElement("div");
    sizerEl.className = "chat-input-sizer";
    sizerEl.setAttribute("aria-hidden", "true");
    (input.parentNode || document.body).append(sizerEl);
  }
  const cs = getComputedStyle(input);
  sizerEl.style.width = `${input.clientWidth}px`;
  sizerEl.style.font = cs.font;
  sizerEl.style.lineHeight = cs.lineHeight;
  sizerEl.style.letterSpacing = cs.letterSpacing;
  sizerEl.style.padding = cs.padding;
  return sizerEl;
}

function autoGrow(input) {
  // Collapsing the textarea to `auto` to measure it grew #chat-log inside the
  // same task: the browser clamped the log's pinned scrollTop to the larger
  // viewport, and the ResizeObserver in transcript.js then re-pinned it. That
  // clamp/re-pin round trip on every keystroke is what read as the transcript
  // flickering up and down. The mirror has no layout effect, so the log never
  // moves while the composer is measured.
  const sizer = inputSizer(input);
  // The trailing newline keeps a final empty line from being measured away.
  sizer.textContent = input.value ? `${input.value}\n` : "\n";
  const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 22;
  const max = lineHeight * MAX_ROWS;
  const content = sizer.scrollHeight;
  const next = Math.min(Math.max(content, lineHeight), max);
  const prev = parseFloat(input.style.height) || 0;
  if (!prev || Math.abs(next - prev) >= 1) {
    input.style.height = `${next}px`;
    // The log shrinks by exactly this delta; re-pin now so the tail never
    // shows an intermediate offset.
    if (prev) repinTail();
  }
  input.style.overflowY = content > max ? "scroll" : "hidden";
}

function renderDraft() {
  const input = el["chat-input"];
  if (!input) return;
  input.value = activeSessionId ? draftFor(activeSessionId).text : "";
  autoGrow(input);
  syncSendState();
}

function saveActiveDraft() {
  const input = el["chat-input"];
  if (input && activeSessionId) draftFor(activeSessionId).text = input.value;
}

function syncSendState() {
  const input = el["chat-input"];
  const send = el["chat-send"];
  if (!input || !send) return;
  send.disabled = input.disabled || !input.value.trim();
}

function attachmentPathToken(path) {
  return JSON.stringify(path);
}
function removePath(text, path) {
  const token = attachmentPathToken(path);
  let index = text.lastIndexOf(token);
  let length = token.length;
  if (index === -1) {
    index = text.lastIndexOf(path);
    length = path.length;
  }
  if (index === -1) return text;
  let start = index;
  let end = index + length;
  if (start > 0 && /\s/.test(text[start - 1])) start--;
  else if (end < text.length && /\s/.test(text[end])) end++;
  return text.slice(0, start) + text.slice(end);
}

function appendAttachmentPath(path, { sessionId, context } = {}) {
  const id = sessionId || activeSessionId;
  if (!id) return false;
  const draft = drafts.get(id);
  if (!draft || (context && (context.draft !== draft || context.cycle !== draft.cycle))) {
    return false;
  }
  const separator = draft.text && !/\s$/.test(draft.text) ? " " : "";
  draft.text += `${separator}${attachmentPathToken(path)}`;
  if (activeSessionId === id) {
    renderDraft();
    el["chat-input"]?.focus({ preventScroll: true });
  }
  return true;
}

function removeAttachmentPath(path, { sessionId, context } = {}) {
  const id = sessionId || activeSessionId;
  const draft = id && drafts.get(id);
  if (!draft || (context && (context.draft !== draft || context.cycle !== draft.cycle))) {
    return false;
  }
  draft.text = removePath(draft.text, path);
  if (activeSessionId === id) renderDraft();
  return true;
}

function doSend() {
  const input = el["chat-input"];
  if (!input || input.disabled || composing) return;
  const text = input.value.trim();
  if (!text) return;

  if (!activeSessionId) {
    input.value = "";
    autoGrow(input);
    syncSendState();
    emit("chat:startSession", { text });
    return;
  }

  const draft = draftFor(activeSessionId);
  draft.text = "";
  draft.cycle++;
  input.value = "";
  autoGrow(input);
  syncSendState();
  attachments?.clear(activeSessionId);
  emit("chat:send", { text });
}

// Stop pending lifecycle: the click disables immediately (optimistic pending),
// chat.js resolves to a brief confirmed flash or back to enabled on failure.
// Visibility stays owned by panels.js; here we only own disabled/busy styling.
// Stop never follows the input's disabled state, so it stays operable while
// the composer is open and a turn is live.
const STOP_LABEL = "Stop active work";
let interruptBusy = false;
let interruptDoneTimer = null;

function renderInterruptPending(interrupt, on) {
  interrupt.disabled = on;
  interrupt.classList.toggle("is-pending", on);
  if (on) interrupt.setAttribute("aria-busy", "true");
  else interrupt.removeAttribute("aria-busy");
}

/** Enter the optimistic pending state; idempotent for the click + send races. */
export function beginInterruptRequest() {
  const interrupt = el["chat-interrupt"];
  if (!interrupt || interruptBusy || interrupt.hidden) return false;
  interruptBusy = true;
  clearTimeout(interruptDoneTimer);
  interruptDoneTimer = null;
  interrupt.classList.remove("is-done");
  interrupt.setAttribute("aria-label", "Stopping active work");
  renderInterruptPending(interrupt, true);
  setInterruptPending(true);
  return true;
}

/** Resolve pending to confirmed (brief success affordance) or failed. */
export function endInterruptRequest(ok) {
  const interrupt = el["chat-interrupt"];
  interruptBusy = false;
  setInterruptPending(false);
  if (!interrupt) return;
  renderInterruptPending(interrupt, false);
  if (!ok) {
    interrupt.classList.remove("is-done", "is-pending");
    interrupt.setAttribute("aria-label", STOP_LABEL);
    return;
  }
  interrupt.classList.remove("is-pending");
  interrupt.classList.add("is-done");
  interrupt.setAttribute("aria-label", "Stopped");
  // Hold the confirmation through one paint so it reads, then hand control
  // back; the visibility rule re-hides only once the turn is truly idle.
  // Disable through the flash without re-entering the pending style: the
  // confirmed state holds steady (no pulse) until control is handed back.
  interrupt.disabled = true;
  clearTimeout(interruptDoneTimer);
  interruptDoneTimer = setTimeout(() => {
    interrupt.classList.remove("is-done");
    interrupt.setAttribute("aria-label", STOP_LABEL);
    interrupt.disabled = false;
  }, 900);
}

/** Drop any pending/confirmed state on session switch without flashing. */
export function resetInterruptButton() {
  interruptBusy = false;
  clearTimeout(interruptDoneTimer);
  interruptDoneTimer = null;
  setInterruptPending(false);
  const interrupt = el["chat-interrupt"];
  if (!interrupt) return;
  interrupt.classList.remove("is-pending", "is-done");
  interrupt.removeAttribute("aria-busy");
  interrupt.setAttribute("aria-label", STOP_LABEL);
  interrupt.disabled = false;
}
/**
 * Wire the composer elements. Idempotent: safe to call multiple times.
 * Must be called after initDom() has registered the element ids.
 */

export function wireComposer({ voice } = {}) {
  if (wired) return;
  const input = el["chat-input"];
  const send = el["chat-send"];
  const interrupt = el["chat-interrupt"];
  if (!input || !send || !interrupt) return;
  voice?.registerTarget({
    button: el["chat-voice"],
    status: el["chat-voice-status"],
    capture() {
      if (!activeSessionId) return null;
      const draft = draftFor(activeSessionId);
      return { sessionId: activeSessionId, draft, cycle: draft.cycle };
    },
    transcribed(text, owner) {
      const draft = owner && drafts.get(owner.sessionId);
      if (!owner || draft !== owner.draft || draft.cycle !== owner.cycle) return;
      draft.text = draft.text ? `${draft.text}\n${text}` : text;
      if (activeSessionId !== owner.sessionId) return;
      renderDraft();
      const input = el["chat-input"];
      if (!input || input.disabled) return;
      // On compact screens, focusing here summons the software keyboard and
      // moves the send target under the next tap. Leave focus on the mic so
      // the completed transcript can be sent immediately with one tap.
      if (!window.matchMedia("(max-width: 1099px)").matches) {
        input.focus({ preventScroll: true });
      }
    },
  });

  attachments = wireAttachments({
    root: el["chat-mode"],
    dropTarget: el["chat-mode"],
    pasteTarget: input,
    appendWhileInactive: true,
    accept: CHAT_ATTACHMENT_ACCEPT,
    captureContext(sessionId) {
      const draft = draftFor(sessionId);
      return { draft, cycle: draft.cycle };
    },
    appendPath: appendAttachmentPath,
    removePath: removeAttachmentPath,
  });
  attachments?.activate(activeSessionId);

  input.addEventListener("input", () => {
    if (!composing) saveActiveDraft();
    autoGrow(input);
    syncSendState();
  });
  input.addEventListener("compositionstart", () => {
    const draft = activeSessionId ? draftFor(activeSessionId) : null;
    composing = true;
    compositionOwner = draft && {
      sessionId: activeSessionId,
      draft,
      cycle: draft.cycle,
    };
  });
  input.addEventListener("compositionend", () => {
    const owner = compositionOwner;
    composing = false;
    compositionOwner = null;
    const current = owner && drafts.get(owner.sessionId);
    if (
      !owner
      || owner.sessionId !== activeSessionId
      || current !== owner.draft
      || current.cycle !== owner.cycle
    ) {
      renderDraft();
      return;
    }
    saveActiveDraft();
    autoGrow(input);
    syncSendState();
  });
  input.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter"
      && !event.shiftKey
      && !event.isComposing
      && !composing
      && event.keyCode !== 229
    ) {
      event.preventDefault();
      doSend();
    }
  });

  send.addEventListener("click", doSend);
  interrupt.addEventListener("click", () => {
    if (interrupt.disabled || interrupt.hidden) return;
    beginInterruptRequest();
    emit("chat:interrupt");
  });
}

/**
 * Save the current draft and restore the target session's draft and tray.
 * A profile reset reuses an id, so reset replaces its ownership object; an
 * upload captured before the reset can no longer append into the new draft.
 */
export function activateComposer(id, { reset = false, discardPrevious = false } = {}) {
  const previousId = activeSessionId;
  if (previousId) {
    if (discardPrevious) {
      drafts.delete(previousId);
      attachments?.clear(previousId);
    } else if (previousId !== id || !reset) {
      saveActiveDraft();
    }
  }
  if (reset && id) drafts.delete(id);

  activeSessionId = id || null;
  attachments?.activate(activeSessionId, { reset });
  renderDraft();
  // With no session and no ghost selected the composer is the landing "start
  // something" surface, so it stays live and its send creates the session.
  setComposerEnabled(Boolean(activeSessionId) || (!id && !state.selectedGhost));
}

/** Discard one session's draft/upload epoch without activating that session. */
export function resetComposerSession(id) {
  if (!id) return;
  if (activeSessionId === id) {
    activateComposer(id, { reset: true });
    return;
  }
  drafts.delete(id);
  attachments?.clear(id);
}

/**
 * Restore a failed full-text message without destroying a newer draft.
 * Failed text is older, so it is placed before any subsequent draft.
 */
export function editComposerDraft(text, sessionId) {
  if (!sessionId || sessionId !== activeSessionId || typeof text !== "string") return false;
  const draft = draftFor(sessionId);
  if (!draft.text) draft.text = text;
  else if (draft.text !== text) draft.text = `${text}\n\n${draft.text}`;
  renderDraft();
  el["chat-input"]?.focus({ preventScroll: true });
  return true;
}

/**
 * Enable or disable the active composer. The profile action follows the same
 * no-session lifecycle as the input rather than leaking from the last session.
 */
export function setComposerEnabled(on) {
  const input = el["chat-input"];
  const send = el["chat-send"];
  const attach = el["chat-attach"];
  const voice = el["chat-voice"];
  if (!input || !send) return;

  input.disabled = !on;
  // Stop owns its own disabled state (optimistic pending + confirmed flash),
  // so it stays operable while the composer is open and a turn is live. The
  // visibility rule in panels.js hides it when no turn is live, which covers
  // the no-session case this line used to handle.
  // Attachments need a session directory to upload into; the landing composer
  // has none until the first message creates one.
  if (attach) attach.disabled = !on || !activeSessionId;
  if (voice) voice.disabled = !on;
  syncSendState();
  input.placeholder = !on
    ? "No active session"
    : (activeSessionId ? "Send a message\u2026" : "Start a new session\u2026");
}

/** Put a failed landing message back so the text is never lost. */
export function restoreLandingDraft(text) {
  const input = el["chat-input"];
  if (!input || activeSessionId || input.value.trim()) return;
  input.value = text;
  autoGrow(input);
  syncSendState();
  input.focus();
}
