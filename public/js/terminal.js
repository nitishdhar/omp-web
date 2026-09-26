"use strict";
// xterm init, fit, touch scroll, WebSocket PTY bridge, mobile reconnection.
// Pooled: one live xterm + socket per recent session (LRU-4 in terminal-pool.js).
// This module owns byte/scroll protocol per entry; pool owns lifecycle/hosts.

import { state, emit, setCurrent } from "./state.js";
import { el } from "./dom.js";
import { api } from "./api.js";
import { showNotice } from "./notice.js";
import { sessionStatus, statusLabel, statusTitle } from "./session-status.js";
import * as pool from "./terminal-pool.js";

const encoder = new TextEncoder();
const RECONNECT_DELAYS = [250, 500, 1000, 2000, 4000, 8000];
const MAX_DEFERRED_INPUT_BYTES = 64 * 1024;
const MAX_DEFERRED_INPUT_MESSAGES = 256;
const MAX_OUTPUT_BATCH_BYTES = 64 * 1024;

// Global mode + shared chrome timers. Everything else lives on pool entries.
let terminalVisible = true;
let scrollStatusTimer, scrubFeedbackTimer, scheduleFrame = 0;
let wired = false;
const intentionalSockets = new WeakSet();
const failedSockets = new WeakSet();
const nonRetrySockets = new WeakSet();
const lastResizeBySocket = new WeakMap();

function active() {
  return pool.activeEntry();
}

function entryFor(id) {
  return id ? pool.peekEntry(id) : null;
}

// Pool eviction/dispose hook: close socket, clear timers, dispose xterm.
// Host node removal is owned by the pool.
function disposeEntryResources(entry) {
  if (!entry) return;
  clearTimeout(entry.reconnectTimer);
  entry.reconnectAttempt = 0;
  entry.generation++;
  entry.scroll.epoch++;
  entry.scroll.generation++;
  const ws = state.sockets.get(entry.id);
  if (ws) {
    intentionalSockets.add(ws);
    if (state.sockets.get(entry.id) === ws) state.sockets.delete(entry.id);
    try { ws.close(); } catch {}
  }
  entry.ws = null;
  clearTimeout(entry.replay.timer);
  entry.replay.hidden = false;
  entry.outQueue.length = 0;
  entry.outWriteActive = false;
  entry.scroll.pending = 0;
  entry.scroll.target = null;
  entry.scroll.pumpActive = false;
  entry.scroll.exitPending = false;
  entry.scroll.deferred = [];
  entry.scroll.deferredBytes = 0;
  entry.scroll.exitCallbacks = [];
  try { entry.term?.dispose(); } catch {}
  entry.term = null;
  entry.fit = null;
}
pool.setDisposeHook(disposeEntryResources);

function ensureGlobalWiring() {
  if (wired) return;
  wired = true;
  wireTouchScroll();
  wireWheelScroll();
  wireScrollScrubber();
  try {
    new ResizeObserver(() => scheduleFit()).observe(el["term-wrap"]);
  } catch {}
  window.addEventListener("resize", () => {
    syncCompactFocusGuard();
    // Rotation must refit even in chat mode: the layer keeps real dimensions
    // under the overlay, and a portrait-sized canvas would otherwise paint
    // past its landscape box (pure-black strip with stale TUI text).
    fitAll({ force: true });
  });
}

function ensureTermFor(entry) {
  if (!entry || entry.term) return entry?.term ?? null;
  ensureGlobalWiring();
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
    // selectionBackground explicit: default blends to rgb(77,77,77) on pure
    // black — near-invisible on phone screens. Accent blue at 35% keeps
    // selected text legible and tracks the app accent.
    theme: { background: "#101214", foreground: "#e4e7ea", cursor: "#5b8dee", selectionBackground: "rgba(91, 141, 238, 0.35)" },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(entry.host);
  entry.term = term;
  entry.fit = fit;
  wireCompactFocusGuardFor(entry);
  term.onData((d) => send({ t: "i", d }));
  return term;
}

export function getTerm() {
  return active()?.term ?? null;
}

// Per-entry first-paint cover. Loader + host hiding apply only when the entry
// is active; background entries stream silently with no cover.
export function resetTerm(id = state.current) {
  const entry = id ? entryFor(id) ?? pool.getEntry(id) : active();
  if (!entry?.term) return;
  entry.outQueue.push({ reset: true });
  entry.replay.hidden = true;
  entry.replay.writes = 0;
  // Debounced reveal: every landed batch pushes the quiet-reveal out, so a
  // slow multi-second replay stays parked; the absolute cap bounds it for
  // sessions that never go quiet.
  entry.replay.deadline = Date.now() + REPLAY_MAX_MS;
  if (pool.activeEntryId() === entry.id) {
    if (entry.host) entry.host.style.visibility = "hidden";
    if (el["replay-loader"]) el["replay-loader"].hidden = false;
  }
  armReplayTimer(entry);
  pumpOutputQueue(entry);
}

function armReplayTimer(entry) {
  if (!entry) return;
  clearTimeout(entry.replay.timer);
  const wait = Math.min(REPLAY_REVEAL_MS, Math.max(0, entry.replay.deadline - Date.now()));
  const generation = entry.generation;
  entry.replay.timer = setTimeout(() => {
    if (generation === entry.generation) revealReplay(entry, "timeout");
  }, wait);
}

// A fresh attach replays scrollback from an empty buffer; xterm follows the
// tail progressively, which reads as the view sweeping down from the top on
// every reload. Park the canvas hidden until the replay burst drains.
// visibility:hidden keeps layout so fitting still measures correctly.
const REPLAY_REVEAL_MS = 1200;
const REPLAY_MAX_MS = 8000;
const REPLAY_QUIET_MS = 400;
function revealReplay(entry, why = "drain") {
  if (!entry || !entry.replay.hidden) return;
  entry.replay.hidden = false;
  clearTimeout(entry.replay.timer);
  // Shared chrome belongs to the active entry only: a background drain must
  // never flip the loader or show a parked host.
  if (pool.activeEntryId() !== entry.id) return;
  if (entry.host) entry.host.style.visibility = "";
  if (el["replay-loader"]) el["replay-loader"].hidden = true;
  try { entry.term?.scrollToBottom(); } catch {}
}

// Empty view shown iff no active entry (explicit hidden toggle; the old
// overflow trick with no JS toggler breaks with N stacked canvases).
function syncChromeForActive() {
  const id = pool.activeEntryId() ?? state.current;
  const empty = el["terminal-empty"] ?? document.getElementById("terminal-empty");
  if (empty) empty.hidden = id != null;
}

export function focusTerminal() {
  if (!terminalVisible) return;
  if (window.matchMedia("(max-width: 1099px)").matches && el["mobile-input"]) {
    el["mobile-input"].focus({ preventScroll: true });
    return;
  }
  const entry = active();
  entry?.term?.focus();
  // Scope helper lookup to the active host first: with N pooled terms the
  // document-wide query returns the oldest entry's helper, not the focused one.
  entry?.host?.querySelector(".xterm-helper-textarea")?.focus({ preventScroll: true })
    ?? document.querySelector(".xterm-helper-textarea")?.focus({ preventScroll: true });
}

function syncCompactFocusGuard() {
  const entry = active();
  const helper = entry?.host?.querySelector(".xterm-helper-textarea")
    ?? document.querySelector(".xterm-helper-textarea");
  if (!helper) return;
  const compact = window.matchMedia("(max-width: 1099px)").matches;
  helper.readOnly = compact;
  if (compact) {
    helper.setAttribute("inputmode", "none");
    if (document.activeElement === helper) helper.blur();
  } else {
    helper.removeAttribute("inputmode");
  }
}

function wireCompactFocusGuardFor(entry) {
  const helper = entry?.host?.querySelector(".xterm-helper-textarea")
    ?? document.querySelector(".xterm-helper-textarea");
  if (!helper || helper.dataset.ompGuard === "1") {
    syncCompactFocusGuard();
    return;
  }
  helper.dataset.ompGuard = "1";
  helper.addEventListener("focus", () => {
    if (window.matchMedia("(max-width: 1099px)").matches) helper.blur();
  });
  syncCompactFocusGuard();
}

function scheduleFit() {
  if (scheduleFrame) return;
  scheduleFrame = requestAnimationFrame(() => {
    scheduleFrame = 0;
    doFit();
  });
}

export function setVisible(visible) {
  terminalVisible = Boolean(visible);
  if (terminalVisible) scheduleFit();
  else active()?.term?.blur();
}

function fitEntry(entry, { force = false } = {}) {
  if (!entry?.fit || !entry?.term || (!terminalVisible && !force)) return false;
  try {
    const proposed = entry.fit.proposeDimensions?.();
    if (proposed && (proposed.cols !== entry.term.cols || proposed.rows !== entry.term.rows)) {
      entry.term.resize(proposed.cols, proposed.rows);
    } else if (!proposed) {
      entry.fit.fit();
    }
  } catch {}
  const ws = state.sockets.get(entry.id);
  if (!ws || ws.readyState !== WebSocket.OPEN) return true;
  const size = `${entry.term.cols}x${entry.term.rows}`;
  if (lastResizeBySocket.get(ws) === size) return true;
  if (sendNow({ t: "r", cols: entry.term.cols, rows: entry.term.rows }, entry.id)) {
    lastResizeBySocket.set(ws, size);
  }
  return true;
}

export function doFit({ force = false } = {}) {
  const entry = active();
  if (!entry) return;
  fitEntry(entry, { force });
}

// Window resize broadcasts to every pooled socket (each entry's dims live on
// its own term; server clamps 20-500x5-200 as today).
function fitAll({ force = false } = {}) {
  for (const id of pool.entryIds()) {
    const entry = entryFor(id);
    if (entry?.term) fitEntry(entry, { force });
  }
}

function touchPixelsPerLine() {
  const term = active()?.term;
  const height = term?._core?._renderService?.dimensions?.css?.cell?.height;
  return Math.max(12, Math.round(height || 16));
}

function wireWheelScroll() {
  const wrap = el["term-wrap"];
  let carry = 0;
  wrap.addEventListener("wheel", (event) => {
    if (
      !state.current
      || event.ctrlKey
      || !event.deltaY
      || (event.target instanceof Element && event.target.closest(".scroll-scrubber"))
    ) return;

    event.preventDefault();
    event.stopPropagation();
    const pixelsPerLine = touchPixelsPerLine();
    const term = active()?.term;
    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? pixelsPerLine
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? pixelsPerLine * Math.max(1, term?.rows || 24)
        : 1;
    const delta = event.deltaY * scale;
    if (carry && Math.sign(carry) !== Math.sign(delta)) carry = 0;
    carry += delta;
    const steps = Math.min(96, Math.trunc(Math.abs(carry) / pixelsPerLine));
    if (!steps) return;
    const direction = carry < 0 ? "up" : "down";
    carry -= Math.sign(carry) * steps * pixelsPerLine;
    scrollTerminal(direction, steps);
  }, { capture: true, passive: false });
}

function wireTouchScroll() {
  const wrap = el["term-wrap"];
  let lastY = null;
  let carry = 0;
  wrap.addEventListener("touchstart", (e) => {
    if (e.target instanceof Element && e.target.closest(".scroll-scrubber")) {
      lastY = null;
      return;
    }
    if (e.touches.length === 1) {
      lastY = e.touches[0].clientY;
      carry = 0;
    }
  }, { capture: true, passive: true });
  wrap.addEventListener("touchmove", (e) => {
    if (e.target instanceof Element && e.target.closest(".scroll-scrubber")) return;
    if (lastY === null || e.touches.length !== 1) return;
    e.preventDefault();
    const y = e.touches[0].clientY;
    const delta = y - lastY;
    lastY = y;
    if (carry && Math.sign(carry) !== Math.sign(delta)) carry = 0;
    carry += delta;
    const pixelsPerLine = touchPixelsPerLine();
    const steps = Math.trunc(Math.abs(carry) / pixelsPerLine);
    if (!steps) return;
    const direction = carry > 0 ? "up" : "down";
    carry -= Math.sign(carry) * steps * pixelsPerLine;
    scrollTerminal(direction, steps);
  }, { capture: true, passive: false });
  const endTouch = () => {
    lastY = null;
    carry = 0;
  };
  wrap.addEventListener("touchend", endTouch, { capture: true, passive: true });
  wrap.addEventListener("touchcancel", endTouch, { capture: true, passive: true });
}

function scrollLabel({ history, position }) {
  if (!position) return "Live";
  if (position >= history) return `Oldest · ${history.toLocaleString()} lines`;
  return `${position.toLocaleString()} lines back`;
}

function applyScrollState(next, id = state.current) {
  if (!next) return;
  const entry = id ? entryFor(id) : active();
  const history = Math.max(0, Math.trunc(Number(next.history) || 0));
  const position = Math.max(0, Math.min(history, Math.trunc(Number(next.position) || 0)));
  const current = { history, position, inMode: Boolean(next.inMode) };
  if (entry) entry.scroll.current = current;
  // Shared scrubber renders the active entry only; background completions
  // update stored state silently for rebind on activate.
  if (id && id !== state.current) return;
  if (!id && !state.current) return;
  const scrubber = el["scroll-scrubber"];
  const label = el["scroll-scrubber-label"];
  if (!scrubber || !label) return;
  const ratio = history ? 1 - position / history : 1;
  const offset = ratio * 100;
  scrubber.hidden = !state.current || history === 0;
  if (scrubber.hidden) {
    clearTimeout(scrubFeedbackTimer);
    scrubber.classList.remove("active");
  }
  scrubber.setAttribute("aria-valuemax", String(history));
  scrubber.setAttribute("aria-valuenow", String(position));
  scrubber.setAttribute("aria-valuetext", scrollLabel(current));
  label.textContent = scrollLabel(current);
  label.style.top = `${offset}%`;
  label.style.transform = `translateY(-${offset}%)`;
  el["scroll-scrubber-thumb"].style.top = `${offset}%`;
  el["scroll-scrubber-thumb"].style.transform = `translate(-50%, -${offset}%)`;
}

function showScrubberFeedback() {
  el["scroll-scrubber"].classList.add("active");
  clearTimeout(scrubFeedbackTimer);
  const dragging = active()?.scroll.scrubDragging;
  if (!dragging) {
    scrubFeedbackTimer = setTimeout(() => el["scroll-scrubber"].classList.remove("active"), 1100);
  }
}

async function refreshScrollState(id) {
  const entry = entryFor(id);
  if (!entry) return;
  const epoch = entry.scroll.epoch;
  try {
    const { scroll } = await api(`/sessions/${encodeURIComponent(id)}/scroll`, { cache: "no-store" });
    const live = entryFor(id);
    if (
      !live ||
      epoch !== live.scroll.epoch ||
      live.scroll.pumpActive ||
      live.scroll.exitPending ||
      live.scroll.pending ||
      live.scroll.target !== null
    ) return;
    applyScrollState(scroll, id);
    live.scroll.scrolling = Boolean(scroll.inMode);
  } catch {}
}

function queueScrollPosition(position, id = state.current) {
  const entry = id ? entryFor(id) : active();
  const targetId = entry?.id ?? id;
  if (!targetId || !entry?.scroll.current.history) return;
  entry.scroll.epoch++;
  entry.scroll.pending = 0;
  entry.scroll.target = Math.max(0, Math.min(entry.scroll.current.history, Math.round(position)));
  entry.scroll.scrolling = true;
  if (targetId === state.current) showScrubberFeedback();
  startScrollPump(targetId);
}

function wireScrollScrubber() {
  const scrubber = el["scroll-scrubber"];
  let pointerId = null;
  const positionAt = (clientY) => {
    const entry = active();
    const history = entry?.scroll.current.history ?? 0;
    const rect = scrubber.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
    return history * (1 - ratio);
  };
  const finish = (event) => {
    if (event.pointerId !== pointerId) return;
    try { scrubber.releasePointerCapture(pointerId); } catch {}
    pointerId = null;
    const entry = active();
    if (entry) entry.scroll.scrubDragging = false;
    showScrubberFeedback();
  };
  scrubber.addEventListener("pointerdown", (event) => {
    const entry = active();
    if (!entry?.scroll.current.history) return;
    event.preventDefault();
    pointerId = event.pointerId;
    entry.scroll.scrubDragging = true;
    scrubber.setPointerCapture(pointerId);
    queueScrollPosition(positionAt(event.clientY));
  });
  scrubber.addEventListener("pointermove", (event) => {
    if (event.pointerId === pointerId) queueScrollPosition(positionAt(event.clientY));
  });
  scrubber.addEventListener("pointerup", finish);
  scrubber.addEventListener("pointercancel", finish);
  scrubber.addEventListener("keydown", (event) => {
    const entry = active();
    const term = entry?.term;
    const current = entry?.scroll.current ?? { history: 0, position: 0 };
    const page = Math.max(1, term?.rows || 24);
    const commands = {
      ArrowUp: current.position + 1,
      ArrowDown: current.position - 1,
      PageUp: current.position + page,
      PageDown: current.position - page,
      Home: current.history,
      End: 0,
    };
    if (!(event.key in commands)) return;
    event.preventDefault();
    queueScrollPosition(commands[event.key]);
  });
}

function showScrollStatus(direction) {
  el["scroll-status"].textContent = direction === "up" ? "History ↑" : "History ↓";
  el["scroll-status"].hidden = false;
  clearTimeout(scrollStatusTimer);
  scrollStatusTimer = setTimeout(() => { el["scroll-status"].hidden = true; }, 800);
}

function hideScrollStatus() {
  clearTimeout(scrollStatusTimer);
  el["scroll-status"].hidden = true;
}


function clearScrollIntent(id = state.current) {
  const entry = id ? entryFor(id) : active();
  if (!entry) return;
  entry.scroll.epoch++;
  entry.scroll.generation++;
  entry.scroll.pending = 0;
  entry.scroll.target = null;
  entry.scroll.scrolling = false;
  if (!id || id === state.current) hideScrollStatus();
}

async function runScrollPump(id, generation) {
  const entry = entryFor(id);
  if (!entry) return;
  try {
    while (
      pool.hasEntry(id) &&
      generation === entry.scroll.generation &&
      (entry.scroll.target !== null || entry.scroll.pending)
    ) {
      let response;
      if (entry.scroll.target !== null) {
        const position = entry.scroll.target;
        entry.scroll.target = null;
        response = await api(`/sessions/${encodeURIComponent(id)}/scroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ position }),
        });
      } else {
        const signed = entry.scroll.pending;
        const direction = signed > 0 ? "up" : "down";
        const steps = Math.min(24, Math.abs(signed));
        entry.scroll.pending -= Math.sign(signed) * steps;
        response = await api(`/sessions/${encodeURIComponent(id)}/scroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ direction, steps }),
        });
      }
      const live = entryFor(id);
      if (live && generation === live.scroll.generation) {
        applyScrollState(response.scroll, id);
        if (id === state.current) showScrubberFeedback();
      }
    }
  } catch {
    const live = entryFor(id);
    if (live && generation === live.scroll.generation) {
      live.scroll.pending = 0;
      live.scroll.target = null;
    }
  } finally {
    const live = entryFor(id);
    if (!live) return;
    live.scroll.pumpActive = false;
    if (!live.scroll.pending && live.scroll.target === null) {
      live.scroll.scrolling = live.scroll.current.inMode;
    }
    if (
      !live.scroll.exitPending &&
      (live.scroll.pending || live.scroll.target !== null) &&
      pool.hasEntry(id)
    ) startScrollPump(id);
  }
}

function startScrollPump(id) {
  const entry = entryFor(id);
  if (!entry || entry.scroll.pumpActive || entry.scroll.exitPending) return;
  entry.scroll.pumpActive = true;
  const generation = entry.scroll.generation;
  entry.scroll.pump = runScrollPump(id, generation);
}

// Drain copy mode through the same transport barrier as scrolling. Inputs that
// arrive during the drain are sent first; only then may new scroll intent run.
function requestScrollExit(id, onDrained) {
  const entry = entryFor(id);
  if (!entry) {
    try { onDrained?.(); } catch {}
    return;
  }
  if (onDrained) entry.scroll.exitCallbacks.push(onDrained);
  if (entry.scroll.exitPending) return;
  const activePump = entry.scroll.pump;
  let exitSucceeded = false;
  clearScrollIntent(id);
  entry.scroll.exitPending = true;
  entry.scroll.pump = activePump
    .catch(() => {})
    .then(() => api(`/sessions/${encodeURIComponent(id)}/scroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: "exit" }),
    }))
    .then(({ scroll }) => {
      exitSucceeded = true;
      applyScrollState(scroll, id);
    })
    .catch(() => {})
    .finally(() => {
      const live = entryFor(id);
      if (!live) {
        for (const callback of entry.scroll.exitCallbacks) {
          try { callback(); } catch {}
        }
        entry.scroll.exitCallbacks = [];
        return;
      }
      live.scroll.exitPending = false;
      const inputs = live.scroll.deferred;
      live.scroll.deferred = [];
      live.scroll.deferredBytes = 0;
      const hasPending = Boolean(live.scroll.pending || live.scroll.target !== null);
      live.scroll.scrolling = hasPending || live.scroll.current.inMode;
      if (!exitSucceeded && inputs.length) {
        notifyInputFailure("Input was not sent because terminal scrolling could not exit.");
      }
      for (const item of inputs) {
        const delivered = exitSucceeded ? sendNow(item.msg, item.id) : false;
        try { item.onSettled?.(delivered); } catch {}
      }
      const callbacks = live.scroll.exitCallbacks;
      live.scroll.exitCallbacks = [];
      for (const callback of callbacks) {
        try { callback(); } catch {}
      }
      if (hasPending && pool.hasEntry(id)) startScrollPump(id);
    });
}

function notifyInputFailure(message = "Input was not sent. Reconnect, then try again.") {
  showNotice(message);
}

function deferInput(msg, id, onSettled) {
  const entry = entryFor(id);
  const ws = state.sockets.get(id);
  if (!entry || !ws || ws.readyState !== WebSocket.OPEN) {
    notifyInputFailure();
    return false;
  }
  const bytes = encoder.encode(msg.d || "").byteLength;
  if (
    liveDeferredCount(entry) >= MAX_DEFERRED_INPUT_MESSAGES ||
    entry.scroll.deferredBytes + bytes > MAX_DEFERRED_INPUT_BYTES
  ) {
    notifyInputFailure("Input was not sent because terminal scrolling is still finishing.");
    return false;
  }
  entry.scroll.deferred.push({ msg, id, onSettled });
  entry.scroll.deferredBytes += bytes;
  return "deferred";
}

function liveDeferredCount(entry) {
  return entry?.scroll.deferred.length ?? 0;
}

export function send(msg, { onDeferredSettled } = {}) {
  const id = state.current;
  const entry = id ? entryFor(id) : null;
  if (msg.t === "i" && id && entry?.scroll.exitPending) {
    if (entry.scroll.scrolling) clearScrollIntent(id);
    return deferInput(msg, id, onDeferredSettled);
  }
  if (msg.t === "i" && id && entry?.scroll.scrolling) {
    const outcome = deferInput(msg, id, onDeferredSettled);
    if (!outcome) return false;
    requestScrollExit(id);
    return outcome;
  }
  return sendNow(msg, id);
}

function sendNow(msg, id = state.current) {
  const ws = state.sockets.get(id);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (msg.t === "i") notifyInputFailure();
    return false;
  }
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    if (msg.t === "i") notifyInputFailure();
    const entry = id ? entryFor(id) : null;
    handleSocketFailure(ws, id, entry?.generation ?? 0);
    return false;
  }
}

export function scrollTerminal(direction, steps = 2) {
  const id = state.current;
  const entry = id ? entryFor(id) : null;
  if (!id || !entry || (direction !== "up" && direction !== "down")) return;
  entry.scroll.epoch++;
  entry.scroll.target = null;
  const count = Math.max(1, Math.min(96, Math.trunc(Number(steps) || 0)));
  const signed = direction === "up" ? count : -count;
  const pending = entry.scroll.pending;
  // New opposite intent replaces unsent distance instead of waiting behind it.
  entry.scroll.pending = pending && Math.sign(pending) !== Math.sign(signed)
    ? signed
    : Math.max(-96, Math.min(96, pending + signed));
  if (id === state.current) {
    showScrollStatus(direction);
    showScrubberFeedback();
  }
  entry.scroll.scrolling = true;
  startScrollPump(id);
}

function paintHeaderStatus(session = state.sessions.find((item) => item.id === state.current)) {
  const entry = active() ?? (session ? entryFor(session.id) : null);
  const connectionState = entry?.connState ?? "idle";
  const status = sessionStatus(session);
  const tip = statusTitle(session);
  const connectionLabel = connectionState === "idle" ? "not connected" : connectionState;
  el.conn.textContent = statusLabel(status);
  el.conn.className = `session-status-indicator badge status-${status}` +
    (connectionState === "closed" ? " connection-dead" : "");
  el.conn.dataset.connection = connectionState;
  el.conn.setAttribute("aria-label", `${tip}; terminal ${connectionLabel}`);
  el.conn.title = `${tip} · terminal ${connectionLabel}`;
}

function setConnFor(entry, text) {
  if (!entry) return;
  entry.connState = text;
  if (pool.activeEntryId() === entry.id) paintHeaderStatus();
}

function sessionRuntimeLabel(session) {
  return session.type === "shell" ? "shell" : (session.profile || "default");
}

export function syncSessionMetadata(sessions) {
  if (!state.current) return;
  const session = sessions.find((item) => item.id === state.current);
  if (session) {
    el["term-title"].textContent = `${session.title}  ·  ${sessionRuntimeLabel(session)}`;
    el["profile-btn"].hidden = session.type === "shell";
    paintHeaderStatus(session);
  }
}

function ackOutput(ws, bytes) {
  if (!bytes || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({ t: "ack", bytes })); } catch {}
}

function pumpOutputQueue(entry) {
  if (!entry || entry.outWriteActive || !entry.term) return;
  while (entry.outQueue.length) {
    const item = entry.outQueue.shift();
    if (item.reset) {
      try { entry.term.reset(); } catch {}
      continue;
    }
    if (item.generation !== entry.generation || !pool.hasEntry(entry.id)) {
      ackOutput(item.ws, item.bytes);
      continue;
    }
    // xterm defers each write callback. Feeding one network chunk per callback
    // turns a redraw into a slow history replay; drain adjacent chunks together.
    let text = item.text;
    let bytes = item.bytes;
    let consumed = 0;
    while (consumed < entry.outQueue.length) {
      const next = entry.outQueue[consumed];
      if (
        next.reset ||
        next.ws !== item.ws ||
        next.id !== item.id ||
        next.generation !== item.generation ||
        bytes + next.bytes > MAX_OUTPUT_BATCH_BYTES
      ) break;
      text += next.text;
      bytes += next.bytes;
      consumed++;
    }
    if (consumed) entry.outQueue.splice(0, consumed);
    entry.replay.writes++;
    entry.replay.lastAt = Date.now();
    if (entry.replay.hidden) armReplayTimer(entry);
    entry.outWriteActive = true;
    try {
      entry.term.write(text, () => {
        ackOutput(item.ws, bytes);
        entry.outWriteActive = false;
        queueMicrotask(() => pumpOutputQueue(entry));
      });
    } catch {
      ackOutput(item.ws, bytes);
      entry.outWriteActive = false;
      queueMicrotask(() => pumpOutputQueue(entry));
    }
    return;
  }
  // The first drain is just the visible screen; scrollback history streams
  // after it. Reveal on drain only after a quiet spell with no new batches,
  // so the tail is actually present when the canvas reappears.
  if (entry.replay.writes > 0 && Date.now() - entry.replay.lastAt >= REPLAY_QUIET_MS) {
    revealReplay(entry);
  }
}
function enqueueOutput(text, ws, id, generation, bytes = 0) {
  const entry = entryFor(id);
  if (!entry) {
    ackOutput(ws, bytes);
    return;
  }
  entry.outQueue.push({ text, ws, id, generation, bytes });
  pumpOutputQueue(entry);
}

function closeSocketInstance(id, ws) {
  if (!ws) return;
  intentionalSockets.add(ws);
  if (state.sockets.get(id) === ws) state.sockets.delete(id);
  try { ws.close(); } catch {}
}

function scheduleReconnect(entry, session, generation) {
  if (!entry || !pool.hasEntry(session.id)) return;
  if (document.visibilityState === "hidden") {
    setConnFor(entry, "closed");
    return;
  }
  if (generation !== entry.generation) return;
  if (entry.reconnectAttempt >= RECONNECT_DELAYS.length) {
    setConnFor(entry, "closed");
    return;
  }
  const delay = RECONNECT_DELAYS[entry.reconnectAttempt++];
  clearTimeout(entry.reconnectTimer);
  setConnFor(entry, "reconnecting");
  entry.reconnectTimer = setTimeout(() => {
    const live = entryFor(session.id);
    if (!live || generation !== live.generation || state.sockets.has(session.id)) return;
    connectSession(live, session, generation, true);
  }, delay);
}

function handleSocketFailure(ws, id, generation) {
  if (failedSockets.has(ws)) return;
  failedSockets.add(ws);
  const entry = entryFor(id);
  if (
    !entry ||
    intentionalSockets.has(ws) ||
    nonRetrySockets.has(ws) ||
    generation !== entry.generation ||
    state.sockets.get(id) !== ws
  ) return;
  state.sockets.delete(id);
  try { ws.close(); } catch {}
  const session = state.sessions.find((item) => item.id === id);
  if (session) scheduleReconnect(entry, session, generation);
  else setConnFor(entry, "closed");
}

function connectSession(entry, session, generation, reconnecting = false) {
  if (!entry || !pool.hasEntry(session.id) || generation !== entry.generation) return;
  fitEntry(entry, { force: true });
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams({
    id: session.id,
    cols: entry.term.cols,
    rows: entry.term.rows,
    flow: "ack",
  });
  if (state.token) params.set("token", state.token);
  const ws = new WebSocket(`${proto}://${location.host}/ws?${params}`);
  entry.ws = ws;
  lastResizeBySocket.set(ws, `${entry.term.cols}x${entry.term.rows}`);
  state.sockets.set(session.id, ws);
  setConnFor(entry, reconnecting ? "reconnecting" : "connecting");
  ws.onopen = () => {
    const live = entryFor(session.id);
    if (
      !live ||
      generation !== live.generation ||
      state.sockets.get(session.id) !== ws
    ) return;
    live.reconnectAttempt = 0;
    setConnFor(live, "live");
    if (pool.activeEntryId() === session.id) fitEntry(live);
    if (
      pool.activeEntryId() === session.id &&
      terminalVisible &&
      !window.matchMedia("(max-width: 1099px)").matches
    ) live.term.focus();
  };
  ws.onmessage = (event) => {
    const live = entryFor(session.id);
    if (
      !live ||
      generation !== live.generation ||
      state.sockets.get(session.id) !== ws ||
      typeof event.data !== "string"
    ) return;
    if (event.data[0] === "{") {
      try {
        const message = JSON.parse(event.data);
        if (message.t === "error") {
          nonRetrySockets.add(ws);
          enqueueOutput(`\r\n[omp-web] ${message.m}`, ws, session.id, generation);
          return;
        }
      } catch {}
    }
    enqueueOutput(
      event.data,
      ws,
      session.id,
      generation,
      encoder.encode(event.data).byteLength,
    );
  };
  ws.onclose = () => {
    const live = entryFor(session.id);
    if (nonRetrySockets.has(ws)) {
      if (
        live &&
        generation === live.generation &&
        state.sockets.get(session.id) === ws
      ) {
        state.sockets.delete(session.id);
        setConnFor(live, "closed");
      }
      return;
    }
    handleSocketFailure(ws, session.id, generation);
  };
  ws.onerror = () => handleSocketFailure(ws, session.id, generation);
}

export function attach(session, { reset = true } = {}) {
  if (!session?.id) return;
  if (state.current === session.id) {
    if (window.matchMedia("(max-width: 1099px)").matches) {
      el.sidebar.classList.add("hidden");
    } else {
      focusTerminal();
    }
    return;
  }
  // Pooled switch: park the previous host in place (socket + buffer survive).
  // No mass-close, no global generation bump — each entry reconnects alone.
  const entry = pool.activateEntry(session.id);
  const isCold = !entry.term || entry.replay.writes === 0;
  setCurrent(session.id);
  paintHeaderStatus(session);
  el.main.classList.add("has-session");
  syncChromeForActive();
  ensureTermFor(entry);
  el["term-title"].textContent = `${session.title}  ·  ${sessionRuntimeLabel(session)}`;
  el["kill-btn"].hidden = false;
  el["profile-btn"].hidden = session.type === "shell";
  el.quickkeys.hidden = false;
  const ws = state.sockets.get(session.id);
  const socketLive = Boolean(ws) && ws.readyState <= WebSocket.OPEN;
  if (reset && (isCold || !socketLive)) {
    // Cold entry, evicted revisit, or a warm entry whose socket died (replay
    // would otherwise duplicate into the intact buffer): clear behind the
    // cover, then stream. Warm switches with a live socket skip this entirely
    // and appear instantly with buffer + viewport intact.
    resetTerm(session.id);
  } else if (!entry.replay.hidden) {
    // Warm instant switch: hide any cover left by the previous active entry
    // and rebind the shared scrubber to this entry's stored scroll state.
    if (el["replay-loader"]) el["replay-loader"].hidden = true;
    if (entry.host) entry.host.style.visibility = "";
  } else if (pool.activeEntryId() === entry.id) {
    // Activating an entry still mid-replay (background reset or slow stream):
    // keep it parked behind the shared cover until its own drain reveals it.
    if (entry.host) entry.host.style.visibility = "hidden";
    if (el["replay-loader"]) el["replay-loader"].hidden = false;
  }
  applyScrollState(entry.scroll.current, session.id);
  refreshScrollState(session.id);
  emit("sidebar:rerender");
  if (window.matchMedia("(max-width: 1099px)").matches) el.sidebar.classList.add("hidden");
  const liveWs = state.sockets.get(session.id);
  if (!liveWs || liveWs.readyState === WebSocket.CLOSED || liveWs.readyState === WebSocket.CLOSING) {
    connectSession(entry, session, entry.generation);
  } else {
    fitEntry(entry, { force: true });
  }
}

// Reactivate a parked entry (ghost preview return): show host, repaint header,
// rebind scrubber, refit. No replay — buffer + socket survived the park.
export function reactivateEntry(id = state.current) {
  if (!id || !pool.hasEntry(id)) return null;
  const entry = pool.activateEntry(id);
  setCurrent(id);
  const session = state.sessions.find((item) => item.id === id);
  paintHeaderStatus(session);
  el.main.classList.add("has-session");
  syncChromeForActive();
  if (entry.term) {
    if (!entry.replay.hidden) {
      if (entry.host) entry.host.style.visibility = "";
      if (el["replay-loader"]) el["replay-loader"].hidden = true;
    } else {
      if (entry.host) entry.host.style.visibility = "hidden";
      if (el["replay-loader"]) el["replay-loader"].hidden = false;
    }
    el["term-title"].textContent = session
      ? `${session.title}  ·  ${sessionRuntimeLabel(session)}`
      : entry.id;
    el["kill-btn"].hidden = false;
    el["profile-btn"].hidden = session ? session.type === "shell" : true;
    if (el.quickkeys) el.quickkeys.hidden = false;
    applyScrollState(entry.scroll.current, id);
    fitEntry(entry, { force: true });
  }
  return entry;
}

// Dispose one session's view (kill / vanished refresh): socket gone, host node
// gone via the pool hook. Clears focused chrome only when it was current.
export function removeSessionView(id) {
  if (!id) return false;
  const wasCurrent = state.current === id;
  pool.disposeEntry(id);
  if (!wasCurrent) return true;
  setCurrent(null);
  el.main.classList.remove("has-session");
  el["term-title"].textContent = "no session";
  el["kill-btn"].hidden = true;
  el["profile-btn"].hidden = true;
  if (el.quickkeys) el.quickkeys.hidden = true;
  applyScrollState({ history: 0, position: 0, inMode: false }, null);
  paintHeaderStatus(undefined);
  syncChromeForActive();
  return true;
}
