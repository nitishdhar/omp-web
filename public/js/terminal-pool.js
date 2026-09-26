"use strict";
// Pooled terminal hosts: one live xterm host per recent session (cap 4, LRU).
// Owns ONLY lifecycle + DOM hosts + LRU order. Byte/scroll protocol lives in
// terminal.js; this module never writes PTY bytes itself.
//
// Inactive hosts use visibility:hidden + pointer-events:none (never
// display:none) so a parked xterm stays measurable for fit().

export const MAX_ENTRIES = 4;

const entries = new Map(); // id -> entry
const lru = []; // oldest first, newest last
let activeId = null;
let disposeHook = null; // (entry) => void, registered by terminal.js

function emptyView() {
  return document.getElementById("terminal-empty");
}

function syncEmptyView() {
  const empty = emptyView();
  if (!empty) return;
  // Explicit handling: empty shown iff no active entry. Replaces the old
  // overflow trick (no JS toggler) which breaks with N stacked canvases.
  empty.hidden = activeId !== null;
}

function hideLegacyTerm() {
  const legacy = document.getElementById("term");
  if (legacy && legacy.style.display !== "none") legacy.style.display = "none";
}

function makeHost(id, visible) {
  const wrap = document.getElementById("term-wrap");
  const host = document.createElement("div");
  host.className = "term-entry";
  host.dataset.sessionId = id;
  // Absolute overlay inside #term-wrap padding (6px): all hosts stack in the
  // same box; inactive stay measurable via visibility (never display:none).
  host.style.position = "absolute";
  host.style.inset = "6px";
  host.style.visibility = visible ? "" : "hidden";
  host.style.pointerEvents = visible ? "" : "none";
  if (wrap) wrap.appendChild(host);
  return host;
}

function makeEntry(id, host) {
  return {
    id,
    host,
    term: null,
    fit: null,
    ws: null,
    generation: 0,
    reconnectAttempt: 0,
    reconnectTimer: 0,
    outQueue: [],
    outWriteActive: false,
    replay: { hidden: false, timer: 0, writes: 0, deadline: 0, lastAt: 0 },
    scroll: {
      scrolling: false,
      scrubDragging: false,
      pending: 0,
      target: null,
      generation: 0,
      epoch: 0,
      pumpActive: false,
      exitPending: false,
      pump: Promise.resolve(),
      deferred: [],
      deferredBytes: 0,
      exitCallbacks: [],
      current: { history: 0, position: 0, inMode: false },
    },
    connState: "idle",
    visible: false,
    fitFrame: 0,
    observer: null,
  };
}

function touch(id) {
  const i = lru.indexOf(id);
  if (i !== -1) lru.splice(i, 1);
  lru.push(id);
}

function evictIfNeeded(exceptId) {
  while (entries.size > MAX_ENTRIES) {
    const oldest = lru.find((id) => id !== exceptId && id !== activeId) ?? lru.find((id) => id !== exceptId);
    if (!oldest) break;
    disposeEntry(oldest);
  }
}

export function setDisposeHook(fn) {
  disposeHook = fn;
}
export function peekEntry(id) {
  return id ? entries.get(id) ?? null : null;
}

export function getEntry(id) {
  if (!id) return null;
  let entry = entries.get(id);
  if (entry) {
    touch(id);
    return entry;
  }
  hideLegacyTerm();
  const host = makeHost(id, false);
  entry = makeEntry(id, host);
  entries.set(id, entry);
  touch(id);
  evictIfNeeded(id);
  syncEmptyView();
  return entry;
}

export function hasEntry(id) {
  return entries.has(id);
}

export function entryIds() {
  return [...entries.keys()];
}

export function activeEntry() {
  return activeId ? entries.get(activeId) ?? null : null;
}

export function activeEntryId() {
  return activeId;
}

export function activateEntry(id) {
  const entry = getEntry(id);
  if (!entry) return null;
  if (activeId && activeId !== id) parkEntry(activeId, { keepActive: true });
  activeId = id;
  touch(id);
  entry.visible = true;
  if (entry.host) {
    entry.host.style.visibility = "";
    entry.host.style.pointerEvents = "";
  }
  syncEmptyView();
  return entry;
}

// Park hides the host but keeps socket + buffer. By default clears activeId
// when parking the active entry (ghost preview); pass {keepActive:true} when
// switching (activateEntry reassigns activeId immediately after).
export function parkEntry(id, { keepActive = false } = {}) {
  const entry = entries.get(id);
  if (!entry) return null;
  entry.visible = false;
  if (entry.host) {
    entry.host.style.visibility = "hidden";
    entry.host.style.pointerEvents = "none";
  }
  if (!keepActive && activeId === id) {
    activeId = null;
    syncEmptyView();
  }
  return entry;
}

export function disposeEntry(id) {
  const entry = entries.get(id);
  if (!entry) {
    if (activeId === id) {
      activeId = null;
      syncEmptyView();
    }
    return false;
  }
  try {
    disposeHook?.(entry);
  } catch {}
  try {
    entry.host?.remove();
  } catch {}
  entries.delete(id);
  const i = lru.indexOf(id);
  if (i !== -1) lru.splice(i, 1);
  if (activeId === id) {
    activeId = null;
    syncEmptyView();
  }
  return true;
}
