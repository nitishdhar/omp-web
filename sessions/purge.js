"use strict";
// On-disk data a session owns: its transcript directory under sessionsDir
// (every profile's JSONL, written via --session-dir) and its private upload
// directory under attachmentsDir. Both are named by the session id. Nothing
// outside those two directories is ever touched, and symlinks are removed as
// links, never followed.

const fs = require("fs");
const path = require("path");
const config = require("../config");

const SESSION_ID = /^[A-Za-z0-9_-]{1,40}$/;

function dataDirs(id) {
  if (typeof id !== "string" || !SESSION_ID.test(id)) {
    const error = new Error("invalid session id");
    error.code = "EBADID";
    throw error;
  }
  return [
    { kind: "transcripts", path: path.join(config.sessionsDir, id) },
    { kind: "attachments", path: path.join(config.attachmentsDir, id) },
  ];
}

// Bounded walk: lstat only, so a link inside counts as the link itself.
function measure(target) {
  let bytes = 0;
  let files = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    let stat;
    try { stat = fs.lstatSync(current); } catch { continue; }
    if (stat.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(current); } catch { continue; }
      for (const name of names) stack.push(path.join(current, name));
    } else {
      bytes += stat.size;
      files += 1;
    }
  }
  return { bytes, files };
}

/** What Delete would remove, per directory. */
function footprint(id) {
  const parts = [];
  for (const dir of dataDirs(id)) {
    if (!fs.existsSync(dir.path) && !isLink(dir.path)) continue;
    parts.push({ kind: dir.kind, ...measure(dir.path) });
  }
  return {
    bytes: parts.reduce((sum, part) => sum + part.bytes, 0),
    files: parts.reduce((sum, part) => sum + part.files, 0),
    parts,
  };
}

function isLink(target) {
  try { return fs.lstatSync(target).isSymbolicLink(); } catch { return false; }
}

/** Remove both data directories; returns what was freed. */
function removeData(id) {
  const freed = footprint(id);
  for (const dir of dataDirs(id)) {
    if (isLink(dir.path)) fs.unlinkSync(dir.path);
    else fs.rmSync(dir.path, { recursive: true, force: true });
  }
  return freed;
}

/** Every session-named entry in the two data roots. */
function dataDirNames() {
  const names = [];
  for (const root of [config.sessionsDir, config.attachmentsDir]) {
    try { names.push(...fs.readdirSync(root).filter((name) => SESSION_ID.test(name))); } catch {}
  }
  return names;
}

module.exports = { footprint, removeData, dataDirNames };
