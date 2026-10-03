"use strict";
// Returns forgotten TUI sessions to the rpc runner, which ends their idle omp
// process (hundreds of MB each). A session is left alone while a turn runs,
// while any terminal client is attached (the browser's pooled terminal
// sockets count, so an open session is never reaped), and until it has been
// quiet for OMP_WEB_TUI_IDLE_MINUTES. sessions.setRunner re-checks all of
// that inside the session's queue, so a client attaching mid-sweep wins.
const config = require("../config");
const sessions = require("../sessions");

const SWEEP_MS = 60_000;
const BUSY_STATUSES = new Set(["working", "waiting", "starting", "shell"]);

let timer = null;
let sweeping = false;

async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const idleMs = config.tuiIdleMinutes * 60_000;
    for (const session of await sessions.list()) {
      if (session.type !== "agent" || session.runner !== "tui") continue;
      if (session.attached > 0 || BUSY_STATUSES.has(session.status)) continue;
      try {
        const converted = await sessions.setRunner(session.id, "rpc", { idleMs });
        if (converted) console.log(`runner: ${session.id} idle in the TUI, switched to rpc`);
      } catch (error) {
        if (error.code !== "EBUSY" && error.code !== "ENOSESSION") {
          console.error(`runner: could not switch ${session.id} to rpc: ${error.message}`);
        }
      }
    }
  } catch (error) {
    console.error(`runner: sweep failed: ${error.message}`);
  } finally {
    sweeping = false;
  }
}

function startReaper() {
  if (timer) return;
  timer = setInterval(() => void sweep(), SWEEP_MS);
  timer.unref();
}

module.exports = { startReaper };
