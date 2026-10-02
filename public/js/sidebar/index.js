"use strict";
// Sidebar chrome: header (brand, view toggle), list host, footer.

import { emit, state } from "../state.js";
import { el, elem } from "../dom.js";
import * as projects from "./projects.js";
import { rowProjection, startInlineRename } from "./rows.js";
import { wireSidebarResize } from "./resize.js";

let searchQuery = "";
let searchWired = false;
let railWired = false;

// Next midnight boundary, for main.js bucket-rollover scheduling. Moved
// verbatim from the retired sidebar/activity.js (Recent view).
export function nextActivityBoundaryAt(now) {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime();
}

export function renderKey(sessions) {
  // Every section now sorts by a stable key, so a session's `lastActivity`
  // bumping no longer changes row order — leaving it in the key only forced
  // repaints that yank rows out from under a tap.
  const painted = sessions
    .map(rowProjection)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify([painted, state.restorable, state.selectedGhost]);
}

// Renders whichever view is active. Exposed for main.js polling.
export function render(sessions, { onOpen } = {}) {
  const host = el["session-list"];
  if (searchQuery.trim()) {
    projects.renderSearch(host, sessions, { onOpen, query: searchQuery, ghosts: state.restorable });
  } else {
    projects.render(host, sessions, { onOpen, ghosts: state.restorable });
  }
  // Every render reinserts rows, which restarts the entrance animation. Retire
  // it after the first paint so a status change never replays the stagger.
  host.classList.add("settled");
}

// Wires search and the text view tabs once.
export function init() {
  wireSidebarResize();
  const toggle = document.querySelector("#sidebar .view-toggle");
  if (!toggle) return;

  const search = el["session-search"] || document.getElementById("session-search");
  if (search && !searchWired) {
    searchWired = true;
    searchQuery = search.value;
    search.addEventListener("input", () => {
      searchQuery = search.value;
      emit("sidebar:rerender");
    });
    search.addEventListener("keydown", (e) => {
      // Enter opens the first live result in rendered DOM order — the rail's
      // answer to the query, never a hidden sort. Ghost rows are skipped:
      // they preview, they don't open.
      if (e.key === "Enter") {
        const first = el["session-list"]?.querySelector(".sess:not(.ghost) .sess-open");
        if (first) {
          e.preventDefault();
          first.click();
        }
        return;
      }
      if (e.key !== "Escape" || !search.value) return;
      e.preventDefault();
      search.value = "";
      searchQuery = "";
      emit("sidebar:rerender");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.closest?.("input, textarea, select, [contenteditable='true'], .xterm")) return;
      el.sidebar?.classList.remove("hidden");
      e.preventDefault();
      search.focus();
      search.select();
    });
  }

  const list = el["session-list"];
  if (list && !railWired) {
    railWired = true;
    list.addEventListener("keydown", onRailKeydown);
  }

  // The Projects/Recent tabs are retired: one ranked list serves both jobs, so
  // a mode switch only split attention. The element stays in the markup as an
  // id-stable host and collapses to nothing while empty.
  toggle.replaceChildren();
}

// Roving focus for the rail: Up/Down/Home/End move across every rendered row
// and folder control, Left/Right collapse/expand on a folder chevron, F2
// renames the focused live row. Enter stays native — buttons activate
// themselves — and the rename input owns every key while it is open.
function onRailKeydown(e) {
  if (e.target.closest?.(".rename-input")) return;
  if (e.key === "F2") {
    const li = e.target.closest?.("li.sess");
    if (li && !li.classList.contains("ghost")) {
      const session = (state.sessions || []).find((s) => s.id === li.dataset.sessionId);
      if (session) {
        e.preventDefault();
        startInlineRename(li, session);
      }
    }
    return;
  }
  const controls = [...el["session-list"].querySelectorAll("button")];
  const at = controls.indexOf(e.target.closest?.("button"));
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (at === -1) return;
    e.preventDefault();
    const next = e.key === "ArrowDown" ? controls[at + 1] : controls[at - 1];
    (next || controls[at]).focus();
    return;
  }
  if (e.key === "Home" || e.key === "End") {
    if (at === -1 || !controls.length) return;
    e.preventDefault();
    controls[e.key === "Home" ? 0 : controls.length - 1].focus();
    return;
  }
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    const toggle = e.target.closest?.(".folder-collapse");
    if (!toggle) return;
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    if ((e.key === "ArrowRight" && !expanded) || (e.key === "ArrowLeft" && expanded)) {
      e.preventDefault();
      toggle.click();
    }
  }
}