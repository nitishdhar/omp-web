"use strict";
// Skills omp-web ships (skills/<name>/SKILL.md) and the per-profile switch
// that points native omp at them. omp-web never writes profile config itself:
// it reads and sets `skills.customDirectories` through `omp config`, so omp
// stays the one writer of its own settings.
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { listProfiles } = require("./util");
const { ompEnv, stripAnsi } = require("./omp-version");

const BUNDLED = path.join(__dirname, "..", "skills");
const CONFIG_KEY = "skills.customDirectories";
const OMP_TIMEOUT_MS = 20_000;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function bundledNames() {
  try {
    return fs.readdirSync(BUNDLED, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// Copies each bundled skill into <OMP_WEB_HOME>/skills on start, because a
// profile that referenced the package directory would lose its skills on the
// next npm upgrade. Only same-named (managed) folders are replaced; anything
// else a user keeps there is left alone. Never fatal: a failed copy keeps the
// previous one.
function syncBundledSkills() {
  for (const name of bundledNames()) {
    const dest = path.join(config.skillsDir, name);
    const temp = path.join(config.skillsDir, `.${name}.tmp-${process.pid}`);
    const old = path.join(config.skillsDir, `.${name}.old-${process.pid}`);
    try {
      fs.mkdirSync(config.skillsDir, { recursive: true, mode: 0o700 });
      fs.rmSync(temp, { recursive: true, force: true });
      fs.cpSync(path.join(BUNDLED, name), temp, { recursive: true });
      let hadOld = false;
      try {
        fs.renameSync(dest, old);
        hadOld = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      fs.renameSync(temp, dest);
      if (hadOld) fs.rmSync(old, { recursive: true, force: true });
    } catch (error) {
      console.error(`omp-web: could not install bundled skill ${name}: ${error.message}`);
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

function frontmatter(text) {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  for (const line of block ? block[1].split(/\r?\n/) : []) {
    const match = line.match(/^(name|description):\s*(.*?)\s*$/);
    if (match) out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

function bundledSkills() {
  return bundledNames().map((name) => {
    let meta = {};
    try {
      meta = frontmatter(fs.readFileSync(path.join(BUNDLED, name, "SKILL.md"), "utf8"));
    } catch {
      /* listed by folder name alone */
    }
    return { name: meta.name || name, description: meta.description || "" };
  });
}

// ---- Profile config through omp --------------------------------------------------

function runConfig(profile, args) {
  const argv = profile === "default" ? ["config", ...args] : [`--profile=${profile}`, "config", ...args];
  return new Promise((resolve, reject) => {
    execFile(config.ompBin, argv, { env: ompEnv(), timeout: OMP_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stripAnsi(stdout));
      const said = stripAnsi(`${stderr || ""}\n${stdout || ""}`).split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
      reject(codedError("ESKILLCONFIG", `omp config failed for ${profile}: ${said || (error.killed ? "timed out" : error.message)}`));
    });
  });
}

async function readDirectories(profile) {
  const output = await runConfig(profile, ["get", CONFIG_KEY, "--json"]);
  let parsed;
  try {
    parsed = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
  } catch {
    throw codedError("ESKILLCONFIG", `omp config returned unreadable output for ${profile}`);
  }
  const value = parsed && parsed.value;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw codedError("ESKILLCONFIG", `${CONFIG_KEY} is not a list for ${profile}`);
  }
  return value;
}

// Entries are compared resolved so "~/x" or a trailing slash still counts.
function isSkillsDir(entry) {
  const expanded = entry === "~" || entry.startsWith("~/") ? path.join(config.homeDir, entry.slice(1)) : entry;
  return path.resolve(expanded) === path.resolve(config.skillsDir);
}

async function profileState(name) {
  try {
    return { name, installed: (await readDirectories(name)).some(isSkillsDir) };
  } catch (error) {
    return { name, installed: false, error: error.message };
  }
}

async function skillsStatus() {
  return {
    skills: bundledSkills(),
    profiles: await Promise.all(listProfiles().map(profileState)),
  };
}

// Read-modify-write of another program's config: serialized so two quick
// toggles cannot each write a list that drops the other's change.
let writes = Promise.resolve();

function setSkillsInstalled(body) {
  const profile = String(body.profile || "");
  if (!listProfiles().includes(profile)) throw codedError("ENOTFOUND", `unknown profile: ${profile}`);
  if (typeof body.installed !== "boolean") throw codedError("EBADINSTALLED", "installed must be true or false");
  const run = writes.catch(() => {}).then(async () => {
    const current = await readDirectories(profile);
    const next = current.filter((entry) => !isSkillsDir(entry));
    if (body.installed) next.push(config.skillsDir);
    if (next.length !== current.length || next.some((entry, index) => entry !== current[index])) {
      await runConfig(profile, ["set", CONFIG_KEY, JSON.stringify(next)]);
    }
    return skillsStatus();
  });
  writes = run;
  return run;
}

module.exports = { syncBundledSkills, skillsStatus, setSkillsInstalled };
