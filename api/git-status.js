"use strict";

// Per-session git state: branch, dirty file count, ahead/behind.
// The caller supplies the cwd so the cache key is tied to the actual working
// directory, not the session id (a session can be reloaded into a new folder).

const { execFile } = require("child_process");

const CACHE_MS = 5_000;
const cache = new Map();
const NEUTRAL_STATUS = Object.freeze({ branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0 });

function parseStatus(text) {
  const lines = String(text || "").split(/\r?\n/);
  const branchLine = lines.find((line) => line.startsWith("## "));
  if (!branchLine) return NEUTRAL_STATUS;

  const header = branchLine.slice(3);
  let branch = null;
  let upstream = null;
  let bracket = "";
  if (/^HEAD \(no branch\)$|^HEAD \(detached (?:at|from) /.test(header)) {
    branch = "detached";
  } else {
    const initial = header.match(/^(?:No commits yet|Initial commit) on (.+)$/);
    const match = initial || header.match(/^(.+?)(?:\.\.\.([^\s\[]+))?(?:\s+\[([^\]]+)\])?$/);
    if (!match) return NEUTRAL_STATUS;
    branch = match[1].trim() || null;
    upstream = initial ? null : (match[2] || null);
    bracket = initial ? "" : (match[3] || "");
  }

  const ahead = Number(bracket.match(/(?:^|,\s*)ahead\s+(\d+)/)?.[1]) || 0;
  const behind = Number(bracket.match(/(?:^|,\s*)behind\s+(\d+)/)?.[1]) || 0;
  const dirty = lines.filter((line) => /^[ MADRCU?][ MADRCU?] /.test(line)).length;
  return { branch, upstream, ahead, behind, dirty };
}

function runGitStatus(cwd) {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        ["status", "--porcelain=v1", "--branch"],
        { encoding: "utf8", cwd, timeout: 5_000 },
        (error, stdout) => resolve(error ? NEUTRAL_STATUS : parseStatus(stdout)),
      );
    } catch {
      resolve(NEUTRAL_STATUS);
    }
  });
}

async function getGitStatus(cwd) {
  const key = cwd || "__none__";
  const now = Date.now();
  const cached = cache.get(key);
  if (cached?.status && now - cached.ts < CACHE_MS) return cached.status;
  if (cached?.pending) return cached.pending;

  const pending = runGitStatus(cwd).then((status) => {
    cache.set(key, { ts: Date.now(), status });
    return status;
  });
  cache.set(key, { pending });
  return pending;
}

module.exports = { getGitStatus, parseStatus };
