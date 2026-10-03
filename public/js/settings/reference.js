"use strict";
// Read-only Settings sections painted from /api/meta: the status legend
// (General), Profiles and About.
//
// Profiles are read-only on purpose: they live in
// ~/.omp/profiles/<name>/agent/config.yml and native OMP owns them. A web
// console editing those files is how a config silently diverges from what OMP
// believes about itself. The Artifacts skill switch (skills.js) is the one
// exception, and it writes through `omp config set`, never the file.

import { el, elem } from "../dom.js";
import { state } from "../state.js";
import { statusLabel } from "../session-status.js";

function profileRows() {
  const details = state.meta?.profileDetails || [];
  if (!details.length) return [elem("p", { class: "set-note" }, "No profiles reported yet.")];
  return details.map((profile) => {
    const card = elem("div", { class: "set-profile", "data-profile": profile.name });
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

export function renderReference() {
  el["settings-profiles"]?.replaceChildren(...profileRows());
  el["settings-legend"]?.replaceChildren(...legendRows());
  el["settings-about"]?.replaceChildren(aboutRows());
}
