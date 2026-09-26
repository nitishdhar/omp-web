"use strict";
// Single shared mutable store. Views read from here and emit events; modules
// never reach into each other's internals.

const listeners = new Map(); // event -> Set<fn>

export const state = {
  token: "",
  meta: { profiles: [], profileDetails: [], folders: [], workspaceRoot: "", attachmentsRoot: "" },
  sessions: [],
  // Dead sessions restorable after a restart (registry/transcript backed).
  // Separate from `sessions` on purpose: ghosts never carry a lifecycle
  // status, and views filter them by membership here, never by a status value.
  restorable: [],
  selectedGhost: null, // ghost id with its detail view open in the main pane
  current: null, // active session id
  sockets: new Map(), // id -> ws (only current kept open)
  selectedFolder: "",
  // Chat is the primary surface for agent sessions; Terminal is the
  // full-fidelity escape hatch. Only an explicit preference selects it.
  mode: localStorage.getItem("omp_web_mode") === "terminal" ? "terminal" : "chat",
};

// Persist UI state that should survive a refresh. Session id is saved on
// change and restored on boot (only if the session still exists).
export function setCurrent(id) {
  state.current = id;
  try {
    if (id) localStorage.setItem("omp_web_current", id);
    else localStorage.removeItem("omp_web_current");
  } catch {}
}

export function setMode(m) {
  state.mode = m;
  try { localStorage.setItem("omp_web_mode", m); } catch {}
}

export function get(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (set) for (const fn of set) fn(payload);
}