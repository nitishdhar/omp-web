"use strict";
// Keys passed to OMP: settings.json `ompEnv: [{var, credential}]` names
// environment variables every omp launch gets from the credential store.
// Values never travel through argv, tmux, or files: in-process spawns merge
// them into the child env here, and pane launches resolve them inside the
// pane through bin/omp-env.js (see sessions.js).
const { getSetting, setSetting } = require("./settings-store");
const { getCredential, credentialMeta } = require("./credentials");

const VAR = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAX_ENTRIES = 32;
// Variables omp-web, the shell, or the dynamic loader rely on; a credential
// there would break launches or hijack them.
const BLOCKED = new Set(["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "TMPDIR", "PWD", "NODE_OPTIONS"]);
const BLOCKED_PREFIXES = ["LC_", "TMUX", "DYLD_", "LD_", "OMP_WEB_"];

function envError(message) {
  const error = new Error(message);
  error.code = "EBADOMPENV";
  return error;
}

function storedEntries() {
  const stored = getSetting("ompEnv");
  if (!Array.isArray(stored)) return [];
  return stored.filter((entry) => entry && typeof entry.var === "string" && VAR.test(entry.var)
    && typeof entry.credential === "string");
}

function blocked(name) {
  return BLOCKED.has(name) || BLOCKED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

async function ompEnvSettings() {
  const entries = [];
  for (const entry of storedEntries()) {
    const meta = credentialMeta(entry.credential);
    const out = { var: entry.var, credential: entry.credential, credentialHint: meta ? meta.hint : "", ok: false };
    try {
      await getCredential(entry.credential);
      out.ok = true;
    } catch (error) {
      out.problem = error.message;
    }
    entries.push(out);
  }
  return { entries };
}

async function setOmpEnv(body = {}) {
  const list = body && body.entries;
  if (!Array.isArray(list)) throw envError("entries must be an array");
  if (list.length > MAX_ENTRIES) throw envError(`at most ${MAX_ENTRIES} entries`);
  const seen = new Set();
  const next = list.map((entry) => {
    const name = entry && typeof entry.var === "string" ? entry.var.trim() : "";
    const credential = entry && typeof entry.credential === "string" ? entry.credential.trim() : "";
    if (!VAR.test(name)) throw envError(`${name || "(empty)"} is not a valid variable name (A-Z, 0-9, _)`);
    if (blocked(name)) throw envError(`${name} is reserved and cannot be passed to omp`);
    if (seen.has(name)) throw envError(`${name} is listed twice`);
    seen.add(name);
    if (!credentialMeta(credential)) throw envError(`${name}: credential ${credential || "(none)"} does not exist`);
    return { var: name, credential };
  });
  await setSetting("ompEnv", next);
  return ompEnvSettings();
}

// The variables to pass and the ones that could not be resolved, with a
// reason that names the variable and credential, never a value.
async function resolveOmpEnv(only) {
  const env = {};
  const missing = [];
  for (const entry of storedEntries()) {
    if (only && !only.includes(entry.var)) continue;
    try {
      env[entry.var] = await getCredential(entry.credential);
    } catch (error) {
      missing.push(`${entry.var} not passed to omp: ${error.message}`);
    }
  }
  return { env, missing };
}

// For omp processes the server spawns itself (model catalog, version and
// update jobs, usage, skills config). Reported once per process per reason so
// periodic checks do not repeat it.
const reported = new Set();

async function withOmpCredentials(baseEnv) {
  const { env, missing } = await resolveOmpEnv();
  for (const line of missing) {
    if (reported.has(line)) continue;
    reported.add(line);
    console.error(`omp-web: ${line}`);
  }
  return { ...baseEnv, ...env };
}

// The variable names a pane launch should resolve, read when the pane command
// is built so the same list can be unset after omp exits.
function ompEnvNames() {
  return storedEntries().map((entry) => entry.var);
}

module.exports = { ompEnvSettings, setOmpEnv, resolveOmpEnv, withOmpCredentials, ompEnvNames, VAR };
