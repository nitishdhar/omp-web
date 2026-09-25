"use strict";
// Command palette. The keyboard grammar was invisible in a tool whose users
// live in a terminal, and a flat list stops working somewhere before 37
// sessions across 49 folders. This is the escape hatch for both: everything
// reachable by name, without the mouse.

import { el, elem } from "./dom.js";
import { emit, state } from "./state.js";
import { workspaceRelative } from "./paths.js";

const MAX_RESULTS = 12;
let open = false;
let active = 0;
let entries = [];

// Subsequence match, not substring: "owm" finds "Omp Web Main" the way a
// terminal user expects, and the score prefers earlier, tighter runs.
function score(haystack, needle) {
  if (!needle) return 0;
  const hay = haystack.toLowerCase();
  const term = needle.toLowerCase();
  let index = 0;
  let first = -1;
  let gaps = 0;
  let last = -1;
  for (const ch of term) {
    index = hay.indexOf(ch, index);
    if (index === -1) return null;
    if (first === -1) first = index;
    if (last !== -1 && index > last + 1) gaps += index - last - 1;
    last = index;
    index += 1;
  }
  return first + gaps;
}

function sessionEntries() {
  return (state.sessions || []).map((session) => ({
    kind: "session",
    id: session.id,
    label: session.title || session.id,
    hint: [folderLabel(session.folder), session.profile || session.type].filter(Boolean).join(" · "),
    status: session.status || "unknown",
    run: () => emit("session:open", session.id),
  }));
}

const folderLabel = (folder) => workspaceRelative(folder);

function commandEntries() {
  const current = (state.sessions || []).find((session) => session.id === state.current);
  const list = [{
    kind: "command",
    label: "New session",
    hint: "create in a folder",
    run: () => emit("session:newInFolder", state.selectedFolder || state.meta?.workspaceRoot),
  }];
  if (current) {
    list.push({
      kind: "command",
      label: "Reload under another profile",
      hint: current.title,
      run: () => emit("session:reloadRequest", current.id),
    }, {
      kind: "command",
      // The palette never kills without the existing confirmation path.
      label: "Kill session",
      hint: current.title,
      danger: true,
      run: () => emit("session:kill", current.id),
    });
    if (current.type !== "shell") {
      list.push({
        kind: "command",
        label: "Switch mode",
        hint: "terminal / chat",
        run: () => emit("mode:change", state.mode === "chat" ? "terminal" : "chat"),
      });
    }
  }
  return list;
}

function build(query) {
  const all = [...sessionEntries(), ...commandEntries()];
  if (!query.trim()) return all.slice(0, MAX_RESULTS);
  return all
    .map((entry) => ({ entry, rank: score(`${entry.label} ${entry.hint}`, query.trim()) }))
    .filter((row) => row.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_RESULTS)
    .map((row) => row.entry);
}

function render(query) {
  const list = el["palette-results"];
  if (!list) return;
  entries = build(query);
  if (active >= entries.length) active = Math.max(0, entries.length - 1);
  list.replaceChildren();
  if (!entries.length) {
    list.append(elem("li", { class: "pal-empty" }, "No matches"));
    return;
  }
  entries.forEach((entry, index) => {
    const row = elem("li", {
      class: `pal-row${index === active ? " is-active" : ""}${entry.danger ? " pal-danger" : ""}`,
      role: "option",
      "aria-selected": String(index === active),
      onclick: () => choose(index),
      onmousemove: () => {
        if (active === index) return;
        active = index;
        render(query);
      },
    });
    if (entry.kind === "session") {
      row.append(elem("span", { class: `dot status-${entry.status}`, "aria-hidden": "true" }));
    } else {
      row.append(elem("span", { class: "pal-glyph", "aria-hidden": "true" }, "›"));
    }
    row.append(elem("span", { class: "pal-label" }, entry.label));
    if (entry.hint) row.append(elem("span", { class: "pal-hint" }, entry.hint));
    list.append(row);
  });
}

function choose(index) {
  const entry = entries[index];
  close();
  entry?.run();
}

export function openPalette() {
  const host = el.palette;
  const input = el["palette-input"];
  if (!host || !input || open) return;
  open = true;
  active = 0;
  host.hidden = false;
  input.value = "";
  render("");
  input.focus();
}

export function close() {
  const host = el.palette;
  if (!host || !open) return;
  open = false;
  host.hidden = true;
}

export function wirePalette() {
  const host = el.palette;
  const input = el["palette-input"];
  if (!host || !input) return;

  input.addEventListener("input", () => { active = 0; render(input.value); });
  host.addEventListener("mousedown", (event) => {
    if (event.target === host) close();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      active = entries.length ? (active + 1) % entries.length : 0;
      render(input.value);
    } else if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      active = entries.length ? (active - 1 + entries.length) % entries.length : 0;
      render(input.value);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(active);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "k" || !(event.metaKey || event.ctrlKey)) return;
    // Deliberately works from inside the terminal too: the palette is the one
    // global affordance, and xterm would otherwise swallow the chord.
    event.preventDefault();
    if (open) close(); else openPalette();
  });
}
