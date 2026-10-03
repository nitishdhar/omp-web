#!/usr/bin/env node
"use strict";

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline/promises");
const config = require("../config");
const { listProfileDetails } = require("../api/util");
const { newestOwnedJsonl, readTranscriptTitle } = require("../transcripts");

const MINIMUM_NODE_MAJOR = 22;
const REQUIRED_OMP_FLAGS = ["--extension", "--profile", "--session-dir", "--model"];

function usage() {
  console.log(`Usage: omp-web [start]
       omp-web doctor
       omp-web recover --list
       omp-web setup [--workspace PATH] [--profile NAME] [--skip-omp-login] [--token]
       omp-web artifact <new|list|path|url|check|touch> ...

Commands:
  start       Run omp-web in the foreground (the default command).
  doctor      Check local prerequisites without starting sessions.
  recover     List transcript-backed session candidates after tmux-server loss.
              Never recreates sessions; explicit review only.
  setup       Configure a workspace, and with --token create a private access token.
  artifact    Create, list, link and check artifacts (run \`omp-web artifact --help\`).

Setup options:
  --workspace PATH    Existing folder root shown by the project picker.
  --profile NAME      Native OMP profile to use for an optional login handoff.
  --skip-omp-login    Do not offer the interactive native OMP handoff.
  --token             Create a private access token and require it (open console otherwise).
  -h, --help          Show this help.
`);
}

function fail(message) {
  console.error(`omp-web: ${message}`);
  process.exitCode = 1;
}

function executablePath(command) {
  if (!command) return "";
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return path.resolve(command);
    } catch {
      return "";
    }
  }
  for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching; a later PATH entry may be executable.
    }
  }
  return "";
}

function boundedHelp(command, args) {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-doctor-"));
  const env = {
    HOME: temporaryHome,
    PATH: process.env.PATH || "",
    SHELL: process.env.SHELL || "/bin/sh",
    LANG: process.env.LANG || "en_US.UTF-8",
    TMPDIR: temporaryHome,
  };
  try {
    const result = childProcess.spawnSync(command, args, {
      cwd: temporaryHome,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    if (result.error || result.status !== 0 || result.signal) {
      return { ok: false, text: "" };
    }
    return { ok: true, text: `${result.stdout || ""}\n${result.stderr || ""}` };
  } finally {
    fs.rmSync(temporaryHome, { force: true, recursive: true });
  }
}

function directoryExists(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function check(ok, label, detail = "") {
  console.log(`${ok ? "ok" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

const PROFILE_CATALOG_TIMEOUT_MS = 20000;
const PROFILE_CATALOG_BUFFER = 8 * 1024 * 1024;

// Reads one profile's resolved model catalog. Unlike boundedHelp this runs
// against the real HOME — profiles live there, and a scratch HOME would report
// every catalog as empty. OMP_PROFILE/PI_PROFILE are stripped because an
// exported value silently redirects omp to a different profile than the one
// asked for, which would validate the wrong catalog.
function profileCatalog(omp, profile) {
  const env = { ...process.env };
  delete env.OMP_PROFILE;
  delete env.PI_PROFILE;
  const args = profile === "default"
    ? ["models", "ls", "--json"]
    : [`--profile=${profile}`, "models", "ls", "--json"];
  const result = childProcess.spawnSync(omp, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROFILE_CATALOG_TIMEOUT_MS,
    maxBuffer: PROFILE_CATALOG_BUFFER,
    env,
  });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    const models = JSON.parse(result.stdout)?.models;
    if (!Array.isArray(models)) return null;
    return new Set(models.map((model) =>
      String(model.selector || `${model.provider}/${model.id}`)));
  } catch {
    return null;
  }
}

// Updating the omp binary preserves each profile's config.yml but can leave
// that profile's model catalog stale, so a configured selector stops
// resolving and OMP exits to a shell the moment a session or profile reload
// uses it. Checking flags and executability does not catch that, and neither
// does checking one profile: profiles isolate their own caches. Resolution is
// verified against the catalog rather than by issuing a request, so this stays
// free and offline.
function checkProfileSelectors(omp) {
  let healthy = true;
  let details;
  try {
    details = listProfileDetails();
  } catch {
    return healthy;
  }
  for (const { name, roles } of details) {
    const wanted = [...new Set(
      (roles || [])
        .filter((role) => role.provider && role.model)
        .map((role) => `${role.provider}/${role.model}`),
    )];
    if (!wanted.length) continue;
    const catalog = profileCatalog(omp, name);
    if (!catalog) {
      console.log(`WARN profile ${name} models — catalog unreadable; `
        + `run \`omp --profile=${name} models refresh\``);
      continue;
    }
    const missing = wanted.filter((selector) => !catalog.has(selector));
    if (!missing.length) {
      check(true, `profile ${name} selectors resolve`, `${wanted.length} configured`);
      continue;
    }
    // Deliberately a warning, not a failure. Some providers proxy arbitrary
    // model names and never enumerate them — litellm does not appear in any
    // catalog here — so absence is strong evidence of a stale catalog but not
    // proof the selector cannot resolve. Failing would break `doctor`'s exit
    // code, and installs use it as their verification gate.
    console.log(`WARN profile ${name} selectors — ${missing.join(", ")} not in `
      + `this profile's catalog; if a session drops to a shell run `
      + `\`omp --profile=${name} models refresh\``);
  }
  return healthy;
}

// tmux is the source of truth for session liveness and per-session metadata
// lives in `@omp_*` tmux options that die with the session (sessions.js), so
// a dead tmux server means sessions are unrecoverable by design. These helpers
// only observe: they never create, modify, or resurrect sessions.
function countLiveSessions(socketLabel = config.tmuxSocket) {
  const result = childProcess.spawnSync(
    config.tmuxBin,
    ["-L", socketLabel, "list-sessions", "-F", "#{session_name}"],
    { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 },
  );
  if (result.error) {
    return { ok: false, detail: result.error.code || result.error.message };
  }
  const stderr = String(result.stderr || "");
  if (result.status !== 0) {
    if (/no server running|failed to connect|no sessions/i.test(stderr)) {
      return { ok: true, live: 0, serverRunning: /no sessions/i.test(stderr) };
    }
    return {
      ok: false,
      detail: stderr.trim().split(/\r?\n/).at(-1) || `exit ${result.status}`,
    };
  }
  const live = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(config.sessionPrefix)).length;
  return { ok: true, live, serverRunning: true };
}

// Session ids that still own at least one omp-web transcript (root or one
// profile level deep, mirroring transcripts.js newestOwnedJsonl). Ownership is
// transcript files only — never tmux state, never a session.
function transcriptOwners() {
  let entries;
  try {
    entries = fs.readdirSync(config.sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const owners = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let file = null;
    try {
      file = newestOwnedJsonl(entry.name);
    } catch {
      continue;
    }
    if (file) owners.push({ id: entry.name, file });
  }
  return owners;
}

// Warning-only persistence check for `doctor`. An empty tmux server holding
// zero `omp_` sessions while transcript-backed directories exist is the
// reboot/tmux-kill signature: sessions are gone by design, not by bug. This
// never flips the healthy flag — loss is expected after a restart, and a
// healthy multi-session server must not warn.
function checkSessionPersistence() {
  const sessions = countLiveSessions();
  const owners = transcriptOwners();
  if (!sessions.ok) {
    console.log(`WARN tmux session persistence — could not inspect tmux server `
      + `'${config.tmuxSocket}' (${sessions.detail}); compare \`tmux -L `
      + `${config.tmuxSocket} ls\` against /api/sessions before concluding loss`);
    return;
  }
  // Registry check is warning-only: a corrupt/unreadable registry degrades to
  // the transcript fallback, it never breaks a live server.
  let registryEntries = null;
  try {
    ({ entries: registryEntries } = require("../registry").readRegistry());
  } catch (error) {
    console.log(`WARN session registry — unreadable (${error.message}); `
      + `restore will fall back to transcript discovery only`);
  }
  if (registryEntries && sessions.live === 0 && Object.keys(registryEntries).length > 0) {
    const count = Object.keys(registryEntries).length;
    console.log(`WARN tmux session persistence — tmux server '${config.tmuxSocket}' `
      + `holds 0 live sessions but ${count} session(s) are restorable from the `
      + `durable registry. Open omp-web and use Restore all (or per-row Restore) `
      + `to bring them back with their saved history.`);
    return;
  }
  if (sessions.live === 0 && owners.length > 0) {
    console.log(`WARN tmux session persistence — tmux server '${config.tmuxSocket}' `
      + `holds 0 live sessions but ${owners.length} session directorie(s) under `
      + `${config.sessionsDir} still own transcripts. A host reboot or tmux-server `
      + `kill discards live sessions and their @omp_* metadata by design; they `
      + `cannot be reattached. Run \`omp-web recover --list\` to review candidates `
      + `and recreate the ones still needed explicitly.`);
    return;
  }
  console.log(`ok tmux session persistence — ${sessions.live} live session(s), `
    + `${owners.length} transcript-backed directorie(s)`
    + (registryEntries ? `, ${Object.keys(registryEntries).length} registry entrie(s)` : ""));
}

const RECOVER_LIST_LIMIT = 20;

// Explicit, read-only candidate listing after tmux-server loss. Prints the
// most recently written transcript-owned session directories so the operator
// can recreate what still matters. Never touches tmux and never recreates
// anything: resurrection happens only through explicit session creation.
function recoverList() {
  const owners = transcriptOwners();
  if (!owners.length) {
    console.log(`no transcript-backed session directories in ${config.sessionsDir}`);
    return;
  }
  const rows = [];
  for (const { id, file } of owners) {
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    let title = "";
    try {
      title = readTranscriptTitle(file);
    } catch {
      title = "";
    }
    rows.push({ id, file, mtimeMs: stat.mtimeMs, size: stat.size, title });
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  console.log(`${rows.length} transcript-backed candidate(s) in ${config.sessionsDir}:`);
  for (const row of rows.slice(0, RECOVER_LIST_LIMIT)) {
    const when = new Date(row.mtimeMs).toISOString();
    const what = row.title ? ` "${row.title}"` : "";
    console.log(`  ${when}  ${row.id}${what}  (${row.size} bytes, ${row.file})`);
  }
  if (rows.length > RECOVER_LIST_LIMIT) {
    console.log(`  … and ${rows.length - RECOVER_LIST_LIMIT} older candidate(s) omitted`);
  }
  console.log(`omp-web never recreates sessions on boot; recreate what still matters `
    + `explicitly with resume intent (New session dialog or POST /api/sessions `
    + `with {"resume":true}; resume defaults to true when substantive history `
    + `exists under the profile, pass {"resume":false} for a clean start).`);
}

function doctor() {
  let healthy = true;
  // macOS or Linux are supported hosts. Linux reports warn-only: every check
  // below (tmux, omp, node-pty) already validates what actually matters there.
  if (process.platform === "linux") {
    console.log(`WARN platform — ${process.platform} (supported: macOS, Linux)`);
  } else {
    healthy = check(process.platform === "darwin", "macOS", process.platform) && healthy;
  }
  // Token is opt-in: no token means an open console, acceptable on loopback
  // only, or on a LAN bind with the explicit OMP_WEB_ALLOW_OPEN=1 hatch
  // (the server refuses to start open on LAN without it).
  if (config.token) {
    healthy = check(true, "authentication", "access token required") && healthy;
  } else if (config.host === "127.0.0.1" || config.host === "::1" || config.host === "localhost") {
    console.log(`WARN authentication — no access token (open console on ${config.host}; setup --token to require one)`);
  } else if (config.allowOpen) {
    console.log(`WARN authentication — no access token, open to the network on ${config.host} via OMP_WEB_ALLOW_OPEN=1`);
  } else {
    healthy = check(false, "authentication", `no token with non-loopback bind ${config.host} — server will refuse to start`) && healthy;
  }
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  healthy = check(
    nodeMajor >= MINIMUM_NODE_MAJOR,
    `Node.js >= ${MINIMUM_NODE_MAJOR}`,
    process.versions.node,
  ) && healthy;

  const tmux = executablePath(config.tmuxBin);
  healthy = check(Boolean(tmux), "tmux executable", config.tmuxBin) && healthy;
  const omp = executablePath(config.ompBin);
  healthy = check(Boolean(omp), "omp executable", config.ompBin) && healthy;

  if (omp) {
    const help = boundedHelp(omp, ["--help"]);
    healthy = check(help.ok, "omp --help", help.ok ? "bounded help completed" : "could not run safely") && healthy;
    if (help.ok) {
      for (const flag of REQUIRED_OMP_FLAGS) {
        healthy = check(help.text.includes(flag), `omp supports ${flag}`) && healthy;
      }
    }
    const setupHelp = boundedHelp(omp, ["setup", "--help"]);
    console.log(
      `${setupHelp.ok ? "ok" : "WARN"} omp setup --help — ${
        setupHelp.ok
          ? "native optional-component setup is available"
          : "could not inspect optional native setup"
      }`,
    );
  }

  if (omp) healthy = checkProfileSelectors(omp) && healthy;

  healthy = check(directoryExists(config.workspaceRoot), "workspace directory", config.workspaceRoot) && healthy;
  try {
    const pty = require("node-pty");
    healthy = check(typeof pty.spawn === "function", "node-pty native module") && healthy;
  } catch (error) {
    healthy = check(false, "node-pty native module", error.code || error.message) && healthy;
  }

  checkSessionPersistence();
  if (!healthy) {
    console.error("\nFix the failed prerequisites, then rerun `omp-web doctor`.");
    process.exitCode = 1;
  }
}

function parseSetupArgs(args) {
  const options = { workspace: "", profile: "", skipOmpLogin: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--skip-omp-login") {
      options.skipOmpLogin = true;
    } else if (arg === "--token") {
      options.token = true;
    } else if (arg === "--workspace" || arg === "--profile") {
      const value = args[++index];
      if (!value || value.startsWith("-")) throw new Error(`${arg} needs a value`);
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    } else if (arg.startsWith("--workspace=")) {
      options.workspace = arg.slice("--workspace=".length);
    } else if (arg.startsWith("--profile=")) {
      options.profile = arg.slice("--profile=".length);
    } else {
      throw new Error(`unknown setup option: ${arg}`);
    }
  }
  if (options.profile && /[\x00-\x1f\x7f]/.test(options.profile)) {
    throw new Error("profile name cannot contain control characters");
  }
  if (options.workspace && /[\x00-\x1f\x7f]/.test(options.workspace)) {
    throw new Error("workspace path cannot contain control characters");
  }
  return options;
}

function envKeys(file) {
  try {
    return new Set(
      fs.readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/))
        .filter(Boolean)
        .map((match) => match[1]),
    );
  } catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw error;
  }
}

function createPrivateDirectory(directory) {
  if (fs.existsSync(directory)) {
    if (!directoryExists(directory)) throw new Error(`${directory} exists but is not a directory`);
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function usingEnvironmentToken() {
  return Boolean(process.env.OMP_WEB_TOKEN);
}

function authenticationInstruction() {
  if (usingEnvironmentToken()) {
    return "Authentication uses configured OMP_WEB_TOKEN; its value is not displayed.";
  }
  try {
    if (fs.readFileSync(config.tokenFile, "utf8").trim()) return `Authentication token file: ${config.tokenFile}`;
  } catch {}
  return "No access token — console is OPEN to the local machine (setup --token to require one).";
}

function createToken() {
  if (usingEnvironmentToken()) {
    console.log("Keeping configured OMP_WEB_TOKEN; no token file was created.");
    return;
  }
  try {
    const descriptor = fs.openSync(config.tokenFile, "wx", 0o600);
    try {
      fs.writeSync(descriptor, `${crypto.randomBytes(32).toString("base64url")}\n`);
    } finally {
      fs.closeSync(descriptor);
    }
    console.log(`Created private authentication token at ${config.tokenFile}.`);
  } catch (error) {
    if (error.code === "EEXIST") {
      const token = fs.readFileSync(config.tokenFile, "utf8").trim();
      if (!token) {
        throw new Error(
          `authentication token file is empty: ${config.tokenFile}. Refusing to overwrite it; populate it or remove it explicitly, then rerun setup`,
        );
      }
      console.log(`Keeping existing authentication token at ${config.tokenFile}.`);
      return;
    }
    throw error;
  }
}

function addWorkspaceIfMissing(workspace) {
  const keys = envKeys(config.envFile);
  if (process.env.OMP_WEB_WORKSPACE !== undefined || keys.has("OMP_WEB_WORKSPACE")) {
    console.log(
      `Keeping existing OMP_WEB_WORKSPACE at ${config.workspaceRoot}; requested workspace was not applied.`,
    );
    return config.workspaceRoot;
  }
  const descriptor = fs.openSync(config.envFile, "a", 0o600);
  try {
    const needsNewline = fs.existsSync(config.envFile) && fs.statSync(config.envFile).size > 0;
    fs.writeSync(descriptor, `${needsNewline ? "\n" : ""}OMP_WEB_WORKSPACE=${workspace}\n`);
  } finally {
    fs.closeSync(descriptor);
  }
  console.log(`Configured workspace at ${workspace}.`);
  return workspace;
}

async function askWorkspace(defaultWorkspace) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(
      `Workspace root [${defaultWorkspace}] (must already exist): `,
    )).trim();
    return path.resolve(answer || defaultWorkspace);
  } finally {
    prompt.close();
  }
}

async function askProfile() {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const profile = (await prompt.question(
      "Native OMP profile [default] (existing or new local name): ",
    )).trim();
    if (/[\x00-\x1f\x7f]/.test(profile)) throw new Error("profile name cannot contain control characters");
    return profile;
  } finally {
    prompt.close();
  }
}

async function askForNativeHandoff(profile) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const selected = profile || "native default profile";
    const answer = (await prompt.question(
      `Open native OMP now for ${selected} login/provider onboarding? [y/N] `,
    )).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
}

function nativeOmpHandoff(profile, workspace) {
  const omp = executablePath(config.ompBin);
  if (!omp) {
    console.error("omp is not on PATH; install it, then run native `omp` and use `/login`.");
    return;
  }
  const args = profile && profile !== "default" ? ["--profile", profile] : [];
  const env = { ...process.env, OMP_PROFILE: "" };
  delete env.PI_PROFILE;
  delete env.PI_CODING_AGENT_DIR;
  const result = childProcess.spawnSync(omp, args, { cwd: workspace, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status && result.status !== 0) process.exitCode = result.status;
}

async function setup(args) {
  let options;
  try {
    options = parseSetupArgs(args);
  } catch (error) {
    fail(error.message);
    return;
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive && (!options.workspace || !options.skipOmpLogin)) {
    fail("noninteractive setup requires --workspace PATH and --skip-omp-login");
    return;
  }

  let workspace = options.workspace ? path.resolve(options.workspace) : "";
  if (!workspace && interactive) {
    const suggestedWorkspace = directoryExists(config.workspaceRoot) ? config.workspaceRoot : process.cwd();
    if (suggestedWorkspace !== config.workspaceRoot) {
      console.log(`Default workspace ${config.workspaceRoot} does not exist; choose an existing directory.`);
    }
    workspace = await askWorkspace(suggestedWorkspace);
  }
  if (/[\x00-\x1f\x7f]/.test(workspace) || !directoryExists(workspace)) {
    fail(`workspace must be an existing directory without control characters: ${workspace || config.workspaceRoot}`);
    return;
  }
  if (!options.skipOmpLogin && interactive && !options.profile) {
    options.profile = await askProfile();
  }

  let effectiveWorkspace;
  try {
    createPrivateDirectory(config.ompWebHome);
    if (options.token) createToken();
    effectiveWorkspace = addWorkspaceIfMissing(workspace);
  } catch (error) {
    fail(error.message);
    return;
  }

  console.log(`\nStart with: omp-web start\nOpen: http://${config.host}:${config.port}\n${authenticationInstruction()}`);
  if (options.skipOmpLogin) {
    console.log("Native OMP login was skipped. Run native `omp` and use `/login` or `/login <provider>` when ready.");
    return;
  }
  if (interactive && await askForNativeHandoff(options.profile)) {
    nativeOmpHandoff(options.profile, effectiveWorkspace);
  } else {
    const command = options.profile && options.profile !== "default"
      ? `omp --profile ${options.profile}`
      : "omp";
    console.log(`Run native \`${command}\` and use \`/login\` or \`/login <provider>\` when ready.`);
  }
}

function start() {
  console.log(`Starting omp-web at http://${config.host}:${config.port}`);
  console.log(authenticationInstruction());
  require("../server");
}

async function main() {
  const [command = "start", ...args] = process.argv.slice(2);
  if (command === "-h" || command === "--help" || command === "help") return usage();
  if (command === "doctor") {
    if (args.length) return fail("doctor does not accept options");
    return doctor();
  }
  if (command === "recover") {
    if (args.length === 1 && args[0] === "--list") return recoverList();
    return fail("usage: omp-web recover --list");
  }
  if (command === "artifact") return require("./artifact-cli").runArtifact(args);
  if (command === "setup") {
    if (args[0] === "-h" || args[0] === "--help") return usage();
    return setup(args);
  }
  if (command === "start") {
    if (args.length) return fail("start does not accept options");
    return start();
  }
  return fail(`unknown command: ${command} (run \`omp-web --help\`)`);
}

// Exposed for targeted verification without running the CLI. Requiring this
// module as a library must not start the server or run a command.
module.exports = { countLiveSessions, transcriptOwners, checkSessionPersistence, recoverList };

if (require.main === module) {
  main().catch((error) => fail(error.message));
}
