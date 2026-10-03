"use strict";
// Voice input settings: settings.json `voice: {baseUrl, model, credential}`,
// where credential names an entry of api/credentials.js. transcribe.js
// resolves them per request, so a save applies without a restart.
const { getSetting, setSetting } = require("./settings-store");
const { getCredential, putCredential, credentialMeta } = require("./credentials");

const MODEL_MAX = 200;
const TEST_TIMEOUT_MS = 10_000;
const ENV_KEYS = ["OMP_WEB_TRANSCRIBE_BASE_URL", "OMP_WEB_TRANSCRIBE_API_KEY", "OMP_WEB_TRANSCRIBE_MODEL"];
const MIGRATED_CREDENTIAL = "voice-api-key";

function voiceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function stored() {
  const voice = getSetting("voice");
  const value = voice && typeof voice === "object" && !Array.isArray(voice) ? voice : {};
  return {
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
    model: typeof value.model === "string" ? value.model : "",
    credential: typeof value.credential === "string" ? value.credential : "",
  };
}

function validBaseUrl(text) {
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function checkFields({ baseUrl, model, credential }) {
  if (!validBaseUrl(baseUrl)) return "base URL must be an absolute http(s) URL";
  if (!model || model.length > MODEL_MAX) return `model must be 1-${MODEL_MAX} characters`;
  if (!credential) return "no API key selected";
  if (!credentialMeta(credential)) return `credential ${credential} does not exist`;
  return "";
}

// Settings plus the key, or a reason voice cannot run. Fetches the value
// (cached by credentials.js) so a missing env var or an unreadable keychain
// shows as a problem rather than a failed recording.
async function resolveVoice(fields = stored()) {
  if (!fields.baseUrl) return { configured: false, problem: "voice input is not configured" };
  const problem = checkFields(fields);
  if (problem) return { configured: true, problem };
  try {
    return { configured: true, ...fields, key: await getCredential(fields.credential) };
  } catch (error) {
    return { configured: true, problem: error.message };
  }
}

async function voiceSettings() {
  const fields = stored();
  const resolved = await resolveVoice(fields);
  const meta = fields.credential ? credentialMeta(fields.credential) : null;
  const out = {
    configured: resolved.configured,
    ...fields,
    credentialHint: meta ? meta.hint : "",
    ready: Boolean(resolved.key),
  };
  if (resolved.configured && !resolved.key) out.problem = resolved.problem;
  return out;
}

async function voiceReady() {
  return Boolean((await resolveVoice()).key);
}

function asField(value, name) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw voiceError("EBADVOICE", `${name} must be a string`);
  return value.trim();
}

async function setVoiceSettings(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw voiceError("EBADVOICE", "body must be an object");
  const fields = {
    baseUrl: asField(body.baseUrl, "baseUrl"),
    model: asField(body.model, "model"),
    credential: asField(body.credential, "credential"),
  };
  // An empty base URL turns voice off and keeps the rest for later.
  if (fields.baseUrl) {
    const problem = checkFields(fields);
    if (problem) throw voiceError("EBADVOICE", problem);
  } else if (fields.model.length > MODEL_MAX) {
    throw voiceError("EBADVOICE", `model must be ${MODEL_MAX} characters or fewer`);
  }
  await setSetting("voice", fields);
  return voiceSettings();
}

// GET <baseUrl>/models with the key: any 2xx proves URL and key together.
// Body fields override the saved settings so the form can be tested unsaved.
async function testVoice(body = {}) {
  const saved = stored();
  const pick = (name) => (body && typeof body[name] === "string" ? body[name].trim() : saved[name]);
  const fields = { baseUrl: pick("baseUrl"), model: pick("model") || "-", credential: pick("credential") };
  const started = Date.now();
  const resolved = await resolveVoice(fields);
  if (!resolved.key) return { ok: false, ms: Date.now() - started, error: resolved.problem };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${fields.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${resolved.key}` },
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => {});
    const ms = Date.now() - started;
    if (response.ok) return { ok: true, status: response.status, ms };
    return { ok: false, status: response.status, ms, error: `service answered HTTP ${response.status}` };
  } catch (error) {
    const ms = Date.now() - started;
    return { ok: false, ms, error: error && error.name === "AbortError" ? "timed out after 10 s" : "service unreachable" };
  } finally {
    clearTimeout(timeout);
  }
}

// One-time cutover from the OMP_WEB_TRANSCRIBE_* variables (inherited or from
// OMP_WEB_HOME/env, which config.js folds into process.env). Runs only while
// settings has no `voice` key, so afterwards the variables are ignored and
// `omp-web doctor` says so.
async function migrateVoiceFromEnv() {
  if (getSetting("voice") !== undefined) return;
  const [baseUrl, apiKey, model] = ENV_KEYS.map((key) => (process.env[key] || "").trim());
  if (!baseUrl || !apiKey || !model) return;
  await putCredential(MIGRATED_CREDENTIAL, { label: "Voice API key", store: "file", value: apiKey });
  await setSetting("voice", { baseUrl, model, credential: MIGRATED_CREDENTIAL });
  console.log(`omp-web: moved OMP_WEB_TRANSCRIBE_* into Settings → Voice (credential ${MIGRATED_CREDENTIAL}); remove the variables`);
}

module.exports = { voiceSettings, voiceReady, resolveVoice, setVoiceSettings, testVoice, migrateVoiceFromEnv, ENV_KEYS };
