"use strict";
// Ghost detail view: the main-pane surface for a dead (restorable) session.
// Clicking a ghost row selects it here instead of a cramped inline button —
// the full folder path, type/profile, and history source are visible, so the
// restore decision has room. Main.js owns when to show/hide; this module only
// paints the skeleton (static markup from index.html when present).

import { el, elem } from "./dom.js";
import { state } from "./state.js";
import { workspaceRelative } from "./paths.js";

// The skeleton normally comes from index.html (registered in initDom), but a
// tab holding a cached older shell lacks those nodes while running newer
// modules — clicks then run against missing DOM and the pane stays blank.
// Build the skeleton on demand so preview never depends on the shell version.
// Runs before main.js wires the action buttons, so those assignments stay safe.
export function ensureSkeleton() {
  if (el["ghost-mode"] && el["ghost-title"] && el["ghost-summary"] && el["ghost-meta"]
      && el["ghost-back-btn"] && el["ghost-restore-btn"] && el["ghost-copy-btn"] && el["ghost-forget-btn"]) return;
  const host = document.querySelector(".content-host");
  if (!host) return;
  if (el["ghost-mode"] && !el["ghost-back-btn"]) {
    // Shell predates the Back control but has the rest: append it in place so
    // the main.js wiring always has a target.
    const actions = el["ghost-mode"].querySelector(".ghost-actions");
    if (actions) {
      const back = elem("button", { id: "ghost-back-btn", class: "ghost", type: "button", text: "Back", title: "Back to the live session" });
      actions.prepend(back);
      el["ghost-back-btn"] = back;
    }
    return;
  }
  // Present but incomplete in an unexpected way: never build a second skeleton.
  if (el["ghost-mode"]) return;
  const section = elem("section", { id: "ghost-mode", "aria-labelledby": "ghost-title", hidden: true });
  section.append(elem("p", { class: "ghost-kicker", text: "Not running" }));
  section.append(elem("h1", { id: "ghost-title", text: "Session" }));
  section.append(elem("p", { id: "ghost-summary", class: "ghost-summary" }));
  section.append(elem("dl", { id: "ghost-meta", class: "ghost-meta" }));
  const actions = elem("div", { class: "ghost-actions" });
  actions.append(elem("button", { id: "ghost-back-btn", class: "ghost", type: "button", text: "Back", title: "Back to the live session" }));
  actions.append(elem("button", { id: "ghost-restore-btn", class: "primary", type: "button", text: "Restore session" }));
  actions.append(elem("button", { id: "ghost-copy-btn", class: "ghost", type: "button", text: "Copy folder path" }));
  actions.append(elem("button", { id: "ghost-forget-btn", class: "danger ghost", type: "button", text: "Forget" }));
  section.append(actions);
  host.append(section);
  el["ghost-mode"] = section;
  for (const id of ["ghost-title", "ghost-summary", "ghost-meta",
    "ghost-back-btn", "ghost-restore-btn", "ghost-copy-btn", "ghost-forget-btn"]) {
    const node = section.querySelector(`#${CSS.escape(id)}`);
    if (node) el[id] = node;
  }
}

function fmtDate(ms) {
  const t = Number(ms) || 0;
  if (!t) return "—";
  try {
    return new Date(t).toLocaleString(undefined, {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return "—"; }
}

function fmtAgo(ms) {
  const t = Number(ms) || 0;
  if (!t) return "unknown";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function selectedGhost() {
  if (!state.selectedGhost) return null;
  return state.restorable.find((g) => g.id === state.selectedGhost) || null;
}

function metaRow(term, value, title) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (title) dd.title = title;
  return [dt, dd];
}

// Fill the skeleton; returns false when the ghost is gone (caller clears).
export function showGhost(ghost) {
  if (!ghost || !el["ghost-mode"]) return false;
  el["ghost-title"].textContent = ghost.title || ghost.id;
  // Not "ended with its tmux server": sessions also end when their OMP exits
  // or something kills the tmux session, and the detail cannot tell which.
  const moved = ghost.folderMissing && ghost.relocatedFolder;
  el["ghost-summary"].textContent = ghost.folderMissing
    ? (moved
      ? `This session is no longer running, and its folder is gone. A folder with the same name exists at ${workspaceRelative(ghost.relocatedFolder)}; restoring reopens it there with its saved transcript history.`
      : "This session is no longer running, and its folder no longer exists, so it cannot be restored. Its transcript is kept.")
    : ghost.type === "shell"
      ? "This shell session is no longer running. Restoring reopens it in the same folder."
      : "This session is no longer running. Restoring reopens it with its saved transcript history.";
  const restoreBtn = el["ghost-restore-btn"];
  restoreBtn.disabled = Boolean(ghost.folderMissing && !moved);
  restoreBtn.textContent = moved ? `Restore in ${workspaceRelative(ghost.relocatedFolder)}` : "Restore session";
  const meta = el["ghost-meta"];
  meta.replaceChildren();
  const typeLabel = ghost.type === "shell" ? "shell" : `agent · ${ghost.profile || "default"}`;
  const sourceLabel = ghost.source === "transcript"
    ? "Recovered from transcript"
    : "Saved session list";
  const lastMs = Number(ghost.lastActivity) > 1e12
    ? Number(ghost.lastActivity)
    : Number(ghost.lastActivity) * 1000;
  for (const [term, value, title] of [
    ["Folder", ghost.folder ? ghost.folder + (ghost.folderMissing ? " (no longer exists)" : "") : "—", ghost.folder || ""],
    ...(moved ? [["Moved to", ghost.relocatedFolder, ghost.relocatedFolder]] : []),
    ["Type", typeLabel, ""],
    ["Found via", sourceLabel, ""],
    ["Last activity", `${fmtAgo(lastMs)} · ${fmtDate(lastMs)}`, ""],
    ["Created", fmtDate(Number(ghost.created)), ""],
  ]) {
    for (const node of metaRow(term, value, title)) meta.append(node);
  }
  if (ghost.pinned) {
    for (const node of metaRow("Pinned", "Yes", "")) meta.append(node);
  }
  el["ghost-mode"].hidden = false;
  el.main.classList.add("ghost-active");
  return true;
}

export function hideGhost() {
  if (el["ghost-mode"]) el["ghost-mode"].hidden = true;
  el.main.classList.remove("ghost-active");
}
