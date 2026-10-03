"use strict";
// Settings → General → Addresses: every address the server answers on
// (GET /api/settings/addresses), which one links use, and the editable public
// address, which is set only here.

import { el, elem } from "../dom.js";
import { api } from "../api.js";
import { copyWithNotice, showNotice } from "../notice.js";

let status = null; // last /api/settings/addresses reply

function addressRow(address) {
  const isLink = address.url === status.linkBase;
  const head = elem("span", { class: "set-address-head" },
    elem("strong", { text: address.label }),
    isLink ? elem("span", { class: "set-pill tone-accent", text: "Links" }) : null,
    elem("span", {
      class: `set-pill ${address.reachable ? "tone-ok" : "tone-warn"}`,
      text: address.reachable ? "Reachable" : "Not reachable",
      title: address.reachable ? "" : "The server's bind address does not include this one",
    }),
  );
  return elem("li", { class: `set-address${isLink ? " is-link" : ""}${address.reachable ? "" : " is-off"}` },
    elem("span", { class: "set-address-main" }, head, elem("span", { class: "set-address-url", text: address.url })),
    elem("button", {
      class: "ghost set-btn",
      type: "button",
      text: "Copy",
      "aria-label": `Copy ${address.label} address`,
      onclick: () => copyWithNotice(address.url, "Address copied"),
    }),
  );
}

function paint() {
  const rows = status.addresses.map(addressRow);
  // The bind matched none of the probed addresses; links use the bind itself.
  if (!status.addresses.some((address) => address.url === status.linkBase)) {
    rows.push(addressRow({ label: "Bind address", url: status.linkBase, reachable: true }));
  }
  el["settings-addresses"].replaceChildren(...rows);
  const input = el["settings-public-url"];
  // A reply landing while the user types must not overwrite their text.
  if (document.activeElement !== input) input.value = status.publicUrl || "";
  el["settings-public-save"].disabled = false;
}

async function load() {
  try {
    status = await api("/settings/addresses");
    paint();
  } catch (error) {
    el["settings-addresses"].replaceChildren(
      elem("li", { class: "set-empty", text: `Could not load addresses: ${error.message}` }),
    );
  }
}

async function save() {
  const button = el["settings-public-save"];
  button.disabled = true;
  try {
    status = await api("/settings/addresses", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicUrl: el["settings-public-url"].value.trim() }),
    });
    el["settings-public-url"].blur();
    paint();
    showNotice(status.publicUrl ? "Public address saved" : "Public address cleared");
  } catch (error) {
    showNotice(error.message || "Could not save the public address", { tone: "error" });
    button.disabled = false;
  }
}

export function show() {
  void load();
}

export function wire() {
  el["settings-public-form"].addEventListener("submit", (event) => {
    event.preventDefault();
    void save();
  });
}
