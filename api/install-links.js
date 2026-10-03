"use strict";
// What installing omp-web changes on the machine, in one place: the bundled
// skills copied to <OMP_WEB_HOME>/skills, a ~/.agents/skills link that every
// omp profile (and other agents reading ~/.agents/skills) loads the artifacts
// skill from, and a ~/.local/bin/omp-web link so agents can run
// `omp-web artifact ...`. Run by the global-install postinstall, every server
// start and `omp-web setup`; inspected read-only by `omp-web doctor`.
// Links are only ever created over nothing, a dangling link or a link that
// is evidently ours: a real file or someone else's link is reported, never
// replaced.
const fs = require("fs");
const path = require("path");
const config = require("../config");

const BUNDLED = path.join(__dirname, "..", "skills");
const BIN = path.join(__dirname, "..", "bin", "omp-web.js");
const SKILL = "artifacts";
const OPT_OUT = "OMP_WEB_NO_INSTALL_LINKS";

const skillLinkPath = () => path.join(config.homeDir, ".agents", "skills", `omp-web-${SKILL}`);
const binLinkPath = () => path.join(config.homeDir, ".local", "bin", "omp-web");
const skillTarget = () => path.join(config.skillsDir, SKILL);

function optedOut() {
  return process.env[OPT_OUT] === "1";
}

function result(item, ok, action, detail) {
  return { item, ok, action, detail };
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

// Byte-for-byte tree compare, so an unchanged install reports "unchanged"
// and skips the copy. Skills are a few small files.
function sameTree(a, b) {
  let left;
  let right;
  try {
    left = fs.readdirSync(a, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name));
    right = fs.readdirSync(b, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name));
  } catch {
    return false;
  }
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    if (entry.name !== other.name || entry.isDirectory() !== other.isDirectory()) return false;
    const pa = path.join(a, entry.name);
    const pb = path.join(b, entry.name);
    if (entry.isDirectory()) return sameTree(pa, pb);
    try {
      return fs.readFileSync(pa).equals(fs.readFileSync(pb));
    } catch {
      return false;
    }
  });
}

// A profile pointing at the package directory would lose its skills on the
// next npm upgrade, hence a copy. Only same-named (managed) folders are
// replaced, through temp + rename; anything else kept there is left alone.
function copyBundledSkill(name) {
  const item = `skill ${name}`;
  const source = path.join(BUNDLED, name);
  const dest = path.join(config.skillsDir, name);
  const temp = path.join(config.skillsDir, `.${name}.tmp-${process.pid}`);
  const old = path.join(config.skillsDir, `.${name}.old-${process.pid}`);
  try {
    if (sameTree(source, dest)) return result(item, true, "unchanged", dest);
    fs.mkdirSync(config.skillsDir, { recursive: true, mode: 0o700 });
    fs.rmSync(temp, { recursive: true, force: true });
    fs.cpSync(source, temp, { recursive: true });
    let hadOld = false;
    try {
      fs.renameSync(dest, old);
      hadOld = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    fs.renameSync(temp, dest);
    if (hadOld) fs.rmSync(old, { recursive: true, force: true });
    return result(item, true, hadOld ? "updated" : "created", dest);
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    return result(item, false, "skipped", `could not copy to ${dest}: ${error.message}`);
  }
}

// -> {kind: "missing"|"link"|"other", target?, resolved?, dangling?}
function inspectPath(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "missing" };
    return { kind: "other", error: error.message };
  }
  if (!stat.isSymbolicLink()) return { kind: "other", directory: stat.isDirectory() };
  const target = fs.readlinkSync(file);
  const resolved = path.resolve(path.dirname(file), target);
  let real = "";
  try {
    real = fs.realpathSync(file);
  } catch {
    /* dangling */
  }
  return { kind: "link", target, resolved, real, dangling: !real };
}

function realOr(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

// Points at <file> already, compared through realpath so a relative link (as
// npm writes into a prefix bin) or a symlinked home still counts.
function pointsAt(state, want) {
  return state.kind === "link" && !state.dangling && state.real === realOr(want);
}

// Symlink swap through a temp name + rename, so the link is never briefly
// missing for an agent resolving it.
function placeLink(file, target, replacing) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.rmSync(temp, { force: true });
  fs.symlinkSync(target, temp);
  fs.renameSync(temp, file);
  return replacing ? "updated" : "created";
}

function describeOther(file, state) {
  if (state.error) return `${file} could not be read (${state.error}); left alone`;
  return `${file} is a real ${state.directory ? "directory" : "file"}, not a link; left alone`;
}

function ensureSkillLink() {
  const item = "skill link";
  const file = skillLinkPath();
  const target = skillTarget();
  if (optedOut()) return result(item, true, "skipped", `${OPT_OUT}=1`);
  if (!fs.existsSync(path.join(target, "SKILL.md"))) return result(item, false, "skipped", `${target} has no SKILL.md to link`);
  try {
    const state = inspectPath(file);
    if (pointsAt(state, target)) return result(item, true, "unchanged", `${file} -> ${target}`);
    // The name is ours: any link there is a previous omp-web link (an older
    // OMP_WEB_HOME, a moved home), so repointing it is safe.
    if (state.kind === "other") return result(item, false, "skipped", describeOther(file, state));
    const action = placeLink(file, target, state.kind === "link");
    return result(item, true, action, `${file} -> ${target}`);
  } catch (error) {
    return result(item, false, "skipped", `${file}: ${error.message}`);
  }
}

// A link into some omp-web install's bin/omp-web.js (a checkout, an older
// global install) is ours to repoint; any other command named omp-web is not.
function isOmpWebBin(resolved) {
  return path.basename(resolved) === "omp-web.js" && path.basename(path.dirname(resolved)) === "bin";
}

function ensureExecutable(file) {
  const mode = fs.statSync(file).mode;
  if ((mode & 0o111) !== 0o111) fs.chmodSync(file, mode | 0o111);
}

function ensureBinLink() {
  const item = "command link";
  const file = binLinkPath();
  if (optedOut()) return result(item, true, "skipped", `${OPT_OUT}=1`);
  try {
    const target = realOr(BIN);
    ensureExecutable(target);
    const state = inspectPath(file);
    if (pointsAt(state, target)) return result(item, true, "unchanged", `${file} -> ${target}`);
    if (state.kind === "other") return result(item, false, "skipped", describeOther(file, state));
    if (state.kind === "link" && !state.dangling && !isOmpWebBin(state.real)) {
      return result(item, false, "skipped", `${file} links to ${state.target}, not omp-web; left alone`);
    }
    const action = placeLink(file, target, state.kind === "link");
    return result(item, true, action, `${file} -> ${target}`);
  } catch (error) {
    return result(item, false, "skipped", `${file}: ${error.message}`);
  }
}

// -> [{item, ok, action: created|updated|unchanged|skipped, detail}]. Never throws.
function ensureInstallLinks() {
  const out = [];
  try {
    for (const name of bundledNames()) out.push(copyBundledSkill(name));
    out.push(ensureSkillLink());
    out.push(ensureBinLink());
  } catch (error) {
    out.push(result("install links", false, "skipped", error.message));
  }
  return out;
}

function formatResult(entry) {
  return `omp-web: ${entry.item} ${entry.action}${entry.ok ? "" : " (problem)"} — ${entry.detail}`;
}

// Startup logs only what changed or needs attention; "unchanged" every start
// would be noise.
function logInstallLinks(results) {
  for (const entry of results) {
    if (entry.ok && (entry.action === "unchanged" || entry.action === "skipped")) continue;
    (entry.ok ? console.log : console.error)(formatResult(entry));
  }
}

function onPath(dir) {
  return (process.env.PATH || "").split(path.delimiter).some((entry) => entry && path.resolve(entry) === dir);
}

// -> "" when <file> links to <target>, else what is wrong and how to fix it.
function linkProblem(file, target) {
  const state = inspectPath(file);
  if (pointsAt(state, target)) return "";
  if (state.kind === "other") return `${describeOther(file, state)}; move it aside, then restart omp-web`;
  if (file === binLinkPath() && state.kind === "link" && !state.dangling && !isOmpWebBin(state.real)) {
    return `${file} links to ${state.target}, not omp-web; left alone`;
  }
  const what = state.kind === "missing" ? `${file} is missing`
    : state.dangling ? `${file} -> ${state.target} is dangling`
    : `${file} points elsewhere (${state.target})`;
  return `${what}; restart omp-web or run \`omp-web setup\` to repair`;
}

// For Settings → Profiles: whether profiles can see the skill at all.
function skillLinkStatus() {
  if (optedOut()) return { ok: false, detail: `${OPT_OUT}=1: the shared skill link is not managed` };
  const problem = linkProblem(skillLinkPath(), skillTarget());
  return problem ? { ok: false, detail: problem } : { ok: true, detail: skillLinkPath() };
}

// Read-only, for doctor: -> [{level: "ok"|"WARN", label, detail}].
function inspectInstallLinks() {
  if (optedOut()) {
    return [{ level: "ok", label: "install links", detail: `skipped (${OPT_OUT}=1)` }];
  }
  const rows = [];
  const check = (label, file, target) => {
    const problem = linkProblem(file, target);
    rows.push(problem ? { level: "WARN", label, detail: problem } : { level: "ok", label, detail: `${file} -> ${target}` });
  };
  check("artifacts skill link", skillLinkPath(), skillTarget());
  check("omp-web command link", binLinkPath(), realOr(BIN));
  const binDir = path.dirname(binLinkPath());
  if (!onPath(binDir)) {
    rows.push({ level: "WARN", label: "PATH", detail: `${binDir} is not on PATH; agents fall back to \`node ${realOr(BIN)}\`` });
  }
  return rows;
}

module.exports = { ensureInstallLinks, logInstallLinks, inspectInstallLinks, skillLinkStatus, formatResult };
