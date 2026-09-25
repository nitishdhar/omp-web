"use strict";

import { el } from "./dom.js";
import { showNotice, hideNotice } from "./notice.js";

const URL_RE = /https?:\/\/[^\s"'`<>()\[\]{}]+[^\s"'`<>()\[\]{}.,;:!?]/g;
const HOLD_MS = 380; // under WebKit's ~500ms callout threshold
let currentUrl = "";

export function closeLinkModal() {
  el["link-modal"].hidden = true;
  el["link-error"].hidden = true;
}

function showError(msg) {
  el["link-error"].textContent = msg;
  el["link-error"].hidden = false;
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(currentUrl);
    closeLinkModal();
    showNotice("Copied");
  } catch {
    showError("Clipboard was denied. Long-press the link text to copy it manually.");
  }
}

function openLink() {
  window.open(currentUrl, "_blank", "noopener");
  closeLinkModal();
}

function showLinkModal(url) {
  currentUrl = url;
  el["link-text"].textContent = url;
  el["link-error"].hidden = true;
  el["link-modal"].hidden = false;
}

// A URL longer than the terminal width is written by the PTY across
// consecutive rows; xterm marks continuation rows with `isWrapped`. Rebuild
// the logical line (cap the walk) and match against the joined text so the
// full wrapped URL is captured, not just the touched row's fragment.
function extractUrlAt(term, col, row) {
  const rows = [];
  let start = row;
  while (row - start < 40 && start > 0 && term.buffer.active.getLine(start)?.isWrapped) start--;
  for (let r = start; r < start + 50; r++) {
    const line = term.buffer.active.getLine(r);
    if (!line) break;
    if (r > start && !line.isWrapped) break;
    let chars = "";
    for (let c = 0; c < term.cols; c++) chars += line.getCell(c)?.getChars() || "";
    rows.push(chars);
  }
  const lineStart = row - start;
  const offset = rows.slice(0, lineStart).reduce((n, text) => n + text.length, 0) + col;
  const text = rows.join("");
  let match;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text))) {
    if (offset >= match.index && offset < match.index + match[0].length) return match[0];
  }
  return null;
}

function termCellFromTouch(term, touch) {
  const dims = term._core?._renderService?.dimensions?.css?.cell;
  const rowsEl = term.element.querySelector(".xterm-rows");
  if (!rowsEl) return null;
  const rect = rowsEl.getBoundingClientRect();
  if (!(touch.clientX >= rect.left && touch.clientX <= rect.right && touch.clientY >= rect.top && touch.clientY <= rect.bottom)) return null;
  const cellW = dims?.width || rect.width / term.cols;
  const cellH = dims?.height || Number(rowsEl.firstElementChild?.clientHeight) || 16;
  const col = Math.floor((touch.clientX - rect.left) / cellW);
  const row = Math.floor(term.buffer.active.viewportY + (touch.clientY - rect.top) / cellH);
  return { col, row: Math.max(0, row) };
}



function hideCopyBar() {
  el["copy-bar"].hidden = true;
}

// Selection drag handles (iOS-style teardrops). They ride on the xterm
// selection: position from getSelectionPosition(), drag re-applies via
// term.select(). start handle = top-left of first cell, end handle =
// bottom-right of last cell; mirrors iOS visual convention.
function hideHandles() {
  el["sel-handles"].hidden = true;
}

function positionHandles(term) {
  const pos = term.getSelectionPosition?.();
  const rowsEl = term.element?.querySelector(".xterm-rows");
  if (!pos || !rowsEl) { hideHandles(); return; }
  const rect = rowsEl.getBoundingClientRect();
  const dims = term._core?._renderService?.dimensions?.css?.cell;
  const cellW = dims?.width || rect.width / term.cols;
  const cellH = dims?.height || Number(rowsEl.firstElementChild?.clientHeight) || 16;
  const viewY = term.buffer.active.viewportY;
  // Keep the touch targets out of iOS/Android edge-gesture zones. The visible
  // handle can be inset from an extreme selection endpoint; dragging still
  // maps back to the actual terminal cell under the finger.
  const edgeInset = 56;
  const set = (handle, col, row) => {
    const left = rect.left + col * cellW;
    el[handle].style.left = Math.min(window.innerWidth - edgeInset, Math.max(edgeInset, left)) + "px";
    el[handle].style.top = rect.top + (row - viewY) * cellH + "px";
  };
  // getSelectionPosition() returns buffer coordinates and normalizes reversed
  // drags, so start is always the top-left cell and end is the exclusive edge.
  set("sel-handle-start", pos.start.x, pos.start.y);
  set("sel-handle-end", pos.end.x, pos.end.y);
  el["sel-handles"].hidden = false;
}

let selectionWatchTerm = null;
function watchSelection(term) {
  if (selectionWatchTerm === term) return;
  selectionWatchTerm = term;
  term.onSelectionChange(() => {
    if (!term.hasSelection?.()) {
      hideCopyBar();
      hideHandles();
    }
  });
}

function showCopyBar(onCopy, onDismiss, term) {
  watchSelection(term);
  positionHandles(term);
  el["copy-bar"].hidden = false;
  el["copy-bar-copy"].onclick = async () => {
    el["copy-bar-copy"].disabled = true;
    try {
      if (await onCopy()) {
        showNotice("Copied");
        hideCopyBar();
        hideHandles();
      } else {
        showNotice("Clipboard was denied");
      }
    } finally {
      el["copy-bar-copy"].disabled = false;
    }
  };
  el["copy-bar-dismiss"].onclick = () => {
    hideHandles();
    hideCopyBar();
    onDismiss?.();
  };
}

// Long-press a URL to open/copy it; one-finger drag scrolls, two-finger drag
// selects and copies. iOS kills custom long-press timers because WebKit's
// text-selection callout claims the gesture (~500ms and swallows touchend);
// preventDefault() on touchstart stops the callout without focusing either
// xterm's helper textarea or the explicit mobile composer.
export function wireLinkModal({ getTerm }) {
  el["link-cancel"].addEventListener("click", closeLinkModal);
  el["link-copy"].addEventListener("click", copyLink);
  el["link-open"].addEventListener("click", openLink);
  el["link-modal"].addEventListener("click", (e) => {
    if (e.target === el["link-modal"]) closeLinkModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el["link-modal"].hidden) closeLinkModal();
  });

  const surface = el["term-wrap"];
  let holdTimer;
  let press = null;        // { cell, x, y }; cell identity backs the hold-callback bail-out
  let twoFinger = false;   // drag-copy in progress
  let anchor = null;       // anchor cell for two-finger selection
  let handleDrag = null;   // { movingEnd, fixed } while a selection handle is being dragged

  function showHoldIndicator(touch) {
    el["hold-indicator"].style.left = touch.clientX + "px";
    el["hold-indicator"].style.top = touch.clientY + "px";
    el["hold-indicator"].hidden = false;
  }

  function hideHoldIndicator() {
    el["hold-indicator"].hidden = true;
  }

  // Selection coordinates: (startIncl, endExcl) — end cell EXCLUDED, matching
  // xterm's getSelectionPosition().end.
  function dragSelect(term, startCol, startRow, endCol, endRow) {
    const flat = (col, row) => row * term.cols + col;
    const a = Math.max(0, flat(startCol, startRow));
    const b = Math.max(0, flat(endCol, endRow));
    const [from, to] = a <= b ? [a, b] : [b, a];
    const row = Math.floor(from / term.cols);
    term.select(from % term.cols, row, Math.max(1, to - from));
  }


  function selectLogicalLine(term, row) {
    let start = row;
    while (start > 0 && term.buffer.active.getLine(start)?.isWrapped) start--;
    let end = row;
    while (term.buffer.active.getLine(end + 1)?.isWrapped) end++;
    term.select(0, start, Math.max(1, (end - start + 1) * term.cols));
  }
  // One-finger handle drag: fixed edge stays stable even after the moving edge
  // crosses it and xterm normalizes the displayed selection.
  function reapplySelection(term, cell) {
    if (!handleDrag) return;
    const fixed = handleDrag.fixed;
    const args = handleDrag.movingEnd
      ? [fixed.x, fixed.y, cell.col + 1, cell.row]
      : [cell.col, cell.row, fixed.x, fixed.y];
    dragSelect(term, ...args);
    positionHandles(term);
  }

  function finishHandleDrag() {
    const term = getTerm?.();
    if (handleDrag && term) positionHandles(term);
    handleDrag = null;
  }

  // iOS-style selection handles: one-finger drags on either teardrop extend
  // or shrink the live selection. Handles alone suppress their events so the
  // surface never treats them as a new press or long-press.
  function wireHandle(handleEl) {
    handleEl.addEventListener("touchstart", (e) => {
      const term = getTerm?.();
      const pos = term?.getSelectionPosition?.();
      if (!pos) return;
      e.stopPropagation();
      e.preventDefault();
      const movingEnd = handleEl.id === "sel-handle-end";
      const fixed = movingEnd ? pos.start : pos.end;
      handleDrag = { movingEnd, fixed: { x: fixed.x, y: fixed.y } };
    }, { passive: false });
    handleEl.addEventListener("touchmove", (e) => {
      if (!handleDrag) return;
      e.preventDefault();
      const term = getTerm?.();
      if (!term) return;
      const cell = termCellFromTouch(term, e.touches[0]);
      if (!cell) return;
      reapplySelection(term, cell);
    }, { passive: false });
    handleEl.addEventListener("touchend", finishHandleDrag);
    handleEl.addEventListener("touchcancel", finishHandleDrag);
  }

  wireHandle(el["sel-handle-start"]);
  wireHandle(el["sel-handle-end"]);

  surface.addEventListener("touchstart", (e) => {
    if (e.target instanceof Element && e.target.closest(".scroll-scrubber")) return;
    const term = getTerm?.();
    if (!term?.element) return;
    clearTimeout(holdTimer);
    press = null;
    if (!el["copy-bar"].hidden || !el["sel-handles"].hidden) {
      hideCopyBar();
      hideHandles();
      term.clearSelection();
    }
    hideNotice();
    if (e.touches.length === 2) {
      const start = termCellFromTouch(term, e.touches[0]);
      if (!start) { endTouch(); return; }
      twoFinger = true;
      anchor = start;
      e.preventDefault();
      return;
    }
    if (e.touches.length !== 1) return;
    const cell = termCellFromTouch(term, e.touches[0]);
    if (!cell) return;
    e.preventDefault();
    press = { cell, x: e.touches[0].clientX, y: e.touches[0].clientY };
    showHoldIndicator(e.touches[0]);
    holdTimer = setTimeout(() => {
      if (press?.cell !== cell) return;
      hideHoldIndicator();
      const url = extractUrlAt(term, cell.col, cell.row);
      press = null;
      if (url) {
        navigator.vibrate?.(15);
        showLinkModal(url);
        return;
      }
      selectLogicalLine(term, cell.row);
      showCopyBar(async () => {
        const ok = await copySelectionNow(term.getSelection());
        if (ok) {
          term.clearSelection();
          navigator.vibrate?.(15);
        }
        return ok;
      }, () => term.clearSelection(), term);
    }, HOLD_MS);
  }, { passive: false });

  surface.addEventListener("touchmove", (e) => {
    if (e.target instanceof Element && e.target.closest(".scroll-scrubber")) return;
    const term = getTerm?.();
    if (!term?.element) return;
    if (e.touches.length === 1 && press) {
      const touch = e.touches[0];
      const dx = touch.clientX - press.x;
      const dy = touch.clientY - press.y;
      if (dx * dx + dy * dy > 144) {
        clearTimeout(holdTimer);
        press = null;
        hideHoldIndicator();
      }
    }
    if (twoFinger && e.touches.length === 2) {
      const head = termCellFromTouch(term, e.touches[1]);
      if (anchor && head) dragSelect(term, anchor.col, anchor.row, head.col + 1, head.row);
      e.preventDefault();
    }
  }, { passive: false });

  function endTouch() {
    clearTimeout(holdTimer);
    hideHoldIndicator();
    press = null;
    twoFinger = false;
    anchor = null;
    if (!handleDrag && el["copy-bar"].hidden) hideHandles();
  }

  // iOS Safari only honors async clipboard writes inside a live user gesture.
  // execCommand runs synchronously first; when it fails, writeText is invoked
  // synchronously from this click handler and its completion controls cleanup.
  async function copySelectionNow(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;";
    document.body.appendChild(ta);
    const selection = document.getSelection();
    const saved = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    ta.select();
    let copied = false;
    try { copied = document.execCommand("copy"); } catch {}
    document.body.removeChild(ta);
    if (saved && selection) { selection.removeAllRanges(); selection.addRange(saved); }
    if (copied) return true;
    if (!navigator.clipboard?.writeText) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  surface.addEventListener("touchend", (e) => {
    const term = getTerm?.();
    // iOS lifts fingers one at a time: finish a drag-copy only after the last
    // lift, otherwise preserve its anchor while one finger remains down.
    if (twoFinger && term && e.touches.length === 0) {
      if (term.hasSelection?.()) {
        showCopyBar(async () => {
          const ok = await copySelectionNow(term.getSelection());
          if (ok) {
            term.clearSelection();
            navigator.vibrate?.(15);
          }
          return ok;
        }, () => term.clearSelection(), term);
      } else {
        showNotice("Nothing selected");
      }
      endTouch();
    } else if (e.touches.length === 0) {
      endTouch();
    } else {
      clearTimeout(holdTimer);
      press = null;
    }
  });
  surface.addEventListener("touchcancel", endTouch);
}
