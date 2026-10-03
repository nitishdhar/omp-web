"use strict";
// Settings → Profiles: the per-profile Artifacts skill switch. The one write
// the Profiles section allows, and it goes through `omp config set` on the
// server, so OMP stays the owner of its own config. Rows land inside the
// profile cards reference.js paints (matched by data-profile), so this module
// repaints whenever those cards are rebuilt.

import { el, elem } from "../dom.js";
import { api } from "../api.js";
import { showNotice } from "../notice.js";

let profiles = null; // [{name, installed, error?}] from the last answer
let loadError = "";
const pending = new Set(); // profiles with a PUT in flight

async function load() {
  try {
    const body = await api("/settings/skills");
    profiles = Array.isArray(body?.profiles) ? body.profiles : [];
    loadError = "";
  } catch (error) {
    loadError = error.message || "request failed";
  }
  paintSkillSwitches();
}

async function setInstalled(profile, installed) {
  pending.add(profile);
  paintSkillSwitches();
  try {
    const body = await api("/settings/skills", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile, installed }),
    });
    if (Array.isArray(body?.profiles)) profiles = body.profiles;
    showNotice(installed ? `Artifacts skill on for ${profile} · new sessions pick it up` : `Artifacts skill off for ${profile}`);
  } catch (error) {
    showNotice(error.message || "Could not change the skill", { tone: "error" });
  } finally {
    pending.delete(profile);
    paintSkillSwitches();
  }
}

function switchRow(name) {
  const info = profiles?.find((p) => p.name === name);
  const busy = pending.has(name);
  let note = "Lets this profile's sessions build and update Artifacts pages.";
  if (loadError) note = `Could not read the skill state: ${loadError}`;
  else if (!profiles) note = "Checking…";
  else if (!info) note = "Not reported by the server.";
  else if (info.error) note = info.error;
  const on = Boolean(info?.installed);
  const toggle = elem("button", {
    class: "set-switch",
    type: "button",
    role: "switch",
    "aria-checked": String(on),
    "aria-label": `Artifacts skill for ${name}`,
    disabled: busy || !info || Boolean(info.error),
    onclick: () => setInstalled(name, !on),
  }, elem("span", { class: "set-switch-knob", "aria-hidden": "true" }));
  return elem("div", { class: "set-skill-row" },
    elem("span", { class: "set-copy" },
      elem("strong", { text: "Artifacts skill" }),
      elem("span", { class: info?.error || loadError ? "is-error" : "", text: note })),
    toggle);
}

export function paintSkillSwitches() {
  for (const card of el["settings-profiles"]?.querySelectorAll(".set-profile[data-profile]") || []) {
    card.querySelector(".set-skill-row")?.remove();
    card.append(switchRow(card.dataset.profile));
  }
}

export function show() {
  paintSkillSwitches();
  void load();
}
