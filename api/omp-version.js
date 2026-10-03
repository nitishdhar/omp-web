"use strict";
// Which omp is installed and whether a newer one exists (`omp update
// --check`), and which sessions still run an omp older than the installed
// binary. Shared with api/omp-update.js, which runs the update jobs.
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { profileHome } = require("../transcripts");
const { sessionProcesses } = require("./stats");

const CHECK_TIMEOUT_MS = 30_000;
const CHECK_OK_MS = 6 * 60 * 60_000;
const CHECK_FAILED_MS = 10 * 60_000;
const VERSION_TIMEOUT_MS = 10_000;
// CSI/OSC escapes: omp colours its output even when piped.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const SEMVER = /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/;

let checkCache = null; // { value, expiresAt }
let checking = null;

function stripAnsi(text) {
  return String(text).replace(ANSI, "");
}

// Same profile selection as a session launch (see api/models.js): an
// inherited OMP_PROFILE would otherwise retarget the default profile.
function ompEnv() {
  const env = { ...process.env, PI_CODING_AGENT_DIR: profileHome("default") };
  delete env.OMP_PROFILE;
  delete env.PI_PROFILE;
  return env;
}

function capture(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(config.ompBin, args, { timeout: timeoutMs, env: ompEnv(), maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const output = stripAnsi(`${stdout || ""}\n${stderr || ""}`);
      if (!error) return resolve({ ok: true, output });
      const reason = error.killed ? "timed out"
        : typeof error.code === "number" ? `exited with code ${error.code}`
        : error.message;
      resolve({ ok: false, output, reason });
    });
  });
}

async function readVersion() {
  const { ok, output } = await capture(["--version"], VERSION_TIMEOUT_MS);
  const match = ok ? output.match(SEMVER) : null;
  return match ? match[0] : null;
}

function lastLine(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) || "";
}

async function runCheck() {
  const { ok, output, reason } = await capture(["update", "--check"], CHECK_TIMEOUT_MS);
  const current = output.match(/Current version:\s*(\S+)/);
  const latest = output.match(/New version available:\s*(\S+)/);
  const channel = output.match(/Current channel:\s*(\S+)/);
  const failed = output.match(/Failed to check for updates:\s*(.+)/);
  let error = null;
  if (failed) error = failed[1].trim();
  else if (!ok) error = lastLine(output) || `omp update --check ${reason}`;
  else if (!current) error = "omp update --check printed no version";
  return {
    current: current ? current[1] : null,
    latest: latest ? latest[1] : null,
    channel: channel ? channel[1] : null,
    updateAvailable: Boolean(latest) && !error,
    checkedAt: Date.now(),
    error,
  };
}

async function cachedCheck(refresh) {
  if (!refresh && checkCache && Date.now() < checkCache.expiresAt) return checkCache.value;
  if (!checking) {
    checking = runCheck().then((value) => {
      checkCache = { value, expiresAt: Date.now() + (value.error ? CHECK_FAILED_MS : CHECK_OK_MS) };
      return value;
    }).finally(() => { checking = null; });
  }
  return checking;
}

// `which omp`: config.ompBin itself when it is a path, else the first
// executable on PATH.
function whichOmp() {
  if (config.ompBin.includes("/")) return path.resolve(config.ompBin);
  for (const dir of (process.env.PATH || "").split(":").filter(Boolean)) {
    const candidate = path.join(dir, config.ompBin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

// Package managers swap the symlink (Homebrew) or replace the file in place,
// so the newer of the link's and the target's ctime is when this omp landed.
function installedAt() {
  const found = whichOmp();
  if (!found) return null;
  let newest = 0;
  try { newest = Math.max(newest, fs.lstatSync(found).ctimeMs); } catch {}
  try { newest = Math.max(newest, fs.statSync(fs.realpathSync(found)).ctimeMs); } catch {}
  return newest ? Math.round(newest) : null;
}

// Agent sessions whose omp started before the installed binary changed: they
// still run the old version until restarted.
async function staleSessions(since) {
  if (!since) return [];
  return (await sessionProcesses())
    .filter(({ session, usage }) => session.type === "agent"
      && usage.ompStartedAt !== null && usage.ompStartedAt < since)
    .map(({ session }) => ({ id: session.id, title: session.title, runner: session.runner, status: session.status }));
}

async function getVersion({ refresh = false } = {}) {
  const check = await cachedCheck(refresh);
  const installed = installedAt();
  return { ...check, installedAt: installed, staleSessions: await staleSessions(installed) };
}

function invalidateVersion() {
  checkCache = null;
}

module.exports = { getVersion, invalidateVersion, readVersion, installedAt, staleSessions, stripAnsi, ompEnv };
