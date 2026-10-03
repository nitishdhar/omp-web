#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function isMissing(error) {
  return error && error.code === "ENOENT";
}

function fixSpawnHelpers() {
  const packageRoot = path.dirname(require.resolve("node-pty/package.json"));
  const prebuilds = path.join(packageRoot, "prebuilds");
  let targets;
  try {
    targets = fs.readdirSync(prebuilds, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
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
}

// Only a global install is "installing omp-web on this machine"; `npm ci` in
// a checkout must not touch the home directory (the server links on start
// instead). Nothing here may fail the install.
function installLinks() {
  if (process.env.npm_config_global !== "true") return;
  try {
    const { ensureInstallLinks, formatResult } = require("../api/install-links");
    for (const entry of ensureInstallLinks()) console.log(formatResult(entry));
  } catch (error) {
    console.log(`omp-web: install links skipped — ${error.message}`);
  }
}

fixSpawnHelpers();
installLinks();
