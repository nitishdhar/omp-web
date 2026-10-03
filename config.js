"use strict";
const os = require("os");
const fs = require("fs");
const path = require("path");

// Central runtime configuration, all overridable via environment.
const HOME = os.homedir();

// Optional local env overlay: OMP_WEB_HOME/env holds KEY=VALUE lines for
// settings that are awkward to inject through a process manager (e.g.
// transcription keys). An inherited environment always wins.
const OWP_DIR = path.resolve(process.env.OMP_WEB_HOME || path.join(HOME, ".omp-web"));
const OWP_ENV = path.join(OWP_DIR, "env");
try {
  for (const line of fs.readFileSync(OWP_ENV, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/\r$/, "");
  }
} catch {
  /* no local env file */
}

const ompHome = path.resolve(process.env.OMP_WEB_OMP_HOME || path.join(HOME, ".omp"));
const config = {
  // Private omp-web data/config root. It deliberately does not contain OMP
  // accounts or profiles; native omp owns those under ompHome.
  ompWebHome: OWP_DIR,
  envFile: OWP_ENV,
  tokenFile: path.join(OWP_DIR, "token"),
  registryFile: path.join(OWP_DIR, "sessions.json"),
  // omp-web's own editable preferences (Settings panel). Never OMP profile
  // config: native omp owns that.
  settingsFile: path.join(OWP_DIR, "settings.json"),

  // HTTP listen host/port. Bind loopback by default; expose via a reverse
  // proxy / Tailscale rather than binding 0.0.0.0 directly.
  host: process.env.OMP_WEB_HOST || "127.0.0.1",
  port: Number(process.env.OMP_WEB_PORT || 7799),

  // Root under which selectable project folders are discovered.
  workspaceRoot: process.env.OMP_WEB_WORKSPACE || path.join(HOME, "workspace"),
  // More folder trees to list beside the workspace (colon-separated), e.g. a
  // ~/private tree moved out of ~/workspace. Their children appear in the
  // picker and sidebar as "<root name>/<folder>". Discovery only: sessions
  // could always run in any folder.
  extraRoots: (process.env.OMP_WEB_EXTRA_ROOTS || "")
    .split(":")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry.startsWith("~/") ? path.join(HOME, entry.slice(2)) : entry)),

  // Display-only: lets the browser render a truthful `~` abbreviation.
  homeDir: HOME,

  // The omp binary. Sessions run `omp [--profile=<name>]` inside tmux.
  ompBin: process.env.OMP_WEB_OMP_BIN || "omp",

  // OMP paths are used for profile and transcript discovery. Changing this
  // does not configure native OMP; use its documented environment instead.
  ompHome,
  profilesDir: process.env.OMP_WEB_PROFILES_DIR || path.join(ompHome, "profiles"),

  // Per-omp-web-session transcript storage. Sessions launch with
  // `--session-dir=<sessionsDir>/<id>` so each `.jsonl` sits in a known place
  // and can be resumed under a different profile later.
  sessionsDir: process.env.OMP_WEB_SESSIONS_DIR || path.join(ompHome, "web-sessions"),

  // Uploaded terminal attachments live outside both project worktrees and omp
  // session data. The API creates one private subdirectory per live session.
  attachmentsDir: path.resolve(
    process.env.OMP_WEB_ATTACHMENTS_DIR || path.join(OWP_DIR, "attachments"),
  ),


  // Voice input transcription. The browser records audio and POSTs it to
  // /api/transcribe; the server forwards it to this OpenAI-compatible
  // /audio/transcriptions endpoint with the key below. The key never reaches
  // the browser. Leave any value empty to disable the mic button.
  transcribeBaseUrl: process.env.OMP_WEB_TRANSCRIBE_BASE_URL || "",
  transcribeApiKey: process.env.OMP_WEB_TRANSCRIBE_API_KEY || "",
  transcribeModel: process.env.OMP_WEB_TRANSCRIBE_MODEL || "",

  // Dedicated tmux server so omp-web sessions never collide with the user's
  // normal tmux server.
  tmuxSocket: process.env.OMP_WEB_TMUX_SOCKET || "omp-web",
  sessionPrefix: "omp_",

  // Optional shared secret. When set, every HTTP request and WebSocket upgrade
  // must present it via `?token=` or the `x-omp-web-token` header. Falls back
  // to the contents of OMP_WEB_HOME/token.
  token:
    process.env.OMP_WEB_TOKEN ||
    (() => {
      try { return fs.readFileSync(path.join(OWP_DIR, "token"), "utf8").trim(); } catch { return ""; }
    })(),
  // Explicit escape hatch for a deliberately LAN-published console with no
  // token: the server still refuses open non-loopback binds without it.
  allowOpen: process.env.OMP_WEB_ALLOW_OPEN === "1",

  // An rpc session's omp exits after this long settled with no Chat request;
  // the next send starts it again.
  rpcIdleMinutes: positiveMinutes("OMP_WEB_RPC_IDLE_MINUTES", 10),
  // A TUI session nobody has looked at for this long is switched back to the
  // rpc runner, which ends its idle omp process.
  tuiIdleMinutes: positiveMinutes("OMP_WEB_TUI_IDLE_MINUTES", 30),
};

function positiveMinutes(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Preserve a user's configured PATH order. Only append common locations that
// are absent so thin process-manager environments can still find tools.
const extraPath = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
const inheritedPath = (process.env.PATH || "").split(":").filter(Boolean);
const seen = new Set(inheritedPath);
process.env.PATH = [...inheritedPath, ...extraPath.filter((p) => !seen.has(p))].join(":");

// Force a UTF-8 locale when the launch environment has none (e.g. launchd).
// Without it, tmux mangles tab-separated `-F` output (breaking session parsing)
// and the omp TUI loses Unicode/box-drawing rendering over the wire.
if (!process.env.LC_ALL && !process.env.LANG) {
  process.env.LANG = "en_US.UTF-8";
  process.env.LC_ALL = "en_US.UTF-8";
}

// Resolve an absolute tmux path; node-pty's posix_spawnp is unforgiving about
// bare command names under a minimal environment.
function resolveTmux() {
  if (process.env.OMP_WEB_TMUX_BIN) return process.env.OMP_WEB_TMUX_BIN;
  for (const p of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return "tmux";
}
config.tmuxBin = resolveTmux();

module.exports = config;
