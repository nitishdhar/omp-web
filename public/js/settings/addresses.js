"use strict";
// Settings → General → Addresses: every address the server answers on
// (GET /api/settings/addresses), which one links use, and the editable public
// address. Read-only apart from the public address, which an
// OMP_WEB_PUBLIC_URL environment value locks.

import { el, elem } from "../dom.js";
import { api } from "../api.js";
import { copyWithNotice, showNotice } from "../notice.js";

const DEFAULT_NOTE = "The address a reverse proxy or Tailscale Serve publishes. Leave empty to clear.";

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
  const pub = status.publicUrl || {};
  const input = el["settings-public-url"];
  const locked = pub.source === "env";
  // A reply landing while the user types must not overwrite their text.
  if (document.activeElement !== input) input.value = pub.value || "";
  input.disabled = locked;
  el["settings-public-save"].disabled = locked;
  const note = el["settings-public-note"];
  note.classList.toggle("is-error", Boolean(pub.error));
  if (pub.error) note.textContent = pub.error;
  else note.textContent = locked ? "Locked · set by OMP_WEB_PUBLIC_URL" : DEFAULT_NOTE;
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
    showNotice(status.publicUrl.value ? "Public address saved" : "Public address cleared");
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
