"use strict";
// Which panels exist. Two sources: OMP_WEB_PANELS (validated at startup,
// locked) and settings.json `panels` (edited in Settings). The proxy, auth and
// /api/meta resolve against the effective list on every request, so a saved
// change applies without a restart. api/panels.js is only the proxy.
const http = require("http");
const { getSetting, setSetting } = require("./settings-store");

const PANEL_ID = /^[a-z0-9-]+$/;
const FIELD_MAX = 40;
const MAX_SETTINGS_PANELS = 20;
// Loopback only, origin only: a path, query, or credentials in the URL would
// make the mount point ambiguous, and any other host turns omp-web into an
// open relay onto the network.
const PANEL_URL = /^http:\/\/(127\.0\.0\.1|localhost):([1-9][0-9]{0,4})\/?$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const CHECK_TIMEOUT_MS = 3_000;

let envPanels = []; // validated once at startup
const warned = new Set();
let effectiveFor = null; // { stored, list }: last computation and its input

function panelError(message) {
  const error = new Error(message);
  error.code = "EBADPANEL";
  return error;
}

function parseUrl(url) {
  const match = typeof url === "string" ? url.match(PANEL_URL) : null;
  const port = match ? Number(match[2]) : 0;
  if (!match || port > 65535) return null;
  return { hostname: match[1], port, host: `${match[1]}:${port}` };
}

const URL_RULE = '"url" must be exactly http://127.0.0.1:<port> or http://localhost:<port> (no path, query, credentials or https).';

// Returns the normalized panel or throws with `${where}: ...`. `taken` holds
// ids already used earlier in the same list (and, for settings, by env).
function validateEntry(entry, where, taken) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw panelError(`${where} must be an object with "id", "label" and "url".`);
  }
  const { id, label, url } = entry;
  const named = typeof id === "string" && id ? `${where} ("${id}")` : where;
  if (typeof id !== "string" || !PANEL_ID.test(id) || id.length > FIELD_MAX) {
    throw panelError(`${named}: "id" must be 1-${FIELD_MAX} characters of a-z, 0-9 or "-".`);
  }
  if (taken.has(id)) throw panelError(`${named}: ${taken.get(id)}`);
  if (typeof label !== "string" || !label.trim() || label.length > FIELD_MAX || CONTROL_CHARS.test(label)) {
    throw panelError(`${named}: "label" must be a non-empty string of at most ${FIELD_MAX} characters without control characters.`);
  }
  const target = parseUrl(url);
  if (!target) throw panelError(`${named}: ${URL_RULE}`);
  return { id, label, url, ...target };
}

function parseEnvPanels(raw) {
  if (!raw || !raw.trim()) return [];
  let list;
  try {
    list = JSON.parse(raw);
  } catch (error) {
    throw new Error(`OMP_WEB_PANELS is not valid JSON (${error.message}).`);
  }
  if (!Array.isArray(list)) throw new Error("OMP_WEB_PANELS must be a JSON array of {\"id\",\"label\",\"url\"} objects.");
  const taken = new Map();
  return list.map((entry, index) => {
    const panel = validateEntry(entry, `OMP_WEB_PANELS entry ${index + 1}`, taken);
    taken.set(panel.id, '"id" is used by an earlier entry; ids must be unique.');
    return { ...panel, source: "env" };
  });
}

function envTaken() {
  return new Map(envPanels.map((panel) => [panel.id, '"id" is already used by a panel set in OMP_WEB_PANELS.']));
}

// Throws with an operator-facing message; server.js turns it into exit(1).
// Stored panels are checked too, but only warned about: a bad settings.json
// must never brick startup.
function configurePanels(raw) {
  envPanels = parseEnvPanels(raw);
  effectiveFor = null;
  effectivePanels();
}

// Env first, then each valid stored entry whose id env does not use. Keyed on
// the store's parsed object, which is reused while the file is unchanged.
function effectivePanels() {
  const stored = getSetting("panels");
  if (effectiveFor && effectiveFor.stored === stored) return effectiveFor.list;
  const list = [...envPanels];
  const taken = envTaken();
  for (const [index, entry] of (Array.isArray(stored) ? stored : []).entries()) {
    try {
      const panel = validateEntry(entry, `settings.json panels entry ${index + 1}`, taken);
      taken.set(panel.id, '"id" is used by an earlier entry; ids must be unique.');
      list.push({ ...panel, source: "settings" });
    } catch (error) {
      if (!warned.has(error.message)) {
        warned.add(error.message);
        console.warn(`omp-web: skipping panel: ${error.message}`);
      }
    }
  }
  effectiveFor = { stored, list };
  return list;
}

function panelById(id) {
  return effectivePanels().find((panel) => panel.id === id) || null;
}

// The browser needs only what it renders; the upstream URL stays server-side.
function publicPanels() {
  return effectivePanels().map(({ id, label }) => ({ id, label }));
}

function listPanels() {
  return effectivePanels().map(({ id, label, url, source }) => ({ id, label, url, source }));
}

async function setPanels(input) {
  if (!Array.isArray(input)) throw panelError('"panels" must be a list of {"id","label","url"} objects.');
  if (input.length > MAX_SETTINGS_PANELS) throw panelError(`at most ${MAX_SETTINGS_PANELS} panels can be added in Settings.`);
  const taken = envTaken();
  const panels = input.map((entry, index) => {
    const panel = validateEntry(entry, `panel ${index + 1}`, taken);
    taken.set(panel.id, '"id" is used by an earlier entry; ids must be unique.');
    return { id: panel.id, label: panel.label, url: panel.url };
  });
  await setSetting("panels", panels);
  return listPanels();
}

// Reachability probe for the Settings form: one GET /, redirects reported as
// their status (never followed), body discarded.
function checkPanel(url) {
  const target = parseUrl(url);
  if (!target) return Promise.reject(panelError(URL_RULE));
  const started = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve({ ...result, ms: Date.now() - started });
    };
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      method: "GET",
      path: "/",
      agent: false,
      headers: { host: target.host },
      timeout: CHECK_TIMEOUT_MS,
    });
    const timer = setTimeout(() => {
      finish({ ok: false, error: "timed out" });
      request.destroy();
    }, CHECK_TIMEOUT_MS);
    request.on("response", (response) => {
      clearTimeout(timer);
      finish({ ok: true, status: response.statusCode });
      response.resume();
      request.destroy();
    });
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, error: error.code === "ECONNREFUSED" ? "connection refused" : error.message || "unreachable" });
    });
    request.end();
  });
}

module.exports = { configurePanels, panelById, publicPanels, listPanels, setPanels, checkPanel };
