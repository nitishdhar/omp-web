"use strict";
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const {
  profileHome,
  profileSessionDirFor,
  sessionDirFor,
  bestResumeSource,
  readTranscriptTitle,
  resolveTranscript,
  fileMtime,
  newestOwnedJsonl,
  substantiveOwnedJsonl,
  sessionCwdFor,
} = require("./transcripts");
const {
  STATUS_STALE_MS,
  THINKING_STALE_MS,
  normalizedSessionStatus,
} = require("./sessions/status");
const registry = require("./registry");
const { listFolders } = require("./api/util");

// Thin wrapper around a dedicated tmux server (socket `config.tmuxSocket`).
// tmux is the source of truth for session liveness; per-session metadata
// (folder, profile, type, title, created) lives in `@omp_*` user options so it
// dies with the session — no sidecar file.

const OPT_KEYS = [
  "folder", "profile", "type", "status", "status_at", "activity", "title", "created",
  "pinned", "transcript", "thinking", "thinking_at", "model", "model_at",
];
const SCROLL_FORMAT = "#{history_size}\t#{scroll_position}\t#{pane_in_mode}";
const PANE_SCROLL_FORMAT = `#{pane_id}\t${SCROLL_FORMAT}`;
const SESSION_FORMAT = [
  "#{session_name}",
  "#{@omp_folder}",
  "#{@omp_profile}",
  "#{@omp_type}",
  "#{@omp_status}",
  "#{@omp_status_at}",
  "#{@omp_activity}",
  "#{pane_current_command}",
  "#{@omp_title}",
  "#{@omp_created}",
  "#{session_attached}",
  "#{session_windows}",
  "#{session_activity}",
  "#{@omp_pinned}",
  "#{@omp_transcript}",
  "#{@omp_thinking}",
  "#{@omp_thinking_at}",
  "#{@omp_model}",
  "#{@omp_model_at}",
  "#{@omp_notitle}",
  "#{@omp_title_lock}",
].join("\t");
const SESSION_ID = /^[A-Za-z0-9_-]{1,40}$/;
const BOOTSTRAP_MARK = String(process.pid);
const EFFORT_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const STATUS_EXTENSION = path.join(__dirname, "extensions", "session-status.mjs");
const OMP_GUARD_REJECTED = "__omp_web_not_running__";
const TMUX_COMMAND_TOKEN = /^[A-Za-z0-9_@%=:.,+;/-]+$/;
const MODEL_WINDOW_CACHE = new Map();
const MODEL_WINDOW_CACHE_TTL_MS = 5 * 60 * 1000;

function sessionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Registry write-through never fails the caller: tmux is the source of truth
// and a dead registry must not break create/kill/pin. Adopt-on-list heals
// missed writes; ghosts are recomputed from the registry on every read.
function rememberSession(record) {
  try {
    registry.upsert(record);
  } catch (error) {
    console.error(`registry upsert failed (${record && record.id}): ${error.message}`);
  }
}

function forgetSession(id) {
  try {
    registry.remove(id);
  } catch (error) {
    console.error(`registry remove failed (${id}): ${error.message}`);
  }
}

function isMissingTarget(message) {
  return /no server running|no sessions|no current target|can't find (?:session|window|pane)|failed to connect/i.test(message);
}

function parseScrollState(stdout) {
  const line = String(stdout || "").trimEnd().split(/\r?\n/).at(-1) || "";
  const [historyRaw, positionRaw, modeRaw] = line.split("\t");
  const history = Math.max(0, Number.parseInt(historyRaw, 10) || 0);
  const inMode = modeRaw === "1";
  const position = inMode ? Math.max(0, Number.parseInt(positionRaw, 10) || 0) : 0;
  return { history, position: Math.min(history, position), inMode };
}

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile(
      config.tmuxBin,
      ["-L", config.tmuxSocket, ...args],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message || "");
          if (/no server running|failed to connect/i.test(msg)) bootstrapped = false;
          if (isMissingTarget(msg)) {
            return resolve({ empty: true, stdout: "", stderr: msg });
          }
          return reject(new Error(msg.trim() || "tmux failed"));
        }
        resolve({ empty: false, stdout, stderr });
      }
    );
  });
}

function slug(name) {
  const s = String(name || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || `s${Date.now().toString(36)}`;
}

function rawTmuxName(id) {
  if (typeof id !== "string" || !SESSION_ID.test(id)) {
    throw sessionError("EBADID", "invalid session id");
  }
  return config.sessionPrefix + id;
}

function tmuxName(id) {
  return `=${rawTmuxName(id)}`;
}

function tmuxPane(id) {
  return `${tmuxName(id)}:`;
}

function shellQuote(value) {
  const text = String(value);
  if (/[\x00-\x1f\x7f]/.test(text)) {
    throw sessionError("EBADARG", "command arguments cannot contain control characters");
  }
  return `'${text.replace(/'/g, `'\"'\"'`)}'`;
}

function shellCommand(args) {
  return args.map(shellQuote).join(" ");
}

function recoverableAgentCommand(args, target) {
  const markShell = shellCommand([
    config.tmuxBin, "-L", config.tmuxSocket,
    "set-option", "-t", target, "@omp_status", "shell",
  ]);
  const flushInput = shellCommand([
    "/usr/bin/perl", "-MPOSIX=tcflush,TCIFLUSH", "-e",
    "defined(tcflush(STDIN, TCIFLUSH)) or exit 1",
  ]);
  // Revoke Chat first, then discard bytes accepted during OMP's exit race
  // before an interactive shell can read from the shared pane PTY.
  const recover = `${markShell} && ${flushInput} && exec "\${SHELL:-/bin/zsh}" -l`;
  const body = `${shellCommand(args)}; ${recover}; exec /usr/bin/tail -f /dev/null`;
  return `exec "\${SHELL:-/bin/zsh}" -lc ${shellQuote(body)}`;
}

async function launchAgentPane(pane, target, cwd, args) {
  requireResult(await tmux([
    "respawn-pane", "-k", "-c", cwd, "-t", pane, recoverableAgentCommand(args, target),
  ]));
}
function ompCommand(id) {
  return [
    "/usr/bin/env",
    "OMP_PROFILE=",
    "PI_PROFILE=",
    `PI_CODING_AGENT_DIR=${profileHome("default")}`,
    `OMP_WEB_STATUS_TARGET=${tmuxPane(id)}`,
    `OMP_WEB_TMUX_SOCKET=${config.tmuxSocket}`,
    `OMP_WEB_TMUX_BIN=${config.tmuxBin}`,
    config.ompBin,
    "--extension", STATUS_EXTENSION,
  ];
}


function requireResult(result) {
  if (result.empty) throw sessionError("ENOSESSION", "session not found");
  return result;
}

async function trackedTranscript(id, profile) {
  const stored = await tmux(["show-option", "-t", tmuxPane(id), "-v", "@omp_transcript"])
    .then((res) => res.stdout.trim())
    .catch(() => "");
  return resolveTranscript(id, profile, stored);
}

// Read a profile's default model role, e.g. "ollama-cloud/glm-5.3-flash:high",
// straight from native OMP's config.yml on every call. Native OMP rewrites that
// file whenever a role changes (`/model`, `/settings`, a config installer), so
// any stored copy goes stale; a process-lifetime cache once made Reload profile
// relaunch sessions on the model the profile had when the server started. The
// read+parse costs ~10 µs, negligible even on the fastest chat-poll cadence.
function defaultRoleFor(profile) {
  let home;
  try {
    home = profileHome(profile);
  } catch {
    return "";
  }

  let text = "";
  try {
    text = fs.readFileSync(path.join(home, "config.yml"), "utf8");
  } catch {}

  let role = "";
  let inRoles = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^modelRoles:\s*$/.test(line)) {
      inRoles = true;
      continue;
    }
    if (!inRoles) continue;
    if (/^\S/.test(line)) break; // left the modelRoles block
    const match = line.match(/^\s+default:\s*(\S+)\s*$/);
    if (match) {
      role = match[1];
      break;
    }
  }

  return role;
}

function configuredEffortFor(profile, liveModel, liveProvider) {
  if (!liveModel) return "";
  const role = defaultRoleFor(profile);
  const separator = role.lastIndexOf(":");
  if (separator < 0) return "";
  const effort = role.slice(separator + 1).toLowerCase();
  if (!EFFORT_LEVELS.has(effort)) return "";
  const configuredModel = role.slice(0, separator);
  const currentModel = String(liveModel);
  const liveIdentifier = currentModel.includes("/") || !liveProvider
    ? currentModel
    : `${liveProvider}/${currentModel}`;
  return configuredModel === liveIdentifier ? effort : "";
}

// What a session was launched on, as { provider, model, effort } — the model
// omp-web passed with --model at reload, or else the profile default that a
// plain `omp --profile=<name>` starts. Used only until the transcript names the
// real runtime model; a model switched inside the TUI writes model_change and
// wins immediately.
function launchIdentityFor(profile, launchModel) {
  let role = String(launchModel || "").trim() || defaultRoleFor(profile || "default");
  if (!role) return null;
  let effort = null;
  const separator = role.lastIndexOf(":");
  if (separator > 0 && EFFORT_LEVELS.has(role.slice(separator + 1).toLowerCase())) {
    effort = role.slice(separator + 1).toLowerCase();
    role = role.slice(0, separator);
  }
  const slash = role.indexOf("/");
  return slash > 0
    ? { provider: role.slice(0, slash), model: role.slice(slash + 1), effort }
    : { provider: null, model: role, effort };
}

// Ensure server-wide options that make multi-client (desktop + phone) resize
// behave. One tmux command keeps a freshly started, otherwise-empty server
// alive long enough to configure it.
let bootstrapped = false;
async function bootstrap() {
  if (bootstrapped) return;
  const result = await tmux([
    "start-server",
    ";", "set-option", "-s", "exit-empty", "off",
    ";", "set-option", "-g", "@omp_web_bootstrap", BOOTSTRAP_MARK,
    ";", "set-option", "-g", "window-size", "latest",
    ";", "set-option", "-g", "aggressive-resize", "on",
    ";", "set-option", "-g", "default-command", "exec $SHELL -l",
    ";", "set-option", "-g", "status", "off",
    // The browser client is xterm.js, which honours synchronized output (DEC
    // 2026). OMP wraps each ~30fps repaint in it, but tmux only forwards the
    // markers to clients it believes support them, and xterm-256color doesn't
    // advertise it — so the browser painted every half-drawn frame (flicker).
    // Indexed set replaces tmux's own xterm* default in place: idempotent
    // across omp-web restarts, where the tmux server outlives the process.
    ";", "set-option", "-s", "terminal-features[0]", "xterm*:clipboard:ccolour:cstyle:focus:title:sync",
  ]);
  if (result.empty) throw new Error("failed to initialize tmux server");
  bootstrapped = true;
}

function sessionFromLine(line) {
  const [
    name, folder, profile, type, rawStatus, rawStatusAt, rawRuntimeActivity,
    paneCommand, title, created, attached, windows, sessionActivity, pinned, source,
    rawThinking, rawThinkingAt, rawLaunchModel, rawLaunchedAt, rawNoTitle, rawTitleLock,
  ] = line.split("\t");
  const id = name.slice(config.sessionPrefix.length);
  const sessionProfile = profile || "default";
  const sessionType = type === "shell" ? "shell" : "agent";
  const publishedStatusAt = Number(rawStatusAt) || 0;
  const transcript = sessionType === "agent"
    ? resolveTranscript(id, sessionProfile, source)
    : "";
  const { status, statusAt } = normalizedSessionStatus(
    sessionType, rawStatus, publishedStatusAt, paneCommand, transcript
  );
  const persistedTitle = transcript ? readTranscriptTitle(transcript) : "";
  // Manual renames lock @omp_title against transcript auto-titling so a
  // renamed session keeps its name across restarts and transcript updates.
  const titleLocked = rawTitleLock === "1";
  const target = tmuxPane(id);
  if (transcript && transcript !== source) {
    tmux(["set-option", "-t", target, "@omp_transcript", transcript]).catch(() => {});
  }
  if (!titleLocked && persistedTitle && persistedTitle !== title) {
    tmux(["set-option", "-t", target, "@omp_title", persistedTitle]).catch(() => {});
  }
  const publishedAge = Date.now() - publishedStatusAt;
  const runtimeActivity = rawStatus === "working"
    && publishedStatusAt && publishedAge >= 0 && publishedAge <= STATUS_STALE_MS
    && rawRuntimeActivity === "compaction"
    ? rawRuntimeActivity
    : "";
  // The extension clears this when reasoning ends, but a hard kill cannot; a
  // short staleness window keeps a dead headline from outliving the turn.
  const thinkingAt = Number(rawThinkingAt) || 0;
  const thinking = rawStatus === "working"
    && thinkingAt && Date.now() - thinkingAt <= THINKING_STALE_MS
    ? String(rawThinking || "").slice(0, 120)
    : "";
  return {
    id,
    tmux: name,
    folder: folder || "",
    profile: sessionProfile,
    type: sessionType,
    status,
    statusAt,
    runtimeActivity,
    title: titleLocked ? (title || name) : (persistedTitle || title || name),
    created: Number(created) || 0,
    attached: Number(attached) || 0,
    windows: Number(windows) || 1,
    lastActivity: Number(sessionActivity) || 0,
    pinned: pinned === "1",
    notitle: rawNoTitle === "1",
    titleLocked,
    // Size powers the unread indicator; the status cache already stats this
    // file, but not for shell sessions, so stat here and tolerate failure.
    transcriptSize: transcript ? transcriptSizeOf(transcript) : 0,
    thinking,
    launchModel: String(rawLaunchModel || "").slice(0, 256),
    launchedAt: Number(rawLaunchedAt) || 0,
  };
}

function transcriptSizeOf(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

async function list() {
  await bootstrap();
  const res = await tmux(["list-sessions", "-F", SESSION_FORMAT]);
  if (res.empty || !res.stdout.trim()) return [];
  const live = res.stdout
    .trim()
    .split("\n")
    .filter((line) => line.startsWith(config.sessionPrefix))
    .map(sessionFromLine)
    .sort((a, b) => b.lastActivity - a.lastActivity);
  // Adopt live sessions missing from the registry (pre-registry sessions,
  // missed writes, hand-made tmux sessions). Never the reverse: registry
  // entries without live sessions are ghosts, never auto-created. One
  // deferred write for the whole batch: adopt heals on every list, so a
  // dropped flush is retried next time and GET never pays for N upserts.
  try {
    const { entries } = registry.readRegistry();
    const missing = [];
    for (const session of live) {
      if (entries[session.id] || !session.folder) continue;
      missing.push({
        id: session.id,
        folder: session.folder,
        profile: session.profile || "default",
        type: session.type,
        title: session.title || session.id,
        created: Number(session.created) || Date.now(),
        pinned: Boolean(session.pinned),
      });
    }
    if (missing.length) {
      setImmediate(() => {
        try {
          const current = registry.readRegistry();
          const merged = { ...current.entries };
          const adopted = new Set();
          for (const record of missing) {
            if (merged[record.id]) continue;
            merged[record.id] = record;
            adopted.add(record.id);
          }
          if (!adopted.size) return;
          registry.writeRegistry(merged, current.forgotten.filter((id) => !adopted.has(id)));
        } catch (error) {
          console.error(`registry adopt failed: ${error.message}`);
        }
      });
    }
  } catch (error) {
    console.error(`registry adopt failed: ${error.message}`);
  }
  return live;
}

async function get(id) {
  await bootstrap();
  const result = await tmux(["display-message", "-p", "-t", tmuxPane(id), SESSION_FORMAT]);
  if (result.empty || !result.stdout.trim()) return null;
  const line = result.stdout.trimEnd().split(/\r?\n/).at(-1);
  return line.startsWith(rawTmuxName(id) + "\t") ? sessionFromLine(line) : null;
}

async function exists(id) {
  await bootstrap();
  return !(await tmux(["has-session", "-t", tmuxName(id)])).empty;
}

// Ghost rows: dead sessions with enough on disk to restore explicitly.
// Primary source is the registry; the transcript fallback covers pre-registry
// ids. Units match live sessions: created in ms, lastActivity in seconds.
//
// Projects get moved (e.g. ~/workspace/x -> ~/private/x). A session whose
// recorded folder is gone cannot restore there, so say so up front, and when
// exactly one listed folder has the same name, offer it as where it went.
function isDirectory(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}
function folderStatus(folder) {
  if (!folder || isDirectory(folder)) return { folderMissing: false };
  const name = path.basename(folder);
  const candidates = listFolders().filter((entry) => path.basename(entry.path) === name);
  return {
    folderMissing: true,
    relocatedFolder: candidates.length === 1 ? candidates[0].path : null,
  };
}
async function restorable() {
  const live = await list();
  const liveIds = new Set(live.map((session) => session.id));
  const { entries, forgotten } = registry.readRegistry();
  const forgottenSet = new Set(forgotten);
  const ghosts = [];
  for (const entry of Object.values(entries)) {
    if (liveIds.has(entry.id)) continue;
    const transcript = resolveTranscript(entry.id, entry.profile);
    // A manual rename outranks omp's transcript auto-title, here as in the
    // live row, so a not-running row keeps the name the user gave it.
    const title = (entry.titleLocked && entry.title)
      || (transcript && readTranscriptTitle(transcript)) || entry.title || entry.id;
    const ownedMtime = fileMtime(newestOwnedJsonl(entry.id));
    const createdMs = Number(entry.created) || 0;
    ghosts.push({
      id: entry.id,
      folder: entry.folder,
      profile: entry.profile,
      type: entry.type,
      title,
      pinned: Boolean(entry.pinned),
      created: createdMs,
      lastActivity: ownedMtime >= 0 ? Math.floor(ownedMtime / 1000) : Math.floor(createdMs / 1000),
      source: "registry",
    });
  }
  // Fallback: transcript-backed dirs neither live nor registered. Shell
  // sessions never write transcripts, so these are always agent sessions.
  // Ids without a recorded cwd are omitted — CLI `recover --list` stays
  // their path; there is deliberately no folder-prompt UI.
  let dirents;
  try {
    dirents = fs.readdirSync(config.sessionsDir, { withFileTypes: true });
  } catch {
    dirents = [];
  }
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const id = dirent.name;
    if (liveIds.has(id) || entries[id] || forgottenSet.has(id)) continue;
    if (!SESSION_ID.test(id)) continue;
    const substantive = substantiveOwnedJsonl(id);
    if (!substantive) continue;
    const folder = sessionCwdFor(id);
    if (!folder) continue;
    const mtime = fileMtime(substantive.file);
    ghosts.push({
      id,
      folder,
      profile: substantive.profile,
      type: "agent",
      title: readTranscriptTitle(substantive.file) || id,
      pinned: false,
      created: mtime >= 0 ? Math.floor(mtime) : 0,
      lastActivity: mtime >= 0 ? Math.floor(mtime / 1000) : 0,
      source: "transcript",
    });
  }
  for (const ghost of ghosts) Object.assign(ghost, folderStatus(ghost.folder));
  return ghosts;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function restoreOne(id, folderOverride = null) {
  try {
    if (typeof id !== "string" || !SESSION_ID.test(id)) {
      throw sessionError("EBADID", "invalid session id");
    }
    const live = await get(id);
    if (live) return { id, ok: true, session: live, note: "already-live" };
    const { entries } = registry.readRegistry();
    let spec = entries[id];
    if (!spec) {
      const substantive = substantiveOwnedJsonl(id);
      const folder = substantive && sessionCwdFor(id);
      if (!substantive || !folder) {
        return { id, ok: false, code: "ENOFOLDER", message: "no recorded folder for this session" };
      }
      spec = {
        id,
        folder,
        profile: substantive.profile,
        type: "agent",
        title: readTranscriptTitle(substantive.file) || id,
        pinned: false,
      };
    }
    // create() derives the id from the name via slug(), so the name pins the
    // id and the human title is restored separately — naming from the title
    // would drift the id whenever the title is not slug-stable ("My session!").
    if (folderOverride) spec = { ...spec, folder: folderOverride };
    let session = await create({
      name: id,
      folder: spec.folder,
      profile: spec.profile,
      type: spec.type,
      resume: spec.type === "agent" ? true : undefined,
      noTitle: spec.notitle === true,
      titleLocked: spec.titleLocked === true,
    });
    if (spec.title && spec.title !== id) {
      try {
        requireResult(await tmux(["set-option", "-t", tmuxPane(id), "@omp_title", spec.title]));
      } catch {
        // Title is cosmetic; the session is live regardless.
      }
      session = (await get(id)) || session;
    }
    if (spec.pinned && !session.pinned) {
      try {
        session = await setPinned(id, true);
      } catch {
        // Pin loss is cosmetic; the session is live regardless.
      }
    }
    rememberSession({
      id,
      folder: session.folder || spec.folder,
      profile: session.profile || spec.profile || "default",
      type: session.type,
      title: spec.title || id,
      created: Number(session.created) || Date.now(),
      pinned: Boolean(session.pinned),
      notitle: spec.notitle === true,
      titleLocked: spec.titleLocked === true,
    });
    return { id, ok: true, session };
  } catch (error) {
    if (error && error.code === "EEXIST") {
      const live = await get(id).catch(() => null);
      if (live) return { id, ok: true, session: live, note: "already-live" };
    }
    return { id, ok: false, code: (error && error.code) || "EINTERNAL", message: error.message };
  }
}

// Sequential, idempotent, storm-safe bulk restore. One failure never aborts
// the batch; pacing keeps a 40-session restore-all from spawning at once.
async function restore(ids, { folder } = {}) {
  const list = Array.isArray(ids) ? ids : [];
  // A folder override only makes sense for one session: it is the answer to
  // "this project moved", never a bulk relocation.
  const override = list.length === 1 && typeof folder === "string" && folder ? folder : null;
  const results = [];
  for (let index = 0; index < list.length; index += 1) {
    if (index > 0) await sleep(750);
    results.push(await restoreOne(list[index], override));
  }
  return results;
}

// Forget a ghost, whether registry or transcript-fallback. Drops registry entry
// or marks transcript-fallback as forgotten. Throws ENOSESSION if neither found.
// Transcripts are untouched; forgotten marker prevents restorable() from listing.
function forgetGhost(id) {
  if (typeof id !== "string" || !SESSION_ID.test(id)) {
    throw sessionError("EBADID", "invalid session id");
  }
  try {
    // Try registry entry first (most common path for pinned sessions).
    if (registry.remove(id)) return true;
    // Check if it's a transcript-fallback ghost (no registry but has transcript dir).
    const substantive = substantiveOwnedJsonl(id);
    const folder = substantive && sessionCwdFor(id);
    if (substantive && folder) {
      // Mark as forgotten so restorable() excludes it going forward.
      registry.forget(id);
      return true;
    }
    // Neither registry nor transcript-fallback ghost found.
    throw sessionError("ENOSESSION", "session not found");
  } catch (error) {
    if (error && error.code === "ENOSESSION") throw error;
    console.error(`registry forget failed (${id}): ${error.message}`);
    throw sessionError("EINTERNAL", "could not forget session");
  }
}

async function resolvePane(id) {
  await bootstrap();
  let result = requireResult(
    await tmux(["display-message", "-p", "-t", tmuxPane(id), "#{@omp_web_bootstrap}\t#{pane_id}"])
  );
  let [mark, pane] = result.stdout.trim().split("\t");
  if (mark !== BOOTSTRAP_MARK) {
    bootstrapped = false;
    await bootstrap();
    result = requireResult(
      await tmux(["display-message", "-p", "-t", tmuxPane(id), "#{@omp_web_bootstrap}\t#{pane_id}"])
    );
    [mark, pane] = result.stdout.trim().split("\t");
  }
  if (mark !== BOOTSTRAP_MARK || !/^%\d+$/.test(pane)) {
    throw sessionError("ENOSESSION", "session not found");
  }
  return pane;
}
async function create({ name, folder, profile, type = "agent", resume, noTitle, titleLocked = false } = {}) {
  await bootstrap();
  const id = slug(name);
  if (await exists(id)) {
    throw sessionError("EEXIST", `A session named "${id}" already exists`);
  }
  const sessionType = String(type || "agent");
  if (sessionType !== "agent" && sessionType !== "shell") {
    throw sessionError("EBADTYPE", "session type must be agent or shell");
  }
  // Reapply server options even if another process recreated tmux between
  // the existence check and this new session.
  bootstrapped = false;
  await bootstrap();
  const cwd = path.resolve(folder || config.workspaceRoot);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw sessionError("ENOFOLDER", "folder not found");
  }
  const prof = sessionType === "agent" && profile && profile !== "default"
    ? String(profile)
    : "";
  const rawName = rawTmuxName(id);
  const target = tmuxPane(id);

  requireResult(await tmux(["new-session", "-d", "-s", rawName, "-x", "220", "-y", "50", "-c", cwd]));
  requireResult(await tmux(["set-option", "-t", target, "@omp_folder", cwd]));
  requireResult(await tmux(["set-option", "-t", target, "@omp_profile", prof || "default"]));
  requireResult(await tmux(["set-option", "-t", target, "@omp_type", sessionType]));
  const initialStatus = sessionType === "shell" ? "shell" : "starting";
  const createdAt = Date.now();
  requireResult(await tmux(["set-option", "-t", target, "@omp_status", initialStatus]));
  requireResult(await tmux(["set-option", "-t", target, "@omp_status_at", String(createdAt)]));
  requireResult(await tmux(["set-option", "-t", target, "@omp_title", String(name || id)]));
  requireResult(await tmux(["set-option", "-t", target, "@omp_created", String(createdAt)]));
  // Title generation is omp core behavior (tiny local models); record an
  // explicit opt-out per session so relaunches can re-apply it. Absent for
  // older sessions, which keep today's auto-title default.
  if (noTitle && sessionType === "agent") {
    requireResult(await tmux(["set-option", "-t", target, "@omp_notitle", "1"]));
  }
  // A restored rename carries its lock forward so the title survives the
  // next transcript sync; tmux stays the source of truth for the live set.
  if (titleLocked === true) {
    requireResult(await tmux(["set-option", "-t", target, "@omp_title_lock", "1"]));
  }
  requireResult(await tmux(["set-option", "-t", target, "status", "off"]));
  const record = {
    id,
    folder: cwd,
    profile: prof || "default",
    type: sessionType,
    title: String(name || id),
    created: createdAt,
    pinned: false,
    notitle: noTitle === true,
    titleLocked: titleLocked === true,
  };

  // tmux's configured default command is already `exec $SHELL -l`. Shell
  // sessions stop here: no OMP directory is created and no command is injected.
  if (sessionType === "shell") {
    rememberSession(record);
    return get(id);
  }

  // A session dir belongs to exactly one OMP profile home. Cross-profile
  // reloads fork from this transcript into the target profile's own directory.
  // The pane wrapper launches OMP without simulated typing, then returns to a
  // recoverable login shell when OMP exits.
  // create() historically launched without -r: a brand-new id owns an empty
  // dir, so there was nothing to resume. After tmux-server loss the same id
  // is recreated with surviving transcripts, and a fresh launch drops into
  // the resume picker instead of the work. Default to resuming the largest
  // substantive transcript under this profile (never another profile's);
  // pass resume:false for a clean start.
  const sdir = profileSessionDirFor(id, prof || "default");
  fs.mkdirSync(sdir, { recursive: true });
  const command = ompCommand(id);
  if (prof) command.push(`--profile=${prof}`);
  command.push(`--session-dir=${sdir}`);
  // Verified against the installed binary (v18.2.10): --no-title disables
  // title auto-generation for the run.
  if (noTitle) command.push("--no-title");
  const resumeSource = resume === false ? null : bestResumeSource(id, prof || "default");
  if (resumeSource) command.push("-r", resumeSource);
  const pane = await resolvePane(id);
  await launchAgentPane(pane, target, cwd, command);
  rememberSession(record);

  return get(id);
}

async function setPinned(id, pinned) {
  await bootstrap();
  const target = tmuxPane(id);
  const args = pinned
    ? ["set-option", "-t", target, "@omp_pinned", "1"]
    : ["set-option", "-t", target, "-u", "@omp_pinned"];
  requireResult(await tmux(args));
  // No entry → no-op: adopt-on-list backfills drifted sessions from tmux.
  try {
    const { entries } = registry.readRegistry();
    if (entries[id]) registry.upsert({ ...entries[id], pinned: Boolean(pinned) });
  } catch (error) {
    console.error(`registry pin update failed (${id}): ${error.message}`);
  }
  return get(id);
}
// Manual rename: trims, locks the display title against transcript
// auto-titling, and opts out of future auto-titles. The tmux session name
// (slug/id) never changes, only @omp_title; the lock survives restarts via
// the registry and skips the transcript->@omp_title sync in sessionFromLine.
async function renameTitle(id, title) {
  await bootstrap();
  if (typeof id !== "string" || !SESSION_ID.test(id)) {
    throw sessionError("EBADID", "invalid session id");
  }
  // tmux prints user options raw and list output is split on tab/newline,
  // so a control character would shift every later field of this row.
  const trimmed = typeof title === "string" ? title.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
  if (!trimmed) {
    throw sessionError("EBADTITLE", "title is required");
  }
  if (trimmed.length > 120) {
    throw sessionError("EBADTITLE", "title must be 120 characters or fewer");
  }
  const live = await get(id);
  if (!live) throw sessionError("ENOSESSION", "session not found");
  const target = tmuxPane(id);
  // Lock before title: a concurrent list() that sees the new title must also
  // see the lock, or its transcript sync would overwrite the rename.
  requireResult(await tmux(["set-option", "-t", target, "@omp_title_lock", "1"]));
  requireResult(await tmux(["set-option", "-t", target, "@omp_notitle", "1"]));
  requireResult(await tmux(["set-option", "-t", target, "@omp_title", trimmed]));
  rememberSession({
    id,
    folder: live.folder,
    profile: live.profile || "default",
    type: live.type,
    title: trimmed,
    created: Number(live.created) || Date.now(),
    pinned: Boolean(live.pinned),
    notitle: true,
    titleLocked: true,
  });
  return get(id);
}

async function paneScrollState(id) {
  await bootstrap();
  let result = requireResult(
    await tmux([
      "display-message", "-p", "-t", tmuxPane(id),
      `#{@omp_web_bootstrap}\t${PANE_SCROLL_FORMAT}`,
    ])
  );
  let line = result.stdout.trimEnd().split(/\r?\n/).at(-1) || "";
  if (!line.startsWith(`${BOOTSTRAP_MARK}\t`)) {
    bootstrapped = false;
    await bootstrap();
    result = requireResult(
      await tmux([
        "display-message", "-p", "-t", tmuxPane(id),
        `#{@omp_web_bootstrap}\t${PANE_SCROLL_FORMAT}`,
      ])
    );
    line = result.stdout.trimEnd().split(/\r?\n/).at(-1) || "";
  }
  const fields = line.split("\t");
  const mark = fields.shift();
  const pane = fields.shift();
  if (mark !== BOOTSTRAP_MARK || !/^%\d+$/.test(pane)) {
    throw sessionError("ENOSESSION", "session not found");
  }
  return { pane, scroll: parseScrollState(fields.join("\t")) };
}

async function scrollState(id) {
  return (await paneScrollState(id)).scroll;
}

async function setScrollPosition(id, position) {
  const requested = Number(position);
  if (!Number.isInteger(requested) || requested < 0 || requested > 1000000) {
    throw sessionError("EBADSCROLL", "invalid scroll position");
  }
  const { pane, scroll: current } = await paneScrollState(id);
  const targetPosition = Math.min(current.history, requested);
  if (targetPosition === current.position && (targetPosition || !current.inMode)) return current;

  const args = targetPosition === 0
    ? ["send-keys", "-t", pane, "-X", "cancel"]
    : [
        "copy-mode", "-e", "-t", pane,
        ";", "send-keys", "-t", pane, "-X", "-N",
        String(Math.abs(targetPosition - current.position)),
        targetPosition > current.position ? "scroll-up" : "scroll-down",
      ];
  args.push(";", "display-message", "-p", "-t", pane, SCROLL_FORMAT);
  return parseScrollState(requireResult(await tmux(args)).stdout);
}

async function scroll(id, direction, steps = 2) {
  const action = direction === "up" ? "scroll-up" : direction === "down" ? "scroll-down" : "";
  const count = Number(steps);
  if (direction !== "exit" && (!action || !Number.isInteger(count) || count < 1 || count > 24)) {
    throw sessionError("EBADSCROLL", "invalid scroll direction");
  }

  const { pane, scroll: current } = await paneScrollState(id);
  if (direction === "exit" && !current.inMode) return current;
  const args = direction === "exit"
    ? ["send-keys", "-t", pane, "-X", "cancel"]
    : [
        "copy-mode", "-e", "-t", pane,
        ";", "send-keys", "-t", pane, "-X", "-N", String(count), action,
      ];
  args.push(";", "display-message", "-p", "-t", pane, SCROLL_FORMAT);
  return parseScrollState(requireResult(await tmux(args)).stdout);
}

async function killNow(id) {
  await bootstrap();
  requireResult(await tmux(["kill-session", "-t", tmuxName(id)]));
  forgetSession(id);
  return true;
}

async function reloadProfileNow(id, { profile, model, noTitle } = {}) {
  await bootstrap();
  const s = await get(id);
  if (!s) throw sessionError("ENOSESSION", "session not found");
  if (s.type === "shell") {
    throw sessionError("EBADSESSIONTYPE", "shell sessions cannot reload an OMP profile");
  }

  const newProfile = profile && profile !== "default" ? String(profile) : "";
  const targetProfile = newProfile || "default";
  const currentProfile = s.profile || "default";
  const crossProfile = targetProfile !== currentProfile;
  const cwd = s.folder || config.workspaceRoot;

  const src = await trackedTranscript(id, s.profile);
  if (!src) {
    throw sessionError("ENOSESSIONFILE", "no saved transcript yet — send a message in the session first");
  }

  // A cross-profile switch forks into the target profile's isolated directory.
  // A same-profile reload resumes an owned transcript in that same directory.
  // The source is never opened in-place under a different profile.
  const sdir = profileSessionDirFor(id, targetProfile);
  fs.mkdirSync(sdir, { recursive: true });
  let forkSource = src;

  const chosenModel = (model && String(model).trim()) || defaultRoleFor(newProfile || "default");

  // Provider behavior follows the selected model, never the user's profile
  // name: profiles can be named for a project, account, or anything else.
  const needsSanitizing = /^openai(?:-codex)?\//i.test(chosenModel || "")
    || /^(?:gpt|codex|o[0-9])/i.test(chosenModel || "");
  if (needsSanitizing) {
    try {
      const safePath = path.join(sdir, path.basename(forkSource).replace(/\.jsonl$/, ".sanitized.jsonl"));
      const raw = fs.readFileSync(forkSource, "utf8");
      let fixed = 0;
      const cleaned = raw
        .split("\n")
        .map((line) => {
          if (!line.includes('"toolCall"') && !line.includes('"tool_call"')) return line;
          try {
            const obj = JSON.parse(line);
            if (obj.type !== "message") return line;
            const content = obj.message && obj.message.content;
            if (!Array.isArray(content)) return line;
            for (const item of content) {
              if (item && item.type === "toolCall" && typeof item.name === "string" && !/^[a-zA-Z0-9_-]+$/.test(item.name)) {
                item.name = item.name.replace(/[^a-zA-Z0-9_-]/g, "_");
                fixed += 1;
              }
            }
            return JSON.stringify(obj);
          } catch {
            return line;
          }
        })
        .join("\n");
      if (fixed > 0) {
        fs.writeFileSync(safePath, cleaned);
        forkSource = safePath;
      }
    } catch {
      // sanitization is best-effort; fall back to the original transcript
    }
  }

  const command = ompCommand(id);
  if (newProfile) command.push(`--profile=${newProfile}`);
  command.push(`--session-dir=${sdir}`, crossProfile ? "--fork" : "-r", forkSource);
  if (chosenModel) command.push("--model", chosenModel);
  // The dialog choice wins; otherwise a stored opt-out carries over, and
  // older sessions without one keep auto-titling. Unchecking clears the
  // stored option so the session returns to auto-titling.
  const noTitleActive = noTitle === true || (noTitle !== false && s.notitle);
  if (noTitleActive) command.push("--no-title");

  const pane = await resolvePane(id);
  const target = tmuxPane(id);
  // Replace the pane process directly. Typing a quoted command into a new
  // login shell races interactive startup prompts such as Oh My Zsh updates.
  // The wrapper returns to a recoverable login shell after OMP exits.
  requireResult(await tmux(["set-option", "-t", target, "@omp_status", "starting"]));
  requireResult(await tmux(["set-option", "-t", target, "@omp_status_at", String(Date.now())]));
  requireResult(await tmux(["set-option", "-t", target, "@omp_profile", newProfile || "default"]));
  if (noTitle === true) {
    requireResult(await tmux(["set-option", "-t", target, "@omp_notitle", "1"]));
  } else if (noTitle === false) {
    // Opting back into auto-titles also releases a manual rename's lock;
    // otherwise the transcript title could never replace it again.
    await tmux(["set-option", "-t", target, "-u", "@omp_notitle"]);
    await tmux(["set-option", "-t", target, "-u", "@omp_title_lock"]);
  }
  await tmux(["set-option", "-t", target, "-u", "@omp_transcript"]);
  // The transcript names the model only once the new runtime's first reply
  // completes; until then this is the only record of what was launched. The
  // stamp lets the chat API tell a model named before this reload (history)
  // from one named after it (the live runtime).
  if (chosenModel) await tmux(["set-option", "-t", target, "@omp_model", chosenModel]);
  else await tmux(["set-option", "-t", target, "-u", "@omp_model"]);
  await tmux(["set-option", "-t", target, "@omp_model_at", String(Date.now())]);
  rememberSession({
    id,
    folder: cwd,
    profile: targetProfile,
    type: "agent",
    title: s.title || id,
    created: Number(s.created) || Date.now(),
    pinned: Boolean(s.pinned),
    notitle: noTitle === true || (noTitle !== false && s.notitle === true),
    titleLocked: noTitle !== false && s.titleLocked === true,
  });

  return get(id);
}

// ---- Chat-mode tmux helpers -----------------------------------------------
// A variant of tmux() that writes `input` to the child's stdin. Required by
// `load-buffer -b <name> -` which reads the buffer content from stdin.
function tmuxWithInput(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      config.tmuxBin,
      ["-L", config.tmuxSocket, ...args],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    child.stdout.on("data", (data) => stdout.push(Buffer.from(data)));
    child.stderr.on("data", (data) => stderr.push(Buffer.from(data)));
    child.on("error", (error) => finish(reject, error));
    child.stdin.on("error", () => {
      // The child close status and stderr carry the useful tmux error.
    });
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        if (/no server running|failed to connect/i.test(err)) bootstrapped = false;
        if (isMissingTarget(err)) {
          return finish(resolve, { empty: true, stdout: "", stderr: err.trim() });
        }
        return finish(reject, new Error(err.trim() || `tmux exited ${code}`));
      }
      finish(resolve, { empty: false, stdout: out, stderr: err });
    });
    try {
      child.stdin.end(typeof input === "string" ? Buffer.from(input, "utf8") : input);
    } catch (error) {
      finish(reject, error);
    }
  });
}

const MAX_TEXT_BYTES = 32 * 1024;
const MAX_KEYS = 16;
const ALLOWED_KEYS = new Set(["Up", "Down", "Left", "Right", "Enter", "Escape", "C-c", "Tab", "BSpace"]);
const MAX_QUEUED_OPERATIONS = 32;
const sessionQueues = new Map();
let inputBufferSeq = 0;

function enqueueSessionOperation(id, operation) {
  rawTmuxName(id);
  let queue = sessionQueues.get(id);
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: 0 };
    sessionQueues.set(id, queue);
  }
  if (queue.pending >= MAX_QUEUED_OPERATIONS) {
    throw sessionError("EBUSY", "too many queued session operations");
  }
  queue.pending += 1;
  const run = queue.tail.catch(() => {}).then(operation);
  queue.tail = run;
  const release = () => {
    queue.pending -= 1;
    if (queue.pending === 0 && sessionQueues.get(id) === queue) sessionQueues.delete(id);
  };
  run.then(release, release);
  return run;
}

function kill(id) {
  return enqueueSessionOperation(id, () => killNow(id));
}

function reloadProfile(id, options = {}) {
  return enqueueSessionOperation(id, () => reloadProfileNow(id, options));
}

function cancelCopyModeThen(pane, args) {
  return [
    "if-shell", "-F", "-t", pane, "#{pane_in_mode}",
    `send-keys -t ${pane} -X cancel`, "",
    ";", ...args,
  ];
}
function guardedOmpCommand(pane, args) {
  const expected = path.basename(config.ompBin);
  if (!TMUX_COMMAND_TOKEN.test(expected) || !args.every((arg) => TMUX_COMMAND_TOKEN.test(String(arg)))) {
    throw sessionError("EBADARG", "invalid tmux command token");
  }
  // Legacy panes expose OMP as the foreground command. Wrapped panes retain a
  // shell parent so login PATH setup and post-exit recovery both work; those
  // prove OMP with a live lifecycle heartbeat instead. `@omp_type` is not usable
  // here: sessions created before it existed have no type and would be refused
  // while OMP is plainly running. The wrapper revokes Chat and flushes the pane
  // input queue before exposing its recovery shell, so input accepted during an
  // OMP exit cannot execute there, and a heartbeat that stopped without that
  // handoff goes stale within STATUS_STALE_MS. tmux compares formats as strings,
  // which matches numeric order here because both sides are 13-digit epoch ms.
  const cutoff = Date.now() - STATUS_STALE_MS;
  const beating = `#{&&:#{!=:#{@omp_status},shell},#{>:#{@omp_status_at},${cutoff}}}`;
  const running = `#{||:#{==:#{pane_current_command},${expected}},${beating}}`;
  return [
    "if-shell", "-F", "-t", pane,
    running,
    args.map(String).join(" "),
    `display-message -p ${OMP_GUARD_REJECTED}`,
  ];
}

function requireOmpCommand(result) {
  const checked = requireResult(result);
  if (checked.stdout.split(/\r?\n/).includes(OMP_GUARD_REJECTED)) {
    throw sessionError("EBADSESSIONTYPE", "OMP is not running in this session");
  }
  return checked;
}

async function resolveAgentInputPane(id) {
  const session = await get(id);
  if (!session) throw sessionError("ENOSESSION", "session not found");
  if (session.type === "shell") {
    throw sessionError("EBADSESSIONTYPE", "OMP is not running in this session");
  }
  if (session.status === "starting") {
    throw sessionError("EBUSY", "OMP is still starting");
  }

  return resolvePane(id);
}


// Inject a prompt into the session's OMP TUI composer using bracketed paste so
// embedded newlines stay in the composer rather than submitting early.
async function sendText(id, text) {
  if (typeof text !== "string" || !text.trim()) {
    throw sessionError("EBADTEXT", "text must be a non-empty, non-whitespace string");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw sessionError("EBADTEXT", `text exceeds maximum length (${MAX_TEXT_BYTES} bytes)`);
  }

  return enqueueSessionOperation(id, async () => {
    const pane = await resolveAgentInputPane(id);
    // Unique per request: even different sessions must not replace a global
    // tmux paste buffer before its owning command queue consumes it.
    const buffer = `omp-web-${process.pid}-${++inputBufferSeq}`;
    let pasted = false;
    try {
      requireResult(await tmuxWithInput(["load-buffer", "-b", buffer, "-"], text));
      const guarded = guardedOmpCommand(pane, [
        // The TUI composer keeps whatever was left in it, and paste appends
        // rather than replaces: a stray "what" in the pane turned a Chat send
        // into "whatWhat is up...". That reaches the agent as one corrupted
        // prompt and can never reconcile with its optimistic bubble, because
        // the full-text hash no longer matches. C-u clears the line first,
        // inside the same guard so a pane without OMP is never touched.
        // Known limit: C-u clears one line, so a multi-line TUI draft keeps
        // its earlier lines.
        "send-keys", "-t", pane, "C-u",
        ";", "paste-buffer", "-d", "-p", "-b", buffer, "-t", pane,
        ";", "send-keys", "-t", pane, "Enter",
      ]);
      requireOmpCommand(await tmux(cancelCopyModeThen(pane, guarded)));
      pasted = true;
    } finally {
      if (!pasted) await tmux(["delete-buffer", "-b", buffer]).catch(() => {});
    }
  });
}


// Send navigation/control keys into the session. Strict allow-list prevents
// arbitrary key injection; arbitrary input goes through sendText instead.
async function sendKeys(id, keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw sessionError("EBADKEYS", "keys must be a non-empty array");
  }
  if (keys.length > MAX_KEYS) {
    throw sessionError("EBADKEYS", `too many keys (max ${MAX_KEYS})`);
  }
  for (const key of keys) {
    if (!ALLOWED_KEYS.has(key)) {
      throw sessionError("EBADKEYS", `key not allowed: ${JSON.stringify(key)}`);
    }
  }
  return enqueueSessionOperation(id, async () => {
    const pane = await resolveAgentInputPane(id);
    requireOmpCommand(await tmux(cancelCopyModeThen(
      pane,
      guardedOmpCommand(pane, ["send-keys", "-t", pane, ...keys]),
    )));
  });
}

async function contextWindowFor(profile, provider, model) {
  if (!model) return null;
  const selector = provider ? `${provider}/${model}` : model;
  const cacheKey = `${profile || "default"}:${selector}`;
  const cached = MODEL_WINDOW_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < MODEL_WINDOW_CACHE_TTL_MS) {
    return cached.value;
  }
  const env = { ...process.env };
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFile(
        config.ompBin,
        ["--profile", profile || "default", "models", selector, "--json"],
        { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, env },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(String(stderr || err.message || "omp models failed")));
          resolve({ stdout });
        }
      );
    });
    const parsed = JSON.parse(stdout);
    const first = parsed && Array.isArray(parsed.models) && parsed.models[0];
    const value = first && Number.isFinite(first.contextWindow) ? first.contextWindow : null;
    MODEL_WINDOW_CACHE.set(cacheKey, { value, at: Date.now() });
    return value;
  } catch {
    return null;
  }
}

module.exports = {
  list, get, exists, create, setPinned, renameTitle, scroll, scrollState, setScrollPosition,
  kill, reloadProfile, tmuxName, tmuxPane, resolvePane, bootstrap, OPT_KEYS,
  sendText, sendKeys, configuredEffortFor, contextWindowFor, launchIdentityFor, restorable,
  restore, forgetGhost,
};
