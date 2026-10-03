"use strict";
// Settings page: a main-area view (#settings-mode) beside the panel and ghost
// views. main.js owns opening and leaving it (session parking is its job);
// this module paints the page and switches sections.
//
// One section is visible at a time so a section's live work (the 10 s stats
// poll) can follow exactly what is on screen.

import { el } from "../dom.js";
import { emit } from "../state.js";
import { renderReference } from "./reference.js";
import { loadPreviewRoots, wirePreviewRoots } from "../preview-roots.js";
import * as panelsSection from "./panels.js";
import * as sessionsSection from "./sessions.js";
import * as storageSection from "./storage.js";
import * as ompSection from "./omp.js";
import * as skillsSection from "./skills.js";
import * as addressesSection from "./addresses.js";

export { watchOmpUpdates } from "./omp.js";

const SECTIONS = {
  general: addressesSection,
  omp: ompSection,
  panels: panelsSection,
  sessions: sessionsSection,
  storage: storageSection,
  folders: { show: () => void loadPreviewRoots() },
  profiles: skillsSection,
  about: {},
};

let active = "general";
let open = false;
let wired = false;

function sectionNodes() {
  return el["settings-body"].querySelectorAll(".set-section");
}

function activate(name) {
  if (!Object.hasOwn(SECTIONS, name)) return;
  if (open && name !== active) SECTIONS[active].hide?.();
  active = name;
  for (const node of sectionNodes()) node.hidden = node.dataset.section !== name;
  for (const button of el["settings-nav"].querySelectorAll(".set-nav-item")) {
    const current = button.dataset.section === name;
    if (current) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
    // The phone chip row scrolls sideways; keep the chosen chip in view.
    if (current && open) button.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  el["settings-body"].scrollTop = 0;
  if (open) SECTIONS[name].show?.();
}

// Rebuilding the profile cards drops the skill rows inside them.
function paintReference() {
  renderReference();
  skillsSection.paintSkillSwitches();
}

export function renderSettings() {
  paintReference();
}

// `section` lets another page link straight to one section (the Artifacts
// empty state points at Profiles).
export function showSettings(section) {
  if (!el["settings-mode"]) return false;
  const wasOpen = open;
  open = true;
  paintReference();
  el["settings-mode"].hidden = false;
  el.main.classList.add("settings-active");
  el["settings-btn"].setAttribute("aria-current", "page");
  const target = section && Object.hasOwn(SECTIONS, section) ? section : null;
  if (target || !wasOpen) activate(target || active);
  return true;
}

export function hideSettings() {
  if (!open) return;
  SECTIONS[active].hide?.();
  open = false;
  el["settings-mode"].hidden = true;
  el.main.classList.remove("settings-active");
  el["settings-btn"].removeAttribute("aria-current");
}

export function wireSettings() {
  if (wired || !el["settings-btn"] || !el["settings-mode"]) return;
  wired = true;
  el["settings-btn"].onclick = () => emit("settings:open");
  el["settings-nav"].addEventListener("click", (event) => {
    const button = event.target.closest(".set-nav-item");
    if (button) activate(button.dataset.section);
  });
  wirePreviewRoots();
  panelsSection.wire();
  sessionsSection.wire();
  storageSection.wire();
  ompSection.wire();
  addressesSection.wire();
  activate(active);
}
