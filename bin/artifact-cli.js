"use strict";
// `omp-web artifact ...`: what agents (and the bundled skill) use to create,
// find, link and validate artifacts. Paths and links come from config.js, so
// OMP_WEB_HOME and its env overlay apply exactly as they do for the server.
const fs = require("fs");
const path = require("path");
const config = require("../config");
const store = require("../api/artifact-store");
const { checkArtifact } = require("../api/artifact-check");

const TEMPLATES_DIR = path.join(__dirname, "..", "artifact-templates");
const TEMPLATES = ["list", "table", "cards", "blank"];

const USAGE = `Usage: omp-web artifact new <slug> --title TITLE [--description TEXT] [--project DIR] [--template list|table|cards|blank]
       omp-web artifact list [--json]
       omp-web artifact path <slug>
       omp-web artifact url <slug>
       omp-web artifact check <slug>
       omp-web artifact touch <slug>

Artifacts live in ${config.artifactsDir}.
Links use OMP_WEB_PUBLIC_URL when set, else http://127.0.0.1:<port>.`;

function codedError(message) {
  const error = new Error(message);
  error.code = "EUSAGE";
  return error;
}

// Accepts `--name value` and `--name=value`; everything else is positional.
function parseArgs(args, valued, flags = []) {
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (flags.includes(name) && eq < 0) {
      options[name] = true;
    } else if (valued.includes(name)) {
      const value = eq < 0 ? args[++index] : arg.slice(eq + 1);
      if (value === undefined) throw codedError(`--${name} needs a value`);
      options[name] = value;
    } else {
      throw codedError(`unknown option ${arg}`);
    }
  }
  return { options, positional };
}

function baseUrl() {
  if (!config.publicUrl) return `http://127.0.0.1:${config.port}`;
  let parsed;
  try {
    parsed = new URL(config.publicUrl);
  } catch {
    throw codedError("OMP_WEB_PUBLIC_URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw codedError("OMP_WEB_PUBLIC_URL must be an http(s) URL");
  }
  return config.publicUrl;
}

function absoluteUrl(slug) {
  return baseUrl() + store.artifactPath(slug);
}

function oneSlug(positional, command) {
  if (positional.length !== 1) throw codedError(`usage: omp-web artifact ${command} <slug>`);
  const [slug] = positional;
  if (!store.validSlug(slug)) throw codedError(`invalid slug "${slug}" (lowercase letters, digits and dashes, at most 40)`);
  return slug;
}

function existingSlug(positional, command) {
  const slug = oneSlug(positional, command);
  try {
    if (!fs.statSync(store.artifactDir(slug)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw codedError(`no artifact named ${slug} (see omp-web artifact list)`);
  }
  return slug;
}

function relativeAge(ms) {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function create(args) {
  const { options, positional } = parseArgs(args, ["title", "description", "project", "template"]);
  const slug = oneSlug(positional, "new");
  const template = options.template || "list";
  if (!TEMPLATES.includes(template)) throw codedError(`unknown template ${template} (${TEMPLATES.join(", ")})`);
  const manifest = { title: (options.title || "").trim() };
  if (options.description) manifest.description = options.description;
  if (options.project) {
    manifest.project = path.resolve(options.project);
    let isDir = false;
    try { isDir = fs.statSync(manifest.project).isDirectory(); } catch { /* reported below */ }
    if (!isDir) throw codedError(`project folder does not exist: ${manifest.project}`);
  }
  const now = new Date().toISOString();
  manifest.updatedAt = now;
  const problem = store.manifestProblem(manifest);
  if (problem) throw codedError(problem === "title is required" ? "--title is required" : problem);

  const dir = store.artifactDir(slug);
  fs.mkdirSync(config.artifactsDir, { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") throw codedError(`artifact ${slug} already exists at ${dir}; update it instead`);
    throw error;
  }
  const source = path.join(TEMPLATES_DIR, template);
  fs.cpSync(source, dir, { recursive: true, filter: (from) => path.basename(from) !== "data.json" });
  const data = JSON.parse(fs.readFileSync(path.join(source, "data.json"), "utf8"));
  data.title = manifest.title;
  data.updatedAt = now;
  store.writeFileAtomic(path.join(dir, "data.json"), JSON.stringify(data, null, 2) + "\n");
  // Written last: list skips a folder until its manifest exists.
  store.writeFileAtomic(path.join(dir, store.MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  console.log(dir);
  console.log(absoluteUrl(slug));
}

function list(args) {
  const { options, positional } = parseArgs(args, [], ["json"]);
  if (positional.length) throw codedError("usage: omp-web artifact list [--json]");
  const base = baseUrl();
  const artifacts = store.listArtifacts().map((artifact) => ({
    ...artifact,
    url: base + artifact.url,
    path: store.artifactDir(artifact.slug),
  }));
  if (options.json) {
    console.log(JSON.stringify({ artifacts }, null, 2));
    return;
  }
  if (!artifacts.length) {
    console.log(`No artifacts yet. Create one with: omp-web artifact new <slug> --title "..."`);
    return;
  }
  for (const artifact of artifacts) {
    console.log(`${artifact.slug}\t${artifact.title}\tupdated ${relativeAge(artifact.updatedAt)}\t${artifact.url}`);
  }
}

function check(args) {
  const { positional } = parseArgs(args, []);
  const slug = oneSlug(positional, "check");
  const results = checkArtifact(slug);
  for (const { level, message } of results) console.log(`${level}: ${message}`);
  const errors = results.filter((result) => result.level === "error").length;
  const warnings = results.filter((result) => result.level === "warn").length;
  console.log(errors ? `${slug}: ${errors} error(s), ${warnings} warning(s)` : `${slug}: ok${warnings ? ` with ${warnings} warning(s)` : ""}`);
  if (errors) process.exitCode = 1;
}

function runArtifact(args) {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case "new": return create(rest);
      case "list": return list(rest);
      case "path": return console.log(store.artifactDir(existingSlug(parseArgs(rest, []).positional, "path")));
      case "url": return console.log(absoluteUrl(existingSlug(parseArgs(rest, []).positional, "url")));
      case "check": return check(rest);
      case "touch": {
        const slug = existingSlug(parseArgs(rest, []).positional, "touch");
        console.log(`${slug} updatedAt ${store.touchArtifact(slug).updatedAt}`);
        return undefined;
      }
      case undefined: case "-h": case "--help": case "help":
        return console.log(USAGE);
      default:
        throw codedError(`unknown artifact command: ${command}\n${USAGE}`);
    }
  } catch (error) {
    console.error(`omp-web: ${error.message}`);
    process.exitCode = 1;
    return undefined;
  }
}

module.exports = { runArtifact };
