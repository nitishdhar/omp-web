"use strict";
// Pieces shared by Settings → Credentials and the Voice section's "New key…":
// the add form, the store picker and the one PUT both use.
//
// A secret value only ever lives in a password input's own value: it is read
// at submit, sent once, and the input is cleared on success. Nothing here
// copies it into state.js, a closure variable or a log line.

import { elem } from "../dom.js";
import { api } from "../api.js";
import { slugify } from "../format.js";

export const ENDPOINT = "/settings/credentials";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const STORE_LABELS = { file: "File", keychain: "Keychain" };
const STORE_OPTIONS = { file: "File on this machine", keychain: "macOS Keychain" };

export function storeLabel(id) {
  return STORE_LABELS[id] || id;
}

export async function fetchCredentials() {
  const result = await api(ENDPOINT);
  return {
    stores: Array.isArray(result?.stores) ? result.stores : [],
    credentials: Array.isArray(result?.credentials) ? result.credentials : [],
  };
}

export function putCredential(name, body) {
  return api(`${ENDPOINT}/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Unavailable stores stay visible but disabled, and `reasonNode` says why, so
// "where did Keychain go" never needs answering.
export function storeSelect(stores, { selected = "file", exclude = null, reasonNode = null, label = "Store" } = {}) {
  const select = elem("select", { "aria-label": label });
  const reasons = [];
  for (const store of stores) {
    if (store.id === exclude) continue;
    const text = STORE_OPTIONS[store.id] || store.id;
    const option = elem("option", { value: store.id, disabled: !store.available }, store.available ? text : `${text} (unavailable)`);
    if (store.id === selected && store.available) option.selected = true;
    select.append(option);
    if (!store.available) reasons.push(`${storeLabel(store.id)} is unavailable${store.reason ? `: ${store.reason}` : ""}.`);
  }
  // With every option disabled the select would render blank.
  if (!select.querySelector("option:not([disabled])")) {
    select.prepend(elem("option", { value: "", disabled: true, selected: true }, "No other store available"));
  }
  if (reasonNode) {
    reasonNode.textContent = reasons.join(" ");
    reasonNode.hidden = !reasons.length;
  }
  return select;
}

export function valueInput(label = "Value") {
  return elem("input", {
    type: "password", autocomplete: "off", autocapitalize: "none", spellcheck: "false",
    maxlength: "8192", "aria-label": label,
  });
}

export function valueProblem(value) {
  if (!value) return "Enter the value.";
  if (value.length > 8192) return "The value is longer than 8192 characters.";
  if (/[\r\n]/.test(value)) return "The value cannot contain line breaks.";
  return "";
}

function field(text, input) {
  return elem("label", { class: "set-field" }, elem("span", { text }), input);
}

// `taken` names the existing credentials so the form refuses an accidental
// overwrite: PUT on an existing name would replace that value.
export function credentialForm({ stores, taken = [], heading = "Add a credential", labelHint = "", onSaved, onCancel }) {
  let nameTouched = false;
  const label = elem("input", { type: "text", maxlength: "60", autocomplete: "off", placeholder: labelHint || "Transcription API key" });
  const name = elem("input", { type: "text", maxlength: "48", autocomplete: "off", autocapitalize: "none", spellcheck: "false", placeholder: "voice-api-key" });
  const reason = elem("p", { class: "set-note", hidden: true });
  const store = storeSelect(stores, { reasonNode: reason });
  const value = valueInput();
  const valueField = field("Value", value);
  const error = elem("p", { class: "set-error", role: "alert", hidden: true });
  const submit = elem("button", { class: "primary set-btn", type: "submit" }, "Save credential");

  function fail(message) {
    error.textContent = message;
    error.hidden = false;
  }

  label.addEventListener("input", () => {
    if (!nameTouched) name.value = slugify(label.value, 48);
  });
  name.addEventListener("input", () => { nameTouched = name.value !== ""; });

  const form = elem("form", { class: "set-panel-form set-cred-form", novalidate: true },
    elem("h3", { text: heading }),
    field("Label", label),
    field("Name", name),
    field("Store", store),
    reason,
    valueField,
    error,
    elem("div", { class: "set-actions" },
      elem("span", { class: "spacer" }),
      onCancel ? elem("button", { class: "ghost set-btn", type: "button", onclick: () => onCancel() }, "Cancel") : null,
      submit,
    ),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    const body = { label: label.value.trim(), store: store.value };
    const id = name.value.trim();
    if (!body.label) return fail("Enter a label.");
    if (!NAME_RE.test(id)) return fail("Names use a–z, 0–9 and -, start with a letter or digit, up to 48 characters.");
    if (taken.includes(id)) return fail(`A credential named ${id} already exists. Replace its value from its row instead.`);
    const problem = valueProblem(value.value);
    if (problem) return fail(problem);
    body.value = value.value;
    submit.disabled = true;
    try {
      const item = await putCredential(id, body);
      value.value = "";
      label.value = "";
      name.value = "";
      nameTouched = false;
      onSaved?.(item);
    } catch (err) {
      fail(err.message || "Could not save the credential.");
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}
