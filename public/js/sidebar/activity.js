"use strict";
// Recent view: working sessions first, then time-bucketed activity.

import { emit } from "../state.js";
import { elem } from "../dom.js";
import { icon } from "../icons.js";
import * as menu from "./menu.js";
import { activityRow } from "./rows.js";
import { sessionDetail } from "./projects.js";


function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function nextActivityBoundaryAt(now) {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime();
}

function openMenu(anchor, session) {
  const items = [
    {
      label: session.pinned ? "Unpin" : "Pin",
      icon: "pin",
      action: () => emit("session:pin", { id: session.id, pinned: !session.pinned }),
    },
  ];
  if (session.type !== "shell") {
    items.push({
      label: "Reload profile…",
      icon: "terminal",
      action: () => emit("session:reloadRequest", session.id),
    });
  }
  items.push({
    label: "Kill",
    icon: "x",
    danger: true,
    action: () => emit("session:kill", session.id),
  });
  menu.show(anchor, session.title || session.id, items, sessionDetail(session));
}

export function render(host, sessions, { onOpen } = {}) {
  menu.close({ restoreFocus: false });
  host.replaceChildren();
  if (!sessions.length) {
    host.append(elem("li", { class: "empty", text: "No recent sessions" }));
    return;
  }

  const now = Date.now();
  const todayStart = startOfDay(now).getTime();
  const yesterdayStart = startOfDay(now - 86400000).getTime();
  const weekAgo = todayStart - 5 * 86400000;
  const needsYou = [];
  const working = [];
  const today = [];
  const yesterday = [];
  const weekday = [];
  const earlier = [];

  for (const session of sessions) {
    const activityAt = (session.lastActivity || 0) * 1000;
    if (session.status === "waiting" && session.type !== "shell") needsYou.push(session);
    else if (session.status === "working") working.push(session);
    else if (activityAt >= todayStart) today.push(session);
    else if (activityAt >= yesterdayStart) yesterday.push(session);
    else if (activityAt >= weekAgo) weekday.push(session);
    else earlier.push(session);
  }

  const byRecency = (a, b) => (Number(b.lastActivity) || 0) - (Number(a.lastActivity) || 0)
    || (Number(b.created) || 0) - (Number(a.created) || 0)
    || String(a.id).localeCompare(String(b.id));
  needsYou.sort(byRecency);
  working.sort(byRecency);
  today.sort(byRecency);
  yesterday.sort(byRecency);
  weekday.sort(byRecency);
  earlier.sort(byRecency);

  const appendBucket = (label, iconName, items) => {
    if (!items.length) return;
    const section = elem("li", { class: "sidebar-section activity-section" });
    // No glyph: at 11px the bucket icons were the loudest thing in the list,
    // competing with the status dots for a label the user already knows.
    section.append(elem("div", { class: "bucket-head" }, elem("span", { text: label })));
    const list = elem("ul", {
      class: "folder-sessions",
      "aria-label": `${label} sessions`,
    });
    for (const session of items) {
      list.append(activityRow(session, { onOpen, menu: openMenu }));
    }
    section.append(list);
    host.append(section);
  };

  if (needsYou.length) appendBucket("Needs you", "bolt", needsYou);
  // "No sessions working" spent a row to report the ordinary case. Its absence
  // says the same thing.
  if (working.length) appendBucket("Working", "bolt", working);

  appendBucket("Today", "clock", today);
  appendBucket("Yesterday", "clock", yesterday);

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  for (let offset = 2; offset <= 6; offset += 1) {
    const dayStart = startOfDay(now - offset * 86400000).getTime();
    const dayEnd = startOfDay(now - (offset - 1) * 86400000).getTime();
    const items = weekday.filter((session) => {
      const activityAt = (session.lastActivity || 0) * 1000;
      return activityAt >= dayStart && activityAt < dayEnd;
    });
    if (items.length) {
      const date = new Date(now - offset * 86400000);
      appendBucket(dayNames[date.getDay()], "clock", items);
    }
  }

  appendBucket("Earlier", "clock", earlier);
}
