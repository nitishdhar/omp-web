"use strict";
// Settings → OMP. Shows the installed omp against the latest release, runs
// `omp update` on the host, then offers "Reload profiles" (refresh every
// profile's model catalog and restart idle sessions still on the old binary).
// The server runs one job at a time; this view only starts jobs and follows
// GET /api/omp/job.

import { el, elem } from "../dom.js";
import { api } from "../api.js";
import { state, emit } from "../state.js";
import { showNotice } from "../notice.js";
import { formatAge } from "../format.js";

const POLL_MS = 1000;
const WATCH_MS = 6 * 60 * 60 * 1000;

let version = null; // last /api/omp/version reply
let job = null; // last /api/omp/job reply's job
let sectionOpen = false;
let poll = null;
let checking = false;
let watching = false;

function running() {
  return job?.state === "running";
}

function paintGear() {
  el["settings-btn"].classList.toggle("has-update", Boolean(version?.updateAvailable));
  el["settings-btn"].title = version?.updateAvailable ? `Settings · omp ${version.latest} available` : "Settings";
}

function paintVersion() {
  const rows = [
    ["Installed", version?.current || "—"],
    // Up to date: the check names no newer release, so latest is what runs.
    ["Latest", version?.latest || (version?.current && !version.error && !version.updateAvailable ? version.current : "—")],
  ];
  if (version?.channel) rows.push(["Channel", version.channel]);
  if (version?.checkedAt) rows.push(["Checked", formatAge(version.checkedAt)]);
  el["settings-omp-version"].replaceChildren(...rows.flatMap(([label, value]) => [
    elem("dt", { text: label }), elem("dd", { text: value }),
  ]));
  const status = el["settings-omp-status"];
  status.classList.toggle("is-error", Boolean(version?.error));
  if (checking) status.textContent = "Checking for updates…";
  else if (!version) status.textContent = "Version not checked yet.";
  else if (version.error) status.textContent = `Could not check for updates: ${version.error}`;
  else if (version.updateAvailable) status.textContent = `omp ${version.latest} is available.`;
  else status.textContent = "omp is up to date.";
  const update = el["settings-omp-update"];
  update.hidden = !version?.updateAvailable;
  update.textContent = `Update to ${version?.latest || "latest"}`;
  update.disabled = running();
  el["settings-omp-check"].disabled = checking || running();
}

function sessionTitle(id) {
  return state.sessions.find((session) => session.id === id)?.title || id;
}

function paintReloadCard() {
  const stale = Array.isArray(version?.staleSessions) ? version.staleSessions : [];
  const updated = job?.kind === "update" && job.state === "succeeded";
  const card = el["settings-omp-reload-card"];
  // A failed reload keeps the card so it can be retried after a fix.
  const retry = job?.kind === "reload" && job.state !== "succeeded";
  card.hidden = !updated && !stale.length && !retry;
  const profiles = state.meta?.profiles || [];
  const items = [elem("li", {
    text: `Refresh the model catalog of every profile${profiles.length ? ` (${profiles.join(", ")})` : ""}.`,
  })];
  if (stale.length) {
    items.push(elem("li", {},
      `Restart ${stale.length} session${stale.length === 1 ? "" : "s"} still on the old version: `,
      elem("span", { class: "set-omp-titles", text: stale.map((item) => item.title || item.id).join(", ") }),
      ". Busy ones are skipped.",
    ));
  } else {
    items.push(elem("li", { text: "No running session is on the old version." }));
  }
  el["settings-omp-reload-list"].replaceChildren(...items);
  el["settings-omp-reload"].disabled = running();
}

function describeResult(done) {
  if (done.kind === "update") {
    if (done.state === "succeeded") return `Updated omp${done.from ? ` from ${done.from}` : ""}${done.to ? ` to ${done.to}` : ""}. Reload profiles to use it in running sessions.`;
    return `Update failed${done.exitCode != null ? ` (exit ${done.exitCode})` : ""}. See the log below.`;
  }
  const result = done.result || {};
  const profiles = Array.isArray(result.profiles) ? result.profiles : [];
  const ok = profiles.filter((item) => item.ok).map((item) => item.name);
  const failed = profiles.filter((item) => !item.ok);
  const restarted = Array.isArray(result.restarted) ? result.restarted : [];
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];
  const parts = [];
  if (done.state !== "succeeded") parts.push(`Reload failed${done.exitCode != null ? ` (exit ${done.exitCode})` : ""}.`);
  parts.push(`Profiles refreshed: ${ok.length ? ok.join(", ") : "none"}.`);
  if (failed.length) parts.push(`Failed: ${failed.map((item) => `${item.name} (${item.error || "error"})`).join(", ")}.`);
  parts.push(`Restarted ${restarted.length} session${restarted.length === 1 ? "" : "s"}${restarted.length ? `: ${restarted.map(sessionTitle).join(", ")}` : ""}.`);
  if (skipped.length) parts.push(`Skipped: ${skipped.map((item) => `${sessionTitle(item.id)} (${item.reason})`).join(", ")}.`);
  return parts.join(" ");
}

function paintJob() {
  const log = el["settings-omp-log"];
  const result = el["settings-omp-result"];
  if (!job) {
    log.hidden = true;
    result.hidden = true;
    return;
  }
  // Stay pinned to the newest line unless the reader scrolled up to look back.
  const pinned = log.hidden || log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  const lines = Array.isArray(job.log) ? job.log : [];
  log.textContent = lines.length ? lines.join("\n") : (running() ? "Starting…" : "(no output)");
  log.hidden = false;
  if (pinned) log.scrollTop = log.scrollHeight;
  if (running()) {
    result.hidden = false;
    result.classList.remove("is-error");
    result.textContent = job.kind === "update" ? "Updating omp…" : "Reloading profiles…";
  } else {
    result.hidden = false;
    result.classList.toggle("is-error", job.state === "failed");
    result.textContent = describeResult(job);
  }
}

function paint() {
  paintVersion();
  paintReloadCard();
  paintJob();
}

async function loadVersion({ refresh = false } = {}) {
  checking = true;
  if (sectionOpen) paintVersion();
  try {
    version = await api(`/omp/version${refresh ? "?refresh=1" : ""}`);
  } catch (error) {
    version = { ...(version || {}), error: error.message, updateAvailable: false };
  } finally {
    checking = false;
  }
  paintGear();
  if (sectionOpen) paint();
}

// A job finishing changes what the server reports: the update moves the
// installed version and staleness; the reload changes catalogs and runners.
function onJobFinished(done) {
  void loadVersion();
  if (done.kind === "reload") {
    emit("meta:refresh");
    emit("sessions:refresh");
  }
}

function syncPoll() {
  const want = sectionOpen || running();
  if (want && !poll) poll = setInterval(() => void loadJob(), POLL_MS);
  else if (!want && poll) {
    clearInterval(poll);
    poll = null;
  }
}

async function loadJob() {
  const wasRunning = running();
  try {
    job = (await api("/omp/job"))?.job || null;
  } catch {
    return; // keep the last known job; the next tick retries
  }
  if (wasRunning && !running() && job) onJobFinished(job);
  syncPoll();
  if (sectionOpen) paint();
}

async function startJob(path, kind) {
  try {
    job = (await api(path, { method: "POST" }))?.job || null;
  } catch (error) {
    showNotice(error.code === "EBUSY" ? "Another omp job is still running" : `Could not start ${kind}: ${error.message}`, { tone: "error" });
    await loadJob();
    return;
  }
  syncPoll();
  paint();
}

export function show() {
  sectionOpen = true;
  paint();
  void loadVersion();
  void loadJob();
  syncPoll();
}

export function hide() {
  sectionOpen = false;
  syncPoll();
}

// Footer gear hint. Once on load and every 6 h: the server caches the check
// for as long, so this never adds network traffic of its own.
export function watchOmpUpdates() {
  if (watching) return;
  watching = true;
  void loadVersion();
  setInterval(() => void loadVersion(), WATCH_MS);
}

export function wire() {
  el["settings-omp-check"].onclick = () => loadVersion({ refresh: true });
  el["settings-omp-update"].onclick = () => {
    if (!confirm("Runs `omp update` on the host. Running sessions keep the old version until restarted.")) return;
    void startJob("/omp/update", "update");
  };
  el["settings-omp-reload"].onclick = () => startJob("/omp/reload", "reload");
}
