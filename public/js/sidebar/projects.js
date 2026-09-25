"use strict";
// Projects view and the shared flat search result surface.

import { state, emit } from "../state.js";
import { elem } from "../dom.js";
import { icon } from "../icons.js";
import * as menu from "./menu.js";
import { sessionRow, ghostRow } from "./rows.js";
import { copyWithNotice } from "../notice.js";

const collapsedProjects = new Set();
const knownProjects = new Set();
let activeProject = null;

function openSessionMenu(anchor, session) {
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

export function sessionDetail(session) {
  const started = Number(session.created)
    ? new Date(Number(session.created) * 1000).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : "";
  return [
    { label: "Folder", value: session.folder || "—" },
    { label: "Profile", value: session.type === "shell" ? "shell" : (session.profile || "default") },
    { label: "Status", value: session.status || "unknown" },
    started ? { label: "Started", value: started } : null,
    Number(session.transcriptSize)
      ? { label: "Transcript", value: `${Math.max(1, Math.round(session.transcriptSize / 1024))} KB` }
      : null,
  ].filter(Boolean);
}

function openFolderMenu(anchor, folder) {
  menu.show(anchor, folder.name, [
    {
      label: folder.path,
      icon: "folder",
      action: () => copyWithNotice(folder.path, "Copied path"),
    },
    {
      label: "New session here",
      icon: "plus",
      action: () => emit("session:newInFolder", folder.path),
    },
  ]);
}

function stableCreatedOrder(a, b) {
  return (Number(b.created) || 0) - (Number(a.created) || 0)
    || String(a.id).localeCompare(String(b.id));
}

function includesQuery(value, query) {
  return String(value || "").toLocaleLowerCase().includes(query);
}
function sessionMatches(session, query) {

  return includesQuery(session.title, query)
    || includesQuery(session.folder, query)
    || includesQuery(session.profile, query)
    || includesQuery(session.type, query);
}

function buildFolders(sessions, ghosts = []) {
  const workspaceRoot = state.meta.workspaceRoot;
  const folders = new Map(
    [{ name: "Workspace", path: workspaceRoot }, ...state.meta.folders]
      .filter((folder) => folder.path != null)
      .map((folder) => [folder.path, { ...folder, sessions: [], ghosts: [] }]),
  );
  const known = folders.size;
  const folderFor = (path) => {
    if (!folders.has(path)) {
      folders.set(path, {
        name: path.replace(workspaceRoot + "/", "") || "Workspace",
        path,
        sessions: [],
        ghosts: [],
      });
    }
    return folders.get(path);
  };
  for (const session of sessions) folderFor(session.folder || workspaceRoot).sessions.push(session);
  // A not-running session whose folder moved sits with the folder it moved to,
  // which is where Restore will offer to reopen it.
  for (const ghost of ghosts) {
    folderFor(ghost.relocatedFolder || ghost.folder || workspaceRoot).ghosts.push(ghost);
  }
  // Keep the server's order (workspace root, workspace folders, then each
  // extra root's folders); only folders it doesn't list are sorted, at the end.
  const listed = [...folders.values()].slice(0, known);
  const extra = [...folders.values()].slice(known).sort((a, b) => String(a.path).localeCompare(String(b.path)));
  return [...listed, ...extra];
}

function currentFolder(sessions) {
  const current = sessions.find((session) => session.id === state.current);
  return current ? (current.folder || state.meta.workspaceRoot) : null;
}

function syncDefaultCollapse(folders, sessions) {
  const current = currentFolder(sessions);
  for (const folder of folders) {
    if (knownProjects.has(folder.path)) continue;
    knownProjects.add(folder.path);
    if (folder.path !== current) collapsedProjects.add(folder.path);
  }
  // Selecting a session used to force its folder open. Now that folders list
  // every session, that meant clicking anything in Pinned or Recent blew the
  // whole containing folder open underneath it. The folder is marked instead,
  // and stays exactly as the user left it.
  activeProject = current;
}

function folderMenuButton(folder) {
  return elem("button", {
    class: "row-menu folder-menu",
    type: "button",
    "aria-label": `Actions for ${folder.name}`,
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    title: `Actions for ${folder.name}`,
    onclick: (event) => openFolderMenu(event.currentTarget, folder),
  }, icon("dots", 14));
}

function folderHeading(folder, expanded) {
  const holdsCurrent = folder.path === activeProject;
  const heading = elem("div", {
    class: "folder-head"
      + (folder.path === state.selectedFolder ? " active" : "")
      + (holdsCurrent ? " holds-current" : ""),
  });
  const toggle = elem("button", {
    class: "folder-toggle",
    type: "button",
    "aria-expanded": String(expanded),
    "aria-pressed": String(folder.path === state.selectedFolder),
    title: folder.path,
    onclick: () => {
      state.selectedFolder = folder.path;
      if (collapsedProjects.has(folder.path)) collapsedProjects.delete(folder.path);
      else collapsedProjects.add(folder.path);
      emit("sidebar:rerender");
    },
  },
    elem("span", { class: "folder-chevron", text: "›", "aria-hidden": "true" }),
    elem("span", { class: "folder-name", text: folder.name }),
    elem("span", { class: "folder-count", text: String(folder.count ?? folder.sessions.length) }),
  );
  heading.append(toggle, folderMenuButton(folder));
  return heading;
}

// A folder with nothing live in it: one quiet line, no chevron or count. Click
// selects it; its menu offers "New session here".
function emptyFolderRow(folder) {
  const row = elem("li", {
    class: "folder-group folder-leaf",
    "data-project-key": folder.path,
  });
  const heading = elem("div", {
    class: "folder-head" + (folder.path === state.selectedFolder ? " active" : ""),
  });
  heading.append(elem("button", {
    class: "folder-toggle folder-select",
    type: "button",
    "aria-pressed": String(folder.path === state.selectedFolder),
    title: folder.path,
    onclick: () => {
      state.selectedFolder = folder.path;
      emit("sidebar:rerender");
    },
  },
    icon("folder", 13),
    elem("span", { class: "folder-name", text: folder.name }),
  ), folderMenuButton(folder));
  row.append(heading);
  return row;
}

// Not-running sessions live in their folders; this is only the bulk action.
// "Restore all" starts an OMP process per session, so it confirms first.
function restoreAllRow(ghosts) {
  if (!ghosts.length) return null;
  const row = elem("li", { class: "sidebar-section not-running-section" });
  row.append(elem("button", {
    class: "restore-all",
    type: "button",
    title: "Restore every not-running session with its saved history",
    onclick: () => {
      if (confirm(`Restore ${ghosts.length} sessions? Each starts its own OMP process.`)) {
        emit("session:restore", { ids: "all" });
      }
    },
  }, elem("span", { text: `Restore all ${ghosts.length} not running…` })));
  return row;
}

function sessionSection(label, className, sessions, onOpen) {
  if (!sessions.length) return null;
  const section = elem("li", { class: `sidebar-section ${className}` });
  section.append(elem("div", { class: "bucket-head" },
    elem("span", { text: label }),
  ));
  const list = elem("ul", { class: "folder-sessions", "aria-label": `${label} sessions` });
  for (const session of sessions) {
    list.append(sessionRow(session, { onOpen, menu: openSessionMenu }));
  }
  section.append(list);
  return section;
}

export function renderSearch(host, sessions, { onOpen, query, ghosts = [] } = {}) {
  menu.close({ restoreFocus: false });
  const search = query.trim().toLocaleLowerCase();
  const matches = sessions.filter((session) => sessionMatches(session, search)).sort(stableCreatedOrder);
  const ghostMatches = ghosts
    .filter((ghost) => sessionMatches({ ...ghost, type: ghost.type }, search))
    .sort(stableCreatedOrder);

  host.replaceChildren();
  for (const session of matches) {
    host.append(sessionRow(session, { onOpen, menu: openSessionMenu }));
  }
  if (ghostMatches.length) {
    const section = elem("li", { class: "sidebar-section not-running-section" });
    section.append(elem("div", { class: "bucket-head" }, elem("span", { text: "Not running" })));
    const list = elem("ul", { class: "folder-sessions", "aria-label": "Not running sessions" });
    for (const ghost of ghostMatches) list.append(ghostRow(ghost));
    section.append(list);
    host.append(section);
  }
  // Folders match too, so searching for a project to start in finds it even
  // when nothing is running there.
  // Name only: every path shares the workspace prefix, so matching on it made
  // "workspace" return all of them.
  const folderMatches = buildFolders(sessions).filter((folder) => includesQuery(folder.name, search));
  for (const folder of folderMatches) host.append(emptyFolderRow(folder));
  if (!matches.length && !ghostMatches.length && !folderMatches.length) {
    host.append(elem("li", {
      class: "empty search-empty",
      text: `No sessions or folders match “${query.trim()}”`,
    }));
  }
}

export function render(host, sessions, { onOpen, ghosts = [] } = {}) {
  menu.close({ restoreFocus: false });
  const folders = buildFolders(sessions, ghosts);
  syncDefaultCollapse(folders, sessions);
  host.replaceChildren();

  // Waiting rows hoist out of their folders: blocked-on-you is the sidebar's
  // highest-priority signal and must not hide inside a collapsed group.
  const waiting = sessions
    .filter((s) => s.type !== "shell" && s.status === "waiting")
    .sort(stableCreatedOrder);
  const needsSection = sessionSection("Needs you", "needs-section", waiting, onOpen);
  if (needsSection) host.append(needsSection);
  const sidelined = new Set(waiting.map((s) => s.id));

  const working = sessions
    .filter((s) => s.type !== "shell" && s.status === "working" && !sidelined.has(s.id))
    .sort(stableCreatedOrder);
  const workingSection = sessionSection("Working", "working-section", working, onOpen);
  if (workingSection) host.append(workingSection);
  for (const session of working) sidelined.add(session.id);

  const pinned = sessions
    .filter((session) => session.pinned && !sidelined.has(session.id))
    .sort(stableCreatedOrder);
  const pinnedSection = sessionSection("Pinned", "pinned-section", pinned, onOpen);
  if (pinnedSection) host.append(pinnedSection);
  for (const session of pinned) sidelined.add(session.id);

  // Every workspace folder is listed, not only the ones with a live session:
  // the sidebar is also where you pick a project to start in, and folders
  // vanishing as their last session ended read as data loss.
  for (const folder of folders) {
    // A session lives in exactly one place: an attention/pinned section wins
    // over its folder. Listing it twice made the sidebar look twice as full as
    // it was and left the folder counts lying.
    const rows = folder.sessions
      .filter((session) => !sidelined.has(session.id))
      .sort(stableCreatedOrder);
    // Not-running sessions belong to their folder too; the count is every
    // session the folder lists, live or not.
    const dead = folder.ghosts.slice().sort(stableCreatedOrder);
    if (!rows.length && !dead.length) {
      host.append(emptyFolderRow(folder));
      continue;
    }
    const expanded = !collapsedProjects.has(folder.path);
    const group = elem("li", {
      class: "folder-group" + (expanded ? "" : " collapsed"),
      "data-project-key": folder.path,
    });
    group.append(folderHeading({ ...folder, count: rows.length + dead.length }, expanded));
    if (expanded) {
      const list = elem("ul", {
        class: "folder-sessions",
        "aria-label": `${folder.name} sessions`,
      });
      for (const session of rows) {
        list.append(sessionRow(session, { onOpen, menu: openSessionMenu }));
      }
      for (const ghost of dead) list.append(ghostRow(ghost));
      group.append(list);
    }
    host.append(group);
  }

  const restoreAll = restoreAllRow(ghosts);
  if (restoreAll) host.append(restoreAll);
}
