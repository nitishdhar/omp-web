"use strict";
// Artifacts page: a main-area view (#artifacts-mode) beside the panel, ghost
// and Settings views. main.js owns opening and leaving it (session parking is
// its job) and sets state.openArtifact; this module paints the gallery or the
// viewer and keeps the list fresh while the page is on screen.

import { el } from "../dom.js";
import { state, emit } from "../state.js";
import { showNotice } from "../notice.js";
import { loadArtifacts, renderArtifactsNav, renderGallery } from "./gallery.js";
import { hideViewer, pruneFrames, showViewer, wireViewer } from "./viewer.js";

export { loadArtifacts } from "./gallery.js";

const POLL_MS = 30_000;
let pollTimer = null;
let wired = false;

export function findArtifact(slug) {
  return state.artifacts.find((a) => a.slug === slug) || null;
}

function paint() {
  renderGallery();
  renderArtifactsNav();
  const artifact = state.openArtifact ? findArtifact(state.openArtifact) : null;
  if (artifact) showViewer(artifact);
  else hideViewer();
}

async function sync() {
  await loadArtifacts();
  if (!state.artifactsOpen) return;
  pruneFrames(state.artifacts);
  if (state.openArtifact && !findArtifact(state.openArtifact)) {
    showNotice("That artifact no longer exists", { tone: "error" });
    emit("artifacts:open", null);
    return;
  }
  paint();
}

export function showArtifacts() {
  if (!el["artifacts-mode"]) return false;
  el["artifacts-mode"].hidden = false;
  el.main.classList.add("artifacts-active");
  paint();
  // The gallery is the place to notice new work; the viewer already shows
  // its own artifact live, so only a gallery visit refetches up front.
  if (!state.openArtifact) void sync();
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      if (document.visibilityState !== "hidden") void sync();
    }, POLL_MS);
  }
  return true;
}

export function hideArtifacts() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (el["artifacts-mode"]) el["artifacts-mode"].hidden = true;
  el.main.classList.remove("artifacts-active");
  renderArtifactsNav();
}

export function wireArtifacts() {
  if (wired || !el["artifacts-btn"] || !el["artifacts-mode"]) return;
  wired = true;
  el["artifacts-btn"].onclick = () => emit("artifacts:open", null);
  el["artifact-back"].onclick = () => emit("artifacts:open", null);
  el["artifacts-empty-settings"].onclick = () => emit("settings:open", "profiles");
  wireViewer();
}
