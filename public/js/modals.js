"use strict";
// New-session and reload-profile modals.

import { state, emit } from "./state.js";
import { el } from "./dom.js";
import { api } from "./api.js";
import { escapeHtml } from "./dom.js";
import { lastChoice, rememberChoice, requestSession, selectFolder } from "./new-session.js";

function folderOptions() {
  const folders = [{ name: "Workspace", path: state.meta.workspaceRoot }, ...state.meta.folders];
  return folders.map((f) =>
    `<option value="${escapeHtml(f.path)}">${escapeHtml(f.name)}</option>`).join("");
}



function profileOptions(includeShell = false) {
  const options = state.meta.profiles
    .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`);
  if (includeShell) {
    options.push('<option value="" data-session-type="shell">Shell only (no OMP)</option>');
  }
  return options.join("");
}

function defaultRole(profile) {
  const details = (state.meta.profileDetails || []).find((item) => item.name === profile);
  return details?.roles?.find((item) => item.role === "default") || null;
}

function paintProfileSummary(selectId, summaryId) {
  const selected = el[selectId].selectedOptions[0];
  const summary = el[summaryId];
  if (!selected || selected.dataset.sessionType === "shell") {
    summary.textContent = "No OMP model configuration";
    return;
  }
  const role = defaultRole(selected.value);
  if (!role) {
    summary.textContent = "Default model configuration unavailable";
    return;
  }
  const model = role.provider ? `${role.provider}/${role.model}` : role.model;
  summary.textContent = `${model} · ${role.effort ? `${role.effort} effort` : "provider default effort"}`;
}

// A tab can stay open for days while an agent adds a profile or a project
// directory appears, and boot-time meta would never show either. Paint from
// cache so the picker opens instantly, then reconcile against the server and
// repaint the still-open dialog without losing the current selection.
async function refreshPickers(repaint) {
  let meta;
  try {
    meta = await api("/meta");
  } catch {
    return;
  }
  if (!Array.isArray(meta?.profiles) || !meta.profiles.length) return;
  state.meta = meta;
  emit("meta:refreshed");
  repaint();
}



export function openModal(folder) {
  const current = state.sessions.find((session) => session.id === state.current);
  const remembered = lastChoice();
  // Explicit "New session here" wins, then the live session's own folder
  // (clone-from-context), then the last accepted choice.
  const want = folder
    || (current && current.folder)
    || remembered.folder
    || state.selectedFolder
    || state.meta.workspaceRoot;
  const wantProfile = (current && current.type !== "shell" && current.profile)
    || remembered.profile
    || "";
  const paint = () => {
    const profile = el["f-profile"].value;
    const shellOnly = el["f-profile"].selectedOptions[0]?.dataset.sessionType === "shell";
    const chosen = el["f-folder"].value || want;
    el["f-folder"].innerHTML = folderOptions();
    el["f-folder"].value = selectFolder(chosen);
    el["f-profile"].innerHTML = profileOptions(true);
    if (shellOnly) {
      el["f-profile"].querySelector('[data-session-type="shell"]').selected = true;
    } else if (profile && state.meta.profiles.includes(profile)) {
      el["f-profile"].value = profile;
    } else if (wantProfile && state.meta.profiles.includes(wantProfile)) {
      el["f-profile"].value = wantProfile;
    }
    paintProfileSummary("f-profile", "f-profile-summary");
  };
  el["f-folder"].value = "";
  el["f-profile"].value = "";
  paint();
  el["f-name"].value = "";
  el["m-error"].hidden = true;
  el.modal.hidden = false;
  el["f-name"].focus();
  el["f-profile"].onchange = () => paintProfileSummary("f-profile", "f-profile-summary");
  refreshPickers(() => { if (!el.modal.hidden) paint(); });
}

export function closeModal() { el.modal.hidden = true; }

export async function createSession({ onCreated }) {
  const name = el["f-name"].value.trim();
  if (!name) { el["m-error"].textContent = "Name is required"; el["m-error"].hidden = false; return; }
  const selectedProfile = el["f-profile"].selectedOptions[0];
  const shellOnly = selectedProfile?.dataset.sessionType === "shell";
  const folder = el["f-folder"].value;
  try {
    const session = await requestSession({
      name,
      folder,
      type: shellOnly ? "shell" : "agent",
      profile: selectedProfile?.value,
    });
    closeModal();
    rememberChoice(folder, shellOnly ? "" : selectedProfile?.value);
    onCreated(session);
  } catch (e) {
    el["m-error"].textContent = e.message; el["m-error"].hidden = false;
  }
}

// ---- Reload under profile ----

export function openReloadModal(sessionId, sessions) {
  const s = sessions.find((item) => item.id === sessionId);
  if (!s && !sessionId) return;
  const paint = () => {
    const want = el["r-profile"].value || s?.profile;
    el["r-profile"].innerHTML = profileOptions();
    el["r-profile"].value = state.meta.profiles.includes(want) ? want : state.meta.profiles[0];
    paintProfileSummary("r-profile", "r-profile-summary");
  };
  el["r-profile"].value = "";
  paint();
  el["r-model"].value = "";
  el["r-error"].hidden = true;
  el["reload-modal"].hidden = false;
  el["r-profile"].dataset.sessionId = sessionId;
  el["r-profile"].focus();
  el["r-profile"].onchange = () => paintProfileSummary("r-profile", "r-profile-summary");
  refreshPickers(() => { if (!el["reload-modal"].hidden) paint(); });
}

export function closeReloadModal() { el["reload-modal"].hidden = true; }

export async function doReloadProfile({ onReloaded }) {
  const id = el["r-profile"].dataset.sessionId;
  if (!id) return;
  const profile = el["r-profile"].value;
  const model = el["r-model"].value.trim();
  try {
    const { session } = await api(`/sessions/${encodeURIComponent(id)}/profile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile, model: model || undefined }),
    });
    closeReloadModal();
    onReloaded(session);
  } catch (e) {
    el["r-error"].textContent = e.message;
    el["r-error"].hidden = false;
  }
}