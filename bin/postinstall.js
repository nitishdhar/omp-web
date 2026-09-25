#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function isMissing(error) {
  return error && error.code === "ENOENT";
}

const packageRoot = path.dirname(require.resolve("node-pty/package.json"));
const prebuilds = path.join(packageRoot, "prebuilds");
let targets;
try {
  targets = fs.readdirSync(prebuilds, { withFileTypes: true });
} catch (error) {
  if (isMissing(error)) process.exit(0);
  throw error;
}

for (const target of targets) {
  if (!target.isDirectory()) continue;
  const helper = path.join(prebuilds, target.name, "spawn-helper");
  let stat;
  try {
    stat = fs.statSync(helper);
  } catch (error) {
    if (isMissing(error)) continue;
    throw error;
  }
  fs.chmodSync(helper, stat.mode | 0o111);
}
