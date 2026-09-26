"use strict";

// Durable live-set record for boot recovery. tmux remains the runtime source
// of truth; this file only remembers which sessions existed so ghosts can be
// offered for explicit restore after a Mac restart or tmux-server death.
// Never auto-resurrects: readers treat registry-only entries as restorable.

const fs = require("fs");
const path = require("path");
const config = require("./config");

const SESSION_ID = /^[A-Za-z0-9_-]{1,40}$/;
const FORGOTTEN_LIMIT = 200;

function registryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateRecord(record) {
  if (!record || typeof record !== "object") {
    throw registryError("EBADRECORD", "registry record must be an object");
  }
  if (typeof record.id !== "string" || !SESSION_ID.test(record.id)) {
    throw registryError("EBADID", "invalid session id");
  }
  if (typeof record.folder !== "string" || !path.isAbsolute(record.folder)) {
    throw registryError("EBADFOLDER", "registry folder must be an absolute path");
  }
  if (record.type !== "agent" && record.type !== "shell") {
    throw registryError("EBADTYPE", "session type must be agent or shell");
  }
  return {
    id: record.id,
    folder: record.folder,
    profile: typeof record.profile === "string" && record.profile ? record.profile : "default",
    type: record.type,
    title: typeof record.title === "string" && record.title ? record.title : record.id,
    created: Number(record.created) || 0,
    pinned: Boolean(record.pinned),
  };
}

// Records are flat (validateRecord returns primitives only), so a per-record
// spread fully isolates the cache from caller mutation.
function copyEntries(entries) {
  return Object.fromEntries(
    Object.entries(entries).map(([id, record]) => [id, { ...record }])
  );
}
// Stat-keyed read cache: registry I/O sits on the GET path (adopt-on-list in
// sessions.js list()), so repeated lists within one file generation skip the
// re-parse. Key is `${file}:${size}:${mtimeMs}` from a single statSync; any
// path/size/mtime change is a miss and re-reads. Copies go out (`{...entries}`,
// `[...forgotten]`) so callers that mutate the result cannot poison the cache;
// writeRegistry refreshes it on success. A failed stat invalidates.
let registryCache = null;

// Missing file → empty; corrupt JSON → empty + console.error, never throw —
function readRegistry() {
  let key = null;
  try {
    const stat = fs.statSync(config.registryFile);
    key = `${config.registryFile}:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    registryCache = null;
    if (error && error.code === "ENOENT") return { entries: {}, forgotten: [] };
    console.error(`registry read failed (${config.registryFile}): ${error.message}`);
    return { entries: {}, forgotten: [] };
  }
  if (registryCache && registryCache.key === key) {
    return { entries: copyEntries(registryCache.entries), forgotten: [...registryCache.forgotten] };
  }
  let raw;
  try {
    raw = fs.readFileSync(config.registryFile, "utf8");
  } catch (error) {
    console.error(`registry read failed (${config.registryFile}): ${error.message}`);
    return { entries: {}, forgotten: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`registry corrupt (${config.registryFile}): ${error.message}`);
    registryCache = { key, entries: {}, forgotten: [] };
    return { entries: {}, forgotten: [] };
  }
  const source = parsed && typeof parsed === "object" ? parsed.entries || {} : {};
  const entries = {};
  for (const [id, record] of Object.entries(source)) {
    try {
      const clean = validateRecord({ ...record, id });
      entries[id] = clean;
    } catch {
      // Skip invalid records; a single bad entry must not poison the set.
    }
  }
  // Parse forgotten ids: array of SESSION_ID strings, invalid entries skipped.
  let forgotten = [];
  if (Array.isArray(parsed.forgotten)) {
    const seen = new Set();
    for (const id of parsed.forgotten) {
      if (typeof id === "string" && SESSION_ID.test(id) && !seen.has(id)) {
        forgotten.push(id);
        seen.add(id);
      }
    }
  }
  registryCache = { key, entries, forgotten };
  return { entries: copyEntries(entries), forgotten: [...forgotten] };
}

function writeRegistry(entries, forgotten = []) {
  const clean = {};
  for (const [id, record] of Object.entries(entries || {})) {
    clean[id] = validateRecord({ ...record, id });
  }
  // Validate and deduplicate forgotten ids, keeping newest (last) entries up to limit.
  const seen = new Set();
  const validForgotten = [];
  for (const id of forgotten) {
    if (typeof id === "string" && SESSION_ID.test(id) && !seen.has(id)) {
      validForgotten.push(id);
      seen.add(id);
    }
  }
  // Keep only the newest FORGOTTEN_LIMIT entries.
  if (validForgotten.length > FORGOTTEN_LIMIT) {
    validForgotten.splice(0, validForgotten.length - FORGOTTEN_LIMIT);
  }
  fs.mkdirSync(path.dirname(config.registryFile), { recursive: true });
  const tmp = `${config.registryFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ entries: clean, forgotten: validForgotten }, null, 2));
  fs.renameSync(tmp, config.registryFile);
  try {
    const stat = fs.statSync(config.registryFile);
    registryCache = {
      key: `${config.registryFile}:${stat.size}:${stat.mtimeMs}`,
      entries: copyEntries(clean),
      forgotten: [...validForgotten],
    };
  } catch {
    registryCache = null;
  }
  return { entries: clean, forgotten: validForgotten };
}

function upsert(record) {
  const clean = validateRecord(record);
  const { entries, forgotten } = readRegistry();
  entries[clean.id] = clean;
  // A re-created/restored session must reappear normally, not stay in forgotten.
  const updated = forgotten.filter(id => id !== clean.id);
  writeRegistry(entries, updated);
  return clean;
}

function remove(id) {
  if (typeof id !== "string" || !SESSION_ID.test(id)) {
    throw registryError("EBADID", "invalid session id");
  }
  const { entries, forgotten } = readRegistry();
  if (!entries[id]) return false;
  delete entries[id];
  // Pass forgotten through: writeRegistry defaults it to [], so every kill or
  // Forget used to resurrect every previously forgotten session.
  writeRegistry(entries, forgotten);
  return true;
}

function forget(id) {
  if (typeof id !== "string" || !SESSION_ID.test(id)) {
    throw registryError("EBADID", "invalid session id");
  }
  const { entries, forgotten } = readRegistry();
  // Already in forgotten? No-op (return false, don't add twice).
  if (forgotten.includes(id)) return false;
  // Add to forgotten.
  writeRegistry(entries, [...forgotten, id]);
  return true;
}

module.exports = { readRegistry, writeRegistry, upsert, remove, forget };
