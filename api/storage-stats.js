"use strict";
// Disk used per session id: transcripts under sessionsDir and uploads under
// attachmentsDir, measured exactly as Delete would remove them
// (sessions/purge.js). Rows cover live sessions, not-running ones (restorable
// ghosts and forgotten ids that still hold data) and orphans: data dirs no
// live, registry or ghost record describes. Walking every transcript tree is
// not free, so the result is cached for a minute; Delete drops the cache.
const sessions = require("../sessions");
const registry = require("../registry");
const purgeData = require("../sessions/purge");
const { readTranscriptTitle, substantiveOwnedJsonl } = require("../transcripts");

const CACHE_MS = 60_000;
let cache = null; // { at, value }

function invalidateStorage() {
  cache = null;
}

async function measureStorage() {
  const live = await sessions.list();
  const ghosts = await sessions.restorable();
  const { forgotten } = registry.readRegistry();
  const rows = [];
  const listed = new Set();
  let transcriptsBytes = 0;
  let attachmentsBytes = 0;

  const add = (id, fields) => {
    if (listed.has(id)) return;
    listed.add(id);
    const size = purgeData.footprint(id);
    for (const part of size.parts) {
      if (part.kind === "transcripts") transcriptsBytes += part.bytes;
      else attachmentsBytes += part.bytes;
    }
    const lastActivity = Math.round(fields.lastActivity || size.newestMs) || null;
    rows.push({ id, runner: null, ...fields, bytes: size.bytes, files: size.files, lastActivity });
  };

  // lastActivity is epoch ms here; sessions report it in seconds.
  for (const session of live) {
    add(session.id, {
      title: session.title,
      state: "live",
      runner: session.runner,
      lastActivity: (session.lastActivity || 0) * 1000,
    });
  }
  for (const ghost of ghosts) {
    add(ghost.id, { title: ghost.title, state: "not-running", lastActivity: (ghost.lastActivity || 0) * 1000 });
  }
  const names = new Set(purgeData.dataDirNames());
  for (const id of forgotten) {
    if (listed.has(id) || !names.has(id)) continue;
    const transcript = substantiveOwnedJsonl(id);
    add(id, {
      title: (transcript && readTranscriptTitle(transcript.file)) || id,
      state: "not-running",
      forgotten: true,
    });
  }
  for (const id of names) {
    add(id, { title: id, state: "orphan" });
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  return { generatedAt: Date.now(), transcriptsBytes, attachmentsBytes, sessions: rows };
}

async function getStorage({ refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = await measureStorage();
  cache = { at: Date.now(), value };
  return value;
}

module.exports = { getStorage, invalidateStorage };
