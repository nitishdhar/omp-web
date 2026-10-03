"use strict";
// `omp-web service install|uninstall|status [--label L] [--dry-run]`: run the
// server as a per-user service — a LaunchAgent on macOS, a systemd user unit
// on Linux. Only the named label is ever read, written, loaded or removed.
//
// The service starts with a thin environment, so install captures what the
// server needs from the installing shell: absolute node and script paths, a
// PATH that resolves node/tmux/omp the same way it does now, and the bind and
// data settings (OMP_WEB_HOST/PORT/HOME/TMUX_SOCKET). Everything else belongs
// in OMP_WEB_HOME/env, which the server loads itself. The token is never
// written into the service file.
//
// tmux, not the service, owns sessions: the tmux server daemonizes out of the
// job's process group (launchd) and the unit uses KillMode=process (systemd),
// so restarting, updating or uninstalling the service leaves sessions running.

const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const config = require("../config");

const USAGE = "usage: omp-web service <install|uninstall|status> [--label L] [--dry-run]";
const SCRIPT = path.resolve(__dirname, "omp-web.js");
const CONFIG_MODULE = path.resolve(__dirname, "..", "config.js");
// Bind and data location must reach the service; the rest is read from
// OMP_WEB_HOME/env by config.js. OMP_WEB_TOKEN is excluded on purpose: a
// service file is not a secret store.
const CAPTURED_ENV = ["OMP_WEB_HOST", "OMP_WEB_PORT", "OMP_WEB_HOME", "OMP_WEB_TMUX_SOCKET"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const PROBE_TIMEOUT_MS = 1500;
const START_WAIT_MS = 8000;

function parseArgs(args) {
  const [action, ...rest] = args;
  if (!["install", "uninstall", "status"].includes(action)) throw new Error(USAGE);
  const options = { action, label: "", dryRun: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--label" && rest[index + 1]) options.label = rest[(index += 1)];
    else if (arg.startsWith("--label=")) options.label = arg.slice("--label=".length);
    else throw new Error(USAGE);
  }
  if (options.dryRun && action === "status") throw new Error("status does not accept --dry-run");
  return options;
}

// OMP_WEB_SERVICE_PLATFORM previews the other platform's file and commands; it
// only makes sense with --dry-run, so anything else is refused rather than
// running the wrong service manager.
function resolvePlatform(dryRun) {
  const override = process.env.OMP_WEB_SERVICE_PLATFORM;
  if (override) {
    if (!["darwin", "linux"].includes(override)) throw new Error("OMP_WEB_SERVICE_PLATFORM must be darwin or linux");
    if (!dryRun && override !== process.platform) throw new Error("OMP_WEB_SERVICE_PLATFORM is only honored with --dry-run");
    return override;
  }
  if (process.platform === "darwin" || process.platform === "linux") return process.platform;
  throw new Error(`service is supported on macOS and Linux, not ${process.platform}`);
}

function resolveLabel(platform, label) {
  if (platform === "darwin") {
    const value = label || "com.omp-web.server";
    if (!LABEL_PATTERN.test(value) || value.endsWith(".plist")) throw new Error(`invalid label: ${value}`);
    return value;
  }
  const base = (label || "omp-web").replace(/\.service$/, "");
  if (!LABEL_PATTERN.test(base)) throw new Error(`invalid label: ${label}`);
  return `${base}.service`;
}

function executablePath(command) {
  if (!command) return "";
  if (command.includes("/")) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return path.resolve(command);
    } catch {
      return "";
    }
  }
  for (const directory of (process.env.PATH || "").split(":").filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // A later PATH entry may hold it.
    }
  }
  return "";
}

// Keep the installing shell's PATH order (so omp/tmux resolve to the same
// binaries) and append the node/tmux/omp directories if a shim or alias made
// them reachable without being on PATH.
function capturedPath(tools) {
  const entries = (process.env.PATH || "").split(":").filter(Boolean);
  for (const tool of tools) {
    if (tool) entries.push(path.dirname(tool));
  }
  return [...new Set(entries)].join(":");
}

function buildSpec(platform, label) {
  const node = process.execPath;
  const tmux = executablePath(config.tmuxBin);
  const omp = executablePath(config.ompBin);
  const env = { PATH: capturedPath([node, tmux, omp]) };
  for (const key of CAPTURED_ENV) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const home = os.homedir();
  const isDefault = platform === "darwin" ? label === "com.omp-web.server" : label === "omp-web.service";
  const file = platform === "darwin"
    ? path.join(home, "Library", "LaunchAgents", `${label}.plist`)
    : path.join(home, ".config", "systemd", "user", label);
  // A second label gets its own log so it never interleaves with the default one.
  const log = platform === "darwin"
    ? path.join(home, "Library", "Logs", isDefault ? "omp-web.log" : `${label}.log`)
    : "";
  return { platform, label, node, script: SCRIPT, workdir: path.dirname(path.dirname(SCRIPT)), env, file, log, tmux, omp };
}

// What the service process will see: config.js evaluated under exactly the
// captured environment, including OMP_WEB_HOME/env and the token file, and
// nothing inherited from this shell (an exported OMP_WEB_TOKEN would not
// reach the service).
function serviceView(node, env) {
  const script = `const c = require(${JSON.stringify(CONFIG_MODULE)});
process.stdout.write(JSON.stringify({ host: c.host, port: c.port, token: Boolean(c.token), allowOpen: c.allowOpen, home: c.ompWebHome, tmuxSocket: c.tmuxSocket }));`;
  const result = childProcess.spawnSync(node, ["-e", script], {
    env: { HOME: os.homedir(), USER: os.userInfo().username, ...env },
    encoding: "utf8",
    timeout: 10000,
  });
  if (result.status !== 0) throw new Error(`could not evaluate the service configuration: ${(result.stderr || result.error?.message || "").trim()}`);
  return JSON.parse(result.stdout);
}

function xml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderPlist(spec) {
  const env = Object.entries(spec.env)
    .map(([key, value]) => `\t\t<key>${xml(key)}</key>\n\t\t<string>${xml(value)}</string>`)
    .join("\n");
  // No LimitLoadToSessionType: the default (Aqua) agent loads again at login
  // after a reboot and can use the login keychain; a Background-session agent
  // did neither.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`omp-web service install\`; rerun it to update. -->
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xml(spec.label)}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xml(spec.node)}</string>
\t\t<string>${xml(spec.script)}</string>
\t\t<string>start</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${env}
\t</dict>
\t<key>WorkingDirectory</key>
\t<string>${xml(spec.workdir)}</string>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${xml(spec.log)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(spec.log)}</string>
</dict>
</plist>
`;
}

// systemd expands %specifiers in both directives and $VARS in ExecStart.
function unitEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
}

function unitArg(value) {
  const escaped = unitEscape(value).replace(/\$/g, "$$$$");
  return /[\s"'\\;]/.test(value) ? `"${escaped}"` : escaped;
}

function renderUnit(spec) {
  const env = Object.entries(spec.env).map(([key, value]) => `Environment="${unitEscape(`${key}=${value}`)}"`).join("\n");
  return `# Written by \`omp-web service install\`; rerun it to update.
[Unit]
Description=omp-web console
After=network.target

[Service]
Type=simple
ExecStart=${unitArg(spec.node)} ${unitArg(spec.script)} start
WorkingDirectory=${unitArg(spec.workdir)}
${env}
# The tmux server shares this unit's cgroup: the default control-group mode
# would take live sessions down on every stop, restart, or crash-restart.
KillMode=process
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

function run(command, args, { allowFail = false } = {}) {
  const result = childProcess.spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function probeHost(host) {
  if (!host || host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}

// Any HTTP answer means the server is up. /api/meta sits behind the token
// check (the static shell does not), so 401 also confirms a token is enforced.
function probe(host, port) {
  return new Promise((resolve) => {
    const request = http.get({ host: probeHost(host), port, path: "/api/meta", timeout: PROBE_TIMEOUT_MS }, (response) => {
      response.resume();
      resolve({ up: true, status: response.statusCode });
    });
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", (error) => resolve({ up: false, error: error.code || error.message }));
  });
}

function describeProbe(host, port, result) {
  const url = `http://${probeHost(host).includes(":") ? `[${probeHost(host)}]` : probeHost(host)}:${port}/api/meta`;
  if (!result.up) return `${url} not answering (${result.error})`;
  const meaning = result.status === 401 ? "up, token required" : result.status === 200 ? "up, open" : "up";
  return `${url} HTTP ${result.status} (${meaning})`;
}

async function waitForHttp(host, port) {
  const deadline = Date.now() + START_WAIT_MS;
  let result = await probe(host, port);
  while (!result.up && Date.now() < deadline) {
    sleep(300);
    result = await probe(host, port);
  }
  return result;
}

function preflight(spec) {
  if (!spec.tmux) console.log(`warning: tmux (${config.tmuxBin}) not found; run \`omp-web doctor\`.`);
  if (!spec.omp) console.log(`warning: omp (${config.ompBin}) not found on PATH; sessions will not start until it is.`);
  const view = serviceView(spec.node, spec.env);
  // setup --token keeps an exported OMP_WEB_TOKEN instead of writing a file,
  // so point at the file the service reads.
  if (!view.token && process.env.OMP_WEB_TOKEN) {
    console.log(`note: OMP_WEB_TOKEN from this shell is not passed to the service; write it to ${path.join(view.home, "token")} (mode 600) for the service to use it.`);
  }
  if (!view.token && !LOOPBACK_HOSTS.has(view.host) && !view.allowOpen) {
    throw new Error(
      `refusing to install: the service would bind ${view.host} without an access token. Run \`omp-web setup --token\`, bind the loopback default, or set OMP_WEB_ALLOW_OPEN=1 in ${path.join(view.home, "env")}.`,
    );
  }
  return view;
}

function printFile(spec, contents) {
  console.log(`# ${spec.file}`);
  process.stdout.write(contents);
}

function printCommands(commands) {
  console.log("\nCommands:");
  for (const command of commands) console.log(`  ${command.join(" ")}`);
}

function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, contents, { mode: 0o644 });
  fs.renameSync(temp, file);
}

// ---- macOS -------------------------------------------------------------

function launchdTarget(spec) {
  return { domain: `gui/${process.getuid()}`, service: `gui/${process.getuid()}/${spec.label}` };
}

function launchdLoaded(spec) {
  return run("launchctl", ["print", launchdTarget(spec).service], { allowFail: true }).status === 0;
}

function launchdBootout(spec) {
  run("launchctl", ["bootout", launchdTarget(spec).service], { allowFail: true });
  // bootout returns before the job is fully gone; bootstrap would fail with EIO.
  for (let attempt = 0; attempt < 50 && launchdLoaded(spec); attempt += 1) sleep(100);
}

function launchdBootstrap(spec) {
  const { domain } = launchdTarget(spec);
  let result;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    result = run("launchctl", ["bootstrap", domain, spec.file], { allowFail: true });
    if (result.status === 0) return;
    sleep(500);
  }
  const detail = (result.stderr || result.stdout).trim();
  throw new Error(`launchctl bootstrap ${domain} failed (${result.status}): ${detail}. A GUI login session is required; log in to the desktop once.`);
}

// `launchctl print` is meant for humans, so read only the job's own
// top-level fields (one tab deep) and ignore nested blocks.
function parseLaunchdPrint(text) {
  const fields = {};
  for (const line of text.split("\n")) {
    const match = /^\t([a-z][a-z ]*?) = (.*)$/.exec(line);
    if (match && !(match[1] in fields)) fields[match[1]] = match[2].trim();
  }
  // launchd prints "last exit code" after a normal exit and "last terminating
  // signal" after a kill (e.g. kickstart -k); either may be absent.
  const lastExit = fields["last exit code"] || fields["last terminating signal"] || "";
  return { state: fields.state || "unknown", pid: fields.pid || "", runs: fields.runs || "", lastExit };
}

async function installDarwin(spec, dryRun) {
  const contents = renderPlist(spec);
  const { domain, service } = launchdTarget(spec);
  const commands = [["launchctl", "bootout", service], ["launchctl", "bootstrap", domain, spec.file]];
  if (dryRun) {
    printFile(spec, contents);
    printCommands(commands);
    return;
  }
  const view = preflight(spec);
  fs.mkdirSync(path.dirname(spec.log), { recursive: true });
  if (launchdLoaded(spec)) {
    console.log(`Stopping loaded ${spec.label} (tmux sessions keep running).`);
    launchdBootout(spec);
  }
  writeFile(spec.file, contents);
  console.log(`Wrote ${spec.file}`);
  launchdBootstrap(spec);
  console.log(`Loaded ${service}; it starts at every login.`);
  console.log(`Log: ${spec.log}`);
  console.log(`HTTP: ${describeProbe(view.host, view.port, await waitForHttp(view.host, view.port))}`);
}

async function uninstallDarwin(spec, dryRun) {
  const { service } = launchdTarget(spec);
  if (dryRun) {
    printCommands([["launchctl", "bootout", service], ["rm", spec.file]]);
    return;
  }
  const loaded = launchdLoaded(spec);
  if (loaded) launchdBootout(spec);
  const existed = fs.existsSync(spec.file);
  if (existed) fs.rmSync(spec.file);
  if (!loaded && !existed) {
    console.log(`${spec.label} is not installed.`);
    return;
  }
  console.log(`${loaded ? "Unloaded" : "Not loaded:"} ${service}`);
  if (existed) console.log(`Removed ${spec.file}`);
  console.log(`tmux sessions were left running; the log ${spec.log} was kept.`);
}

function installedEnvDarwin(spec) {
  const result = run("plutil", ["-convert", "json", "-o", "-", spec.file], { allowFail: true });
  if (result.status !== 0) return null;
  const plist = JSON.parse(result.stdout);
  return { node: plist.ProgramArguments?.[0] || process.execPath, env: plist.EnvironmentVariables || {} };
}

async function statusDarwin(spec) {
  const installed = fs.existsSync(spec.file);
  console.log(`label:   ${spec.label}`);
  console.log(`file:    ${installed ? spec.file : `${spec.file} (missing)`}`);
  const printed = run("launchctl", ["print", launchdTarget(spec).service], { allowFail: true });
  if (printed.status !== 0) {
    console.log("launchd: not loaded");
  } else {
    const { state, pid, runs, lastExit } = parseLaunchdPrint(printed.stdout);
    console.log(`launchd: ${state}${pid ? `, pid ${pid}` : ""}${runs ? `, runs ${runs}` : ""}${lastExit ? `, last exit ${lastExit}` : ""}`);
  }
  console.log(`log:     ${spec.log}`);
  if (!installed) {
    if (printed.status !== 0) process.exitCode = 1;
    return;
  }
  await printHttpStatus(installedEnvDarwin(spec));
}

// ---- Linux -------------------------------------------------------------

function systemctl(args, options) {
  return run("systemctl", ["--user", ...args], options);
}

// Checked before any file changes: a shell entered through su/sudo, or a host
// without systemd, has no user manager to talk to.
function requireUserManager() {
  const result = childProcess.spawnSync("systemctl", ["--user", "show-environment"], { encoding: "utf8" });
  if (result.error) throw new Error("systemctl not found; `service` needs systemd. Run `omp-web` under your own supervisor instead.");
  if (result.status !== 0) {
    const user = os.userInfo().username;
    throw new Error(
      `no systemd user manager is reachable (${(result.stderr || "").trim()}). Run this from your own login session (SSH or console, not su/sudo), or start one with \`loginctl enable-linger ${user}\`, then retry.`,
    );
  }
}

async function installLinux(spec, dryRun) {
  const contents = renderUnit(spec);
  const commands = [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", spec.label], ["systemctl", "--user", "restart", spec.label]];
  if (dryRun) {
    printFile(spec, contents);
    printCommands(commands);
    printLingerHint();
    return;
  }
  const view = preflight(spec);
  requireUserManager();
  writeFile(spec.file, contents);
  console.log(`Wrote ${spec.file}`);
  systemctl(["daemon-reload"]);
  systemctl(["enable", spec.label]);
  // restart, not start: a running unit must pick up the new ExecStart/Environment.
  systemctl(["restart", spec.label]);
  console.log(`Enabled and started ${spec.label}.`);
  console.log(`Log: journalctl --user -u ${spec.label}`);
  console.log(`HTTP: ${describeProbe(view.host, view.port, await waitForHttp(view.host, view.port))}`);
  printLingerHint();
}

function printLingerHint() {
  const user = os.userInfo().username;
  const linger = childProcess.spawnSync("loginctl", ["show-user", user, "--property=Linger", "--value"], { encoding: "utf8" });
  if (linger.status === 0 && linger.stdout.trim() === "yes") return;
  console.log(`\nUser services stop at logout and wait for a login after a reboot. To keep omp-web running, run once:\n  loginctl enable-linger ${user}`);
}

async function uninstallLinux(spec, dryRun) {
  const commands = [["systemctl", "--user", "disable", "--now", spec.label], ["rm", spec.file], ["systemctl", "--user", "daemon-reload"]];
  if (dryRun) {
    printCommands(commands);
    return;
  }
  if (!fs.existsSync(spec.file)) {
    console.log(`${spec.label} is not installed.`);
    return;
  }
  requireUserManager();
  systemctl(["disable", "--now", spec.label], { allowFail: true });
  fs.rmSync(spec.file);
  systemctl(["daemon-reload"]);
  console.log(`Stopped and disabled ${spec.label}; removed ${spec.file}`);
  console.log("tmux sessions were left running.");
}

function installedEnvLinux(spec) {
  let text;
  try {
    text = fs.readFileSync(spec.file, "utf8");
  } catch {
    return null;
  }
  const env = {};
  for (const line of text.split("\n")) {
    const match = /^Environment="((?:[^"\\]|\\.)*)"$/.exec(line);
    if (!match) continue;
    const pair = match[1].replace(/\\(.)/g, "$1").replace(/%%/g, "%");
    const index = pair.indexOf("=");
    env[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return { node: process.execPath, env };
}

async function statusLinux(spec) {
  const installed = fs.existsSync(spec.file);
  console.log(`unit:    ${spec.label}`);
  console.log(`file:    ${installed ? spec.file : `${spec.file} (missing)`}`);
  const shown = systemctl(["show", spec.label, "--property=LoadState,UnitFileState,ActiveState,SubState,MainPID,ExecMainStatus,NRestarts"], { allowFail: true });
  const fields = Object.fromEntries(shown.stdout.split("\n").filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2)));
  console.log(`systemd: ${fields.ActiveState || "unknown"} (${fields.SubState || "?"}), ${fields.UnitFileState || "not enabled"}, pid ${fields.MainPID || "0"}, last exit ${fields.ExecMainStatus || "?"}, restarts ${fields.NRestarts || "0"}`);
  console.log(`log:     journalctl --user -u ${spec.label}`);
  if (!installed) {
    process.exitCode = 1;
    return;
  }
  await printHttpStatus(installedEnvLinux(spec));
}

async function printHttpStatus(installed) {
  if (!installed) return;
  const view = serviceView(installed.node, installed.env);
  console.log(`bind:    ${view.host}:${view.port}, ${view.token ? "token required" : "open"}, tmux socket ${view.tmuxSocket}`);
  const result = await probe(view.host, view.port);
  console.log(`http:    ${describeProbe(view.host, view.port, result)}`);
  if (!result.up) process.exitCode = 1;
}

async function runService(args) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(`omp-web: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const platform = resolvePlatform(options.dryRun);
  const spec = buildSpec(platform, resolveLabel(platform, options.label));
  const handlers = platform === "darwin"
    ? { install: installDarwin, uninstall: uninstallDarwin, status: statusDarwin }
    : { install: installLinux, uninstall: uninstallLinux, status: statusLinux };
  await handlers[options.action](spec, options.dryRun);
}

module.exports = { runService };
