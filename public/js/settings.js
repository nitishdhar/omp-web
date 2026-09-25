"use strict";
// Settings sheet. Consolidates the preferences that were scattered across the
// header's overflow, and gives profile visibility a home.
//
// Profiles are read-only on purpose: they live in
// ~/.omp/profiles/<name>/agent/config.yml and native OMP owns them. A web
// console editing those files is how a config silently diverges from what OMP
// believes about itself. omp-web's own preferences (viewer folders) are
// editable because omp-web is their only owner.

import { el, elem } from "./dom.js";
import { state } from "./state.js";
import { statusLabel } from "./session-status.js";
import { loadPreviewRoots, wirePreviewRoots } from "./preview-roots.js";

let wired = false;

function profileRows() {
  const details = state.meta?.profileDetails || [];
  if (!details.length) return [elem("p", { class: "set-note" }, "No profiles reported yet.")];
  return details.map((profile) => {
    const card = elem("div", { class: "set-profile" });
    card.append(elem("div", { class: "set-profile-name" }, profile.name));
    const roles = profile.roles || [];
    if (!roles.length) {
      card.append(elem("div", { class: "set-note" }, "No roles configured."));
      return card;
    }
    const grid = elem("dl", { class: "set-roles" });
    for (const role of roles) {
      grid.append(elem("dt", {}, role.role || "default"));
      const value = [role.model, role.provider, role.effort ? `${role.effort} effort` : null]
        .filter(Boolean).join(" · ");
      grid.append(elem("dd", {}, value || "—"));
    }
    card.append(grid);
    return card;
  });
}

function aboutRows() {
  const version = document.querySelector('script[src*="/js/main.js"]')?.src.split("v=")[1] || "—";
  const rows = [
    ["Workspace", state.meta?.workspaceRoot || "—"],
    ["Sessions", String((state.sessions || []).length)],
    ["Profiles", String((state.meta?.profiles || []).length)],
    ["Folders", String((state.meta?.folders || []).length)],
    ["Frontend", version],
  ];
  const grid = elem("dl", { class: "set-roles" });
  for (const [label, value] of rows) {
    grid.append(elem("dt", {}, label), elem("dd", {}, value));
  }
  return grid;
}

// The dots carry real meaning (waiting blocks you; working is live) and every
// other surface uses them, so the app has to say what they are somewhere.
function legendRows() {
  const rows = ["waiting", "working", "done", "idle", "unknown"].map((status) => elem("div", {},
    elem("span", { class: `session-status-indicator dot status-${status}`, "aria-hidden": "true" }),
    elem("span", { text: statusLabel(status) }),
  ));
  rows.push(elem("div", {},
    elem("span", { class: "unread-dot", "aria-hidden": "true", text: "\u25cf" }),
    elem("span", { text: "New output since you last opened the session" }),
  ));
  return rows;
}

export function renderSettings() {
  const profiles = el["settings-profiles"];
  const about = el["settings-about"];
  const legend = el["settings-legend"];
  if (profiles) profiles.replaceChildren(...profileRows());
  if (legend) legend.replaceChildren(...legendRows());
  if (about) about.replaceChildren(aboutRows());
}

export function openSettings() {
  const host = el.settings;
  if (!host) return;
  renderSettings();
  void loadPreviewRoots();
  host.hidden = false;
  el["settings-close"]?.focus();
}

export function closeSettings() {
  const host = el.settings;
  if (host) host.hidden = true;
}

export function wireSettings() {
  if (wired) return;
  const host = el.settings;
  const open = el["settings-btn"];
  if (!host || !open) return;
  wired = true;
  open.onclick = () => openSettings();
  wirePreviewRoots();
  el["settings-close"].onclick = () => closeSettings();
  host.addEventListener("mousedown", (event) => {
    if (event.target === host) closeSettings();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !host.hidden) closeSettings();
  });
}
