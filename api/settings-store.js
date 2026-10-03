"use strict";
// The one reader/writer of OMP_WEB_HOME/settings.json, omp-web's own editable
// preferences (keys: previewRoots, panels, runtime). Every caller re-reads so
// a save applies on the next request without a restart; the stat-keyed cache
// only skips re-parsing an unchanged file. Writes replace one key and keep
// the rest, through temp + rename so a crash never leaves half a file.
const fs = require("fs");
const path = require("path");
const config = require("../config");

let cached = null; // { key, value }

function statKey() {
  try {
    const stat = fs.statSync(config.settingsFile);
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return "missing";
  }
}

function readSettings() {
  const key = statKey();
  if (cached && cached.key === key) return cached.value;
  let value = {};
  if (key !== "missing") {
    try {
      const parsed = JSON.parse(fs.readFileSync(config.settingsFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed;
    } catch {
      /* unreadable or invalid: behave as empty, never brick a request */
    }
  }
  cached = { key, value };
  return value;
}

function getSetting(name) {
  return readSettings()[name];
}

// Serialized so two concurrent saves of different keys cannot each write a
// copy that drops the other's change.
let writes = Promise.resolve();

function setSetting(name, value) {
  const run = writes.catch(() => {}).then(async () => {
    const next = { ...readSettings(), [name]: value };
    await fs.promises.mkdir(path.dirname(config.settingsFile), { recursive: true, mode: 0o700 });
    const temp = `${config.settingsFile}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await fs.promises.rename(temp, config.settingsFile);
    cached = null;
    return value;
  });
  writes = run;
  return run;
}

module.exports = { getSetting, setSetting };
