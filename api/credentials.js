"use strict";
// omp-web's own named secrets. Metadata ({label, store, updatedAt, hint}) lives
// in settings.json under `credentials`; the value lives in its store
// (api/credential-stores.js). Values are write-only: nothing here returns,
// logs or puts one in an error message, and the server reads them only
// through getCredential().
const { getSetting, setSetting } = require("./settings-store");
const { WRITABLE, listStores, requireAvailable } = require("./credential-stores");

const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const LABEL_MAX = 60;
const VALUE_MAX = 8192;
const CACHE_MS = 30_000;

function credentialError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function allMeta() {
  const stored = getSetting("credentials");
  return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
}

function metaFor(name) {
  const meta = allMeta()[name];
  return meta && typeof meta === "object" && WRITABLE[meta.store] ? meta : null;
}

// Short values get no hint: their last four characters are too much of them.
function hintOf(value) {
  return typeof value === "string" && value.length >= 12 ? value.slice(-4) : "";
}

// Who references a credential. Read from settings directly rather than via
// voice-settings.js / omp-env.js, which themselves depend on this module.
function usedBy(name) {
  const users = [];
  const voice = getSetting("voice");
  if (voice && voice.credential === name) users.push({ kind: "voice", label: "Voice input" });
  const ompEnv = getSetting("ompEnv");
  for (const entry of Array.isArray(ompEnv) ? ompEnv : []) {
    if (entry && entry.credential === name) users.push({ kind: "omp-env", label: `Passed to OMP as ${entry.var}` });
  }
  return users;
}

function publicItem(name, meta) {
  return {
    name,
    label: meta.label || name,
    store: meta.store,
    updatedAt: meta.updatedAt || "",
    hint: meta.hint || "",
    usedBy: usedBy(name),
  };
}

function checkName(name) {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw credentialError("EBADCREDENTIAL", "name must be 1-48 lowercase letters, digits or dashes, starting with a letter or digit");
  }
}

function checkValue(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > VALUE_MAX) {
    throw credentialError("EBADCREDENTIAL", `value must be 1-${VALUE_MAX} characters`);
  }
  if (/[\r\n\0]/.test(value)) throw credentialError("EBADCREDENTIAL", "value must be a single line");
}

// Keyed by the metadata's store and updatedAt, so a change made by another
// process (the CLI) invalidates the entry as soon as settings.json changes.
const cache = new Map(); // name -> { key, value, at }

function cacheKey(meta) {
  return `${meta.store}:${meta.updatedAt || ""}`;
}

async function getCredential(name) {
  const meta = metaFor(name);
  if (!meta) throw credentialError("ENOCREDENTIAL", `credential ${name} does not exist`);
  const hit = cache.get(name);
  if (hit && hit.key === cacheKey(meta) && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await WRITABLE[meta.store].read(name);
  if (!value) throw credentialError("ENOCREDENTIAL", `credential ${name} has no value in the ${meta.store} store`);
  cache.set(name, { key: cacheKey(meta), value, at: Date.now() });
  return value;
}

async function listCredentials() {
  const credentials = Object.keys(allMeta())
    .filter((name) => NAME.test(name) && metaFor(name))
    .map((name) => publicItem(name, metaFor(name)))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { stores: await listStores(), credentials };
}

// Metadata read-modify-write spans awaits on the stores; serialize so two
// saves cannot interleave.
let mutations = Promise.resolve();

function serialized(task) {
  const run = mutations.catch(() => {}).then(task);
  mutations = run;
  return run;
}

async function saveMeta(name, meta) {
  const next = { ...allMeta() };
  if (meta) next[name] = meta;
  else delete next[name];
  cache.delete(name);
  await setSetting("credentials", next);
}

function putCredential(name, body = {}) {
  return serialized(async () => {
    checkName(name);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw credentialError("EBADCREDENTIAL", "body must be an object");
    const existing = metaFor(name);
    const store = body.store === undefined ? (existing ? existing.store : "file") : body.store;
    if (!WRITABLE[store]) throw credentialError("EBADCREDENTIAL", "store must be file or keychain");
    let label = body.label === undefined ? (existing && existing.label) || name : body.label;
    if (typeof label !== "string") throw credentialError("EBADCREDENTIAL", "label must be a string");
    label = label.trim() || name;
    if (label.length > LABEL_MAX) throw credentialError("EBADCREDENTIAL", `label must be ${LABEL_MAX} characters or fewer`);
    let value = null;
    if (body.value !== undefined) {
      checkValue(body.value);
      value = body.value;
    }
    if (value === null && !existing) throw credentialError("EBADCREDENTIAL", "a value is required");

    const moving = Boolean(existing && existing.store !== store);
    // A label-only edit must still work when the store is unavailable here.
    if (value !== null || moving) await requireAvailable(store);
    // A store change without a new value moves the stored one.
    if (value === null && moving) {
      value = await WRITABLE[existing.store].read(name);
      if (!value) throw credentialError("ENOCREDENTIAL", `credential ${name} has no value to move`);
    }
    const meta = value === null
      ? { ...existing, label }
      : { label, store, updatedAt: new Date().toISOString(), hint: hintOf(value) };
    if (value !== null) await WRITABLE[store].write(name, value);
    await saveMeta(name, meta);
    // Write new, then drop old: a failed delete leaves a stray copy, never a
    // credential without a value.
    if (moving) {
      await WRITABLE[existing.store].remove(name).catch((error) => {
        console.error(`omp-web: credential ${name}: could not remove the old ${existing.store} copy (${error.message})`);
      });
    }
    return publicItem(name, meta);
  });
}

function deleteCredential(name) {
  return serialized(async () => {
    checkName(name);
    const meta = metaFor(name);
    if (!meta) throw credentialError("ENOCREDENTIAL", `credential ${name} does not exist`);
    const users = usedBy(name);
    if (users.length) {
      throw credentialError("EINUSE", `credential ${name} is used by ${users.map((user) => user.label).join(", ")}`);
    }
    await WRITABLE[meta.store].remove(name);
    await saveMeta(name, null);
    return { ok: true };
  });
}

function credentialMeta(name) {
  const meta = metaFor(name);
  return meta ? publicItem(name, meta) : null;
}

module.exports = { getCredential, listCredentials, putCredential, deleteCredential, credentialMeta };
