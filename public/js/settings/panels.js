"use strict";
// Settings → Panels. Edits a local draft of the settings-sourced panel list;
// Save replaces the whole list server-side and repaints from the reply, so the
// rows never show an entry the server refused. Env panels (OMP_WEB_PANELS) are
// listed first and locked: the server owns them and settings cannot shadow them.

import { el, elem } from "../dom.js";
import { api } from "../api.js";
import { emit } from "../state.js";
import { showNotice } from "../notice.js";
import { slugify } from "../format.js";

const ENDPOINT = "/settings/panels";

let envRows = []; // [{id,label,url,source:"env"}]
let draft = []; // [{key,id,label,url}] settings rows in display order
let saved = []; // last server-confirmed settings rows, for the changed-frames diff
let dirty = false;
let editing = null; // draft key with its inline editor open
let idTouched = false; // the add form stops auto-slugging once the id is edited
let keySeq = 0;
const checks = new Map(); // url -> { text, tone }

function withKey(panel) {
  return { key: ++keySeq, id: panel.id, label: panel.label, url: panel.url };
}

function adopt(list) {
  const panels = Array.isArray(list) ? list : [];
  envRows = panels.filter((panel) => panel.source === "env");
  draft = panels.filter((panel) => panel.source !== "env").map(withKey);
  saved = draft.map(({ id, url }) => ({ id, url }));
  dirty = false;
  editing = null;
}

function setDirty(value = true) {
  dirty = value;
  el["settings-panels-save"].disabled = !dirty;
  el["settings-panels-status"].textContent = dirty ? "Unsaved changes" : "";
}

function pill(url) {
  const check = checks.get(url);
  if (!check) return null;
  return elem("span", { class: `set-pill tone-${check.tone}`, text: check.text });
}

function describeCheck(result) {
  const ms = `${Math.round(Number(result?.ms) || 0)} ms`;
  if (!result?.ok) return { text: `${result?.error || "Unreachable"} · ${ms}`, tone: "error" };
  const status = Number(result.status) || 0;
  if (status >= 200 && status < 400) return { text: `Reachable · HTTP ${status} · ${ms}`, tone: "ok" };
  return { text: `HTTP ${status} · ${ms}`, tone: "warn" };
}

async function runCheck(url) {
  try {
    return describeCheck(await api(`${ENDPOINT}/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }));
  } catch (error) {
    return { text: error.message || "Check failed", tone: "error" };
  }
}

async function testRow(url, button) {
  button.disabled = true;
  checks.set(url, { text: "Testing…", tone: "pending" });
  render();
  checks.set(url, await runCheck(url));
  render();
}

function idTaken(id, exceptKey = null) {
  return envRows.some((panel) => panel.id === id)
    || draft.some((row) => row.id === id && row.key !== exceptKey);
}

// Mirrors only what the user can fix before Save; the server is the authority
// for every other rule and its message names the offending entry.
function localProblem({ id, label, url }, exceptKey = null) {
  if (!label) return "Give the panel a label.";
  if (!id) return "Give the panel an id.";
  if (!url) return "Give the panel a URL.";
  if (idTaken(id, exceptKey)) return `The id "${id}" is already used.`;
  return "";
}

function move(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= draft.length) return;
  [draft[index], draft[target]] = [draft[target], draft[index]];
  setDirty();
  render();
}

function actionButton(text, label, onclick, extra = {}) {
  return elem("button", { class: "ghost set-btn", type: "button", "aria-label": label, title: label, onclick, ...extra }, text);
}

function envRow(panel) {
  return elem("li", { class: "set-panel is-locked" },
    elem("div", { class: "set-panel-main" },
      elem("div", { class: "set-panel-title" },
        elem("strong", { text: panel.label }),
        elem("code", { class: "set-panel-id", text: panel.id }),
        elem("span", { class: "set-badge", text: "Env" }),
      ),
      elem("div", { class: "set-panel-url", text: panel.url }),
      elem("div", { class: "set-panel-lock", text: "Locked · set in OMP_WEB_PANELS" }),
      pill(panel.url),
    ),
    elem("div", { class: "set-panel-actions" },
      actionButton("Test", `Test ${panel.label}`, (event) => testRow(panel.url, event.currentTarget)),
    ),
  );
}

function editorRow(row) {
  const label = elem("input", { type: "text", maxlength: "40", value: row.label, "aria-label": "Label" });
  const id = elem("input", { type: "text", maxlength: "40", value: row.id, "aria-label": "Id", autocapitalize: "none", spellcheck: "false" });
  const url = elem("input", { type: "url", value: row.url, "aria-label": "URL", autocapitalize: "none", spellcheck: "false" });
  const error = elem("p", { class: "set-error", role: "alert", hidden: true });
  const form = elem("form", { class: "set-panel-edit", novalidate: true },
    elem("label", { class: "set-field" }, elem("span", { text: "Label" }), label),
    elem("label", { class: "set-field" }, elem("span", { text: "Id" }), id),
    elem("label", { class: "set-field" }, elem("span", { text: "URL" }), url),
    error,
    elem("div", { class: "set-actions" },
      elem("span", { class: "spacer" }),
      elem("button", { class: "ghost set-btn", type: "button", onclick: () => { editing = null; render(); } }, "Cancel"),
      elem("button", { class: "primary set-btn", type: "submit" }, "Done"),
    ),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = { id: id.value.trim(), label: label.value.trim(), url: url.value.trim() };
    const problem = localProblem(next, row.key);
    if (problem) {
      error.textContent = problem;
      error.hidden = false;
      return;
    }
    Object.assign(row, next);
    editing = null;
    setDirty();
    render();
  });
  return elem("li", { class: "set-panel is-editing" }, form);
}

function settingsRow(row, index) {
  if (row.key === editing) return editorRow(row);
  return elem("li", { class: "set-panel" },
    elem("div", { class: "set-panel-main" },
      elem("div", { class: "set-panel-title" },
        elem("strong", { text: row.label }),
        elem("code", { class: "set-panel-id", text: row.id }),
        elem("span", { class: "set-badge", text: "Settings" }),
      ),
      elem("div", { class: "set-panel-url", text: row.url }),
      pill(row.url),
    ),
    elem("div", { class: "set-panel-actions" },
      actionButton("Test", `Test ${row.label}`, (event) => testRow(row.url, event.currentTarget)),
      actionButton("Edit", `Edit ${row.label}`, () => { editing = row.key; render(); }),
      actionButton("↑", `Move ${row.label} up`, () => move(index, -1), { disabled: index === 0 }),
      actionButton("↓", `Move ${row.label} down`, () => move(index, 1), { disabled: index === draft.length - 1 }),
      elem("button", {
        class: "danger set-btn", type: "button", title: `Remove ${row.label}`, "aria-label": `Remove ${row.label}`,
        onclick: () => {
          draft = draft.filter((item) => item.key !== row.key);
          setDirty();
          render();
        },
      }, "Remove"),
    ),
  );
}

function render() {
  const list = el["settings-panels-list"];
  const rows = [...envRows.map(envRow), ...draft.map(settingsRow)];
  if (!rows.length) rows.push(elem("li", { class: "set-empty", text: "No panels yet. Add a local app below." }));
  list.replaceChildren(...rows);
}

async function load() {
  try {
    const result = await api(ENDPOINT);
    adopt(result?.panels);
    setDirty(false);
  } catch (error) {
    el["settings-panels-status"].textContent = `Could not load panels: ${error.message}`;
  }
  render();
}

async function save() {
  const button = el["settings-panels-save"];
  button.disabled = true;
  el["settings-panels-status"].textContent = "Saving…";
  const before = saved;
  try {
    const result = await api(ENDPOINT, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ panels: draft.map(({ id, label, url }) => ({ id, label, url })) }),
    });
    adopt(result?.panels);
    setDirty(false);
    render();
    // A frame already opened for a removed or re-pointed panel still shows the
    // old app; main.js drops those frames before the sidebar repaints.
    const changed = before
      .filter((old) => !saved.some((now) => now.id === old.id && now.url === old.url))
      .map((old) => old.id);
    emit("panels:saved", { changed });
    showNotice("Panels saved");
  } catch (error) {
    el["settings-panels-status"].textContent = error.message || "Could not save panels";
    showNotice(error.message || "Could not save panels", { tone: "error" });
    button.disabled = false;
  }
}

function addCheckPill(check) {
  const node = el["settings-panel-check"];
  if (!check) {
    node.hidden = true;
    return;
  }
  node.textContent = check.text;
  node.className = `set-pill tone-${check.tone}`;
  node.hidden = false;
}

function resetAddForm() {
  el["settings-panel-label"].value = "";
  el["settings-panel-id"].value = "";
  el["settings-panel-url"].value = "";
  idTouched = false;
  addCheckPill(null);
}

export function show() {
  // Navigating away and back keeps an unsaved draft; a clean list reloads so
  // another tab's save shows up.
  if (!dirty) void load();
  else render();
}

export function wire() {
  el["settings-panel-label"].addEventListener("input", () => {
    if (!idTouched) el["settings-panel-id"].value = slugify(el["settings-panel-label"].value, 40);
  });
  el["settings-panel-id"].addEventListener("input", () => {
    idTouched = el["settings-panel-id"].value !== "";
  });
  el["settings-panel-url"].addEventListener("blur", () => {
    if (el["settings-panel-url"].value === "http://127.0.0.1:") el["settings-panel-url"].value = "";
  });
  el["settings-panel-url"].addEventListener("focus", () => {
    if (!el["settings-panel-url"].value) el["settings-panel-url"].value = "http://127.0.0.1:";
  });
  el["settings-panel-url"].addEventListener("input", () => addCheckPill(null));
  el["settings-panel-test"].onclick = async () => {
    const url = el["settings-panel-url"].value.trim();
    if (!url) {
      addCheckPill({ text: "Enter a URL first", tone: "error" });
      return;
    }
    el["settings-panel-test"].disabled = true;
    addCheckPill({ text: "Testing…", tone: "pending" });
    const check = await runCheck(url);
    checks.set(url, check);
    addCheckPill(check);
    el["settings-panel-test"].disabled = false;
  };
  el["settings-panel-form"].addEventListener("submit", (event) => {
    event.preventDefault();
    const next = {
      label: el["settings-panel-label"].value.trim(),
      id: el["settings-panel-id"].value.trim(),
      url: el["settings-panel-url"].value.trim(),
    };
    const problem = localProblem(next);
    if (problem) {
      addCheckPill({ text: problem, tone: "error" });
      return;
    }
    draft.push(withKey(next));
    resetAddForm();
    setDirty();
    render();
  });
  el["settings-panels-save"].onclick = () => save();
}
