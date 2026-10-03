"use strict";
// Settings → Profiles: the per-profile Artifacts skill switch. Every profile
// loads the skill through the shared ~/.agents/skills link, so the switch is
// an opt-out: off lists it in that profile's skills.ignoredSkills. The one
// write the Profiles section allows, and it goes through `omp config set` on
// the server, so OMP stays the owner of its own config. Rows land inside the
// profile cards reference.js paints (matched by data-profile), so this module
// repaints whenever those cards are rebuilt.

import { el, elem } from "../dom.js";
import { api } from "../api.js";
import { showNotice } from "../notice.js";

let profiles = null; // [{name, installed, error?}] from the last answer
let link = null; // {ok, detail}: the shared skill link every profile reads
let loadError = "";
const pending = new Set(); // profiles with a PUT in flight

function accept(body) {
  if (Array.isArray(body?.profiles)) profiles = body.profiles;
  if (body?.link) link = body.link;
}

async function load() {
  try {
    const body = await api("/settings/skills");
    profiles = [];
    accept(body);
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
    accept(await api("/settings/skills", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile, installed }),
    }));
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
  let note = "On for every profile by default. Lets this profile's sessions build and update Artifacts pages.";
  let error = false;
  if (loadError) [note, error] = [`Could not read the skill state: ${loadError}`, true];
  else if (!profiles) note = "Checking…";
  else if (!info) note = "Not reported by the server.";
  else if (info.error) [note, error] = [info.error, true];
  else if (link && !link.ok) [note, error] = [`No profile can load the skill: ${link.detail}`, true];
  else if (!info.installed) note = "Off · listed in this profile's skills.ignoredSkills.";
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
      elem("span", { class: error ? "is-error" : "", text: note })),
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
