"use strict";
// Session creation shared by the modal and the landing composer. The composer
// path has no dialog, so it has to derive folder, profile and name itself.

import { state } from "./state.js";
import { api } from "./api.js";

// Last accepted agent choice, so the next session opens on the folder and
// profile you actually use. Shell-only is deliberately never remembered: it
// is a one-off escape hatch and defaulting to it would silently create a
// session with no agent.
const LAST_CHOICE_KEY = "omp_web_new_session";

export function lastChoice() {
  try { return JSON.parse(localStorage.getItem(LAST_CHOICE_KEY) || "{}") || {}; }
  catch { return {}; }
}

export function rememberChoice(folder, profile) {
  if (!profile) return;
  try { localStorage.setItem(LAST_CHOICE_KEY, JSON.stringify({ folder, profile })); } catch {}
}

export function selectFolder(selected) {
  const folders = [{ name: "Workspace", path: state.meta.workspaceRoot }, ...state.meta.folders];
  return folders.some((f) => f.path === selected) ? selected : state.meta.workspaceRoot;
}

export function defaultChoice() {
  const remembered = lastChoice();
  const profiles = state.meta.profiles || [];
  return {
    folder: selectFolder(remembered.folder || state.selectedFolder || state.meta.workspaceRoot),
    profile: profiles.includes(remembered.profile)
      ? remembered.profile
      : (profiles.includes("default") ? "default" : profiles[0] || "default"),
  };
}

// tmux session names are derived server-side from this, so strip the markdown
// a prompt usually opens with rather than encoding it into an id.
export function sessionNameFrom(text) {
  const first = String(text || "").split("\n").find((line) => line.trim());
  const name = (first || "")
    .replace(/[`*_#>\[\]()]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ")
    .slice(0, 40)
    .trim();
  return name || "New session";
}

export async function requestSession({ name, folder, profile, type = "agent", noTitle } = {}) {
  const { session } = await api("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      folder,
      type,
      profile: type === "shell" ? undefined : profile,
      noTitle: noTitle === true,
    }),
  });
  return session;
}
