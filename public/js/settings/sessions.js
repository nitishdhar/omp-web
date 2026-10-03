"use strict";
// Settings → Sessions & memory. What omp-web's own panes are costing right now
// (/api/stats), a one-shot "sleep idle Terminal sessions", and the two idle
// timers. Env-set timers are locked: the server refuses to override them.

import { el, elem } from "../dom.js";
import { api } from "../api.js";
import { state, emit } from "../state.js";
import { showNotice } from "../notice.js";
import { statusLabel } from "../session-status.js";
import { formatBytes } from "../format.js";

const POLL_MS = 10000;
const TIMERS = [
  { key: "rpcIdleMinutes", input: "settings-rpc-idle", note: "settings-rpc-idle-note", env: "OMP_WEB_RPC_IDLE_MINUTES" },
  { key: "tuiIdleMinutes", input: "settings-tui-idle", note: "settings-tui-idle-note", env: "OMP_WEB_TUI_IDLE_MINUTES" },
];

let poll = null;
let loading = false;
let runtime = null;

function runnerLabel(row) {
  if (row.type === "shell") return "Shell";
  return row.runner === "rpc" ? "Chat" : row.runner === "tui" ? "Terminal" : "—";
}

function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}

function renderTotals(totals = {}) {
  const parts = [
    `${plural(totals.ompProcesses || 0, "omp process", "omp processes")} using ${formatBytes(totals.ompRssBytes || 0)}`,
    `${totals.tui || 0} Terminal`,
    `${totals.rpcActive || 0} Chat running`,
    `${totals.rpcIdle || 0} Chat asleep`,
    `${totals.shell || 0} Shell`,
  ];
  el["settings-stats-totals"].textContent = parts.join(" · ");
}

function cell(className, ...children) {
  return elem("div", { class: `set-cell ${className}`, role: "cell" }, ...children);
}

function sessionRow(row) {
  const status = row.type === "shell" ? "shell" : row.status;
  const runner = runnerLabel(row);
  return elem("div", { class: `set-tr${row.active ? "" : " is-asleep"}`, role: "row" },
    cell("set-c-title",
      elem("span", { class: `session-status-indicator dot status-${status || "unknown"}`, title: statusLabel(status), "aria-label": statusLabel(status), role: "img" }),
      elem("span", { class: "set-c-name", title: row.title || row.id, text: row.title || row.id }),
      row.attached ? elem("span", { class: "set-tag", text: "open" }) : null,
    ),
    cell("set-c-runner", elem("span", { class: `set-badge runner-${runner.toLowerCase()}`, text: runner })),
    cell("set-c-mem", row.rssBytes ? formatBytes(row.rssBytes) : "—"),
    cell("set-c-procs", String(row.processes || 0)),
  );
}

function renderSessions(rows) {
  const head = elem("div", { class: "set-tr set-th", role: "row" },
    elem("div", { class: "set-cell set-c-title", role: "columnheader", text: "Session" }),
    elem("div", { class: "set-cell set-c-runner", role: "columnheader", text: "Runner" }),
    elem("div", { class: "set-cell set-c-mem", role: "columnheader", text: "Memory" }),
    elem("div", { class: "set-cell set-c-procs", role: "columnheader", text: "Procs" }),
  );
  const body = rows.length
    ? rows.map(sessionRow)
    : [elem("p", { class: "set-empty", text: "No live sessions." })];
  el["settings-stats-list"].replaceChildren(head, ...body);
}

async function loadStats() {
  if (loading) return;
  loading = true;
  try {
    const stats = await api("/stats");
    renderTotals(stats?.totals);
    renderSessions(Array.isArray(stats?.sessions) ? stats.sessions : []);
  } catch (error) {
    el["settings-stats-totals"].textContent = `Could not read process stats: ${error.message}`;
  } finally {
    loading = false;
  }
}

function paintRuntime() {
  for (const timer of TIMERS) {
    const info = runtime?.[timer.key];
    const input = el[timer.input];
    if (!info) continue;
    input.min = String(info.min);
    input.max = String(info.max);
    // A reply landing while the user types must not overwrite their number.
    if (document.activeElement !== input) input.value = String(info.value);
    const locked = info.source === "env";
    input.disabled = locked;
    el[timer.note].textContent = locked
      ? `Locked · set by ${timer.env}`
      : `${info.min}–${info.max} minutes · default ${info.default}${info.source === "default" ? " (in use)" : ""}`;
  }
  el["settings-runtime-save"].disabled = TIMERS.every((timer) => runtime?.[timer.key]?.source === "env");
}

async function loadRuntime() {
  try {
    runtime = await api("/settings/runtime");
    paintRuntime();
  } catch (error) {
    el["settings-rpc-idle-note"].textContent = `Could not load timers: ${error.message}`;
  }
}

async function saveRuntime() {
  const body = {};
  for (const timer of TIMERS) {
    if (runtime?.[timer.key]?.source === "env") continue;
    const value = el[timer.input].valueAsNumber;
    if (!Number.isFinite(value)) {
      showNotice("Enter a number of minutes", { tone: "error" });
      el[timer.input].focus();
      return;
    }
    body[timer.key] = value;
  }
  el["settings-runtime-save"].disabled = true;
  try {
    runtime = await api("/settings/runtime", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    paintRuntime();
    showNotice("Timers saved · new sessions and the next sweep use them");
  } catch (error) {
    showNotice(error.message || "Could not save timers", { tone: "error" });
    el["settings-runtime-save"].disabled = false;
  }
}

function describeSleep(result) {
  const converted = Array.isArray(result?.converted) ? result.converted : [];
  const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
  const name = (id) => state.sessions.find((session) => session.id === id)?.title || id;
  const lines = [converted.length
    ? `Put ${plural(converted.length, "Terminal session")} to sleep.`
    : "No Terminal session was put to sleep."];
  if (skipped.length) {
    lines.push(`Skipped ${skipped.length}: ${skipped.map((item) => `${name(item.id)} (${item.reason})`).join(", ")}.`);
  }
  return lines.join(" ");
}

async function sleepIdle() {
  const button = el["settings-sleep-btn"];
  const result = el["settings-sleep-result"];
  button.disabled = true;
  result.hidden = false;
  result.classList.remove("is-error");
  result.textContent = "Working…";
  try {
    result.textContent = describeSleep(await api("/sessions/sleep-idle", { method: "POST" }));
    // Runner badges in the sidebar and here both changed.
    emit("sessions:refresh");
    await loadStats();
  } catch (error) {
    result.textContent = `Could not put sessions to sleep: ${error.message}`;
    result.classList.add("is-error");
  } finally {
    button.disabled = false;
  }
}

function onVisibility() {
  if (poll && document.visibilityState === "visible") void loadStats();
}

export function show() {
  void loadStats();
  void loadRuntime();
  clearInterval(poll);
  // Polls only while this section is on screen: index.js calls hide() on
  // every section switch and when the page closes.
  poll = setInterval(() => {
    if (document.visibilityState === "visible") void loadStats();
  }, POLL_MS);
  document.addEventListener("visibilitychange", onVisibility);
}

export function hide() {
  clearInterval(poll);
  poll = null;
  document.removeEventListener("visibilitychange", onVisibility);
}

export function wire() {
  el["settings-sleep-btn"].onclick = () => sleepIdle();
  el["settings-runtime-form"].addEventListener("submit", (event) => {
    event.preventDefault();
    void saveRuntime();
  });
}
