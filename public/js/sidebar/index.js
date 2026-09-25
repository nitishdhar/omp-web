"use strict";
// Sidebar chrome: header (brand, view toggle), list host, footer.

import { emit, state } from "../state.js";
import { el, elem } from "../dom.js";
import * as projects from "./projects.js";
import { rowProjection } from "./rows.js";
import { wireSidebarResize } from "./resize.js";

let searchQuery = "";
let searchWired = false;

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

  // The Projects/Recent tabs are retired: one ranked list serves both jobs, so
  // a mode switch only split attention. The element stays in the markup as an
  // id-stable host and collapses to nothing while empty.
  toggle.replaceChildren();
}