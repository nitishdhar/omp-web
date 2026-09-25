"use strict";
// Current native OMP profile model roles. The server exposes only this bounded,
// allowlisted projection of config.yml; provider credentials never reach here.

import { api } from "./api.js";
import { el, elem } from "./dom.js";
import { state, emit } from "./state.js";

function currentProfile() {
  const session = state.sessions.find((item) => item.id === state.current);
  return session && session.type !== "shell" ? (session.profile || "default") : "default";
}

function detailsFor(profile) {
  return (state.meta.profileDetails || []).find((item) => item.name === profile) || null;
}

function roleLabel(role) {
  return role ? role[0].toUpperCase() + role.slice(1) : "Role";
}

function render(profile = currentProfile()) {
  const details = detailsFor(profile);
  const roles = Array.isArray(details?.roles) ? details.roles : [];
  el["profile-info-title"].textContent = `${profile} profile`;
  el["profile-info-status"].textContent = roles.length ? `${roles.length} model roles` : "No model roles found";
  el["profile-info-grid"].replaceChildren(...roles.map((item) => {
    const identifier = item.provider ? `${item.provider}/${item.model}` : item.model;
    const effort = item.effort || "provider default";
    return elem("div", { class: "profile-role" },
      elem("span", { class: "profile-role-name" }, roleLabel(item.role)),
      elem("span", { class: "profile-role-model", title: identifier }, identifier),
      elem("span", { class: `profile-role-effort${item.effort ? "" : " is-default"}` }, effort),
    );
  }));
}

async function refresh() {
  try {
    const meta = await api("/meta");
    if (!Array.isArray(meta?.profiles) || !Array.isArray(meta?.profileDetails)) return;
    state.meta = meta;
    emit("meta:refreshed");
    render();
  } catch {
    // Cached metadata remains useful when a refresh fails.
  }
}

function close({ restoreFocus = false } = {}) {
  el["profile-info-popover"].hidden = true;
  el["profile-info-btn"].setAttribute("aria-expanded", "false");
  // The trigger lives inside a menu that is closed by now; the menu button is
  // the only focusable ancestor left on screen.
  if (restoreFocus) el["session-actions-toggle"].focus();
}

export function syncProfileInfo(profile) {
  if (el["profile-info-popover"] && !el["profile-info-popover"].hidden) render(profile);
}

export function wireProfileInfo() {
  el["profile-info-btn"].onclick = () => {
    const open = el["profile-info-popover"].hidden;
    el["usage-popover"].hidden = true;
    el["usage-btn"].setAttribute("aria-expanded", "false");
    el["profile-info-popover"].hidden = !open;
    el["profile-info-btn"].setAttribute("aria-expanded", String(open));
    if (open) {
      render();
      void refresh();
    }
  };
  document.addEventListener("click", (event) => {
    if (el["profile-info-popover"].hidden ||
        el["profile-info-popover"].contains(event.target) ||
        el["profile-info-btn"].contains(event.target)) return;
    close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el["profile-info-popover"].hidden) close({ restoreFocus: true });
  });
}
