"use strict";
// Turn rail: one tick per user message beside the transcript, so a long
// session shows where you are and any earlier turn is one click away. Owned by
// transcript.js, which supplies every turn in the timeline (not only the
// mounted window) and performs the jump; this module only draws.

import { el, elem } from "../dom.js";

const PREVIEW_CHARS = 90;
// Below this a rail is decoration: the whole conversation fits on screen.
const MIN_TURNS = 3;

let jumpTo = null;
let renderedKey = "";
let ticks = new Map();
let activeId = null;
let activeTick = null;

/** Register the transcript's jump action. */
export function initRail(onJump) {
  jumpTo = onJump;
}

function preview(text) {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : line;
}

function timeLabel(at) {
  if (!at) return "";
  const value = new Date(at);
  if (Number.isNaN(value.getTime())) return "";
  return value.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Redraw the ticks for `turns` ({ id, text, at } in timeline order). Cheap to
 * call on every window sync: an unchanged turn list keeps its DOM.
 */
export function syncRail(turns) {
  const host = el["chat-rail"];
  if (!host) return;
  const key = turns.map((turn) => `${turn.id}\u0001${preview(turn.text)}`).join("\u0002");
  if (key === renderedKey) return;
  renderedKey = key;
  ticks = new Map();
  activeTick = null;
  if (turns.length < MIN_TURNS) {
    host.replaceChildren();
    host.hidden = true;
    return;
  }
  const track = elem("div", { class: "chat-rail-track" });
  track.style.setProperty("--turns", String(turns.length));
  const last = turns.length - 1;
  turns.forEach((turn, index) => {
    const when = timeLabel(turn.at);
    const text = preview(turn.text) || "(attachment)";
    const tick = elem("button", {
      class: "chat-rail-tick",
      type: "button",
      // Pointer affordance only: hundreds of ticks in the tab order would bury
      // the composer, and the history buttons already page by keyboard.
      tabindex: "-1",
      title: when ? `${when} · ${text}` : text,
      onclick: () => jumpTo?.(turn.id),
    });
    tick.style.top = `${(index / last) * 100}%`;
    ticks.set(turn.id, tick);
    track.append(tick);
  });
  host.replaceChildren(track);
  host.hidden = false;
  fitRail();
  markActive(activeId);
}

/**
 * Past one tick per 9px the ticks overlap; thinner, dimmer lines read as a
 * texture there and the active turn still stands out. Measured on each
 * active-turn pass because the rail has no height while Chat is hidden.
 */
export function fitRail() {
  const host = el["chat-rail"];
  if (!host || host.hidden || !host.clientHeight) return;
  host.classList.toggle("is-dense", ticks.size * 9 > host.clientHeight);
}

/** Highlight the turn the reader is in. */
export function markActive(id) {
  activeId = id;
  const next = id ? ticks.get(id) || null : null;
  if (next === activeTick) return;
  activeTick?.classList.remove("is-active");
  next?.classList.add("is-active");
  activeTick = next;
}
