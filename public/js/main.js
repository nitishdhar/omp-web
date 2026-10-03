"use strict";
// Boot + wiring. Owns app-level actions; modules emit events for them.

import { state, emit, get, setCurrent, setMode } from "./state.js";
import { el, initDom } from "./dom.js";
import { api } from "./api.js";
import { captureUrlToken, wireAuth, showAuth } from "./auth.js";
import * as terminal from "./terminal.js";
import * as modals from "./modals.js";
import { wireQuickkeys, activateQuickkeysSession, resetQuickkeysSession } from "./quickkeys.js";
import { wireUsage } from "./usage.js";
import { wireProfileInfo, syncProfileInfo } from "./profile-info.js";
import { wireLinkModal } from "./linkshare.js";
import * as sidebar from "./sidebar/index.js";
import { markSessionSeen } from "./sidebar/rows.js";
import { nextActivityBoundaryAt } from "./sidebar/index.js";
import * as chat from "./chat.js";
import * as ghost from "./ghost.js";
import * as panels from "./panels.js";
import * as artifacts from "./artifacts/index.js";
import { wirePalette } from "./palette.js";
import { wireSettings, renderSettings, showSettings, hideSettings, watchOmpUpdates } from "./settings/index.js";
import { createVoiceController } from "./voice.js";
import { suppressTailScroll } from "./chat/transcript.js";
import { closeFileViewer, openFileViewer } from "./file-viewer.js";
import { showNotice, hideNotice, copyWithNotice } from "./notice.js";
import { formatBytes } from "./format.js";
import { defaultChoice, sessionNameFrom, requestSession, rememberChoice } from "./new-session.js";

const voice = createVoiceController();

// Mirrors frontendVersion() in api/routes.js: every versioned asset the page
// actually loaded, in document order, so any shipped change raises the prompt.
const loadedFrontendVersion = [
  ...document.querySelectorAll('link[href*="?v="], script[src*="?v="]'),
]
  .map((node) => new URL(node.href || node.src, location.href).searchParams.get("v"))
  .filter(Boolean)
  .join(".");
let polling = false;
let versionPolling = false;
let lastRenderedJson = null;
let activityTimer = null;
let refreshing = false;
// A refresh() call that lands mid-poll is replayed once the poll finishes, so
// a caller's "list again now" is never silently lost to the in-flight one.
let refreshQueued = false;
// Bumped when this tab opens a session it just created. A list requested
// before that can predate the session; applying it would read the open
// session as vanished and reset Chat, dropping the message just sent.
let sessionsEpoch = 0;

// Ghost detail: a dead session previewed in the main pane. Selecting a ghost
// is mutually exclusive with a live session — the terminal and chat poll both
// A panel view, the Artifacts page and the Settings page park the session the
// same way, so one exit serves all four.
function clearPreviewView() {
  if (!state.selectedGhost && !state.openPanel && !state.settingsOpen && !state.artifactsOpen
    && !el.main.classList.contains("ghost-active") && !el.main.classList.contains("panel-active")) return;
  state.selectedGhost = null;
  state.openPanel = null;
  state.settingsOpen = false;
  ghost.hideGhost();
  panels.hidePanel();
  hideSettings();
  leaveArtifacts();
  applyMode(state.mode);
  // The parked live entry survived the preview (socket + buffer intact):
  // resume its host, header and scrubber with no replay, or fall back to
  // the empty chrome when it was disposed while parked.
  terminal.resumeCurrent();
  // The stored preference may be Terminal; a Chat (rpc) session still has no
  // TUI to show, so it comes back in Chat as openSession() would show it.
  const resumed = state.sessions.find((session) => session.id === state.current);
  if (resumed?.runner === "rpc" && state.view !== "chat") applyMode("chat");
  // Both previews hid the toggle; shells are the only sessions without one.
  el["mode-toggle"].hidden = resumed?.type === "shell";
  emit("sidebar:rerender");
}

function leaveArtifacts() {
  state.artifactsOpen = false;
  state.openArtifact = null;
  artifacts.hideArtifacts();
}
function selectGhost(id) {
  const item = state.restorable.find((g) => g.id === id);
  if (!item) return;
  // A ghost replaces an open panel or Settings in place; the live session
  // stays parked.
  state.openPanel = null;
  panels.hidePanel();
  state.settingsOpen = false;
  hideSettings();
  leaveArtifacts();
  closeFileViewer();
  chat.resetChat();
  // Park the live session: socket + buffer survive, chrome hides, current
  // clears so header actions and the poll stop targeting a hidden session.
  terminal.parkCurrent();
  activateQuickkeysSession(null);
  state.selectedGhost = id;
  // resetChat() ran above with no ghost selected, which leaves the landing
  // composer live; a ghost is not a place to type.
  chat.setComposerEnabled(false);
  if (!ghost.showGhost(item)) {
    // The detail section is missing from this tab's DOM: the tab loaded a
    // cached index.html from before the ghost view shipped. Never leave a
    // dead pane — surface the reload prompt the version poll would raise.
    el["update-btn"].hidden = false;
    el["term-title"].textContent = `${item.title || id} · reload required`;
    emit("sidebar:rerender");
    return;
  }
  el["term-title"].textContent = `${item.title || id} · not running`;
  el["term-title"].title = "";
  el["mode-toggle"].hidden = true;
  if (window.matchMedia("(max-width: 1099px)").matches) el.sidebar.classList.add("hidden");
  emit("sidebar:rerender");
}

// A panel is an operator-configured local web app shown through /panels/<id>/.
// Same parking as a ghost preview, so returning to the session costs no replay.
function selectPanel(id) {
  const panel = panels.configuredPanels().find((p) => p.id === id);
  if (!panel) return;
  state.selectedGhost = null;
  ghost.hideGhost();
  state.settingsOpen = false;
  hideSettings();
  leaveArtifacts();
  closeFileViewer();
  chat.resetChat();
  terminal.parkCurrent();
  activateQuickkeysSession(null);
  state.openPanel = id;
  chat.setComposerEnabled(false);
  panels.showPanel(panel);
  el["term-title"].textContent = panel.label;
  el["term-title"].title = "";
  el["mode-toggle"].hidden = true;
  if (window.matchMedia("(max-width: 1099px)").matches) el.sidebar.classList.add("hidden");
  emit("sidebar:rerender");
}

// Settings is a page in the main pane, parked over the session like a panel.
function selectSettings(section) {
  state.selectedGhost = null;
  ghost.hideGhost();
  state.openPanel = null;
  panels.hidePanel();
  leaveArtifacts();
  closeFileViewer();
  chat.resetChat();
  terminal.parkCurrent();
  activateQuickkeysSession(null);
  state.settingsOpen = true;
  chat.setComposerEnabled(false);
  if (!showSettings(section)) {
    // A tab on a cached shell from before the page shipped has no
    // #settings-mode; surface the reload prompt instead of a dead pane.
    el["update-btn"].hidden = false;
  }
  el["term-title"].textContent = "Settings";
  el["term-title"].title = "";
  el["mode-toggle"].hidden = true;
  if (window.matchMedia("(max-width: 1099px)").matches) el.sidebar.classList.add("hidden");
  emit("sidebar:rerender");
}

// Artifacts: the gallery (slug null) or one artifact's viewer, parked over the
// session like Settings. Gallery and viewer are one page, so moving between
// them never re-parks anything.
function selectArtifacts(slug = null) {
  if (slug && !artifacts.findArtifact(slug)) return;
  state.selectedGhost = null;
  ghost.hideGhost();
  state.openPanel = null;
  panels.hidePanel();
  state.settingsOpen = false;
  hideSettings();
  closeFileViewer();
  chat.resetChat();
  terminal.parkCurrent();
  activateQuickkeysSession(null);
  state.artifactsOpen = true;
  state.openArtifact = slug;
  chat.setComposerEnabled(false);
  if (!artifacts.showArtifacts()) {
    state.artifactsOpen = false;
    state.openArtifact = null;
    el["update-btn"].hidden = false;
  }
  el["term-title"].textContent = "Artifacts";
  el["term-title"].title = "";
  el["mode-toggle"].hidden = true;
  if (window.matchMedia("(max-width: 1099px)").matches) el.sidebar.classList.add("hidden");
  emit("sidebar:rerender");
}

// Settings changed something /api/meta reports (panels, profile catalogs): reload it and
// let the meta:refreshed subscribers repaint, as the profile popover does.
async function refreshMeta() {
  try {
    const meta = await api("/meta");
    if (!meta || typeof meta !== "object") return;
    state.meta = meta;
    emit("meta:refreshed");
  } catch (e) {
    showNotice("Could not refresh settings: " + e.message, { tone: "error" });
  }
}

function openSession(session) {
  clearPreviewView();
  closeFileViewer();
  markSessionSeen(session);
  terminal.attach(session);
  syncProfileInfo();
  activateQuickkeysSession(session.id);
  const shellOnly = session.type === "shell";
  el["mode-toggle"].hidden = shellOnly;
  if (shellOnly) {
    // Terminal is a per-session constraint for shells, not a change to the
    // user's persisted Agent-session view preference.
    applyMode("terminal");
    chat.resetChat({ discardPrevious: false });
  } else if (session.runner === "rpc") {
    // A Chat session starts omp only when you send. Opening one never starts
    // a TUI: the Terminal preference applies to sessions already running one,
    // and the Terminal toggle is the explicit way in. Session-local, like the
    // shell constraint above, so the stored preference is untouched.
    applyMode("chat");
  } else {
    applyMode(state.mode);
    if (state.mode !== "chat") chat.enterChat(session.id);
  }
}

// ---- Attention: tab title, notifications ---------------------------------
// Transition-based: fire only when a session *enters* waiting while nobody is
// looking. The ● in the tab title mirrors sidebar state continuously.
let notifyAllowed = false;
function wireNotifications() {
  const btn = el["notify-btn"];
  if (!btn) return;
  if (!("Notification" in window)) { btn.hidden = true; return; }
  notifyAllowed = Notification.permission === "granted";
  const paint = () => {
    btn.classList.toggle("active", notifyAllowed);
    btn.setAttribute("aria-pressed", String(notifyAllowed));
    btn.title = notifyAllowed ? "Waiting alerts on" : "Alert me when a session needs input";
  };
  paint();
  btn.onclick = async () => {
    if (!notifyAllowed) {
      try { notifyAllowed = (await Notification.requestPermission()) === "granted"; }
      catch { notifyAllowed = false; }
    } else {
      notifyAllowed = false; // browser permissions can't be revoked per-site from JS
    }
    paint();
  };
}
let knownWaiting = new Set();
function syncAttention(sessions) {
  const waitingNow = new Set(
    sessions.filter((s) => s.status === "waiting" && s.type !== "shell").map((s) => s.id),
  );
  if (notifyAllowed && document.hidden) {
    for (const id of waitingNow) {
      if (knownWaiting.has(id)) continue;
      const session = sessions.find((s) => s.id === id);
      try {
        new Notification("Needs input", {
          body: session ? session.title : id,
          tag: `omp-waiting-${id}`,
        });
      } catch {}
    }
  }
  knownWaiting = waitingNow;
  const base = "omp-web";
  document.title = waitingNow.size ? `(${waitingNow.size}) ${base}` : base;
}


function renderSidebar() {
  sidebar.render(state.sessions, { onOpen: openSession });
  // The Recent section prints relative ages, so the list still has to repaint
  // on the next minute/day boundary even though the view mode is gone.
  clearTimeout(activityTimer);
  const boundary = nextActivityBoundaryAt(Date.now());
  activityTimer = setTimeout(() => {
    activityTimer = null;
    renderSidebar();
  }, Math.max(0, boundary - Date.now()) + 1);
}
async function checkFrontendVersion() {
  try {
    const { version } = await api("/version", { cache: "no-store" });
    if (version && version !== loadedFrontendVersion) el["update-btn"].hidden = false;
  } catch {}
}

// Restore the last active session after a refresh/PWA relaunch (tmux kept
// the omp process alive). Runs at boot and retries on later polls while the
// first list came back empty: an empty list means the fetch failed, not that
// the session is gone, so the saved id must survive until a real list arrives.
let restorePending = true;
function restoreSavedSession() {
  if (state.current || state.selectedGhost || state.openPanel || state.settingsOpen || state.artifactsOpen) {
    restorePending = false;
    return;
  }
  if (!state.sessions.length) return; // keep the key; a later poll retries
  restorePending = false;
  const saved = (() => { try { return localStorage.getItem("omp_web_current"); } catch { return null; } })();
  const savedSession = saved && state.sessions.find((s) => s.id === saved);
  if (savedSession) openSession(savedSession);
  else if (saved) setCurrent(null); // positive absence: a real list excludes it
}

async function refresh() {
  if (refreshing) { refreshQueued = true; return; }
  refreshing = true;
  const epoch = sessionsEpoch;
  try {
    const { sessions, restorable } = await api("/sessions");
    if (epoch !== sessionsEpoch) { refreshQueued = true; return; }
    state.sessions = sessions;
    state.restorable = Array.isArray(restorable) ? restorable : [];
    el["side-foot"].textContent = "";
    chat.refreshLanding();
    syncAttention(sessions);
    terminal.syncSessionMetadata(sessions);
    // Skip re-render when nothing changed: the poll otherwise rebuilds the
    // row nodes under the user's finger, and WebKit cancels the synthesized
    // click when the touch target is removed mid-tap — that ate every first
    // tap on a session row (the "must double-tap" complaint).
    const json = sidebar.renderKey(sessions);
    if (json !== lastRenderedJson) {
      lastRenderedJson = json;
      renderSidebar();
    }
    if (state.selectedGhost && !state.restorable.find((g) => g.id === state.selectedGhost)) {
      // The previewed ghost restored or was forgotten elsewhere; drop the view.
      clearPreviewView();
    }
    if (state.current && !sessions.find((s) => s.id === state.current)) {
      const vanished = state.current;
      closeFileViewer();
      chat.resetChat();
      terminal.removeSessionView(vanished);
      activateQuickkeysSession(null);
      el["mode-toggle"].hidden = false;
    }
    // Pooled background entries killed elsewhere keep a terminal, host node
    // and LRU slot until evicted — dispose them here instead.
    terminal.pruneSessions(sessions);
    // A boot that raced an empty list leaves the saved id intact; pick it up
    // as soon as a real list arrives instead of stranding the tab on landing.
    if (restorePending) restoreSavedSession();
  } catch (e) {
    el["side-foot"].textContent = "offline: " + e.message;
  } finally {
    refreshing = false;
    if (refreshQueued) { refreshQueued = false; void refresh(); }
  }
}


async function boot() {
  // PWA install prompt needs a service worker (sw.js caches nothing — it only
  // satisfies the installability check). Fails silently off secure contexts.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  try {
    state.meta = await api("/meta");
    state.selectedFolder = state.selectedFolder || state.meta.workspaceRoot;
    renderSettings();
    panels.renderPanelNav();
    // The footer count; the list itself refreshes whenever the page opens.
    void artifacts.loadArtifacts();
    // Only after the token proved good: an unauthenticated check would raise
    // the auth gate a second time.
    watchOmpUpdates();
    voice.setAvailable(Boolean(state.meta.transcribe));
    if (window.matchMedia("(max-width: 1099px)").matches) el.sidebar.classList.add("hidden");
    wireViewportHeight();
  } catch (e) {
    if (e.status === 401) { showAuth(state.token ? "Invalid token — try again" : ""); return; }
    el["side-foot"].textContent = "failed to load: " + e.message;
    return;
  }
  await refresh();
  await checkFrontendVersion();
  restoreSavedSession();
  // 2s while visible so a status flip (working -> done) lands within a beat of
  // the tmux write; hidden tabs fall back to 4s but must keep polling, since
  // syncAttention's waiting notification is the whole point of a hidden tab.
  if (!polling) {
    polling = true;
    let hiddenTicks = 0;
    setInterval(() => {
      if (document.visibilityState === "hidden" && ++hiddenTicks % 2) return;
      refresh();
    }, 2000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "hidden") refresh();
    });
  }
  if (!versionPolling) { versionPolling = true; setInterval(checkFrontendVersion, 15000); }
}
async function killSession(id) {
  if (!id) return;
  const runtime = state.sessions.find((session) => session.id === id)?.type === "shell"
    ? "shell"
    : "OMP process";
  if (!confirm(`Kill this session? Its ${runtime} ends and cannot be revived.`)) return;
  try {
    const wasCurrent = state.current === id;
    await api(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    terminal.removeSessionView(id);
    if (wasCurrent) {
      closeFileViewer();
      chat.resetChat();
      activateQuickkeysSession(null);
      el["mode-toggle"].hidden = false;
    }
    await refresh();
    showNotice("Session ended");
  } catch (e) { showNotice("Kill failed: " + e.message, { tone: "error" }); }
}

async function pinSession(id, pinned) {
  try {
    await api(`/sessions/${encodeURIComponent(id)}/pin`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned }),
    });
    const local = state.sessions.find((s) => s.id === id);
    if (local) local.pinned = pinned;
    emit("sidebar:rerender");
    showNotice(pinned ? "Pinned" : "Unpinned");
  } catch (e) { showNotice("Pin failed: " + e.message, { tone: "error" }); }
}

// Rename owns the PATCH + refresh: the sidebar row only emits the intent.
async function renameSession(id, title) {
  try {
    await api(`/sessions/${encodeURIComponent(id)}/title`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    await refresh();
    showNotice("Renamed");
  } catch (e) { showNotice("Rename failed: " + e.message, { tone: "error" }); }
}

// The chat run row emits the choice; the switch is OMP's own /switch, typed
// into the session by the backend after it validates against the profile's
// catalog. The transcript's model_change shows up on the next chat poll.
async function switchSessionModel({ id, model, effort }) {
  try {
    const result = await api(`/sessions/${encodeURIComponent(id)}/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, effort: effort || null }),
    });
    const name = String(result.model || model).split("/").pop();
    showNotice(`Switched to ${name}${result.effort ? ` · ${result.effort} effort` : ""}`);
  } catch (e) { showNotice("Switch failed: " + e.message, { tone: "error" }); }
}

const openingTerminal = new Set();
// Terminal on an rpc session needs a TUI first: the server stops the bridge
// and respawns the pane, or refuses with EBUSY while a turn is running. A
// just-created session opens before refresh() lists it, so the caller may pass
// the row it already holds.
async function openTerminal(id, known = null) {
  const session = state.sessions.find((s) => s.id === id) || known;
  if (!session || session.type === "shell") return;
  if (session.runner !== "rpc") {
    if (state.current === id) { setMode("terminal"); applyMode("terminal"); }
    return;
  }
  if (openingTerminal.has(id)) return;
  openingTerminal.add(id);
  showNotice("Starting terminal…", { duration: 30000 });
  try {
    const result = await api(`/sessions/${encodeURIComponent(id)}/runner`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runner: "tui" }),
    });
    // refresh() skips while another poll is in flight; the response is the
    // authoritative row, so a repeat toggle never re-posts the conversion.
    const index = state.sessions.findIndex((s) => s.id === id);
    if (index >= 0) state.sessions[index] = result?.session || { ...state.sessions[index], runner: "tui" };
    await refresh();
    hideNotice();
    if (state.current === id) { setMode("terminal"); applyMode("terminal"); }
  } catch (e) {
    const message = e.code === "EBUSY"
      ? (e.message || "Finishing the current turn; try again or Stop")
      : "Could not open Terminal: " + e.message;
    showNotice(message, { tone: "error", duration: 5000 });
  } finally {
    openingTerminal.delete(id);
  }
}

function onAttachUi(session) {
  sessionsEpoch++;
  openSession(session);
  refresh();
}

// The landing composer has no dialog, so the folder/profile come from the last
// accepted choice and the name from the message itself. A name collision is
// the only expected failure; anything else puts the text back in the box.
async function startSessionWithMessage(text) {
  const { folder, profile } = defaultChoice();
  const base = sessionNameFrom(text);
  let lastError = null;
  // The composer clears on Enter; until the session opens with the message
  // queued, this notice is the only sign the send was taken.
  showNotice("Starting session…", { duration: 30000 });
  for (let n = 1; n <= 5; n++) {
    try {
      const session = await requestSession({ name: n === 1 ? base : `${base} ${n}`, folder, profile, noTitle: true });
      hideNotice();
      rememberChoice(folder, profile);
      if (state.mode !== "chat") setMode("chat");
      onAttachUi(session);
      await chat.sendChat(text);
      return;
    } catch (err) {
      lastError = err;
      if (err?.code !== "EEXIST") break;
    }
  }
  showNotice("Could not start session: " + (lastError?.message || "unknown error"), { tone: "error" });
  chat.restoreLandingDraft(text);
}

async function restoreSessions(ids, { folder } = {}) {
  try {
    const { results } = await api("/sessions/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, folder }),
    });
    // Restore is slow by design (paced). Refresh once; failures surface in
    await refresh();
    const ok = (results || []).filter((r) => r.ok && r.session);
    const failed = (results || []).filter((r) => !r.ok);
    if (failed.length) {
      // Name the session and the reason: a bare count left "why can't this be
      // restored?" unanswerable (a moved folder reads as a dead session).
      const first = failed[0];
      const known = state.restorable.find((g) => g.id === first.id);
      const reason = first.code === "ENOFOLDER" && known?.folder
        ? `folder not found (${known.folder})`
        : (first.message || first.code || "failed");
      const rest = failed.length > 1 ? ` (+${failed.length - 1} more)` : "";
      showNotice(`Could not restore ${known?.title || first.id}: ${reason}${rest}`, { tone: "error", duration: 6000 });
    }
    for (const result of ok) markSessionSeen(result.session);
    // A restored ghost stops being a ghost: drop the detail view, and when a
    // single session came back, open it so restore lands somewhere visible.
    if (state.selectedGhost && ok.some((r) => r.id === state.selectedGhost)) {
      state.selectedGhost = null;
      ghost.hideGhost();
    }
    if (ok.length === 1) {
      const live = state.sessions.find((s) => s.id === ok[0].id);
      if (live) openSession(live);
    } else {
      if (ok.length > 1) showNotice(`Restored ${ok.length} sessions`);
      emit("sidebar:rerender");
    }
  } catch (e) { showNotice("Restore failed: " + e.message, { tone: "error" }); }
}

async function forgetGhost(id) {
  try {
    await api(`/sessions/${encodeURIComponent(id)}/ghost`, { method: "DELETE" });
    await refresh();
    showNotice("Removed from not running");
    if (state.selectedGhost === id) clearPreviewView();
  } catch (e) { showNotice("Forget failed: " + e.message, { tone: "error" }); }
}

// Delete is the irreversible counterpart to Forget: the confirmation states
// what will be removed and how much, measured by the server just before.
async function deleteSession(id) {
  if (!id) return;
  const known = state.sessions.find((s) => s.id === id) || state.restorable.find((g) => g.id === id);
  const name = known?.title || id;
  let info;
  try {
    info = await api(`/sessions/${encodeURIComponent(id)}/footprint`);
  } catch (e) { showNotice("Delete failed: " + e.message, { tone: "error" }); return; }
  if (info.twin) {
    showNotice(`Can't delete ${name}: ${info.twin} shares its data folder`, { tone: "error", duration: 6000 });
    return;
  }
  const size = info.files ? `${formatBytes(info.bytes)} in ${info.files} file${info.files === 1 ? "" : "s"}` : "no files on disk";
  const lines = [
    `Delete "${name}" permanently?`,
    "",
    ...(info.live ? ["It is running and will be stopped first."] : []),
    `Removes its transcripts and uploads (${size}). It cannot be restored afterwards.`,
  ];
  if (!confirm(lines.join("\n"))) return;
  try {
    const wasCurrent = state.current === id;
    const result = await api(`/sessions/${encodeURIComponent(id)}/data`, { method: "DELETE" });
    if (info.live) {
      terminal.removeSessionView(id);
      if (wasCurrent) {
        closeFileViewer();
        chat.resetChat();
        activateQuickkeysSession(null);
        el["mode-toggle"].hidden = false;
      }
    }
    if (state.selectedGhost === id) clearPreviewView();
    await refresh();
    showNotice(`Deleted ${name} · freed ${formatBytes(result.freed?.bytes || 0)}`);
  } catch (e) { showNotice("Delete failed: " + e.message, { tone: "error" }); }
}

let syncViewportInset = () => {};

// Keep the PTY connected in chat mode; defer hidden resize work until the
// terminal is visible again. Connect/reconnect still establishes its size.
function applyMode(mode) {
  const current = state.sessions.find((session) => session.id === state.current);
  if (mode === "chat" && current?.type === "shell") mode = "terminal";
  state.view = mode;
  el["chat-mode"].hidden = (mode !== "chat");
  el.main.classList.toggle("chat-active", mode === "chat");
  terminal.setVisible(mode === "terminal");
  for (const seg of el["mode-toggle"].querySelectorAll(".mode-seg")) {
    seg.setAttribute("aria-pressed", String(seg.dataset.mode === mode));
  }
  if (mode === "chat") {
    // The visible terminal textarea can retain focus after a compact-mode
    // switch. Blur it before inset reconciliation so its keyboard closes
    // instead of covering the Chat composer.
    el["mobile-input"]?.blur();
    if (state.current) chat.enterChat(state.current);
    else chat.resetChat();
  } else {
    chat.leaveChat();
    // Re-fit terminal after the overlay is gone; covers any resize that
    // occurred while chat was showing.
    terminal.doFit();
  }
  syncViewportInset();
}

initDom();
// Heal a stale cached shell: ghost.ensureSkeleton() builds the detail nodes
// when index.html predates them, so preview works at any shell version and
// the button wiring below always has targets.
ghost.ensureSkeleton();
wireLinkModal({ getTerm: terminal.getTerm, focusTerminal: terminal.focusTerminal });
captureUrlToken();
sidebar.init();
wireAuth(boot);
wireQuickkeys({ voice });
activateQuickkeysSession(null);
wireUsage();
wirePalette();
wireSettings();
artifacts.wireArtifacts();
wireProfileInfo();
wireNotifications();
chat.wireComposer({ voice });
chat.resetChat();
// Apply the persisted mode now that DOM is ready (no session yet; chat.enterChat
// fires later once boot() restores or the user picks a session).
applyMode(state.mode);
// Compact layouts pin #chat-mode to the viewport because the parent chain is
// unreliable on iOS standalone (a stale 100dvh after the keyboard closes left
// the pane short, floating the composer above a dead gap). The pinned pane
// needs the live header bottom. Never resize the app frame itself: the meta
// viewport already tracks the keyboard, and shrinking the frame collapses the
// transcript above it.
let viewportWired = false;
function wireViewportHeight() {
  if (viewportWired) return;
  viewportWired = true;
  const head = document.querySelector(".term-head");
  const rootStyle = document.documentElement.style;
  const setVar = (name, value) => {
    // iOS fires visualViewport resizes per keystroke (autocomplete bar);
    // rewriting identical vars still costs a style recalc and replays the
    // pane layout, which reads as the transcript above flickering.
    if (rootStyle.getPropertyValue(name) !== value) rootStyle.setProperty(name, value);
  };
  const sync = () => {
    if (head) {
      setVar("--chat-top", `${Math.round(head.getBoundingClientRect().bottom)}px`);
    }
    // iOS can leave visualViewport stale after focus moves. Only the focused
    // chat composer may claim its covered strip; every other state clears it.
    const vv = window.visualViewport;
    const chatFocused = el.main.classList.contains("chat-active") &&
      document.activeElement === el["chat-input"];
    const covered = chatFocused && vv
      ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
      : 0;
    scheduleKbInset(covered);
    // Safari scrolls the log itself while the keyboard animates; that must not
    // read as the user leaving the tail.
    suppressTailScroll(450);
  };
  // The autocomplete bar toggles the visual viewport per keystroke; chasing
  // every oscillation moves the whole pane up and down under the user's text.
  // Changes settle through a short trailing debounce, and sub-16px noise
  // (rounding, toolbar shimmer) never applies at all. A real keyboard is
  // hundreds of px and lands 150ms later — imperceptible against its own
  // 300ms slide-in animation.
  let kbTimer = 0;
  let kbApplied = -1;
  const scheduleKbInset = (covered) => {
    clearTimeout(kbTimer);
    if (covered === 0) {
      kbApplied = 0;
      setVar("--kb-inset", "0px");
      return;
    }
    if (Math.abs(covered - kbApplied) < 16 && kbApplied >= 0) return;
    kbTimer = setTimeout(() => setVar("--kb-inset", `${covered}px`), 150);
    kbApplied = covered;
  };
  // During keyboard animation iOS reports transient viewport values; a sync
  // that lands mid-animation can compute a wrong inset and no further event
  // fires once values settle. Re-run briefly after every trigger so the final
  // pass sees settled numbers. Timers are cheap and self-cancelling by design
  // (each run only writes CSS vars).
  let settleTimers = [];
  const resyncAfterSettle = () => {
    for (const t of settleTimers) clearTimeout(t);
    settleTimers = [150, 400, 900].map((ms) => setTimeout(sync, ms));
  };
  const syncAndSettle = () => { sync(); resyncAfterSettle(); };
  syncViewportInset = syncAndSettle;
  el["chat-input"].addEventListener("focus", syncAndSettle);
  el["chat-input"].addEventListener("blur", syncAndSettle);
  if (head && window.ResizeObserver) new ResizeObserver(syncAndSettle).observe(head);
  window.addEventListener("resize", syncAndSettle);
  window.addEventListener("orientationchange", syncAndSettle);
  window.visualViewport?.addEventListener("resize", syncAndSettle);
  window.visualViewport?.addEventListener("scroll", syncAndSettle);
  sync();
}
// ---- Wiring ---------------------------------------------------------------
el["new-btn"].onclick = () => modals.openModal();
el["empty-new-btn"].onclick = () => modals.openModal();
el["m-cancel"].onclick = modals.closeModal;
el["m-create"].onclick = () => modals.createSession({ onCreated: onAttachUi });
el["kill-btn"].onclick = () => killSession(state.current);
el["profile-btn"].onclick = () => modals.openReloadModal(state.current, state.sessions);
el["r-cancel"].onclick = modals.closeReloadModal;
el["r-reload"].onclick = () => modals.doReloadProfile({
  onReloaded: (session) => {
    resetQuickkeysSession(session.id);
    chat.resetChatSession(session.id);
    syncProfileInfo(session.profile || "default");
    // Per-entry reset + cover on the reloaded id only; siblings untouched.
    terminal.resetTerm(session.id);
    showNotice(`Reloaded under ${session.profile || "default"}`);
    refresh();
  },
});
el["reload-btn"].onclick = () => location.reload();
el["update-btn"].onclick = () => location.reload();
el["menu-btn"].onclick = () => el.sidebar.classList.toggle("hidden");
// The compact drawer is the full viewport width, so the button that opened it
// sits behind it. Without this the only way out is committing to a session.
el["sidebar-close"].onclick = () => el.sidebar.classList.add("hidden");
// Only the token layer changes, so the toggle is a single attribute. The
// terminal stays dark in both: it shows another program's ANSI output.
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const light = theme === "light";
  el["theme-btn"].title = light ? "Switch to dark theme" : "Switch to light theme";
  el["theme-btn"].setAttribute("aria-label", el["theme-btn"].title);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", light ? "#ffffff" : "#0f1113");
  try { localStorage.setItem("omp_web_theme", theme); } catch {}
}
applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
el["theme-btn"].onclick = () =>
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
el["mode-toggle"].addEventListener("click", (event) => {
  const seg = event.target.closest(".mode-seg");
  if (!seg || seg.getAttribute("aria-pressed") === "true") return;
  emit("mode:change", seg.dataset.mode);
});
el["f-name"].addEventListener("keydown", (e) => { if (e.key === "Enter") modals.createSession({ onCreated: onAttachUi }); });

function closeSessionActions({ restoreFocus = false } = {}) {
  el["session-actions"].hidden = true;
  el["session-actions-toggle"].setAttribute("aria-expanded", "false");
  if (restoreFocus) el["session-actions-toggle"].focus();
}
el["session-actions-toggle"].onclick = () => {
  const open = el["session-actions"].hidden;
  el["session-actions"].hidden = !open;
  el["session-actions-toggle"].setAttribute("aria-expanded", String(open));
};
el["session-actions"].addEventListener("click", (event) => {
  // The popovers live outside this menu now, so every item closes it; the
  // popover it opened stays up.
  if (event.target.closest("button")) closeSessionActions();
});
document.addEventListener("click", (event) => {
  if (!el["session-actions"].contains(event.target) &&
      !el["session-actions-toggle"].contains(event.target)) closeSessionActions();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!el["session-actions"].hidden) {
    closeSessionActions({ restoreFocus: true });
    return;
  }
  // One dismissal grammar for every dialog. The auth gate is excluded on
  // purpose: nothing behind it is usable, so dismissing it would be a dead end.
  if (!el.modal.hidden) { modals.closeModal(); return; }
  if (!el["reload-modal"].hidden) { modals.closeReloadModal(); }
});
// Enter commits from either text field; the selects keep native behaviour.
el["r-model"].addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  el["r-reload"].click();
});


// Sidebar event bridge: view modules emit intents; main owns the actions.
get("session:pin", (p) => pinSession(p.id, p.pinned));
get("session:rename", (p) => renameSession(p.id, p.title));
get("session:kill", (id) => killSession(id));
get("session:open", (id) => {
  const session = state.sessions.find((s) => s.id === id);
  if (session) openSession(session);
});
get("session:reloadRequest", (id) => modals.openReloadModal(id, state.sessions));
get("session:switchModel", (choice) => switchSessionModel(choice));
get("session:newInFolder", (folder) => modals.openModal(folder));
get("session:restore", ({ ids, folder }) => restoreSessions(ids, { folder }));
get("session:forget", (id) => forgetGhost(id));
get("session:delete", (id) => deleteSession(id));
get("ghost:select", (id) => selectGhost(id));
get("panel:open", (id) => selectPanel(id));
get("settings:open", (section) => selectSettings(section));
get("artifacts:open", (slug) => selectArtifacts(slug));
get("sessions:refresh", () => refresh());
get("panels:saved", ({ changed } = {}) => {
  panels.dropFrames(changed || []);
  void refreshMeta();
});
get("meta:refresh", () => refreshMeta());
// Ghost detail actions live on the static skeleton in index.html; they act on
// whichever ghost is currently selected.
el["ghost-restore-btn"].onclick = () => {
  const item = ghost.selectedGhost();
  if (!item) return;
  restoreSessions([item.id], { folder: item.folderMissing ? item.relocatedFolder || undefined : undefined });
};
el["ghost-copy-btn"].onclick = () => {
  const item = ghost.selectedGhost();
  if (item?.folder) copyWithNotice(item.folder, "Copied path");
};
el["ghost-forget-btn"].onclick = () => {
  if (state.selectedGhost) forgetGhost(state.selectedGhost);
};
// A tab holding an older cached shell has no Delete button in the detail view.
if (el["ghost-delete-btn"]) {
  el["ghost-delete-btn"].onclick = () => {
    if (state.selectedGhost) deleteSession(state.selectedGhost);
  };
}
// Back returns to the parked live session (or empty chrome when none): the
// same clearPreviewView flow as opening a session, guarded for cached old shells.
if (el["ghost-back-btn"]) el["ghost-back-btn"].onclick = () => clearPreviewView();
// UI-only sidebar state must rerender immediately without waiting for polling.
get("sidebar:rerender", () => {
  lastRenderedJson = sidebar.renderKey(state.sessions);
  renderSidebar();
});
get("chat:send", (p) => chat.sendChat(p.text));
get("chat:startSession", ({ text }) => startSessionWithMessage(text));
get("chat:interrupt", () => chat.interruptChat());
get("chat:retry", (p) => chat.retryChat(p.id));
get("chat:edit", (p) => chat.editChat(p.id));
get("chat:regenerate", (p) => chat.regenerateLast(p?.sessionId));
get("chat:retryPoll", (p) => chat.retryPollTurn(p?.sessionId));
get("chat:retryInterrupt", (p) => chat.retryInterrupt(p?.sessionId));
get("file:open", ({ path }) => openFileViewer({ sessionId: state.current, path }));
get("auth:required", () => {
  if (el.authgate.hidden) showAuth("Your token is no longer accepted. Unlock to reconnect.");
});
get("mode:change", (mode) => {
  const current = state.sessions.find((s) => s.id === state.current);
  if (mode === "terminal" && current?.runner === "rpc") { void openTerminal(current.id); return; }
  setMode(mode);
  applyMode(mode);
});
get("session:openTerminal", (id) => openTerminal(id));
get("chat:answer", (answer) => chat.answerAsk(answer));
get("meta:refreshed", renderSettings);
get("meta:refreshed", () => panels.renderPanelNav());
// Voice readiness lives in /api/meta; Settings → Voice and Credentials ask for
// a meta refresh after a change, and the microphone follows without a reload.
get("meta:refreshed", () => voice.setAvailable(Boolean(state.meta?.transcribe)));
boot();