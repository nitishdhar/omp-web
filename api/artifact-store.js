"use strict";
// Artifacts on disk: one folder per slug under config.artifactsDir holding an
// artifact.json manifest and static files. Shared by the /a/ server, the
// /api/artifacts list and the `omp-web artifact` CLI so all three apply the
// same slug, manifest and served-path rules.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const config = require("../config");

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MANIFEST = "artifact.json";
const MANIFEST_LIMIT = 64 * 1024;
const SIZE_CAP = 20 * 1024 * 1024;
const CAP_LENGTH = 22;
const CAP_CONTEXT = "omp-web-artifact:v1:";
// A walk this deep or this wide is not a page; stop rather than stall a list.
const WALK_DEPTH = 16;
const WALK_ENTRIES = 10_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validSlug(slug) {
  return typeof slug === "string" && SLUG.test(slug);
}

function artifactDir(slug) {
  return path.join(config.artifactsDir, slug);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// A served path segment: non-empty, no separators or NUL, and never a dotfile
// (which also rules out "." and "..").
function servableSegment(segment) {
  return typeof segment === "string" && segment !== "" && !segment.startsWith(".")
    && !/[/\\\0]/.test(segment);
}

function allowedType(name) {
  return Object.prototype.hasOwnProperty.call(MIME, path.extname(name).toLowerCase());
}

// ---- Capability key ------------------------------------------------------------

// Read on every call so deleting the file revokes every link at once. Created
// through temp + link so a concurrent reader never sees a half-written key.
function readKey({ create = false } = {}) {
  try {
    const key = fs.readFileSync(config.artifactsKeyFile);
    if (key.length >= 32) return key;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!create) return null;
  fs.mkdirSync(path.dirname(config.artifactsKeyFile), { recursive: true, mode: 0o700 });
  const temp = `${config.artifactsKeyFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, crypto.randomBytes(32), { mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(temp, config.artifactsKeyFile);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return fs.readFileSync(config.artifactsKeyFile);
}

function capFor(slug, key) {
  return crypto.createHmac("sha256", key).update(CAP_CONTEXT + slug).digest("base64url").slice(0, CAP_LENGTH);
}

function capMatches(slug, cap) {
  if (!validSlug(slug) || typeof cap !== "string" || cap.length !== CAP_LENGTH) return false;
  const key = readKey();
  if (!key) return false;
  return crypto.timingSafeEqual(Buffer.from(capFor(slug, key)), Buffer.from(cap));
}

function artifactPath(slug) {
  return `/a/${capFor(slug, readKey({ create: true }))}/${slug}/`;
}

// ---- Manifest ------------------------------------------------------------------

function manifestProblem(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return "manifest must be a JSON object";
  const { title, description, project, entry, updatedAt } = manifest;
  if (typeof title !== "string" || !title.trim()) return "title is required";
  if (title.length > 80) return "title is longer than 80 characters";
  if (description !== undefined && (typeof description !== "string" || description.length > 280)) {
    return "description must be a string of at most 280 characters";
  }
  if (project !== undefined && (typeof project !== "string" || !path.isAbsolute(project))) {
    return "project must be an absolute folder path";
  }
  if (entry !== undefined) {
    if (typeof entry !== "string" || !entry.split("/").every(servableSegment)) {
      return "entry must be a relative path without dot segments";
    }
    if (!allowedType(entry)) return "entry has a file type that is not served";
  }
  if (updatedAt !== undefined && (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt)))) {
    return "updatedAt must be an ISO date string";
  }
  return null;
}

// -> { manifest } or { error }; never throws.
function readManifest(slug) {
  let text;
  try {
    const file = path.join(artifactDir(slug), MANIFEST);
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { error: `${MANIFEST} is not a file` };
    if (stat.size > MANIFEST_LIMIT) return { error: `${MANIFEST} is larger than 64 KB` };
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { error: error.code === "ENOENT" ? `${MANIFEST} is missing` : `${MANIFEST} is unreadable` };
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    return { error: `${MANIFEST} is not valid JSON (${error.message})` };
  }
  const problem = manifestProblem(manifest);
  return problem ? { error: `${MANIFEST}: ${problem}` } : { manifest };
}

// ---- Folder walk -----------------------------------------------------------------

// Never follows symlinks: they are reported, and sized as the link itself.
function walk(dir) {
  const out = { bytes: 0, files: 0, newestMtimeMs: 0, entries: [], truncated: false };
  const visit = (abs, rel, depth) => {
    let names;
    try {
      names = fs.readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (out.entries.length >= WALK_ENTRIES || depth > WALK_DEPTH) {
        out.truncated = true;
        return;
      }
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let stat;
      try {
        stat = fs.lstatSync(childAbs);
      } catch {
        continue;
      }
      out.entries.push({ rel: childRel, abs: childAbs, stat });
      if (stat.isDirectory()) {
        visit(childAbs, childRel, depth + 1);
        continue;
      }
      out.bytes += stat.size;
      if (stat.isFile()) {
        out.files += 1;
        out.newestMtimeMs = Math.max(out.newestMtimeMs, stat.mtimeMs);
      }
    }
  };
  visit(dir, "", 0);
  return out;
}

// Effective updatedAt: the later of the manifest's claim and the newest file,
// so a data.json rewrite counts even when nobody touched the manifest.
function describe(slug, manifest, tree = walk(artifactDir(slug))) {
  const claimed = manifest.updatedAt ? Date.parse(manifest.updatedAt) : 0;
  return {
    slug,
    title: manifest.title,
    description: manifest.description || "",
    project: manifest.project || "",
    updatedAt: Math.round(Math.max(claimed, tree.newestMtimeMs)),
    bytes: tree.bytes,
    files: tree.files,
    url: artifactPath(slug),
  };
}

function slugFolders() {
  let entries;
  try {
    entries = fs.readdirSync(config.artifactsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory() && validSlug(entry.name)).map((entry) => entry.name);
}

// Folders without a valid manifest are skipped; `check` explains why.
function listArtifacts() {
  const out = [];
  for (const slug of slugFolders()) {
    const { manifest } = readManifest(slug);
    if (manifest) out.push(describe(slug, manifest));
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt || a.slug.localeCompare(b.slug));
}

// ---- Served files ----------------------------------------------------------------

// `segments` are decoded URL path segments below the slug; empty means the
// entry. Resolves null for anything that must not be served.
async function resolveServed(slug, segments) {
  const { manifest } = readManifest(slug);
  if (!manifest) return null;
  const wanted = segments.length ? segments : (manifest.entry || "index.html").split("/");
  if (!wanted.every(servableSegment) || !allowedType(wanted.at(-1))) return null;
  try {
    const rootReal = await fs.promises.realpath(artifactDir(slug));
    const real = await fs.promises.realpath(path.join(rootReal, ...wanted));
    // A symlink may land inside the folder yet on a dotfile or other type.
    if (!isInside(rootReal, real) || !allowedType(real)) return null;
    if (!path.relative(rootReal, real).split(path.sep).every(servableSegment)) return null;
    const stat = await fs.promises.stat(real);
    if (!stat.isFile()) return null;
    return { filePath: real, stat, contentType: MIME[path.extname(wanted.at(-1)).toLowerCase()] };
  } catch {
    return null;
  }
}

// ---- Writes ------------------------------------------------------------------------

function writeFileAtomic(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

function touchArtifact(slug) {
  if (!validSlug(slug)) throw codedError("EBADSLUG", `invalid slug: ${slug}`);
  const { manifest, error } = readManifest(slug);
  if (!manifest) throw codedError("EBADMANIFEST", error);
  manifest.updatedAt = new Date().toISOString();
  writeFileAtomic(path.join(artifactDir(slug), MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

module.exports = {
  SLUG, MANIFEST, SIZE_CAP, MIME,
  validSlug, artifactDir, isInside, allowedType, servableSegment,
  readKey, capFor, capMatches, artifactPath,
  manifestProblem, readManifest, walk, describe, listArtifacts,
  resolveServed, writeFileAtomic, touchArtifact,
};
