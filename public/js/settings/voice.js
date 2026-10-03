"use strict";
// Settings → Voice. Where dictation clips go: an OpenAI-compatible base URL,
// a model and the name of a stored credential (never the key itself). Test
// runs against the form as typed, so a URL or key can be checked before
// Save. Save asks main.js to refresh /api/meta, whose `transcribe` flag shows
// or hides the composer microphone without a reload.
//
// The fields sit in a plain div, not a <form>: "New key…" opens the shared
// credential <form> inline between them, and forms cannot nest.

import { el, elem } from "../dom.js";
import { api } from "../api.js";
import { emit } from "../state.js";
import { showNotice } from "../notice.js";
import { fetchCredentials, credentialForm } from "./credential-form.js";

const ENDPOINT = "/settings/voice";
const NEW_KEY = "\u0000new"; // cannot collide with a credential name

let stores = [];
let credentials = [];
let chosen = ""; // the selector's last real credential, restored when "New key…" is cancelled

function paintState(voice) {
  const node = el["settings-voice-state"];
  let tone = "warn";
  let pill = "Not configured";
  let text = "Voice input is off. Add a base URL, model and key to turn it on.";
  if (voice?.ready) {
    tone = "ok";
    pill = "Ready";
    text = "The microphone button shows in the composer.";
  } else if (voice?.configured) {
    tone = "error";
    pill = "Problem";
    text = voice.problem || "Voice input is configured but not ready.";
  }
  node.replaceChildren(elem("span", { class: `set-pill tone-${tone}`, text: pill }), " ", text);
}

function credentialOptions() {
  const select = el["settings-voice-credential"];
  const options = [elem("option", { value: "" }, credentials.length ? "Choose a key…" : "No keys yet")];
  for (const item of credentials) {
    const extra = item.hint ? ` (…${item.hint})` : "";
    options.push(elem("option", { value: item.name }, `${item.label || item.name}${extra}`));
  }
  // A saved name the list no longer carries still shows, so Save never
  // silently switches keys.
  if (chosen && !credentials.some((item) => item.name === chosen)) {
    options.push(elem("option", { value: chosen }, `${chosen} (not found)`));
  }
  options.push(elem("option", { value: NEW_KEY }, "New key…"));
  select.replaceChildren(...options);
  select.value = chosen;
}

function closeNewKey() {
  el["settings-voice-new"].replaceChildren();
  el["settings-voice-new"].hidden = true;
}

function openNewKey() {
  el["settings-voice-new"].replaceChildren(credentialForm({
    stores,
    taken: credentials.map((item) => item.name),
    heading: "New key",
    labelHint: "Voice API key",
    onCancel: () => {
      closeNewKey();
      el["settings-voice-credential"].value = chosen;
    },
    onSaved: async (item) => {
      closeNewKey();
      chosen = item?.name || "";
      showNotice(`${item?.label || "Key"} saved. Save voice settings to use it.`);
      await loadCredentials();
    },
  }));
  el["settings-voice-new"].hidden = false;
  el["settings-voice-new"].querySelector("input")?.focus();
}

function adopt(voice) {
  el["settings-voice-url"].value = voice?.baseUrl || "";
  el["settings-voice-model"].value = voice?.model || "";
  chosen = voice?.credential || "";
  paintState(voice);
}

async function loadCredentials() {
  try {
    ({ stores, credentials } = await fetchCredentials());
  } catch (err) {
    showNotice(`Could not load credentials: ${err.message}`, { tone: "error" });
  }
  credentialOptions();
}

async function load() {
  checkPill(null);
  closeNewKey();
  try {
    adopt(await api(ENDPOINT));
  } catch (err) {
    el["settings-voice-state"].textContent = `Could not load voice settings: ${err.message}`;
  }
  await loadCredentials();
}

function formValues() {
  return {
    baseUrl: el["settings-voice-url"].value.trim(),
    model: el["settings-voice-model"].value.trim(),
    credential: chosen,
  };
}

function checkPill(check) {
  const node = el["settings-voice-check"];
  node.hidden = !check;
  if (!check) return;
  node.textContent = check.text;
  node.className = `set-pill tone-${check.tone}`;
}

function describeTest(result) {
  const ms = `${Math.round(Number(result?.ms) || 0)} ms`;
  const status = Number(result?.status) || 0;
  if (result?.ok) return { text: `OK · HTTP ${status} · ${ms}`, tone: "ok" };
  // The server's error already names the status when there was one.
  const what = result?.error || (status ? `HTTP ${status}` : "Unreachable");
  return { text: `${what} · ${ms}`, tone: "error" };
}

async function test() {
  const button = el["settings-voice-test"];
  button.disabled = true;
  checkPill({ text: "Testing…", tone: "pending" });
  try {
    checkPill(describeTest(await api(`${ENDPOINT}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(formValues()),
    })));
  } catch (err) {
    checkPill({ text: err.message || "Test failed", tone: "error" });
  } finally {
    button.disabled = false;
  }
}

async function save() {
  const button = el["settings-voice-save"];
  button.disabled = true;
  try {
    adopt(await api(ENDPOINT, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(formValues()),
    }));
    credentialOptions();
    emit("meta:refresh");
    showNotice("Voice settings saved");
  } catch (err) {
    showNotice(err.message || "Could not save voice settings", { tone: "error" });
  } finally {
    button.disabled = false;
  }
}

export function show() {
  void load();
}

export function wire() {
  el["settings-voice-credential"].addEventListener("change", () => {
    const value = el["settings-voice-credential"].value;
    if (value === NEW_KEY) return openNewKey();
    chosen = value;
    closeNewKey();
    checkPill(null);
  });
  for (const id of ["settings-voice-url", "settings-voice-model"]) {
    el[id].addEventListener("input", () => checkPill(null));
  }
  el["settings-voice-test"].onclick = () => test();
  el["settings-voice-save"].onclick = () => save();
}
