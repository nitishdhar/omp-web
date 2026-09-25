"use strict";
// Desktop-only column resize. Session titles are long and folder paths longer;
// a fixed column truncated both. Width persists so it survives a reload.

import { el, elem } from "../dom.js";

const KEY = "omp_web_sidebar_width";
const MIN = 240;
const MAX = 480;
const STEP = 16;

const clamp = (px) => Math.min(MAX, Math.max(MIN, Math.round(px)));

function apply(px) {
  el.sidebar.style.setProperty("--sidebar-w", `${px}px`);
}

function store(px) {
  try { localStorage.setItem(KEY, String(px)); } catch {}
}

function currentWidth() {
  return el.sidebar.getBoundingClientRect().width;
}

export function wireSidebarResize() {
  const stored = (() => { try { return Number(localStorage.getItem(KEY)); } catch { return 0; } })();
  if (stored) apply(clamp(stored));

  const handle = elem("div", {
    id: "sidebar-resize",
    class: "sidebar-resize",
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize sidebar",
    tabindex: "0",
    title: "Drag to resize · double-click to reset",
  });

  let dragging = false;
  handle.addEventListener("pointerdown", (event) => {
    dragging = true;
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    apply(clamp(event.clientX - el.sidebar.getBoundingClientRect().left));
  });
  handle.addEventListener("pointerup", (event) => {
    if (!dragging) return;
    dragging = false;
    handle.releasePointerCapture(event.pointerId);
    store(clamp(currentWidth()));
  });
  handle.addEventListener("dblclick", () => {
    el.sidebar.style.removeProperty("--sidebar-w");
    try { localStorage.removeItem(KEY); } catch {}
  });
  handle.addEventListener("keydown", (event) => {
    const delta = event.key === "ArrowLeft" ? -STEP : event.key === "ArrowRight" ? STEP : 0;
    if (!delta) return;
    event.preventDefault();
    const next = clamp(currentWidth() + delta);
    apply(next);
    store(next);
  });

  el.sidebar.append(handle);
  el["sidebar-resize"] = handle;
}
