"use strict";
// Agents name a document the way a person would — `action-docket.md` — rather
// than by its path from the session folder. Resolution used to stop at the
// folder's top level, so a file one directory down was a dead link while its
// sibling at the top opened: the "sometimes it opens" bug. This finds the one
// file under a root whose path ends with the requested relative path.
//
// Async readdir on purpose: this process also streams every terminal, and a
// synchronous walk of a workspace-sized tree blocks it for half a second.
const fs = require("fs");
const path = require("path");

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "venv", "__pycache__"]);
const MAX_DEPTH = 8;
// Every session folder measured was under 600 files; a session rooted at the
// whole workspace is ~85k. The cap bounds that case instead of guessing in it.
const MAX_FILES = 25_000;

/**
 * @returns {{ matches: string[], complete: boolean }} At most two matches (two
 * already proves ambiguity). `complete` is false when the cap stopped the walk,
 * in which case a single match is not proof of uniqueness.
 */
async function findBySuffix(root, relativePath) {
  const segments = String(relativePath).split(/[\\/]+/).filter((s) => s && s !== ".");
  if (!segments.length || segments.includes("..")) return { matches: [], complete: true };
  const suffix = path.sep + segments.join(path.sep);
  const matches = [];
  let files = 0;
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      // Dirent reports a symlink as neither directory nor file, so links are
      // never followed; the caller's realpath containment check still runs.
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) stack.push([full, depth + 1]);
        continue;
      }
      if (!entry.isFile()) continue;
      if (++files > MAX_FILES) return { matches, complete: false };
      if (!full.endsWith(suffix)) continue;
      matches.push(full);
      if (matches.length > 1) return { matches, complete: true };
    }
  }
  return { matches, complete: true };
}

module.exports = { findBySuffix };
