"use strict";
const fs = require("fs");
const path = require("path");
const config = require("../config");

const JSON_CT = "application/json; charset=utf-8";
const MAX_BODY_BYTES = 1_000_000;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": JSON_CT,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function errorStatus(error) {
  const code = error && error.code;
  if (code === "EBODYTOOLARGE" || code === "EATTACHMENTTOOLARGE" || code === "EPAYLOADTOOLARGE" || code === "EVOICETOOLARGE") return 413;
  if (code === "ENOSESSION" || code === "ENOTRANSCRIPT" || code === "ENOTFOUND") return 404;
  if (code === "EEXIST" || code === "ENOSESSIONFILE" || code === "ECONFLICT" || code === "EBUSY") return 409;
  // A setting fixed by the environment; Settings shows it read-only.
  if (code === "ELOCKED") return 409;
  if (code === "EUNSUPPORTEDATTACHMENT") return 415;
  if (code === "ENOTRANSCRIBER" || code === "EVOICEUPSTREAM" || code === "EVOICETIMEOUT" || code === "EMODELSUNAVAILABLE") return 503;
  // omp under the RPC runner could not be started or did not answer; or
  // `omp config` failed while reading or switching a profile's skills.
  if (code === "ERUNNER" || code === "ENOBRIDGE" || code === "ESTOPPING" || code === "ESKILLCONFIG") return 503;
  if (
    error instanceof SyntaxError ||
    (typeof code === "string" && code.startsWith("EBAD")) ||
    code === "ENOFOLDER" ||
    code === "EABORTED"
  ) {
    return 400;
  }
  return 500;
}

function sendError(res, error) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const status = errorStatus(error);
  const code = error && error.code;
  const publicCode =
    status === 500 ? "EINTERNAL" :
    code || (error instanceof SyntaxError ? "EBADJSON" : "EBADREQUEST");
  let message = status === 500 ? "internal server error" : String(error && error.message || "request failed");
  if (code === "ENOSESSION") message = "session not found";
  else if (code === "ENOTRANSCRIPT") message = "transcript not found";
  else if (code === "ENOFOLDER") message = "folder not found";
  sendJson(res, status, { error: message, code: String(publicCode) });
}

function readBody(req) {
  const declared = req.headers && req.headers["content-length"];
  if (declared !== undefined) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      return Promise.reject(codedError("EBADBODY", "invalid content-length"));
    }
    if (bytes > MAX_BODY_BYTES) {
      req.resume();
      return Promise.reject(codedError("EBODYTOOLARGE", "request body is too large"));
    }
  }

  return new Promise((resolve, reject) => {
    let chunks = [];
    let bytes = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      chunks = [];
      reject(error);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY_BYTES) {
        fail(codedError("EBODYTOOLARGE", "request body is too large"));
        req.resume();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
        resolve(body);
      } catch {
        reject(codedError("EBADBODY", "request body must be valid UTF-8"));
      }
    });
    req.on("aborted", () => fail(codedError("EABORTED", "request was aborted")));
    req.on("error", fail);
  });
}

function childFolders(root, labelPrefix = "") {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ name: labelPrefix + e.name, path: path.join(root, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Workspace children first, then each extra root's children labelled
// "<root name>/<folder>" so a private project can never be mistaken for (or
// collide with) a workspace one. Order is meaningful: the sidebar keeps it.
function listFolders() {
  const folders = childFolders(config.workspaceRoot);
  const seen = new Set(folders.map((folder) => folder.path));
  for (const root of config.extraRoots) {
    if (root === config.workspaceRoot) continue;
    for (const folder of childFolders(root, `${path.basename(root)}/`)) {
      if (seen.has(folder.path)) continue;
      seen.add(folder.path);
      folders.push(folder);
    }
  }
  return folders;
}

function listProfiles() {
  const out = ["default"];
  try {
    for (const e of fs.readdirSync(config.profilesDir, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(e.name);
    }
  } catch {
    /* no profiles dir */
  }
  return out;
}

const PROFILE_ROLE_LIMIT = 16;
const PROFILE_CONFIG_LIMIT = 64 * 1024;
const MODEL_ROLE_LIMIT = 512;
const ROLE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._+@:/-]{0,511}$/;
const EFFORT_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function profileHome(profile) {
  return profile === "default"
    ? path.join(config.ompHome, "agent")
    : path.join(config.profilesDir, profile, "agent");
}

function splitModelRole(value) {
  const raw = String(value || "").slice(0, MODEL_ROLE_LIMIT).replace(/^['"]|['"]$/g, "");
  if (!MODEL_IDENTIFIER.test(raw)) return null;
  const separator = raw.lastIndexOf(":");
  const suffix = separator >= 0 ? raw.slice(separator + 1).toLowerCase() : "";
  const effort = EFFORT_LEVELS.has(suffix) ? suffix : "";
  const identifier = effort ? raw.slice(0, separator) : raw;
  const slash = identifier.indexOf("/");
  return {
    provider: slash > 0 ? identifier.slice(0, slash) : "",
    model: slash > 0 ? identifier.slice(slash + 1) : identifier,
    effort,
  };
}

function profileRoles(profile) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(profileHome(profile), "config.yml"), "utf8")
      .slice(0, PROFILE_CONFIG_LIMIT);
  } catch {
    return [];
  }
  const roles = [];
  let inRoles = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^modelRoles:\s*$/.test(line)) {
      inRoles = true;
      continue;
    }
    if (!inRoles) continue;
    if (/^\S/.test(line)) break;
    const match = line.match(/^\s+([A-Za-z][A-Za-z0-9_-]{0,31}):\s*(\S.*?)\s*$/);
    if (!match || !ROLE_NAME.test(match[1]) || roles.length >= PROFILE_ROLE_LIMIT) continue;
    const value = match[2].replace(/\s+#.*$/, "");
    const parsed = splitModelRole(value);
    if (parsed?.model) roles.push({ role: match[1], ...parsed });
  }
  return roles;
}

function listProfileDetails() {
  return listProfiles().map((name) => ({ name, roles: profileRoles(name) }));
}

module.exports = {
  sendJson, sendError, readBody, listFolders, listProfiles, listProfileDetails,
};
