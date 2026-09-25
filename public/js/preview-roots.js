"use strict";
// Settings → File viewer folders. The server owns validation and the stored
// list; every render comes from its reply, so the panel never shows a folder
// the server refused or normalised differently.

import { el, elem } from "./dom.js";
import { api } from "./api.js";
import { showNotice } from "./notice.js";
import { tildePath } from "./paths.js";

const ENDPOINT = "/settings/preview-roots";
let roots = [];
let wired = false;

function render() {
  const list = el["settings-preview-roots"];
  if (!list) return;
  list.replaceChildren(...roots.map((root) => elem("li", { class: "set-root" },
    elem("span", { class: "set-root-path", title: root, text: tildePath(root) }),
    elem("button", {
      class: "ghost set-root-remove",
      type: "button",
      "aria-label": `Remove ${root}`,
      title: "Remove",
      onclick: () => save(roots.filter((item) => item !== root), "Folder removed"),
    }, "×"),
  )));
  list.hidden = !roots.length;
}

async function save(next, message) {
  try {
    const result = await api(ENDPOINT, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roots: next }),
    });
    roots = Array.isArray(result?.roots) ? result.roots : [];
    render();
    showNotice(message);
    return true;
  } catch (error) {
    showNotice(error.message || "Could not save folders", { tone: "error" });
    return false;
  }
}

export async function loadPreviewRoots() {
  try {
    const result = await api(ENDPOINT);
    roots = Array.isArray(result?.roots) ? result.roots : [];
  } catch {
    roots = [];
  }
  render();
}

export function wirePreviewRoots() {
  if (wired || !el["settings-preview-root-form"]) return;
  wired = true;
  el["settings-preview-root-form"].addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = el["settings-preview-root-input"];
    const value = input.value.trim();
    if (!value) return;
    el["settings-preview-root-add"].disabled = true;
    if (await save([...roots, value], "Folder added")) input.value = "";
    el["settings-preview-root-add"].disabled = false;
  });
}
