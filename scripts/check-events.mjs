#!/usr/bin/env node
// An emitted event with no get() subscriber fails silently — that shipped twice
// (the folder "New session here" and ghost "Forget" menu items both did
// nothing). This makes it a check instead of a bug report.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const jsRoot = join(root, "public", "js");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

function collect(source, file, re, into) {
  for (const match of source.matchAll(re)) {
    const line = source.slice(0, match.index).split("\n").length;
    const at = `${relative(root, file)}:${line}`;
    const hits = into.get(match[1]) || [];
    hits.push(at);
    into.set(match[1], hits);
  }
}

const emitted = new Map();
const subscribed = new Map();
for (const file of walk(jsRoot)) {
  const source = readFileSync(file, "utf8");
  // Bare calls only: `headers.get("content-type")` and `params.get("v")` are
  // not event subscriptions.
  collect(source, file, /(?<![.\w])emit\(\s*"([^"]+)"/g, emitted);
  collect(source, file, /(?<![.\w])get\(\s*"([^"]+)"/g, subscribed);
}

const unheard = [...emitted.keys()].filter((name) => !subscribed.has(name)).sort();
const unsent = [...subscribed.keys()].filter((name) => !emitted.has(name)).sort();

function report(title, names, sources) {
  if (!names.length) return;
  console.error(`\n${title}`);
  for (const name of names) console.error(`  ${name}\n    ${sources.get(name).join("\n    ")}`);
}

report("emitted but never subscribed:", unheard, emitted);
report("subscribed but never emitted:", unsent, subscribed);

if (unheard.length || unsent.length) process.exit(1);
console.log(`events ok: ${emitted.size} emitted, ${subscribed.size} subscribed`);
