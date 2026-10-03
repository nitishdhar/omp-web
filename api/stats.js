"use strict";
// Memory per session: one `ps` and one tmux list, no caching. Processes are
// attributed by walking each omp-web pane's process tree from its pane_pid,
// so nothing outside omp-web's own tmux socket is ever counted. Only omp
// (with its __omp_worker_* helpers) and the rpc bridge count: the login
// shell, the holder's `tail`, and whatever a tool spawned (browsers, dev
// servers) are walked through but not charged to omp.
const { execFile } = require("child_process");
const path = require("path");
const config = require("../config");
const sessions = require("../sessions");
const runner = require("../sessions/runner");

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s(.*)$/;
// ps `etime` is [[dd-]hh:]mm:ss on both macOS and Linux; `lstart` is not
// portably parseable.
const ETIME = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/;
const OMP_NAME = path.basename(config.ompBin);
const NODE_NAME = path.basename(process.execPath);

function elapsedMs(etime) {
  const match = ETIME.exec(etime);
  if (!match) return null;
  const [, days = 0, hours = 0, minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60_000 + Number(seconds) * 1000;
}

function processTable() {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-axo", "pid=,ppid=,rss=,etime=,command="], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      const now = Date.now();
      const byPid = new Map();
      const children = new Map();
      for (const line of stdout.split("\n")) {
        const match = line.match(PS_LINE);
        if (!match) continue;
        const elapsed = elapsedMs(match[4]);
        const proc = {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          rssBytes: Number(match[3]) * 1024,
          startedAt: elapsed === null ? null : now - elapsed,
          command: match[5],
        };
        byPid.set(proc.pid, proc);
        if (!children.has(proc.ppid)) children.set(proc.ppid, []);
        children.get(proc.ppid).push(proc.pid);
      }
      resolve({ byPid, children });
    });
  });
}

// The executable is the first word; a path with spaces never names omp or
// node here, and the wrapper shells carry both names only as later words.
function kindOf(command) {
  const exe = path.basename(command.split(" ")[0]);
  if (exe === OMP_NAME) return "omp";
  if (exe === NODE_NAME && command.includes(` ${runner.BRIDGE} `)) return "bridge";
  return null;
}

function attribute(table, panePid) {
  // ompStartedAt: the oldest omp process, i.e. the session's main omp; its
  // workers start later. api/omp-update.js compares it with the install time.
  const out = { processes: 0, rssBytes: 0, active: false, ompStartedAt: null };
  if (!panePid) return out;
  const stack = [panePid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const proc = table.byPid.get(pid);
    if (!proc) continue;
    const kind = kindOf(proc.command);
    if (kind) {
      out.processes += 1;
      out.rssBytes += proc.rssBytes;
      if (kind === "omp") {
        out.active = true;
        if (proc.startedAt !== null && (out.ompStartedAt === null || proc.startedAt < out.ompStartedAt)) {
          out.ompStartedAt = proc.startedAt;
        }
      }
    }
    for (const child of table.children.get(pid) || []) stack.push(child);
  }
  return out;
}

// Live sessions with their attributed omp/bridge processes.
async function sessionProcesses() {
  const [live, table] = await Promise.all([sessions.list(), processTable()]);
  return live.map((session) => ({ session, usage: attribute(table, session.panePid) }));
}

async function getStats() {
  const totals = { ompProcesses: 0, ompRssBytes: 0, tui: 0, rpcActive: 0, rpcIdle: 0, shell: 0 };
  const rows = (await sessionProcesses()).map(({ session, usage }) => {
    totals.ompProcesses += usage.processes;
    totals.ompRssBytes += usage.rssBytes;
    if (session.type === "shell") totals.shell += 1;
    else if (session.runner === "tui") totals.tui += 1;
    else if (usage.active) totals.rpcActive += 1;
    else totals.rpcIdle += 1;
    return {
      id: session.id,
      title: session.title,
      type: session.type,
      runner: session.runner,
      status: session.status,
      attached: session.attached,
      processes: usage.processes,
      rssBytes: usage.rssBytes,
      active: usage.active,
    };
  });
  rows.sort((a, b) => b.rssBytes - a.rssBytes);
  return { generatedAt: Date.now(), totals, sessions: rows };
}

module.exports = { getStats, sessionProcesses };
