"use strict";
// Settings → Credentials. Lists named secrets by metadata only (the server
// never returns a value; `hint` is at most the last four characters) and
// edits them one row at a time. Every change repaints from the server reply.
// A change can flip voice readiness (the key it uses was replaced or moved),
// so each one asks main.js to refresh /api/meta.

import { el, elem } from "../dom.js";
import { api } from "../api.js";
import { emit } from "../state.js";
import { showNotice } from "../notice.js";
import { formatAge } from "../format.js";
import {
  ENDPOINT, fetchCredentials, putCredential, storeLabel, storeSelect,
  valueInput, valueProblem, credentialForm,
} from "./credential-form.js";
import * as ompEnv from "./omp-env.js";

let stores = [];
let credentials = [];
let editing = null; // { name, mode: "replace" | "store" }

function updatedText(updatedAt) {
  const ms = typeof updatedAt === "number" ? updatedAt : Date.parse(updatedAt);
  return Number.isFinite(ms) && ms > 0 ? `Updated ${formatAge(ms)}` : "";
}

function usedByText(item) {
  const users = Array.isArray(item.usedBy) ? item.usedBy.map((user) => user.label).filter(Boolean) : [];
  return users.length ? users.join(", ") : "";
}

function changed(message) {
  editing = null;
  emit("meta:refresh");
  showNotice(message);
  void load();
}

function editorForm(item, controls, build) {
  const error = elem("p", { class: "set-error", role: "alert", hidden: true });
  const save = elem("button", { class: "primary set-btn", type: "submit" }, "Save");
  const form = elem("form", { class: "set-cred-edit", novalidate: true },
    ...controls,
    error,
    elem("div", { class: "set-actions" },
      elem("span", { class: "spacer" }),
      elem("button", { class: "ghost set-btn", type: "button", onclick: () => { editing = null; render(); } }, "Cancel"),
      save,
    ),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    const built = build();
    if (built.problem) {
      error.textContent = built.problem;
      error.hidden = false;
      return;
    }
    save.disabled = true;
    try {
      await putCredential(item.name, built.body);
      built.clear?.();
      changed(built.done);
    } catch (err) {
      error.textContent = err.message || "Could not save the change.";
      error.hidden = false;
      save.disabled = false;
    }
  });
  return form;
}

function field(text, input) {
  return elem("label", { class: "set-field" }, elem("span", { text }), input);
}

function replaceEditor(item) {
  const value = valueInput("New value");
  return editorForm(item, [field("New value", value)], () => ({
    problem: valueProblem(value.value),
    body: { value: value.value },
    clear: () => { value.value = ""; },
    done: `${item.label} value replaced`,
  }));
}

// The server moves the value itself (writes the new store, then deletes the
// old), so this editor never asks for it again.
function storeEditor(item) {
  const reason = elem("p", { class: "set-note", hidden: true });
  const target = storeSelect(stores, { exclude: item.store, reasonNode: reason, label: "Move to" });
  return editorForm(item, [field("Move to", target), reason], () => {
    const option = target.selectedOptions[0];
    if (!option || option.disabled) return { problem: "No other store is available on this machine." };
    return { body: { store: option.value }, done: `${item.label} moved to ${storeLabel(option.value)}` };
  });
}

async function remove(item) {
  if (!confirm(`Delete ${item.label} (${item.name})? Its value is removed from ${storeLabel(item.store)} and cannot be shown again.`)) return;
  try {
    await api(`${ENDPOINT}/${encodeURIComponent(item.name)}`, { method: "DELETE" });
    changed(`${item.label} deleted`);
  } catch (err) {
    showNotice(err.message || "Could not delete the credential", { tone: "error" });
    void load();
  }
}

function row(item) {
  const users = usedByText(item);
  const open = editing?.name === item.name ? editing.mode : null;
  const meta = [item.hint ? `…${item.hint}` : "", updatedText(item.updatedAt)].filter(Boolean).join(" · ");
  const button = (text, mode) => elem("button", {
    class: "ghost set-btn", type: "button", "aria-label": `${text}: ${item.label}`, "aria-expanded": String(open === mode),
    onclick: () => { editing = open === mode ? null : { name: item.name, mode }; render(); },
  }, text);
  return elem("li", { class: `set-panel set-cred${open ? " is-open" : ""}` },
    elem("div", { class: "set-panel-main" },
      elem("div", { class: "set-panel-title" },
        elem("strong", { text: item.label || item.name }),
        elem("code", { class: "set-panel-id", text: item.name }),
        elem("span", { class: `set-badge store-${item.store}`, text: storeLabel(item.store) }),
      ),
      meta ? elem("div", { class: "set-cred-meta", text: meta }) : null,
      elem("div", { class: "set-panel-lock", text: users ? `Used by ${users} · switch it to another key before deleting` : "Not used" }),
    ),
    elem("div", { class: "set-panel-actions" },
      button("Replace value", "replace"),
      button("Change store", "store"),
      elem("button", {
        class: "danger set-btn", type: "button", disabled: Boolean(users),
        title: users ? `In use by ${users}. Point it at another key first.` : `Delete ${item.label}`,
        "aria-label": users ? `Delete ${item.label} (in use by ${users})` : `Delete ${item.label}`,
        onclick: () => remove(item),
      }, "Delete"),
    ),
    open === "replace" ? replaceEditor(item) : null,
    open === "store" ? storeEditor(item) : null,
  );
}

function render() {
  const rows = credentials.map(row);
  if (!rows.length) rows.push(elem("li", { class: "set-empty", text: "No credentials yet. Add one below." }));
  el["settings-credentials-list"].replaceChildren(...rows);
}

// Rebuilt only after a load, so opening a row editor keeps a half-filled add
// form intact; a load means the store list or the taken names may differ.
function renderAddForm() {
  el["settings-credential-add"].replaceChildren(credentialForm({
    stores,
    taken: credentials.map((item) => item.name),
    onSaved: (item) => changed(`${item?.label || "Credential"} saved`),
  }));
}

async function load() {
  el["settings-credentials-status"].textContent = "";
  try {
    ({ stores, credentials } = await fetchCredentials());
  } catch (err) {
    el["settings-credentials-status"].textContent = `Could not load credentials: ${err.message}`;
  }
  // A row whose credential vanished (another tab deleted it) closes its editor.
  if (editing && !credentials.some((item) => item.name === editing.name)) editing = null;
  render();
  renderAddForm();
  // Saving the OMP list changes these rows' "used by", so it reloads them.
  void ompEnv.refresh(credentials, { saved: load });
}

export function show() {
  editing = null;
  void load();
}
