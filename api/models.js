"use strict";
// Per-profile chat model catalog (native `omp models --json`) and the in-session
// switch. An rpc session switches through the bridge (set_model plus
// set_thinking_level); a TUI session gets OMP's own `/switch
// <selector>:<level>` built-in typed like any Chat send. Either way OMP changes
// the live model and thinking level for this session only, writes model_change
// + thinking_level_change to the transcript (which Chat already projects), and
// never reaches the model.

const { execFile } = require("child_process");
const { promisify } = require("util");
const config = require("../config");
const sessions = require("../sessions");
const { listProfiles } = require("./util");
const { profileHome } = require("../transcripts");

const execFileAsync = promisify(execFile);
const CACHE_MS = 10 * 60_000;
const MAX_MODELS = 200;
const MAX_TEXT = 120;
// OMP's thinking ladder; a model lists the subset it supports.
const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
// A selector is typed into the TUI, so it must never carry a space (that would
// end the argument), a colon (the level separator), or a control character.
const SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._@/+-]{0,159}$/;

const cache = new Map();

function modelsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function text(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_TEXT) : "";
}

function normalize(payload) {
  const rows = Array.isArray(payload?.models) ? payload.models : [];
  const models = [];
  for (const row of rows) {
    if (!row || row.kind !== "chat" || typeof row.selector !== "string" || !SELECTOR.test(row.selector)) continue;
    const levels = Array.isArray(row.thinking) ? row.thinking.filter((level) => LEVELS.has(level)) : [];
    models.push({ selector: row.selector, name: text(row.name) || row.selector, levels });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

async function load(profile) {
  const args = profile === "default"
    ? ["models", "--json"]
    : [`--profile=${profile}`, "models", "--json"];
  // Same profile selection as a session launch: an inherited OMP_PROFILE
  // made the "default" catalog list another profile's models, which the
  // default runtime then rejected as not found.
  const env = { ...process.env, PI_CODING_AGENT_DIR: profileHome("default") };
  delete env.OMP_PROFILE;
  delete env.PI_PROFILE;
  const { stdout } = await execFileAsync(config.ompBin, args, {
    env,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return normalize(JSON.parse(stdout));
}

/** Chat models available to `profile`, cached per profile. */
async function listModels(profile) {
  const name = String(profile || "default");
  if (!listProfiles().includes(name)) throw modelsError("EBADPROFILE", `unknown profile: ${name}`);
  const hit = cache.get(name);
  if (hit && (hit.pending || Date.now() - hit.at < CACHE_MS)) return hit.pending || hit.models;
  const pending = load(name).then((models) => {
    cache.set(name, { at: Date.now(), models });
    return models;
  }).catch(() => {
    cache.delete(name);
    throw modelsError("EMODELSUNAVAILABLE", `could not list models for ${name}`);
  });
  cache.set(name, { at: 0, pending });
  return pending;
}

/**
 * Switch a live agent session's model and thinking level. Both values are
 * validated against that session's profile catalog before anything is typed.
 */
async function switchModel(id, { model, effort } = {}) {
  const session = await sessions.get(id);
  if (!session) throw modelsError("ENOSESSION", "session not found");
  if (session.type === "shell") throw modelsError("EBADTYPE", "shell sessions have no model");
  const models = await listModels(session.profile || "default");
  const entry = models.find((item) => item.selector === model);
  if (!entry) throw modelsError("EBADMODEL", `model is not available under ${session.profile || "default"}`);
  let level = null;
  if (effort != null && effort !== "") {
    if (!(effort === "off" || entry.levels.includes(effort))) {
      throw modelsError("EBADEFFORT", `${entry.selector} does not support ${effort} effort`);
    }
    level = effort;
  }
  if (session.runner === "rpc") {
    // Selectors are `<provider>/<model id>`; only the id may contain slashes.
    const slash = entry.selector.indexOf("/");
    if (slash <= 0) throw modelsError("EBADMODEL", `${entry.selector} names no provider`);
    await sessions.setRuntimeModel(id, {
      provider: entry.selector.slice(0, slash),
      modelId: entry.selector.slice(slash + 1),
      level,
    });
  } else {
    await sessions.sendText(id, level ? `/switch ${entry.selector}:${level}` : `/switch ${entry.selector}`);
  }
  return { model: entry.selector, effort: level };
}

module.exports = { listModels, switchModel };
