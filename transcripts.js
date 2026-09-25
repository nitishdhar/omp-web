"use strict";

// Locate, read, and rewrite the owning OMP JSONL transcript for a session.
// Extracted from sessions.js so that module stays focused on tmux orchestration.

const fs = require("fs");
const path = require("path");
const config = require("./config");

function sessionDirFor(id) {
  return path.join(config.sessionsDir, id);
}

function profileSessionDirFor(id, profile) {
  const owner =
    !profile || profile === "default"
      ? "default"
      : encodeURIComponent(String(profile)).replace(/\./g, "%2E");
  return path.join(sessionDirFor(id), owner);
}

function profileHome(profile) {
  return !profile || profile === "default"
    ? path.join(config.ompHome, "agent")
    : path.join(config.profilesDir, profile, "agent");
}

// Legacy pinned transcripts lived directly in sessionDirFor(id). Do not
// recurse here: child directories are owned by distinct OMP profile homes.
function newestDirectJsonl(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  let bestT = -1;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl") || e.name.endsWith(".sanitized.jsonl")) continue;
    const p = path.join(dir, e.name);
    let t;
    try {
      t = fs.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (t > bestT) {
      bestT = t;
      best = p;
    }
  }
  return best;
}

// Locate only a transcript that omp-web itself owns. A profile-home lookup
// cannot distinguish this web session from another conversation in the same
// project, so an absent transcript is an error rather than a silent fork of
// unrelated work.
function findSessionFile(id, profile) {
  return newestDirectJsonl(profileSessionDirFor(id, profile)) || newestDirectJsonl(sessionDirFor(id));
}

// Every profile directory belonging to this session id. OMP writes subagent
// transcripts one level deeper (inside a directory named after the parent
// file), so direct children only ever yield this session's own conversations.
function newestOwnedJsonl(id) {
  const root = sessionDirFor(id);
  let best = newestDirectJsonl(root);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return best;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    best = newer(best, newestDirectJsonl(path.join(root, e.name)));
  }
  return best;
}

function fileMtime(file) {
  if (!file) return -1;
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st.mtimeMs : -1;
  } catch {
    return -1;
  }
}

function newer(a, b) {
  return fileMtime(b) > fileMtime(a) ? b : a;
}

// Inverse of profileSessionDirFor's owner encoding. decodeURIComponent
// reverses both encodeURIComponent and the extra dot encoding; "default"
// stays "default". Unparseable names pass through unchanged.
function decodeProfileDir(name) {
  if (!name || name === "default") return "default";
  try {
    return decodeURIComponent(String(name));
  } catch {
    return String(name);
  }
}

// Every owned transcript candidate for a session id: legacy root files plus
// one profile level deep. Direct children only — OMP writes subagent
// transcripts one level deeper and those are never adopted.
function scanOwnedJsonl(id) {
  const found = [];
  const root = sessionDirFor(id);
  const scanDir = (dir, profile) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl") || e.name.endsWith(".sanitized.jsonl")) continue;
      const file = path.join(dir, e.name);
      let stat = null;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      found.push({ file, profile, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  scanDir(root, "default");
  let children;
  try {
    children = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const child of children) {
    if (!child.isDirectory()) continue;
    scanDir(path.join(root, child.name), decodeProfileDir(child.name));
  }
  return found;
}

// Largest substantive transcript this id owns, for pre-registry fallback
// ghosts. Null when nothing reaches RESUME_MIN_BYTES.
function substantiveOwnedJsonl(id) {
  let best = null;
  for (const candidate of scanOwnedJsonl(id)) {
    if (candidate.size < RESUME_MIN_BYTES) continue;
    if (!best || candidate.size > best.size) best = candidate;
  }
  return best ? { file: best.file, profile: best.profile } : null;
}

function readCwdFromFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.toString("utf8", 0, size).split("\n")) {
      if (!line.includes("\"session\"") || !line.includes("\"cwd\"")) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "session" && typeof entry.cwd === "string"
          && path.isAbsolute(entry.cwd)) {
          return entry.cwd;
        }
      } catch {
        // OMP may be writing the tail of a JSONL line; headers precede it.
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return null;
}

// Working directory recorded in this id's transcripts, newest first. Bounded:
// only the first 64KB of each owned file, direct children only. Null when no
// transcript records a cwd — those ids stay recoverable via the CLI only.
function sessionCwdFor(id) {
  const candidates = scanOwnedJsonl(id).sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    const cwd = readCwdFromFile(candidate.file);
    if (cwd) return cwd;
  }
  return null;
}

function isOwnedTranscript(file, profile) {
  const target = path.resolve(file);
  const roots = [config.sessionsDir, path.join(profileHome(profile), "sessions")].map((root) =>
    path.resolve(root)
  );
  return roots.some((root) => target === root || target.startsWith(root + path.sep));
}

function readTranscriptTitle(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.toString("utf8", 0, size).split("\n")) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "title" && typeof entry.title === "string" && entry.title.trim()) {
          return entry.title.trim();
        }
      } catch {
        // OMP may be writing the tail of a JSONL line; title records precede it.
      }
    }
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return "";
}
// Minimum transcript size that counts as substantive history. A fresh OMP
// launch inside a non-empty --session-dir writes a new near-empty .jsonl
// (framing only, well under this bound), so substance is decided by size —
// never by mtime, which a fresh-empty launch would win.
const RESUME_MIN_BYTES = 5 * 1024;

// Resume source for (re)creating a session id: the largest substantive
// transcript this session id owns under the target profile — that profile's
// directory plus the legacy id-root directory (same scope as
// findSessionFile). Never another profile's directory. Skips sanitized
// derivatives (reload writes those from the original; the original is the
// source) and fresh-empty launches. Selection is by substance (size); callers
// use readTranscriptTitle on the result for logging only.
function bestResumeSource(id, profile) {
  const dirs = [profileSessionDirFor(id, profile), sessionDirFor(id)];
  let best = null;
  let bestSize = -1;
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl") || e.name.endsWith(".sanitized.jsonl")) continue;
      const p = path.join(dir, e.name);
      let size = -1;
      try {
        size = fs.statSync(p).size;
      } catch {
        continue;
      }
      if (size < RESUME_MIN_BYTES) continue;
      if (size > bestSize) {
        bestSize = size;
        best = p;
      }
    }
  }
  return best;
}


// The stored pin is a hint, never an override. OMP opens a new transcript when
// a session switches profile or model mid-run and never tells tmux, so honoring
// a still-existing pin froze chat on a dead file while the terminal kept
// streaming. Prefer whichever transcript this session owns most recently.
function resolveTranscript(id, profile, stored) {
  const pinned = stored && isOwnedTranscript(stored, profile) ? stored : null;
  let best = newer(pinned, findSessionFile(id, profile));
  best = newer(best, newestOwnedJsonl(id));
  return fileMtime(best) < 0 ? null : best;
}

module.exports = {
  profileHome,
  profileSessionDirFor,
  sessionDirFor,
  findSessionFile,
  isOwnedTranscript,
  newestOwnedJsonl,
  readTranscriptTitle,
  resolveTranscript,
  bestResumeSource,
  fileMtime,
  substantiveOwnedJsonl,
  sessionCwdFor,
  RESUME_MIN_BYTES,
};
