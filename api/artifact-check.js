"use strict";
// `omp-web artifact check <slug>`: everything the server would refuse or the
// CSP would block, found before a user opens a broken link. Errors are what
// stops the page working (or leaks outside the folder); warnings are likely
// mistakes the server tolerates.
const fs = require("fs");
const path = require("path");
const store = require("./artifact-store");

const SCANNED = new Set([".html", ".htm", ".css", ".js", ".mjs"]);
const SCAN_LIMIT = 2 * 1024 * 1024;
// Absolute http(s) URLs anywhere, and protocol-relative "//host.tld" right
// after a quote, "(" or "=" (where a URL sits), which skips most `//` comments.
const EXTERNAL = /\bhttps?:\/\/[^\s"'`)<>]+|(?<=["'(=]\s*)\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s"'`)<>]*/gi;
// XML namespace identifiers look like URLs but are never fetched.
const NAMESPACE = /^https?:\/\/www\.w3\.org\//i;

function megabytes(bytes) {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function externalReferences(text) {
  const found = new Set();
  for (const match of text.matchAll(EXTERNAL)) {
    if (!NAMESPACE.test(match[0])) found.add(match[0]);
    if (found.size >= 3) break;
  }
  return [...found];
}

// -> [{level: "ok"|"warn"|"error", message}]
function checkArtifact(slug) {
  const results = [];
  const ok = (message) => results.push({ level: "ok", message });
  const warn = (message) => results.push({ level: "warn", message });
  const error = (message) => results.push({ level: "error", message });

  if (!store.validSlug(slug)) {
    error(`invalid slug "${slug}" (lowercase letters, digits and dashes, at most 40)`);
    return results;
  }
  const dir = store.artifactDir(slug);
  let rootReal;
  try {
    rootReal = fs.realpathSync(dir);
    if (!fs.statSync(rootReal).isDirectory()) throw new Error("not a directory");
  } catch {
    error(`no artifact folder at ${dir}`);
    return results;
  }

  const { manifest, error: manifestError } = store.readManifest(slug);
  if (manifest) ok(`${store.MANIFEST} valid ("${manifest.title}")`);
  else error(manifestError);

  const tree = store.walk(dir);
  if (tree.truncated) warn("folder is too deep or has too many entries; only part of it was checked");
  for (const { rel, abs, stat } of tree.entries) {
    const hidden = rel.split("/").some((segment) => segment.startsWith("."));
    if (stat.isSymbolicLink()) {
      let target = null;
      try {
        target = fs.realpathSync(abs);
      } catch {
        error(`${rel}: broken symlink`);
        continue;
      }
      if (!store.isInside(rootReal, target)) error(`${rel}: symlink escapes the artifact folder`);
      continue;
    }
    if (!stat.isFile()) continue;
    if (hidden) {
      warn(`${rel}: dotfiles are never served`);
      continue;
    }
    const ext = path.extname(rel).toLowerCase();
    if (!store.allowedType(rel)) {
      error(`${rel}: file type ${ext || "(none)"} is not served`);
      continue;
    }
    // The manifest was already parsed and reported above.
    if (ext === ".json" && rel !== store.MANIFEST) {
      try {
        JSON.parse(fs.readFileSync(abs, "utf8"));
      } catch (parseError) {
        error(`${rel}: invalid JSON (${parseError.message})`);
      }
    } else if (SCANNED.has(ext) && stat.size <= SCAN_LIMIT) {
      const refs = externalReferences(fs.readFileSync(abs, "utf8"));
      if (refs.length) warn(`${rel}: external reference${refs.length > 1 ? "s" : ""} the page cannot load (CSP): ${refs.join(", ")}`);
    }
  }

  if (manifest) {
    const entry = manifest.entry || "index.html";
    const entryPath = path.join(dir, ...entry.split("/"));
    let entryOk = false;
    try {
      const real = fs.realpathSync(entryPath);
      entryOk = store.isInside(rootReal, real) && fs.statSync(real).isFile();
    } catch {
      entryOk = false;
    }
    if (entryOk) ok(`entry ${entry} exists`);
    else error(`entry ${entry} is missing`);
  }

  if (tree.bytes > store.SIZE_CAP) error(`size ${megabytes(tree.bytes)} is over the ${megabytes(store.SIZE_CAP)} cap`);
  else ok(`size ${megabytes(tree.bytes)} in ${tree.files} file${tree.files === 1 ? "" : "s"}`);
  return results;
}

module.exports = { checkArtifact };
