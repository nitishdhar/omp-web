"use strict";
// Quick keys, mobile input forwarding, clipboard paste.

import { el } from "./dom.js";
import { state } from "./state.js";
import { clearAttachments, wireAttachments } from "./mobile-attachments.js";
import { showNotice } from "./notice.js";
import { send, focusTerminal, scrollTerminal } from "./terminal.js";

function unescapeSeq(s) {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\t/g, "\t").replace(/\\r/g, "\r").replace(/\\n/g, "\n");
}
async function pasteClipboard() {
  const ownerId = state.current;
  const ownerEpoch = activeMobileEpoch;
  try {
    const text = await navigator.clipboard.readText();
    if (
      !ownerId ||
      ownerId !== state.current ||
      ownerId !== activeMobileSession ||
      ownerEpoch !== activeMobileEpoch
    ) {
      showNotice("Paste canceled after switching sessions.");
      return;
    }
    if (sessionDraft(ownerId).locked) {
      showNotice("Paste canceled while terminal input is still pending.");
      return;
    }
    if (text) send({ t: "i", d: text });
    focusTerminal();
  } catch {
    showNotice("Clipboard access was denied. Allow paste access, then try again.", { tone: "error" });
  }
}


let mobileComposing = false, compositionSession = null;
let activeMobileSession = null, activeMobileEpoch = 0;
let attachmentController = null;
const mobileSessions = new Map();
function quotePath(path) {
  return `'${path.replace(/'/g, "'\\''")}'`;
}
const modifiers = new Set();
const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

function splitGraphemes(text) {
  return segmenter
    ? Array.from(segmenter.segment(text), ({ segment }) => segment)
    : Array.from(text);
}

function normalizeInput(value) {
  return value.replace(/\r\n?|\n/g, "\r");
}

function sessionDraft(id) {
  if (!mobileSessions.has(id)) {
    mobileSessions.set(id, {
      id,
      value: "",
      syncedValue: "",
      confirmedValue: "",
      unsent: false,
      pendingSubmit: false,
      pendingDeliveries: 0,
      deferredFailed: false,
      locked: false,
    });
  }
  return mobileSessions.get(id);
}

function applyModifiers(text) {
  if (!text || !modifiers.size) return text;
  const first = text[0];
  let prefix = "";
  let value = first;
  if (modifiers.has("ctrl") && /^[a-z]$/i.test(first)) {
    value = String.fromCharCode(first.toUpperCase().charCodeAt(0) & 0x1f);
  }
  if (modifiers.has("alt")) prefix = "\x1b";
  modifiers.clear();
  syncModifiers();
  return prefix + value + text.slice(1);
}

function syncModifiers() {
  el.quickkeys.querySelectorAll("button[data-modifier]").forEach((button) => {
    const active = modifiers.has(button.dataset.modifier);
    button.setAttribute("aria-pressed", String(active));
    button.classList.toggle("active", active);
  });
}

function syncUnsentStatus(draft) {
  const pending = Boolean(draft?.unsent);
  if (el["terminal-unsent"]) el["terminal-unsent"].hidden = !pending;
  if (el["mobile-input"]) {
    el["mobile-input"].readOnly = Boolean(draft?.locked);
    el["mobile-input"].classList.toggle("unsent", pending);
    el["mobile-input"].setAttribute("aria-invalid", String(pending));
  }
  if (el["terminal-voice"]) {
    el["terminal-voice"].disabled = !activeMobileSession || Boolean(draft?.locked);
  }
}

function draftDelta(previous, next) {
  const before = splitGraphemes(previous);
  const after = splitGraphemes(next);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  return {
    deleted: before.length - prefix,
    inserted: after.slice(prefix).join(""),
  };
}

function clearTerminalAttachments(sessionId) {
  if (attachmentController?.clear) attachmentController.clear(sessionId);
  else clearAttachments(sessionId);
}

function ownsDraft(draft) {
  return mobileSessions.get(draft.id) === draft;
}

function syncSettledDraft(draft, { updateValue = false } = {}) {
  if (!ownsDraft(draft) || draft.id !== activeMobileSession || draft.id !== state.current) return;
  if (updateValue) el["mobile-input"].value = draft.value.replace(/\r/g, "\n");
  syncUnsentStatus(draft);
}

function settleDeferredDraft(draft, next, { submit, delivered }) {
  if (!ownsDraft(draft)) return;
  draft.pendingDeliveries = Math.max(0, draft.pendingDeliveries - 1);
  if (delivered) {
    if (submit) {
      draft.value = "";
      draft.syncedValue = "";
      draft.confirmedValue = "";
      draft.unsent = false;
      draft.pendingSubmit = false;
      draft.locked = false;
      clearTerminalAttachments(draft.id);
    } else {
      draft.confirmedValue = next;
    }
  } else {
    draft.deferredFailed = true;
    draft.unsent = true;
    draft.pendingSubmit = draft.pendingSubmit || submit;
    if (submit) draft.locked = false;
  }
  if (!draft.pendingDeliveries) {
    if (draft.deferredFailed) {
      draft.syncedValue = draft.confirmedValue;
      draft.unsent = true;
      draft.deferredFailed = false;
    } else if (!draft.pendingSubmit) {
      draft.syncedValue = draft.confirmedValue;
    }
  }
  syncSettledDraft(draft, { updateValue: delivered && submit });
  if (
    delivered &&
    submit &&
    draft.id === activeMobileSession &&
    draft.id === state.current
  ) el["mobile-input"].blur();
}

function transmitDraft(draft, next, { submit = false } = {}) {
  const { deleted, inserted } = draftDelta(draft.syncedValue, next);
  const modifierSnapshot = [...modifiers];
  const payload = "\x7f".repeat(deleted) + applyModifiers(inserted + (submit ? "\r" : ""));
  const outcome = payload
    ? send({ t: "i", d: payload }, {
        onDeferredSettled(delivered) {
          settleDeferredDraft(draft, next, { submit, delivered });
        },
      })
    : true;
  if (!outcome) {
    modifiers.clear();
    for (const modifier of modifierSnapshot) modifiers.add(modifier);
    syncModifiers();
    draft.value = next;
    draft.unsent = true;
    draft.pendingSubmit = draft.pendingSubmit || submit;
    syncUnsentStatus(draft);
    return false;
  }
  draft.syncedValue = next;
  draft.unsent = false;
  if (outcome === "deferred") {
    draft.pendingDeliveries++;
    draft.pendingSubmit = draft.pendingSubmit || submit;
    if (submit) draft.locked = true;
    syncUnsentStatus(draft);
    return true;
  }
  draft.confirmedValue = next;
  draft.pendingSubmit = false;
  if (submit) {
    draft.value = "";
    draft.syncedValue = "";
    draft.confirmedValue = "";
    el["mobile-input"].value = "";
    clearTerminalAttachments(draft.id);
    el["mobile-input"].blur();
  }
  syncUnsentStatus(draft);
  return true;
}

function ensureActiveSession() {
  if (activeMobileSession !== state.current) activateQuickkeysSession(state.current);
  return activeMobileSession ? sessionDraft(activeMobileSession) : null;
}

function appendTerminalDictation(text, owner) {
  const draft = owner && mobileSessions.get(owner.sessionId);
  if (
    !owner ||
    draft !== owner.draft ||
    owner.epoch !== activeMobileEpoch ||
    owner.sessionId !== activeMobileSession ||
    owner.sessionId !== state.current ||
    draft.locked
  ) return;
  const spoken = String(text).replace(/\s+/g, " ").trim();
  if (!spoken) return;
  const separator = draft.value && !/\s$/.test(draft.value) ? " " : "";
  const next = draft.value + separator + spoken;
  el["mobile-input"].value = next.replace(/\r/g, "\n");
  draft.value = next;
  if (draft.unsent) {
    draft.unsent = draft.pendingSubmit || next !== draft.syncedValue;
    syncUnsentStatus(draft);
  } else {
    transmitDraft(draft, next);
  }
  el["mobile-input"].focus({ preventScroll: true });
}

function sendMobileInput() {
  const input = el["mobile-input"];
  const draft = ensureActiveSession();
  if (!draft) return;
  let next = normalizeInput(input.value);
  const submit = next.endsWith("\r");
  if (submit) {
    next = next.slice(0, -1);
    input.value = next.replace(/\r/g, "\n");
  }
  draft.value = next;
  if (!submit && draft.unsent) {
    draft.unsent = draft.pendingSubmit || next !== draft.syncedValue;
    syncUnsentStatus(draft);
    return;
  }
  transmitDraft(draft, next, { submit });
}

export function activateQuickkeysSession(id, { reset = false } = {}) {
  const input = el["mobile-input"];
  if (!input) return;
  if (activeMobileSession) sessionDraft(activeMobileSession).value = normalizeInput(input.value);
  mobileComposing = false;
  compositionSession = null;
  modifiers.clear();
  syncModifiers();
  const nextSession = id || null;
  if (nextSession !== activeMobileSession || reset) activeMobileEpoch++;
  if (reset && id) mobileSessions.delete(id);
  activeMobileSession = nextSession;
  const draft = activeMobileSession ? sessionDraft(activeMobileSession) : null;
  input.value = draft ? draft.value.replace(/\r/g, "\n") : "";
  syncUnsentStatus(draft);
  attachmentController?.activate?.(activeMobileSession, { reset });
}

export function resetQuickkeysSession(id) {
  if (!id) return;
  if (activeMobileSession === id) {
    activateQuickkeysSession(id, { reset: true });
    return;
  }
  mobileSessions.delete(id);
  attachmentController?.clear?.(id);
}

export function wireQuickkeys({ voice } = {}) {
  const input = el["mobile-input"];
  voice?.registerTarget({
    button: el["terminal-voice"],
    status: el["terminal-voice-status"],
    label: "Dictate terminal input",
    capture() {
      const draft = ensureActiveSession();
      return draft && !draft.locked
        ? { sessionId: activeMobileSession, epoch: activeMobileEpoch, draft }
        : null;
    },
    transcribed: appendTerminalDictation,
  });
  attachmentController = wireAttachments({
    root: input.closest(".mobile-composer-shell"),
    appendPath(path, context = {}) {
      const id = context.sessionId || state.current;
      if (
        !id ||
        id !== state.current ||
        id !== activeMobileSession ||
        sessionDraft(id).locked
      ) return false;
      const draft = sessionDraft(id);
      const anchor = draft.value;
      const separator = anchor && !/\s$/.test(anchor) ? " " : "";
      const appended = `${separator}${quotePath(path)}`;
      const retain = () => {
        if (!ownsDraft(draft)) return false;
        draft.value = draft.value.startsWith(anchor)
          ? anchor + appended + draft.value.slice(anchor.length)
          : draft.value + appended;
        draft.unsent = true;
        syncSettledDraft(draft, { updateValue: true });
        return true;
      };
      input.focus({ preventScroll: true });
      if (draft.unsent) {
        retain();
        return true;
      }
      let settle;
      const deferred = new Promise((resolve) => { settle = resolve; });
      const outcome = send({ t: "i", d: appended }, {
        onDeferredSettled(delivered) {
          const owned = ownsDraft(draft);
          if (!delivered && owned) retain();
          settle(owned);
        },
      });
      if (!outcome) {
        retain();
        return true;
      }
      return outcome === "deferred" ? deferred : true;
    },
  }) || null;
  activateQuickkeysSession(state.current);

  const toggle = el["quickkeys-toggle"];
  const setCollapsed = (collapsed) => {
    el.quickkeys.classList.toggle("collapsed", collapsed);
    toggle.classList.toggle("active", !collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", collapsed ? "Show terminal keys" : "Hide terminal keys");
  };
  // Keys start hidden to give the terminal room; the choice is remembered.
  const stored = (() => {
    try { return localStorage.getItem("omp_web_quickkeys_open"); } catch { return null; }
  })();
  toggle.addEventListener("click", () => {
    const collapsed = !el.quickkeys.classList.contains("collapsed");
    setCollapsed(collapsed);
    try { localStorage.setItem("omp_web_quickkeys_open", collapsed ? "0" : "1"); } catch {}
  });
  setCollapsed(stored !== "1");

  const submitDraft = () => {
    const draft = ensureActiveSession();
    if (!draft || draft.locked) return;
    draft.value = normalizeInput(input.value);
    transmitDraft(draft, draft.value, { submit: true });
  };
  document.querySelector("[data-mobile-return]")?.addEventListener("click", submitDraft);
  el["terminal-unsent-retry"]?.addEventListener("click", () => {
    const draft = ensureActiveSession();
    if (!draft || draft.locked) return;
    transmitDraft(draft, draft.value, { submit: draft.pendingSubmit });
    input.focus({ preventScroll: true });
  });

  input.addEventListener("compositionstart", () => {
    ensureActiveSession();
    mobileComposing = true;
    compositionSession = activeMobileSession;
  });
  input.addEventListener("compositionend", () => {
    const owner = compositionSession;
    mobileComposing = false;
    compositionSession = null;
    if (!owner || owner !== activeMobileSession || owner !== state.current) return;
    sendMobileInput();
  });
  input.addEventListener("input", () => {
    if (!mobileComposing) sendMobileInput();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Backspace" && !input.value) {
      event.preventDefault();
      send({ t: "i", d: "\x7f" });
    }
  });
  el.quickkeys.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-seq], button[data-scroll], button[data-paste], button[data-attach], button[data-modifier]");
    if (!button) return;
    ensureActiveSession();
    if (button.dataset.paste !== undefined) { pasteClipboard(); return; }
    if (button.dataset.scroll) { scrollTerminal(button.dataset.scroll); return; }
    if (button.dataset.modifier) {
      modifiers.has(button.dataset.modifier) ? modifiers.delete(button.dataset.modifier) : modifiers.add(button.dataset.modifier);
      syncModifiers();
      focusTerminal();
      return;
    }
    const modifierSnapshot = [...modifiers];
    if (!send({ t: "i", d: applyModifiers(unescapeSeq(button.getAttribute("data-seq"))) })) {
      modifiers.clear();
      for (const modifier of modifierSnapshot) modifiers.add(modifier);
      syncModifiers();
    }
    focusTerminal();
  });
}