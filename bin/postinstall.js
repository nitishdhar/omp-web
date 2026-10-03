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

// node-pty ships prebuilt binaries for macOS only; everywhere else its own
// install step compiles it with node-gyp. A build that "succeeded" can still
// fail to load (missing toolchain pieces, a Node ABI change), which otherwise
// surfaces much later as every session failing to open. Report it here in one
// line naming the tools (bin/omp-web.js doctor says the same), never failing
// the install from this script.
function checkNodePty() {
  try {
    require("node-pty");
  } catch (error) {
    const reason = String(error && error.message || error).split("\n")[0];
    console.error(`omp-web: node-pty failed to load (${reason}) — it needs a C++ toolchain `
      + "when no prebuilt binary fits: Linux build-essential and python3 (or your distro's "
      + "equivalent), macOS Xcode Command Line Tools (`xcode-select --install`); install "
      + "them, then rerun the install.");
  }
}

fixSpawnHelpers();
checkNodePty();
installLinks();
