"use strict";
// Where a cited file lives: maps the path an agent wrote in chat to one real
// file inside an allowed root, or a coded error. Opening, verifying and
// streaming the bytes stays in file-preview.js.
const fs = require("fs");
const path = require("path");
const os = require("os");
const config = require("../config");
const { findBySuffix } = require("./file-find");
const { listPreviewRoots } = require("./preview-roots");

function previewError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isStrictDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function realDirectory(directory) {
  try {
    const resolved = await fs.promises.realpath(directory);
    const stat = await fs.promises.stat(resolved);
    return stat.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

async function allowedRoots(session, id) {
  const roots = [];
  const sessionRoot = session.folder && await realDirectory(session.folder);
  if (sessionRoot) roots.push(sessionRoot);

  const attachmentsRoot = await realDirectory(config.attachmentsDir);
  const sessionAttachments = await realDirectory(path.join(config.attachmentsDir, id));
  if (attachmentsRoot && sessionAttachments && isStrictDescendant(attachmentsRoot, sessionAttachments)) {
    roots.push(sessionAttachments);
  }
  return roots;
}
async function canonicalWithin(root, requestedPath) {
  const candidate = path.resolve(root, requestedPath);
  try {
    const filePath = await fs.promises.realpath(candidate);
    return isStrictDescendant(root, filePath) ? filePath : null;
  } catch {
    return null;
  }
}

async function workspaceFallback(requestedPath, sessionRoot) {
  const matches = new Map();
  // A path like `omp-web/README.md` names a sibling project; private projects
  // under an extra root are siblings too.
  for (const top of [config.workspaceRoot, ...config.extraRoots]) {
    const topRoot = await realDirectory(top);
    if (!topRoot) continue;
    let entries = [];
    try {
      entries = await fs.promises.readdir(topRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const root = await realDirectory(path.join(topRoot, entry.name));
      if (!root || root === sessionRoot) continue;
      const filePath = await canonicalWithin(root, requestedPath);
      if (filePath) matches.set(filePath, root);
    }
  }
  if (matches.size > 1) {
    throw previewError("ECONFLICT", "file path matches multiple workspace folders; use an absolute path");
  }
  const match = matches.entries().next().value;
  return match ? { filePath: match[0], roots: [match[1]] } : null;
}

// Agent output writes `~/workspace/...` constantly, and Node does not treat a
// tilde as absolute: such a path fell through to the relative branch, resolved
// to <sessionFolder>/~/workspace/... and 404'd. Expansion changes nothing about
// containment — the result still has to be a strict descendant of an allowed
// root — it just stops every tilde path being a dead link.
function expandHome(requestedPath) {
  if (requestedPath === "~") return os.homedir();
  if (requestedPath.startsWith("~/")) return path.join(os.homedir(), requestedPath.slice(2));
  return requestedPath;
}

// Agents shorten long paths (`…/Gift Deed/Declaration.pdf`); the tail is still
// a usable suffix even though the literal path does not exist.
const ELIDED_PREFIX = /^(?:…|\.\.\.)[\\/]/;

async function extraRootMatch(extra, requestedPath) {
  const matches = [];
  for (const root of extra) {
    const found = await findBySuffix(root, requestedPath);
    if (!found.complete && !found.matches.length) continue;
    if (!found.complete) return null;
    matches.push(...found.matches);
    if (matches.length > 1) {
      throw previewError("ECONFLICT", "file name matches several files in your viewer folders; use a longer path");
    }
  }
  return matches[0] || null;
}

async function resolvePreviewPath(session, id, rawPath) {
  const elided = ELIDED_PREFIX.test(rawPath);
  const requestedPath = elided ? rawPath.replace(ELIDED_PREFIX, "") : expandHome(rawPath);
  const base = await allowedRoots(session, id);
  const extra = [];
  for (const root of listPreviewRoots()) {
    const real = await realDirectory(root);
    if (real && !base.includes(real) && !extra.includes(real)) extra.push(real);
  }
  const roots = [...base, ...extra];
  if (path.isAbsolute(requestedPath)) {
    let filePath;
    try {
      filePath = await fs.promises.realpath(requestedPath);
    } catch {
      throw previewError("ENOTFOUND", "file not found");
    }
    if (!roots.some((root) => isStrictDescendant(root, filePath))) {
      throw previewError("EBADPATH", "outside this session's folder — add its folder in Settings → File viewer folders");
    }
    return { filePath, roots, extra };
  }

  const sessionRoot = session.folder && await realDirectory(session.folder);
  if (!sessionRoot) throw previewError("ENOFOLDER", "folder not found");
  if (!elided) {
    const local = await canonicalWithin(sessionRoot, requestedPath);
    if (local) return { filePath: local, roots, extra };
    const fallback = await workspaceFallback(requestedPath, sessionRoot);
    if (fallback) return { ...fallback, extra: [] };
  }
  const found = await findBySuffix(sessionRoot, requestedPath);
  if (found.matches.length > 1) {
    throw previewError("ECONFLICT", "file name matches several files in this folder; use a longer path");
  }
  if (found.matches.length === 1 && found.complete) {
    const deep = await canonicalWithin(sessionRoot, path.relative(sessionRoot, found.matches[0]));
    if (deep) return { filePath: deep, roots, extra };
  }
  const inExtra = await extraRootMatch(extra, requestedPath);
  if (inExtra) return { filePath: await fs.promises.realpath(inExtra), roots, extra };
  throw previewError("ENOTFOUND", "file not found");
}

module.exports = { previewError, isStrictDescendant, resolvePreviewPath };
