"use strict";
// Returns forgotten TUI sessions to the rpc runner, which ends their idle omp
// process (hundreds of MB each). A session is left alone while a turn runs,
// while any terminal client is attached (the browser's pooled terminal
// sockets count, so an open session is never reaped), and until it has been
// quiet for the TUI idle timer (api/runtime-settings.js, read every sweep).
// sessions.setRunner re-checks all of that inside the session's queue, so a
// client attaching mid-sweep wins.
const sessions = require("../sessions");
const { timerMinutes } = require("../api/runtime-settings");

const SWEEP_MS = 60_000;
const BUSY_STATUSES = new Set(["working", "waiting", "starting"]);

let timer = null;
let sweeping = false;

function skipReason(session) {
  if (session.attached > 0) return "open in a browser tab";
  if (session.status === "shell") return "omp not running";
  if (BUSY_STATUSES.has(session.status)) return "busy";
  return null;
}

// One pass over every TUI session. `idleMs` 0 is "sleep now": the idle-time
// threshold is ignored but the attached/busy/shell guards are not.
async function sleepTuiSessions(idleMs) {
  const converted = [];
  const skipped = [];
  for (const session of await sessions.list()) {
    if (session.type !== "agent" || session.runner !== "tui") continue;
    const reason = skipReason(session);
    if (reason) {
      skipped.push({ id: session.id, reason });
      continue;
    }
    try {
      if (await sessions.setRunner(session.id, "rpc", { idleMs })) {
        converted.push(session.id);
      } else if (idleMs === 0) {
        // Re-checked in the queue and refused: something changed since list.
        const now = await sessions.get(session.id);
        skipped.push({ id: session.id, reason: (now && skipReason(now)) || "busy" });
      }
    } catch (error) {
      skipped.push({ id: session.id, reason: error.code === "EBUSY" ? "busy" : error.message });
      if (error.code !== "EBUSY" && error.code !== "ENOSESSION") {
        console.error(`runner: could not switch ${session.id} to rpc: ${error.message}`);
      }
    }
  }
  return { converted, skipped };
}

async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const { converted } = await sleepTuiSessions(timerMinutes("tuiIdleMinutes") * 60_000);
    for (const id of converted) console.log(`runner: ${id} idle in the TUI, switched to rpc`);
  } catch (error) {
    console.error(`runner: sweep failed: ${error.message}`);
  } finally {
    sweeping = false;
  }
}

function sleepIdleNow() {
  return sleepTuiSessions(0);
}

function startReaper() {
  if (timer) return;
  timer = setInterval(() => void sweep(), SWEEP_MS);
  timer.unref();
}

module.exports = { startReaper, sleepIdleNow };
