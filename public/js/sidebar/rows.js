"use strict";
// Session rows shared by both sidebar views. One row = one live session.
// Row anatomy: [dot] title (unread ● / needs-you pill) … menu
//              folder · profile/profile or shell · status · activity — a
//              second metadata line that disambiguates truncated titles
//              without a hover tooltip (touch has no hover).

import { elem } from "../dom.js";
import { icon } from "../icons.js";
import { emit, state } from "../state.js";
import { sessionStatus, statusLabel, statusTitle } from "../session-status.js";
import * as menu from "./menu.js";
import { copyWithNotice } from "../notice.js";
import { workspaceRelative } from "../paths.js";

const folderShort = (folder) => workspaceRelative(folder);

function folderName(folder) {
  const normalized = String(folder || "").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function relativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() / 1000 - ts;
  if (diff < 90) return "just now";
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

// Unread memory: transcript byte-size baselines recorded per session in
// sessionStorage when the user opens the session. Not durable state — a
// reload only resets the badge, never sessions (tmux stays truth).
function seenKey(id) { return `omp_web_seen_${id}`; }

export function markSessionSeen(session) {
  if (!session || session.type === "shell" || !Number(session.transcriptSize)) return;
  try { sessionStorage.setItem(seenKey(session.id), String(session.transcriptSize)); } catch {}
}

export function sessionHasUnread(session) {
  if (!session || session.type === "shell" || session.id === state.current) return false;
  const size = Number(session.transcriptSize);
  if (!size) return false;
  try {
    const seen = Number(sessionStorage.getItem(seenKey(session.id)) || 0);
    // First sighting of a transcript marks it seen: badge means "grew since
    // you last opened it", not "has content".
    if (!seen) {
      sessionStorage.setItem(seenKey(session.id), String(size));
      return false;
    }
    return size > seen;
  } catch { return false; }
}

function sessionDetails(session) {
  const status = sessionStatus(session);
  const details = [
    folderShort(session.folder),
    session.type === "shell" ? "shell" : (session.profile || "default"),
    statusLabel(status),
  ];
  if (session.attached) details.push("terminal attached");
  const activity = relativeTime(Number(session.lastActivity) || 0);
  if (activity) details.push(`active ${activity}`);
  return details.join(" · ");
}

function appendWindowCount(row, session) {
  if (Number(session.windows) <= 1) return;
  row.append(elem("span", {
    class: "window-count",
    text: `×${session.windows}`,
    title: `${session.windows} tmux windows`,
    "aria-label": `${session.windows} tmux windows`,
  }));
}

function buildSessionRow(session, { onOpen, menu, showFolder = false, narrow = false }) {
  const details = sessionDetails(session);
  const status = sessionStatus(session);
  const unread = sessionHasUnread(session);
  const li = elem("li", {
    class: `sess status-${status}${session.id === state.current ? " active" : ""}${unread ? " has-unread" : ""}`,
    "data-session-id": session.id,
  });
  const open = elem("button", {
    class: "sess-open",
    type: "button",
    title: details,
    "aria-label": details ? `${session.title}, ${details}` : session.title,
    "data-session-id": session.id,
    "aria-current": session.id === state.current ? "page" : null,
    onclick: () => onOpen && onOpen(session),
  });
  const lines = elem("span", { class: "sess-lines" });
  const row = elem("span", { class: "row1" });
  const dotTitle = statusTitle(session) +
    (session.attached ? " · terminal attached" : "");
  row.append(elem("span", {
    class: `session-status-indicator dot status-${status}`,
    title: dotTitle,
    "aria-hidden": "true",
  }));
  row.append(elem("span", { class: "title", text: session.title }));
  if (status === "waiting") {
    row.append(elem("span", {
      class: "needs-you",
      text: "needs input",
      title: "This session is blocked on an answer or approval",
    }));
  }
  if (unread) {
    row.append(elem("span", {
      class: "unread-dot",
      text: "●",
      title: "Session produced output since you last opened it",
      "aria-hidden": "true",
    }));
  }
  if (showFolder && narrow) {
    row.append(elem("span", {
      class: "session-folder",
      text: folderName(session.folder),
      title: session.folder,
    }));
  }
  appendWindowCount(row, session);
  lines.append(row);
  // Metadata line kills the hover-tooltip hunt for identical truncated titles.
  // Shell sessions have no profile; Recent rows repeat the folder here only on
  // wide layouts where the second line has room.
  if (!narrow) {
    const statusText = status === "waiting" ? "Waiting" : "";
    const sub = [
      folderName(session.folder),
      session.type === "shell" ? "shell" : (session.profile || "default"),
      statusText || relativeTime(Number(session.lastActivity) || 0),
    ].filter(Boolean);
    lines.append(elem("span", { class: "row2", text: sub.join(" · ") }));
  }
  open.append(lines);
  li.append(open);
  if (menu) {
    // Pinning was two clicks inside the overflow menu, and now that folders
    // list pinned sessions too, a row gave no sign of its own pin state. The
    // toggle is the affordance and the indicator: revealed on hover, and
    // always visible once pinned.
    li.append(elem("button", {
      class: `row-pin${session.pinned ? " is-pinned" : ""}`,
      type: "button",
      "aria-pressed": String(Boolean(session.pinned)),
      "aria-label": session.pinned ? `Unpin ${session.title}` : `Pin ${session.title}`,
      title: session.pinned ? "Unpin" : "Pin",
      onclick: (event) => {
        event.stopPropagation();
        emit("session:pin", { id: session.id, pinned: !session.pinned });
      },
    }, icon("pin", 13)));
    li.append(elem("button", {
      class: "row-menu",
      type: "button",
      "data-session-id": session.id,
      "aria-label": `Actions for ${session.title}`,
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      title: `Actions for ${session.title}`,
      onclick: (event) => menu(event.currentTarget, session),
    }, icon("dots", 14)));
  }
  return li;
}

// Exactly what a row paints, and nothing else. The poll render gate compares
// these projections so invisible churn — transcript bytes, heartbeat
// timestamps, sub-minute activity drift — never rebuilds rows under the
// user's finger mid-tap.
export function rowProjection(session) {
  return {
    id: session.id,
    title: session.title,
    status: sessionStatus(session),
    details: sessionDetails(session),
    activity: relativeTime(Number(session.lastActivity) || 0),
    folder: session.folder,
    profile: session.profile,
    type: session.type,
    windows: Number(session.windows) || 0,
    pinned: Boolean(session.pinned),
    unread: sessionHasUnread(session),
    active: session.id === state.current,
  };
}

export function sessionRow(session, options = {}) {
  return buildSessionRow(session, options);
}

// Ghost row: a dead session offered for explicit restore. Reuses the Unknown
// hollow status dot (sessionStatus falls back on a missing status); ghost-ness
// comes from the dimming + dashed outline, never from a status literal.
// The row itself is the affordance: clicking opens the ghost's detail view in
// the main pane (restore + full folder/type/history there), so the title keeps
// the full row width. Restore/Forget stay in the overflow menu too.
export function ghostRow(ghost) {
  const li = elem("li", {
    class: `sess ghost${ghost.id === state.selectedGhost ? " selected" : ""}`,
    "data-session-id": ghost.id,
  });
  const open = elem("button", {
    class: "sess-open ghost-open",
    type: "button",
    title: `${ghost.title} — not running. Folder: ${ghost.folder}`,
    "aria-label": `${ghost.title}, not running. Open restore details.`,
    "aria-current": ghost.id === state.selectedGhost ? "page" : null,
    onclick: () => emit("ghost:select", ghost.id),
  });
  const lines = elem("span", { class: "sess-lines" });
  const row = elem("span", { class: "row1" });
  row.append(elem("span", {
    class: "session-status-indicator dot status-unknown",
    title: "Not running",
    "aria-hidden": "true",
  }));
  row.append(elem("span", { class: "title", text: ghost.title }));
  lines.append(row);
  lines.append(elem("span", {
    class: "row2",
    text: [
      folderName(ghost.relocatedFolder || ghost.folder),
      ghost.type === "shell" ? "shell" : (ghost.profile || "default"),
      ghost.folderMissing ? (ghost.relocatedFolder ? "folder moved" : "folder missing") : "not running",
    ].filter(Boolean).join(" · "),
  }));
  open.append(lines);
  li.append(open);
  li.append(elem("button", {
    class: "row-menu",
    type: "button",
    "data-session-id": ghost.id,
    "aria-label": `Actions for ${ghost.title}`,
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    title: `Actions for ${ghost.title}`,
    onclick: (event) => openGhostMenu(event.currentTarget, ghost),
  }, icon("dots", 14)));
  return li;
}

function openGhostMenu(anchor, ghost) {
  const moved = ghost.folderMissing && ghost.relocatedFolder;
  menu.show(anchor, ghost.title || ghost.id, [
    {
      // The recorded folder is gone; restoring there can only fail. Offer the
      // one folder with the same name instead, and say which it is.
      label: moved ? `Restore in ${folderShort(ghost.relocatedFolder)}` : "Restore",
      icon: "bolt",
      action: () => emit("session:restore", { ids: [ghost.id], folder: moved ? ghost.relocatedFolder : undefined }),
    },
    {
      label: "Copy folder path",
      icon: "folder",
      action: () => copyWithNotice(ghost.folder, "Copied path"),
    },
    {
      label: "Forget",
      icon: "x",
      danger: true,
      action: () => emit("session:forget", ghost.id),
    },
  ], [
    { label: "Folder", value: ghost.folder || "—" },
    { label: "Profile", value: ghost.type === "shell" ? "shell" : (ghost.profile || "default") },
  ]);
}
