"use strict";
// Settings → Credentials → Passed to OMP: environment variables new OMP
// sessions start with, each filled from a stored credential. Edits a local
// draft like Settings → Panels; Save replaces the whole list and repaints from
// the reply, whose per-row ok/problem is the server's check of each credential.
// Only names travel here; the server resolves values when it spawns omp.

import { el, elem } from "../dom.js";
import { api } from "../api.js";
import { showNotice } from "../notice.js";

const ENDPOINT = "/settings/omp-env";
const VAR_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAX_ENTRIES = 32;
// Mirrors the server's list (it stays the authority) so a name omp-web or the
// shell depends on is refused at Add, not only at Save.
const RESERVED = new Set(["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "TMPDIR", "PWD", "NODE_OPTIONS"]);
const RESERVED_PREFIXES = ["LC_", "TMUX", "DYLD_", "LD_", "OMP_WEB_"];

function reserved(name) {
  return RESERVED.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

let draft = []; // [{var, credential, ok?, problem?, saved}]
let credentials = []; // [{name, label, hint}] for labels and the picker
let dirty = false;
let onSaved = null; // credentials.js reloads its rows: "used by" changed

function setDirty(value = true) {
  dirty = value;
  el["settings-omp-env-save"].disabled = !dirty;
  el["settings-omp-env-status"].textContent = dirty ? "Unsaved changes" : "";
}

function fail(message) {
  el["settings-omp-env-error"].textContent = message;
}

function credentialText(name, hint) {
  const item = credentials.find((entry) => entry.name === name);
  const shown = hint || item?.hint;
  return `${item?.label || name}${shown ? ` (…${shown})` : ""}`;
}

function statusPill(entry) {
  if (!entry.saved) return elem("span", { class: "set-pill tone-warn", text: "Unsaved" });
  if (entry.ok) return elem("span", { class: "set-pill tone-ok", text: "OK" });
  return elem("span", { class: "set-pill tone-error", text: entry.problem || "Problem", title: entry.problem || "" });
}

function row(entry, index) {
  return elem("li", { class: "set-root set-omp-env-row" },
    elem("code", { class: "set-omp-env-var", text: entry.var }),
    elem("span", { class: "set-omp-env-arrow", "aria-hidden": "true", text: "←" }),
    elem("span", { class: "set-omp-env-cred", text: credentialText(entry.credential, entry.credentialHint) }),
    statusPill(entry),
    elem("button", {
      class: "ghost set-root-remove", type: "button", title: `Stop passing ${entry.var}`, "aria-label": `Stop passing ${entry.var}`,
      onclick: () => {
        draft.splice(index, 1);
        setDirty();
        render();
      },
    }, "×"),
  );
}

function render() {
  const rows = draft.map(row);
  if (!rows.length) rows.push(elem("li", { class: "set-empty", text: "Nothing passed to OMP." }));
  el["settings-omp-env-list"].replaceChildren(...rows);
}

function paintPicker() {
  const select = el["settings-omp-env-credential"];
  const current = select.value;
  const options = credentials.map((item) => elem("option", { value: item.name }, credentialText(item.name)));
  if (!options.length) options.push(elem("option", { value: "", disabled: true, selected: true }, "Add a credential first"));
  select.replaceChildren(...options);
  if (credentials.some((item) => item.name === current)) select.value = current;
  el["settings-omp-env-add"].disabled = !credentials.length;
}

function adopt(result) {
  const entries = Array.isArray(result?.entries) ? result.entries : [];
  draft = entries.map((entry) => ({ ...entry, saved: true }));
  setDirty(false);
}

async function save() {
  const button = el["settings-omp-env-save"];
  button.disabled = true;
  fail("");
  el["settings-omp-env-status"].textContent = "Saving…";
  try {
    adopt(await api(ENDPOINT, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries: draft.map((entry) => ({ var: entry.var, credential: entry.credential })) }),
    }));
    render();
    showNotice("OMP variables saved");
    onSaved?.();
  } catch (err) {
    el["settings-omp-env-status"].textContent = "Not saved";
    fail(err.message || "Could not save OMP variables");
    button.disabled = false;
  }
}

function add(event) {
  event.preventDefault();
  fail("");
  const input = el["settings-omp-env-var"];
  const name = input.value.trim().toUpperCase();
  const credential = el["settings-omp-env-credential"].value;
  if (!VAR_RE.test(name)) return fail("Variable names use A–Z, 0–9 and _, and do not start with a digit.");
  if (reserved(name)) return fail(`${name} is reserved: omp-web or the shell sets it.`);
  if (draft.some((entry) => entry.var === name)) return fail(`${name} is already in the list.`);
  if (draft.length >= MAX_ENTRIES) return fail(`At most ${MAX_ENTRIES} variables.`);
  if (!credential) return fail("Choose a credential.");
  draft.push({ var: name, credential, saved: false });
  input.value = "";
  setDirty();
  render();
}

// Called on every Credentials load. A dirty draft survives (the user is mid
// edit); only the labels and the picker follow the fresh credential list.
export async function refresh(list, { saved } = {}) {
  credentials = list;
  onSaved = saved;
  paintPicker();
  if (!dirty) {
    fail("");
    try {
      adopt(await api(ENDPOINT));
    } catch (err) {
      fail(`Could not load OMP variables: ${err.message}`);
    }
  }
  render();
}

export function wire() {
  // Upper-cased as typed so what shows is the name the session gets.
  el["settings-omp-env-var"].addEventListener("input", (event) => {
    const input = event.currentTarget;
    const at = input.selectionStart;
    input.value = input.value.toUpperCase();
    input.setSelectionRange(at, at);
    fail("");
  });
  el["settings-omp-env-form"].addEventListener("submit", add);
  el["settings-omp-env-save"].onclick = () => save();
}
