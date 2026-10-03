"use strict";
// Artifacts gallery: the /api/artifacts list painted as cards, with project
// chips once any artifact names a folder. It also paints the footer count,
// since both read the same list. main.js owns opening and leaving the page.

import { el, elem } from "../dom.js";
import { state, emit } from "../state.js";
import { api } from "../api.js";
import { formatAge, formatBytes } from "../format.js";

let projectFilter = ""; // absolute project folder, "" = every artifact
let loadError = "";

function folderName(dir) {
  return String(dir).replace(/\/+$/, "").split("/").pop() || String(dir);
}

// A failed fetch keeps the last good list: a blip should not blank the page
// or the count, only say that what is shown may be stale.
export async function loadArtifacts() {
  try {
    const body = await api("/artifacts");
    state.artifacts = Array.isArray(body?.artifacts) ? body.artifacts : [];
    loadError = "";
  } catch (e) {
    loadError = e.message || "request failed";
  }
  renderArtifactsNav();
}

export function renderArtifactsNav() {
  const count = state.artifacts.length;
  const badge = el["artifacts-count"];
  if (badge) {
    badge.textContent = count ? String(count) : "";
    badge.hidden = count === 0;
  }
  const button = el["artifacts-btn"];
  if (!button) return;
  button.title = count ? `Artifacts (${count})` : "Artifacts";
  if (state.artifactsOpen) button.setAttribute("aria-current", "page");
  else button.removeAttribute("aria-current");
}

function card(artifact) {
  const meta = [
    artifact.project ? elem("span", { class: "art-card-project", title: artifact.project, text: folderName(artifact.project) }) : null,
    elem("span", { text: `updated ${formatAge(artifact.updatedAt)}` }),
    elem("span", { text: formatBytes(artifact.bytes) }),
  ];
  return elem("li", { class: "art-card-item" }, elem("button", {
    class: "art-card",
    type: "button",
    "data-slug": artifact.slug,
    onclick: () => emit("artifacts:open", artifact.slug),
  },
  elem("span", { class: "art-card-title", text: artifact.title || artifact.slug }),
  artifact.description ? elem("span", { class: "art-card-desc", text: artifact.description }) : null,
  elem("span", { class: "art-card-meta" }, ...meta)));
}

function chip(label, value, title) {
  return elem("button", {
    class: "art-chip",
    type: "button",
    title: title || null,
    "aria-pressed": String(projectFilter === value),
    onclick: () => {
      projectFilter = value;
      renderGallery();
    },
  }, label);
}

function renderFilters(list) {
  const projects = [...new Set(list.map((a) => a.project).filter(Boolean))]
    .sort((a, b) => folderName(a).localeCompare(folderName(b)));
  // The chosen project lost its last artifact: fall back to everything
  // rather than an empty page with no visible reason.
  if (projectFilter && !projects.includes(projectFilter)) projectFilter = "";
  const host = el["artifacts-filters"];
  host.hidden = projects.length === 0;
  host.replaceChildren(...(projects.length
    ? [chip("All", ""), ...projects.map((dir) => chip(folderName(dir), dir, dir))]
    : []));
}

export function renderGallery() {
  if (!el["artifacts-list"]) return;
  const list = state.artifacts;
  renderFilters(list);
  const shown = projectFilter ? list.filter((a) => a.project === projectFilter) : list;
  el["artifacts-list"].replaceChildren(...shown.map(card));
  el["artifacts-list"].hidden = list.length === 0;
  el["artifacts-empty"].hidden = list.length > 0 || Boolean(loadError);
  const status = el["artifacts-status"];
  status.classList.toggle("is-error", Boolean(loadError));
  if (loadError) status.textContent = `Could not load artifacts: ${loadError}`;
  else if (!list.length) status.textContent = "";
  else if (shown.length === list.length) status.textContent = `${list.length} ${list.length === 1 ? "artifact" : "artifacts"}`;
  else status.textContent = `${shown.length} of ${list.length} artifacts`;
}
