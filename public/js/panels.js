"use strict";
// Panel view: operator-configured local web apps (OMP_WEB_PANELS) shown in the
// main pane through the server's /panels/<id>/ proxy. Main.js owns when to
// show/hide; this module paints the sidebar entries and the frames.

import { el, elem } from "./dom.js";
import { state, emit } from "./state.js";

const SVG_NS = "http://www.w3.org/2000/svg";
// One frame per opened panel, never removed: detaching an iframe reloads the
// app and loses whatever the user was doing in it.
const frames = new Map(); // id -> iframe

function panelIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24", "aria-hidden": "true", fill: "none", stroke: "currentColor",
    "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round",
  })) svg.setAttribute(k, v);
  const frame = document.createElementNS(SVG_NS, "rect");
  for (const [k, v] of Object.entries({ x: "3.5", y: "4.5", width: "17", height: "15", rx: "2.5" })) frame.setAttribute(k, v);
  const bar = document.createElementNS(SVG_NS, "path");
  bar.setAttribute("d", "M3.5 9h17");
  svg.append(frame, bar);
  return svg;
}

export function configuredPanels() {
  return Array.isArray(state.meta.panels) ? state.meta.panels : [];
}

export function renderPanelNav() {
  const nav = el["panel-nav"];
  if (!nav) return;
  const list = configuredPanels();
  nav.replaceChildren(...list.map((panel) => elem("button", {
    class: "panel-link",
    type: "button",
    title: panel.label,
    "data-panel-id": panel.id,
    onclick: () => emit("panel:open", panel.id),
  }, panelIcon(), elem("span", { class: "panel-link-label", text: panel.label }))));
  nav.hidden = list.length === 0;
  syncPanelNav();
}

function syncPanelNav() {
  for (const button of el["panel-nav"]?.querySelectorAll(".panel-link") || []) {
    if (button.dataset.panelId === state.openPanel) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

// The token rides only the first navigation: the server answers it with the
// path-scoped panel cookie and a redirect to the clean URL.
function frameUrl(id) {
  const base = `/panels/${encodeURIComponent(id)}/`;
  return state.token ? `${base}?token=${encodeURIComponent(state.token)}` : base;
}

export function showPanel(panel) {
  const host = el["panel-mode"];
  if (!panel || !host) return;
  if (!frames.has(panel.id)) {
    const frame = elem("iframe", { class: "panel-frame", title: panel.label, src: frameUrl(panel.id) });
    frames.set(panel.id, frame);
    host.append(frame);
  }
  for (const [id, frame] of frames) frame.hidden = id !== panel.id;
  host.setAttribute("aria-label", panel.label);
  host.hidden = false;
  el.main.classList.add("panel-active");
  syncPanelNav();
}

export function hidePanel() {
  if (el["panel-mode"]) el["panel-mode"].hidden = true;
  el.main.classList.remove("panel-active");
  syncPanelNav();
}
