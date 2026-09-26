"use strict";
// xterm init, fit, touch scroll, WebSocket PTY bridge, mobile reconnection.

import { state, emit, setCurrent } from "./state.js";
import { el } from "./dom.js";
import { api } from "./api.js";
import { showNotice } from "./notice.js";
import { sessionStatus, statusLabel, statusTitle } from "./session-status.js";

const encoder = new TextEncoder();
const RECONNECT_DELAYS = [250, 500, 1000, 2000, 4000, 8000];
const MAX_DEFERRED_INPUT_BYTES = 64 * 1024;
const MAX_DEFERRED_INPUT_MESSAGES = 256;
const MAX_OUTPUT_BATCH_BYTES = 64 * 1024;

let term, fit;
let reconnectTimer, scrollStatusTimer, scrubFeedbackTimer, fitFrame;
let reconnectAttempt = 0, connectionGeneration = 0;
let terminalVisible = true;
let connectionState = "idle";
let scrolling = false, scrubDragging = false;
let scrollPending = 0, scrollTarget = null, scrollGeneration = 0, scrollStateEpoch = 0;
let scrollPumpActive = false, scrollExitPending = false;
let scrollPump = Promise.resolve(), deferredScrollInputs = [], deferredInputBytes = 0;
let scrollExitCallbacks = [];
let currentScrollState = { history: 0, position: 0, inMode: false };
let outputQueue = [], outputWriteActive = false;
let replayHidden = false, replayTimer = null, replayWrites = 0, replayDeadline = 0;
const intentionalSockets = new WeakSet();
const failedSockets = new WeakSet();
const nonRetrySockets = new WeakSet();
const lastResizeBySocket = new WeakMap();

export function ensureTerm({ send }) {
  if (term) return term;
  term = new Terminal({
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
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(el.term);
  wireCompactFocusGuard();
  term.onData((d) => send({ t: "i", d }));
  wireTouchScroll();
  wireWheelScroll();
  wireScrollScrubber();
  new ResizeObserver(scheduleFit).observe(el["term-wrap"]);
  window.addEventListener("resize", () => {
    syncCompactFocusGuard();
    // Rotation must refit even in chat mode: the layer keeps real dimensions
    // under the overlay, and a portrait-sized canvas would otherwise paint
    // past its landscape box (pure-black strip with stale TUI text).
    if (fitFrame) return;
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      doFit({ force: true });
    });
  });
  return term;
}

export function getTerm() { return term; }

export function resetTerm() {
  if (!term) return;
  outputQueue.push({ reset: true });
  replayHidden = true;
  replayWrites = 0;
  // Debounced reveal: every landed batch pushes the quiet-reveal out, so a
  // slow multi-second replay stays parked; the absolute cap bounds it for
  // sessions that never go quiet.
  replayDeadline = Date.now() + REPLAY_MAX_MS;
  armReplayTimer();
  const generation = connectionGeneration;
  if (el.term) el.term.style.visibility = "hidden";
  pumpOutputQueue();
}

function armReplayTimer() {
  clearTimeout(replayTimer);
  const wait = Math.min(REPLAY_REVEAL_MS, Math.max(0, replayDeadline - Date.now()));
  const generation = connectionGeneration;
  replayTimer = setTimeout(() => {
    if (generation === connectionGeneration) revealReplay();
  }, wait);
}

// A fresh attach replays scrollback from an empty buffer; xterm follows the
// tail progressively, which reads as the view sweeping down from the top on
// every reload. Park the canvas hidden until the replay burst drains.
// visibility:hidden keeps layout so fitting still measures correctly.
const REPLAY_REVEAL_MS = 1200;
const REPLAY_MAX_MS = 8000;
function revealReplay() {
  if (!replayHidden) return;
  replayHidden = false;
  clearTimeout(replayTimer);
  if (el.term) el.term.style.visibility = "";
  try { term?.scrollToBottom(); } catch {}
}

export function showEmpty() {
  const id = state.current;
  clearTimeout(reconnectTimer);
  reconnectAttempt = 0;
  connectionGeneration++;
  if (id) closeSocket(id);
  setCurrent(null);
  el.main.classList.remove("has-session");
  el["term-title"].textContent = "no session";
  el["kill-btn"].hidden = true;
  el["profile-btn"].hidden = true;
  el.quickkeys.hidden = true;
  applyScrollState({ history: 0, position: 0, inMode: false });
  setConn("idle");
  resetTerm();
}

export function focusTerminal() {
  if (!terminalVisible) return;
  if (window.matchMedia("(max-width: 1099px)").matches && el["mobile-input"]) {
    el["mobile-input"].focus({ preventScroll: true });
    return;
  }
  term?.focus();
  document.querySelector(".xterm-helper-textarea")?.focus({ preventScroll: true });
}

function syncCompactFocusGuard() {
  const helper = document.querySelector(".xterm-helper-textarea");
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

function wireCompactFocusGuard() {
  const helper = document.querySelector(".xterm-helper-textarea");
  if (!helper) return;
  helper.addEventListener("focus", () => {
    if (window.matchMedia("(max-width: 1099px)").matches) helper.blur();
  });
  syncCompactFocusGuard();
}

function scheduleFit() {
  if (fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    doFit();
  });
}

export function setVisible(visible) {
  terminalVisible = Boolean(visible);
  if (terminalVisible) scheduleFit();
  else term?.blur();
}

export function doFit({ force = false } = {}) {
  if (!fit || !term || (!terminalVisible && !force)) return;
  try {
    const proposed = fit.proposeDimensions?.();
    if (proposed && (proposed.cols !== term.cols || proposed.rows !== term.rows)) {
      term.resize(proposed.cols, proposed.rows);
    } else if (!proposed) {
      fit.fit();
    }
  } catch {}
  const id = state.current;
  const ws = state.sockets.get(id);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const size = `${term.cols}x${term.rows}`;
  if (lastResizeBySocket.get(ws) === size) return;
  if (sendNow({ t: "r", cols: term.cols, rows: term.rows }, id)) {
    lastResizeBySocket.set(ws, size);
  }
}

function touchPixelsPerLine() {
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

function applyScrollState(next) {
  if (!next) return;
  const history = Math.max(0, Math.trunc(Number(next.history) || 0));
  const position = Math.max(0, Math.min(history, Math.trunc(Number(next.position) || 0)));
  currentScrollState = { history, position, inMode: Boolean(next.inMode) };
  const scrubber = el["scroll-scrubber"];
  const label = el["scroll-scrubber-label"];
  const ratio = history ? 1 - position / history : 1;
  const offset = ratio * 100;
  scrubber.hidden = !state.current || history === 0;
  if (scrubber.hidden) {
    clearTimeout(scrubFeedbackTimer);
    scrubber.classList.remove("active");
  }
  scrubber.setAttribute("aria-valuemax", String(history));
  scrubber.setAttribute("aria-valuenow", String(position));
  scrubber.setAttribute("aria-valuetext", scrollLabel(currentScrollState));
  label.textContent = scrollLabel(currentScrollState);
  label.style.top = `${offset}%`;
  label.style.transform = `translateY(-${offset}%)`;
  el["scroll-scrubber-thumb"].style.top = `${offset}%`;
  el["scroll-scrubber-thumb"].style.transform = `translate(-50%, -${offset}%)`;
}

function showScrubberFeedback() {
  el["scroll-scrubber"].classList.add("active");
  clearTimeout(scrubFeedbackTimer);
  if (!scrubDragging) {
    scrubFeedbackTimer = setTimeout(() => el["scroll-scrubber"].classList.remove("active"), 1100);
  }
}

async function refreshScrollState(id) {
  const epoch = scrollStateEpoch;
  try {
    const { scroll } = await api(`/sessions/${encodeURIComponent(id)}/scroll`, { cache: "no-store" });
    if (
      state.current !== id ||
      epoch !== scrollStateEpoch ||
      scrollPumpActive ||
      scrollExitPending ||
      scrollPending ||
      scrollTarget !== null
    ) return;
    applyScrollState(scroll);
    scrolling = Boolean(scroll.inMode);
  } catch {}
}

function queueScrollPosition(position) {
  const id = state.current;
  if (!id || !currentScrollState.history) return;
  scrollStateEpoch++;
  scrollPending = 0;
  scrollTarget = Math.max(0, Math.min(currentScrollState.history, Math.round(position)));
  scrolling = true;
  showScrubberFeedback();
  startScrollPump(id);
}

function wireScrollScrubber() {
  const scrubber = el["scroll-scrubber"];
  let pointerId = null;
  const positionAt = (clientY) => {
    const rect = scrubber.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
    return currentScrollState.history * (1 - ratio);
  };
  const finish = (event) => {
    if (event.pointerId !== pointerId) return;
    try { scrubber.releasePointerCapture(pointerId); } catch {}
    pointerId = null;
    scrubDragging = false;
    showScrubberFeedback();
  };
  scrubber.addEventListener("pointerdown", (event) => {
    if (!currentScrollState.history) return;
    event.preventDefault();
    pointerId = event.pointerId;
    scrubDragging = true;
    scrubber.setPointerCapture(pointerId);
    queueScrollPosition(positionAt(event.clientY));
  });
  scrubber.addEventListener("pointermove", (event) => {
    if (event.pointerId === pointerId) queueScrollPosition(positionAt(event.clientY));
  });
  scrubber.addEventListener("pointerup", finish);
  scrubber.addEventListener("pointercancel", finish);
  scrubber.addEventListener("keydown", (event) => {
    const page = Math.max(1, term?.rows || 24);
    const commands = {
      ArrowUp: currentScrollState.position + 1,
      ArrowDown: currentScrollState.position - 1,
      PageUp: currentScrollState.position + page,
      PageDown: currentScrollState.position - page,
      Home: currentScrollState.history,
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


function clearScrollIntent() {
  scrollStateEpoch++;
  scrollGeneration++;
  scrollPending = 0;
  scrollTarget = null;
  scrolling = false;
  hideScrollStatus();
}

async function runScrollPump(id, generation) {
  try {
    while (
      state.current === id &&
      generation === scrollGeneration &&
      (scrollTarget !== null || scrollPending)
    ) {
      let response;
      if (scrollTarget !== null) {
        const position = scrollTarget;
        scrollTarget = null;
        response = await api(`/sessions/${encodeURIComponent(id)}/scroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ position }),
        });
      } else {
        const signed = scrollPending;
        const direction = signed > 0 ? "up" : "down";
        const steps = Math.min(24, Math.abs(signed));
        scrollPending -= Math.sign(signed) * steps;
        response = await api(`/sessions/${encodeURIComponent(id)}/scroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ direction, steps }),
        });
      }
      if (state.current === id && generation === scrollGeneration) {
        applyScrollState(response.scroll);
        showScrubberFeedback();
      }
    }
  } catch {
    if (state.current === id && generation === scrollGeneration) {
      scrollPending = 0;
      scrollTarget = null;
    }
  } finally {
    scrollPumpActive = false;
    if (!scrollPending && scrollTarget === null) scrolling = currentScrollState.inMode;
    if (
      !scrollExitPending &&
      (scrollPending || scrollTarget !== null) &&
      state.current
    ) startScrollPump(state.current);
  }
}

function startScrollPump(id) {
  if (scrollPumpActive || scrollExitPending) return;
  scrollPumpActive = true;
  const generation = scrollGeneration;
  scrollPump = runScrollPump(id, generation);
}

// Drain copy mode through the same transport barrier as scrolling. Inputs that
// arrive during the drain are sent first; only then may new scroll intent run.
function requestScrollExit(id, onDrained) {
  if (onDrained) scrollExitCallbacks.push(onDrained);
  if (scrollExitPending) return;
  const activePump = scrollPump;
  let exitSucceeded = false;
  clearScrollIntent();
  scrollExitPending = true;
  scrollPump = activePump
    .catch(() => {})
    .then(() => api(`/sessions/${encodeURIComponent(id)}/scroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: "exit" }),
    }))
    .then(({ scroll }) => {
      exitSucceeded = true;
      if (state.current === id) applyScrollState(scroll);
    })
    .catch(() => {})
    .finally(() => {
      scrollExitPending = false;
      const inputs = deferredScrollInputs;
      deferredScrollInputs = [];
      deferredInputBytes = 0;
      const hasPending = Boolean(scrollPending || scrollTarget !== null);
      scrolling = hasPending || currentScrollState.inMode;
      if (!exitSucceeded && inputs.length) {
        notifyInputFailure("Input was not sent because terminal scrolling could not exit.");
      }
      for (const entry of inputs) {
        const delivered = exitSucceeded ? sendNow(entry.msg, entry.id) : false;
        try { entry.onSettled?.(delivered); } catch {}
      }
      const callbacks = scrollExitCallbacks;
      scrollExitCallbacks = [];
      for (const callback of callbacks) callback();
      if (hasPending && state.current) startScrollPump(state.current);
    });
}

function notifyInputFailure(message = "Input was not sent. Reconnect, then try again.") {
  showNotice(message);
}

function deferInput(msg, id, onSettled) {
  const ws = state.sockets.get(id);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    notifyInputFailure();
    return false;
  }
  const bytes = encoder.encode(msg.d || "").byteLength;
  if (
    deferredScrollInputs.length >= MAX_DEFERRED_INPUT_MESSAGES ||
    deferredInputBytes + bytes > MAX_DEFERRED_INPUT_BYTES
  ) {
    notifyInputFailure("Input was not sent because terminal scrolling is still finishing.");
    return false;
  }
  deferredScrollInputs.push({ msg, id, onSettled });
  deferredInputBytes += bytes;
  return "deferred";
}

export function send(msg, { onDeferredSettled } = {}) {
  const id = state.current;
  if (msg.t === "i" && id && scrollExitPending) {
    if (scrolling) clearScrollIntent();
    return deferInput(msg, id, onDeferredSettled);
  }
  if (msg.t === "i" && id && scrolling) {
    const outcome = deferInput(msg, id, onDeferredSettled);
    if (!outcome) return false;
    requestScrollExit(id);
    return outcome;
  }
  return sendNow(msg, id);
}

export function sendNow(msg, id = state.current) {
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
    handleSocketFailure(ws, id, connectionGeneration);
    return false;
  }
}

export function scrollTerminal(direction, steps = 2) {
  const id = state.current;
  if (!id || (direction !== "up" && direction !== "down")) return;
  scrollStateEpoch++;
  scrollTarget = null;
  const count = Math.max(1, Math.min(96, Math.trunc(Number(steps) || 0)));
  const signed = direction === "up" ? count : -count;
  // New opposite intent replaces unsent distance instead of waiting behind it.
  scrollPending = scrollPending && Math.sign(scrollPending) !== Math.sign(signed)
    ? signed
    : Math.max(-96, Math.min(96, scrollPending + signed));
  showScrollStatus(direction);
  showScrubberFeedback();
  scrolling = true;
  startScrollPump(id);
}

function paintHeaderStatus(session = state.sessions.find((item) => item.id === state.current)) {
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
export function setConn(text) {
  connectionState = text;
  paintHeaderStatus();
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

function pumpOutputQueue() {
  if (outputWriteActive || !term) return;
  while (outputQueue.length) {
    const entry = outputQueue.shift();
    if (entry.reset) {
      term.reset();
      continue;
    }
    if (entry.generation !== connectionGeneration || state.current !== entry.id) {
      ackOutput(entry.ws, entry.bytes);
      continue;
    }
    // xterm defers each write callback. Feeding one network chunk per callback
    // turns a redraw into a slow history replay; drain adjacent chunks together.
    let text = entry.text;
    let bytes = entry.bytes;
    let consumed = 0;
    while (consumed < outputQueue.length) {
      const next = outputQueue[consumed];
      if (
        next.reset ||
        next.ws !== entry.ws ||
        next.id !== entry.id ||
        next.generation !== entry.generation ||
        bytes + next.bytes > MAX_OUTPUT_BATCH_BYTES
      ) break;
      text += next.text;
      bytes += next.bytes;
      consumed++;
    }
    if (consumed) outputQueue.splice(0, consumed);
    replayWrites++;
    if (replayHidden) armReplayTimer();
    outputWriteActive = true;
    try {
      term.write(text, () => {
        ackOutput(entry.ws, bytes);
        outputWriteActive = false;
        queueMicrotask(pumpOutputQueue);
      });
    } catch {
      ackOutput(entry.ws, bytes);
      outputWriteActive = false;
      queueMicrotask(pumpOutputQueue);
    }
    return;
  }
  // The reset-only drain (no output arrived yet) must not reveal: the replay
  // hasn't started, and showing the empty canvas is the top-flash itself.
  if (replayWrites > 0) revealReplay();
}

function enqueueOutput(text, ws, id, generation, bytes = 0) {
  outputQueue.push({ text, ws, id, generation, bytes });
  pumpOutputQueue();
}

function closeSocketInstance(id, ws) {
  if (!ws) return;
  intentionalSockets.add(ws);
  if (state.sockets.get(id) === ws) state.sockets.delete(id);
  try { ws.close(); } catch {}
}

function closeSocket(id) {
  closeSocketInstance(id, state.sockets.get(id));
}

function scheduleReconnect(session, generation) {
  if (
    document.visibilityState === "hidden" ||
    state.current !== session.id ||
    generation !== connectionGeneration
  ) {
    setConn("closed");
    return;
  }
  if (reconnectAttempt >= RECONNECT_DELAYS.length) {
    setConn("closed");
    return;
  }
  const delay = RECONNECT_DELAYS[reconnectAttempt++];
  clearTimeout(reconnectTimer);
  setConn("reconnecting");
  reconnectTimer = setTimeout(() => {
    if (
      state.current !== session.id ||
      generation !== connectionGeneration ||
      state.sockets.has(session.id)
    ) return;
    connectSession(session, generation, true);
  }, delay);
}

function handleSocketFailure(ws, id, generation) {
  if (failedSockets.has(ws)) return;
  failedSockets.add(ws);
  if (
    intentionalSockets.has(ws) ||
    nonRetrySockets.has(ws) ||
    state.current !== id ||
    generation !== connectionGeneration ||
    state.sockets.get(id) !== ws
  ) return;
  state.sockets.delete(id);
  try { ws.close(); } catch {}
  const session = state.sessions.find((item) => item.id === id);
  if (session) scheduleReconnect(session, generation);
  else setConn("closed");
}

function connectSession(session, generation, reconnecting = false) {
  if (state.current !== session.id || generation !== connectionGeneration) return;
  doFit({ force: true });
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams({
    id: session.id,
    cols: term.cols,
    rows: term.rows,
    flow: "ack",
  });
  if (state.token) params.set("token", state.token);
  const ws = new WebSocket(`${proto}://${location.host}/ws?${params}`);
  lastResizeBySocket.set(ws, `${term.cols}x${term.rows}`);
  state.sockets.set(session.id, ws);
  setConn(reconnecting ? "reconnecting" : "connecting");
  ws.onopen = () => {
    if (
      generation !== connectionGeneration ||
      state.current !== session.id ||
      state.sockets.get(session.id) !== ws
    ) return;
    reconnectAttempt = 0;
    setConn("live");
    doFit();
    if (terminalVisible && !window.matchMedia("(max-width: 1099px)").matches) term.focus();
  };
  ws.onmessage = (event) => {
    if (
      generation !== connectionGeneration ||
      state.current !== session.id ||
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
    if (nonRetrySockets.has(ws)) {
      if (
        generation === connectionGeneration &&
        state.current === session.id &&
        state.sockets.get(session.id) === ws
      ) {
        state.sockets.delete(session.id);
        setConn("closed");
      }
      return;
    }
    handleSocketFailure(ws, session.id, generation);
  };
  ws.onerror = () => handleSocketFailure(ws, session.id, generation);
}

export function attach(session, { reset = true } = {}) {
  if (state.current === session.id) {
    if (window.matchMedia("(max-width: 1099px)").matches) {
      el.sidebar.classList.add("hidden");
    } else {
      focusTerminal();
    }
    return;
  }
  clearTimeout(reconnectTimer);
  reconnectAttempt = 0;
  const outgoingId = state.current;
  const outgoingSocket = state.sockets.get(outgoingId);
  const drainOutgoing = Boolean(outgoingId && (scrolling || scrollExitPending));
  if (drainOutgoing) {
    requestScrollExit(outgoingId, () => closeSocketInstance(outgoingId, outgoingSocket));
  }
  else if (!scrollExitPending) clearScrollIntent();
  for (const id of state.sockets.keys()) {
    if (!drainOutgoing || id !== outgoingId) closeSocket(id);
  }
  connectionGeneration++;
  const generation = connectionGeneration;
  setCurrent(session.id);
  paintHeaderStatus(session);
  el.main.classList.add("has-session");
  scrollStateEpoch++;
  applyScrollState({ history: 0, position: 0, inMode: false });
  ensureTerm({ send });
  if (reset) resetTerm();
  el["term-title"].textContent = `${session.title}  ·  ${sessionRuntimeLabel(session)}`;
  el["kill-btn"].hidden = false;
  el["profile-btn"].hidden = session.type === "shell";
  el.quickkeys.hidden = false;
  refreshScrollState(session.id);
  emit("sidebar:rerender");
  if (window.matchMedia("(max-width: 1099px)").matches) el.sidebar.classList.add("hidden");
  connectSession(session, generation);
}

function replaceCurrentConnection(session) {
  connectionGeneration++;
  const generation = connectionGeneration;
  reconnectAttempt = 0;
  closeSocket(session.id);
  connectSession(session, generation, true);
}

export function reconnectCurrent() {
  if (document.visibilityState === "hidden" || !state.current) return;
  const id = state.current;
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (state.current !== id) return;
    if (scrolling || scrollExitPending) {
      requestScrollExit(id, () => {
        if (state.current === id) replaceCurrentConnection(session);
      });
      return;
    }
    replaceCurrentConnection(session);
  }, 100);
}