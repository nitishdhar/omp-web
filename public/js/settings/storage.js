"use strict";
// Settings → Storage. Disk used by every session's transcripts and uploads,
// biggest first, with bulk delete for data nothing is running on. Live rows
// are never selectable: stopping a session is a sidebar decision, not cleanup.

import { el, elem } from "../dom.js";
import { api } from "../api.js";
import { emit } from "../state.js";
import { showNotice } from "../notice.js";
import { formatBytes, formatAge } from "../format.js";

const STATE_LABELS = { live: "Live", "not-running": "Not running", orphan: "Orphan" };
const DAY_MS = 24 * 60 * 60 * 1000;

let rows = [];
const selected = new Set(); // ids
let busy = false;

function deletable(row) {
  return row.state === "not-running" || row.state === "orphan";
}

function shownRows() {
  if (!el["settings-storage-filter"].checked) return rows;
  const days = Math.max(0, Number(el["settings-storage-days"].value) || 0);
  const cutoff = Date.now() - days * DAY_MS;
  // Unknown activity counts as old: nothing has touched it that we can see.
  return rows.filter((row) => deletable(row) && (Number(row.lastActivity) || 0) <= cutoff);
}

function selectedBytes() {
  return rows.filter((row) => selected.has(row.id)).reduce((sum, row) => sum + (Number(row.bytes) || 0), 0);
}

function paintDeleteButton() {
  const button = el["settings-storage-delete"];
  button.disabled = busy || selected.size === 0;
  button.textContent = selected.size
    ? `Delete selected (${selected.size} · ${formatBytes(selectedBytes())})`
    : "Delete selected";
  const eligible = shownRows().filter(deletable);
  const all = el["settings-storage-all"];
  all.disabled = busy || eligible.length === 0;
  all.checked = eligible.length > 0 && eligible.every((row) => selected.has(row.id));
}

function storageRow(row) {
  const name = row.title || row.id;
  const canDelete = deletable(row);
  const box = canDelete
    ? elem("input", {
      type: "checkbox",
      "aria-label": `Select ${name}`,
      checked: selected.has(row.id),
      disabled: busy,
      onchange: (event) => {
        if (event.currentTarget.checked) selected.add(row.id);
        else selected.delete(row.id);
        paintDeleteButton();
      },
    })
    : elem("span", { class: "set-storage-nobox", "aria-hidden": "true" });
  const meta = [formatAge(row.lastActivity), `${row.files || 0} file${row.files === 1 ? "" : "s"}`].join(" · ");
  return elem("li", { class: `set-storage-row state-${row.state}` },
    elem("label", { class: "set-storage-pick" }, box,
      elem("span", { class: "set-storage-main" },
        elem("span", { class: "set-storage-name", title: row.id, text: name }),
        elem("span", { class: "set-storage-meta", text: meta }),
      ),
    ),
    elem("span", { class: `set-badge state-${row.state}`, text: STATE_LABELS[row.state] || row.state }),
    elem("span", { class: "set-storage-size", text: formatBytes(row.bytes) }),
  );
}

function render() {
  const list = el["settings-storage-list"];
  const shown = shownRows();
  // Delete acts on what is visible: a row the filter hides drops its tick.
  for (const id of [...selected]) if (!shown.some((row) => row.id === id)) selected.delete(id);
  list.replaceChildren(...(shown.length
    ? shown.map(storageRow)
    : [elem("li", { class: "set-empty", text: rows.length ? "Nothing matches the filter." : "No session data on disk." })]));
  paintDeleteButton();
}

async function load({ refresh = false } = {}) {
  el["settings-storage-refresh"].disabled = true;
  try {
    const result = await api(`/stats/storage${refresh ? "?refresh=1" : ""}`);
    rows = Array.isArray(result?.sessions) ? result.sessions : [];
    // A row that went live or vanished since it was ticked must not stay selected.
    for (const id of [...selected]) {
      const row = rows.find((item) => item.id === id);
      if (!row || !deletable(row)) selected.delete(id);
    }
    el["settings-storage-totals"].textContent =
      `Transcripts ${formatBytes(result?.transcriptsBytes)} · Uploads ${formatBytes(result?.attachmentsBytes)}`;
  } catch (error) {
    el["settings-storage-totals"].textContent = `Could not measure storage: ${error.message}`;
  } finally {
    el["settings-storage-refresh"].disabled = false;
  }
  render();
}

async function deleteSelected() {
  const targets = rows.filter((row) => selected.has(row.id) && deletable(row));
  if (!targets.length || busy) return;
  const total = formatBytes(targets.reduce((sum, row) => sum + (Number(row.bytes) || 0), 0));
  const count = `${targets.length} session${targets.length === 1 ? "" : "s"}`;
  if (!confirm(`Delete ${count} permanently?\n\nRemoves their transcripts and uploads (${total}). They cannot be restored afterwards.`)) return;
  busy = true;
  render();
  const progress = el["settings-storage-progress"];
  const failures = [];
  let freed = 0;
  // Sequential on purpose: each delete takes the session's queue server-side,
  // and the progress line has to mean something.
  for (const [index, row] of targets.entries()) {
    progress.textContent = `Deleting ${index + 1} of ${targets.length}…`;
    try {
      const result = await api(`/sessions/${encodeURIComponent(row.id)}/data`, { method: "DELETE" });
      freed += Number(result?.freed?.bytes) || 0;
      selected.delete(row.id);
    } catch (error) {
      failures.push(`${row.title || row.id}: ${error.message}`);
    }
  }
  busy = false;
  const done = targets.length - failures.length;
  progress.textContent = failures.length
    ? `Deleted ${done} of ${targets.length}. Failed: ${failures.join("; ")}`
    : `Deleted ${done} · freed ${formatBytes(freed)}`;
  showNotice(failures.length ? `${failures.length} delete${failures.length === 1 ? "" : "s"} failed` : `Freed ${formatBytes(freed)}`,
    { tone: failures.length ? "error" : "info" });
  emit("sessions:refresh");
  await load({ refresh: true });
}

export function show() {
  void load();
}

export function wire() {
  el["settings-storage-refresh"].onclick = () => load({ refresh: true });
  el["settings-storage-filter"].addEventListener("change", render);
  el["settings-storage-days"].addEventListener("input", () => {
    if (el["settings-storage-filter"].checked) render();
  });
  el["settings-storage-all"].addEventListener("change", (event) => {
    for (const row of shownRows().filter(deletable)) {
      if (event.currentTarget.checked) selected.add(row.id);
      else selected.delete(row.id);
    }
    render();
  });
  el["settings-storage-delete"].onclick = () => deleteSelected();
}
