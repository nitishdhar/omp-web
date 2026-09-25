"use strict";
// Extra folders the file viewer may read, beyond the session folder, sibling
// workspace repos, and attachments. Agents routinely cite documents that live
// elsewhere (~/Documents/..., ~/.omp/agent/config.yml), and those links could
// never open. Edited from the Settings panel and read on every request, so a
// change applies without a restart.
//
// This is not a privilege boundary against the token holder — the terminal is
// already a full shell — it keeps the web route from serving the whole home
// directory, and keeps credential files out even inside a chosen folder.
const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("../config");

const MAX_ROOTS = 20;
const CREDENTIAL_NAME = /(?:^|[^a-z])(?:o?auth|credentials?|secrets?|tokens?|passwords?|api[-_]?keys?)(?:[^a-z]|$)/i;
// Agent configs that commonly carry bearer headers or API keys in plain JSON.
const AGENT_KEY_FILES = new Set(["mcp.json", "settings.local.json"]);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(config.settingsFile, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function listPreviewRoots() {
  const roots = readSettings().previewRoots;
  return Array.isArray(roots)
    ? roots.filter((root) => typeof root === "string" && path.isAbsolute(root))
    : [];
}

function containsOrIs(dir, candidate) {
  const relative = path.relative(dir, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realOrResolved(target) {
  try { return await fs.promises.realpath(target); } catch { return path.resolve(target); }
}

async function validateRoot(raw) {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input || input.length > 4096 || input.includes("\0")) {
    throw codedError("EBADROOT", "folder path is required");
  }
  const expanded = input === "~" ? os.homedir()
    : input.startsWith("~/") ? path.join(os.homedir(), input.slice(2))
    : input;
  if (!path.isAbsolute(expanded)) throw codedError("EBADROOT", `${input}: use an absolute path or ~/…`);
  let real;
  try {
    real = await fs.promises.realpath(expanded);
    if (!(await fs.promises.stat(real)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw codedError("EBADROOT", `${input}: folder not found`);
  }
  const home = await realOrResolved(os.homedir());
  if (containsOrIs(real, home)) {
    throw codedError("EBADROOT", `${input}: too broad — choose a folder inside your home directory`);
  }
  const ownData = await realOrResolved(config.ompWebHome);
  if (containsOrIs(real, ownData) || containsOrIs(ownData, real)) {
    throw codedError("EBADROOT", `${input}: overlaps omp-web's own token and settings`);
  }
  return real;
}

async function setPreviewRoots(input) {
  if (!Array.isArray(input)) throw codedError("EBADROOT", "roots must be a list of folders");
  if (input.length > MAX_ROOTS) throw codedError("EBADROOT", `at most ${MAX_ROOTS} folders`);
  const roots = [];
  for (const raw of input) {
    const real = await validateRoot(raw);
    if (!roots.includes(real)) roots.push(real);
  }
  const next = { ...readSettings(), previewRoots: roots };
  await fs.promises.mkdir(path.dirname(config.settingsFile), { recursive: true, mode: 0o700 });
  const temp = `${config.settingsFile}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  await fs.promises.rename(temp, config.settingsFile);
  return roots;
}

/** Credential-shaped paths are refused inside an extra root even when allowed by type. */
function refusedInExtraRoot(root, filePath) {
  const relative = path.relative(root, filePath);
  if (relative.split(path.sep).some((segment) => segment.startsWith("."))) return true;
  const name = path.basename(filePath);
  return CREDENTIAL_NAME.test(name) || AGENT_KEY_FILES.has(name.toLowerCase());
}

module.exports = { listPreviewRoots, setPreviewRoots, refusedInExtraRoot };
