"use strict";
// Effective idle timers. The reaper reads them on every sweep and the rpc
// launch reads them for each new bridge, so a Settings change applies to the
// next sweep and the next launch; a running bridge keeps the window it was
// started with. An environment value (including OMP_WEB_HOME/env, which
// config.js folds into process.env) wins and locks the key.
const { getSetting, setSetting } = require("./settings-store");

const TIMERS = {
  // An rpc session's omp exits after this long settled with no Chat request;
  // the next send starts it again.
  rpcIdleMinutes: { env: "OMP_WEB_RPC_IDLE_MINUTES", default: 10, min: 1, max: 1440 },
  // A TUI session nobody has looked at for this long is switched back to the
  // rpc runner, which ends its idle omp process.
  tuiIdleMinutes: { env: "OMP_WEB_TUI_IDLE_MINUTES", default: 30, min: 5, max: 1440 },
};

function settingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function envMinutes(spec) {
  const raw = process.env[spec.env];
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function inBounds(spec, value) {
  return typeof value === "number" && Number.isFinite(value)
    && value >= spec.min && value <= spec.max
    && Math.round(value * 10) / 10 === value;
}

function storedRuntime() {
  const stored = getSetting("runtime");
  return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
}

function resolve(name) {
  const spec = TIMERS[name];
  const fromEnv = envMinutes(spec);
  if (fromEnv !== null) return { value: fromEnv, source: "env" };
  const stored = storedRuntime()[name];
  if (inBounds(spec, stored)) return { value: stored, source: "settings" };
  return { value: spec.default, source: "default" };
}

function timerMinutes(name) {
  return resolve(name).value;
}

function runtimeSettings() {
  const out = {};
  for (const [name, spec] of Object.entries(TIMERS)) {
    out[name] = { ...resolve(name), default: spec.default, min: spec.min, max: spec.max };
  }
  return out;
}

async function setRuntimeSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw settingError("EBADSETTING", "expected an object of timer minutes");
  }
  const updates = {};
  for (const [name, value] of Object.entries(input)) {
    const spec = TIMERS[name];
    if (!spec) throw settingError("EBADSETTING", `unknown setting: ${name}`);
    if (envMinutes(spec) !== null) {
      throw settingError("ELOCKED", `${name} is set by ${spec.env}; change it there`);
    }
    if (!inBounds(spec, value)) {
      throw settingError("EBADSETTING", `${name} must be a number from ${spec.min} to ${spec.max} with at most one decimal`);
    }
    updates[name] = value;
  }
  if (Object.keys(updates).length) {
    await setSetting("runtime", { ...storedRuntime(), ...updates });
  }
  return runtimeSettings();
}

module.exports = { timerMinutes, runtimeSettings, setRuntimeSettings };
