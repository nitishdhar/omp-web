"use strict";
// Update the host's omp from Settings: `omp update` installs a newer omp (omp
// detects its own install method); "reload" refreshes every profile's model
// catalog and restarts settled sessions still running the old binary. Nothing
// here runs at startup or on a timer: only on an explicit POST, one job at a
// time. api/omp-version.js answers whether there is anything to do.
const { spawn } = require("child_process");
const crypto = require("crypto");
const config = require("../config");
const sessions = require("../sessions");
const { listProfiles } = require("./util");
const { clearModelCache } = require("./models");
const { invalidateVersion, readVersion, installedAt, staleSessions, stripAnsi, ompEnv } = require("./omp-version");

const UPDATE_TIMEOUT_MS = 15 * 60_000;
const REFRESH_TIMEOUT_MS = 90_000;
const MAX_LOG_LINES = 200;
const BUSY_STATUSES = new Set(["working", "waiting", "starting"]);

let job = null;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ---- Jobs ---------------------------------------------------------------------

function logLine(target, raw) {
  const line = stripAnsi(raw).trimEnd();
  if (!line.trim()) return;
  target.log.push(line);
  if (target.log.length > MAX_LOG_LINES) target.log.splice(0, target.log.length - MAX_LOG_LINES);
}

// Streams stdout and stderr into the job log line by line; `\r` progress
// redraws count as lines too. `lastLine` is what a failure most likely said.
async function spawnLogged(target, args, timeoutMs) {
  const env = await ompEnv();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(config.ompBin, args, { stdio: ["ignore", "pipe", "pipe"], env });
    } catch (error) {
      resolve({ code: null, error: error.message });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    let lastLine = "";
    const take = (raw) => {
      const line = stripAnsi(raw).trim();
      if (line) lastLine = line;
      logLine(target, raw);
    };
    const pump = (stream) => {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        const parts = (pending + chunk).split(/\r\n|\n|\r/);
        pending = parts.pop();
        for (const part of parts) take(part);
      });
      stream.on("end", () => { if (pending) take(pending); });
    };
    pump(child.stdout);
    pump(child.stderr);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const error = timedOut ? "timed out" : code === 0 ? null : `exited with code ${code}`;
      resolve({ code, error, lastLine });
    });
  });
}

function startJob(kind, run) {
  if (job && job.state === "running") {
    throw codedError("EBUSY", `an omp ${job.kind} is already running`);
  }
  const current = {
    id: crypto.randomUUID(),
    kind,
    state: "running",
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    from: null,
    to: null,
    log: [],
    result: null,
  };
  job = current;
  const finish = (ok) => {
    current.state = ok ? "succeeded" : "failed";
    current.finishedAt = Date.now();
  };
  run(current).then(finish, (error) => {
    logLine(current, `error: ${error.message}`);
    finish(false);
  });
  return current;
}

async function runUpdate(current) {
  current.from = await readVersion();
  logLine(current, `$ omp update`);
  const { code, error } = await spawnLogged(current, ["update"], UPDATE_TIMEOUT_MS);
  current.exitCode = code;
  if (error) logLine(current, `omp update ${error}`);
  current.to = await readVersion();
  invalidateVersion();
  return code === 0 && !error;
}

async function runReload(current) {
  const profiles = [];
  for (const name of listProfiles()) {
    const args = name === "default" ? ["models", "refresh"] : [`--profile=${name}`, "models", "refresh"];
    logLine(current, `$ omp ${args.join(" ")}`);
    const { error, lastLine } = await spawnLogged(current, args, REFRESH_TIMEOUT_MS);
    profiles.push(error ? { name, ok: false, error: lastLine || error } : { name, ok: true });
  }
  clearModelCache();
  const restarted = [];
  const skipped = [];
  for (const stale of await staleSessions(installedAt())) {
    if (BUSY_STATUSES.has(stale.status)) {
      skipped.push({ id: stale.id, reason: "busy" });
      logLine(current, `skip ${stale.id}: busy`);
      continue;
    }
    try {
      const outcome = await sessions.restartOmp(stale.id);
      if (outcome.restarted) {
        restarted.push(stale.id);
        logLine(current, `restarted ${stale.id} (${stale.runner})`);
      } else {
        skipped.push({ id: stale.id, reason: outcome.reason });
        logLine(current, `skip ${stale.id}: ${outcome.reason}`);
      }
    } catch (error) {
      skipped.push({ id: stale.id, reason: error.message });
      logLine(current, `skip ${stale.id}: ${error.message}`);
    }
  }
  current.result = { profiles, restarted, skipped };
  return profiles.every((profile) => profile.ok);
}

function startUpdate() {
  return startJob("update", runUpdate);
}

function startReload() {
  return startJob("reload", runReload);
}

function currentJob() {
  return job;
}

module.exports = { startUpdate, startReload, currentJob };
