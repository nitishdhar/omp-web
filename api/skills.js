"use strict";
// Per-profile switch for the skills omp-web ships. Every profile loads them
// through the shared ~/.agents/skills link (api/install-links.js), so the
// switch is an opt-out: off = the skill's name in that profile's
// `skills.ignoredSkills`. omp-web never writes profile config itself; it goes
// through `omp config`, so omp stays the one writer of its own settings.
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { listProfiles } = require("./util");
const { ompEnv, stripAnsi } = require("./omp-version");
const { profileHome } = require("../transcripts");
const { skillLinkStatus } = require("./install-links");

const BUNDLED = path.join(__dirname, "..", "skills");
const IGNORED_KEY = "skills.ignoredSkills";
const SKILL = "artifacts";
const OMP_TIMEOUT_MS = 20_000;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
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
  let names = [];
  try {
    names = fs.readdirSync(BUNDLED, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    /* none shipped */
  }
  return names.map((name) => {
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

async function readList(profile, key) {
  const output = await runConfig(profile, ["get", key, "--json"]);
  let parsed;
  try {
    parsed = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
  } catch {
    throw codedError("ESKILLCONFIG", `omp config returned unreadable output for ${profile}`);
  }
  const value = parsed && parsed.value;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw codedError("ESKILLCONFIG", `${key} is not a list for ${profile}`);
  }
  return value;
}

function sameList(a, b) {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

async function profileState(name) {
  try {
    return { name, installed: !(await readList(name, IGNORED_KEY)).includes(SKILL) };
  } catch (error) {
    return { name, installed: false, error: error.message };
  }
}

async function skillsStatus() {
  return {
    skills: bundledSkills(),
    link: skillLinkStatus(),
    profiles: await Promise.all(listProfiles().map(profileState)),
  };
}

// Read-modify-write of another program's config: serialized so two quick
// toggles cannot each write a list that drops the other's change.
let writes = Promise.resolve();

function serialized(task) {
  const run = writes.catch(() => {}).then(task);
  writes = run;
  return run;
}

function setSkillsInstalled(body) {
  const profile = String(body.profile || "");
  if (!listProfiles().includes(profile)) throw codedError("ENOTFOUND", `unknown profile: ${profile}`);
  if (typeof body.installed !== "boolean") throw codedError("EBADINSTALLED", "installed must be true or false");
  return serialized(async () => {
    const current = await readList(profile, IGNORED_KEY);
    const next = current.filter((entry) => entry !== SKILL);
    if (!body.installed) next.push(SKILL);
    if (!sameList(current, next)) await runConfig(profile, ["set", IGNORED_KEY, JSON.stringify(next)]);
    return skillsStatus();
  });
}

// ---- One-time cleanup of the old opt-in switch ------------------------------------

const CUSTOM_KEY = "skills.customDirectories";

// Entries are compared resolved so "~/x" or a trailing slash still counts.
function isSkillsDir(entry) {
  const expanded = entry === "~" || entry.startsWith("~/") ? path.join(config.homeDir, entry.slice(1)) : entry;
  return path.resolve(expanded) === path.resolve(config.skillsDir);
}

// The old switch added <OMP_WEB_HOME>/skills to skills.customDirectories.
// Left there beside the shared link, omp loads the skill twice and namespaces
// the second copy. A text pre-check on config.yml keeps this from spawning
// omp for every profile on every start once the entry is gone.
function mayListSkillsDir(profile) {
  try {
    const text = fs.readFileSync(path.join(profileHome(profile), "config.yml"), "utf8");
    return text.includes(CUSTOM_KEY.split(".")[1]) && text.includes(`${path.basename(config.ompWebHome)}/skills`);
  } catch {
    return false;
  }
}

async function migrateCustomDirectories() {
  for (const profile of listProfiles().filter(mayListSkillsDir)) {
    try {
      await serialized(async () => {
        const current = await readList(profile, CUSTOM_KEY);
        const next = current.filter((entry) => !isSkillsDir(entry));
        if (sameList(current, next)) return;
        await runConfig(profile, ["set", CUSTOM_KEY, JSON.stringify(next)]);
        console.log(`omp-web: removed ${config.skillsDir} from ${profile}'s ${CUSTOM_KEY}; the skill now loads from ~/.agents/skills`);
      });
    } catch (error) {
      console.error(`omp-web: could not clean ${profile}'s ${CUSTOM_KEY}: ${error.message}`);
    }
  }
}

module.exports = { skillsStatus, setSkillsInstalled, migrateCustomDirectories };
