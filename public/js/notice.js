"use strict";
// The one transient-feedback surface. Reuses #copy-flash, which predates it and
// is still named for its first caller.

import { el } from "./dom.js";

const FADE_MS = 220;
let flashTimer;

export function showNotice(text, { tone = "info", duration } = {}) {
  const node = el["copy-flash"];
  node.textContent = text;
  node.classList.toggle("error", tone === "error");
  node.hidden = false;
  node.style.opacity = "1";
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    node.style.opacity = "0";
    flashTimer = setTimeout(() => { node.hidden = true; }, FADE_MS);
  }, duration ?? (tone === "error" ? 3200 : 1400));
}

export function hideNotice() {
  clearTimeout(flashTimer);
  el["copy-flash"].hidden = true;
  el["copy-flash"].style.opacity = "";
}

export async function copyWithNotice(text, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    showNotice(label);
    return true;
  } catch {
    showNotice("Copy failed — clipboard access was denied", { tone: "error" });
    return false;
  }
}
