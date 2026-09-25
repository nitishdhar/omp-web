"use strict";
// Path abbreviation for display. `~` means $HOME and nothing else: abbreviating
// the workspace root to `~` printed paths that do not exist (`~/omp-web` for
// `$HOME/workspace/omp-web`), which is worse than showing the full path.

import { state } from "./state.js";

/** Full path with only $HOME collapsed. Always a real, pasteable path. */
export function tildePath(full) {
  const path = String(full || "");
  const home = state.meta?.homeDir;
  if (!home || !(path === home || path.startsWith(home + "/"))) return path;
  return "~" + path.slice(home.length);
}

/**
 * Compact label for a project folder: its path relative to the workspace root,
 * which is the part that actually distinguishes one session from another.
 * Falls back to the $HOME-collapsed absolute path when outside the workspace.
 */
export function workspaceRelative(full) {
  const path = String(full || "");
  const root = state.meta?.workspaceRoot;
  if (!path) return "";
  if (root && path === root) return "workspace";
  if (root && path.startsWith(root + "/")) return path.slice(root.length + 1);
  // Extra roots (e.g. ~/private) read as "<root name>/<folder>", the same label
  // the folder picker and sidebar use.
  for (const extra of state.meta?.extraRoots || []) {
    const name = extra.slice(extra.lastIndexOf("/") + 1);
    if (path === extra) return name;
    if (path.startsWith(extra + "/")) return `${name}/${path.slice(extra.length + 1)}`;
  }
  return tildePath(path);
}
