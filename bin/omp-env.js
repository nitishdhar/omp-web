#!/usr/bin/env node
"use strict";
// Pane-side half of "Keys passed to OMP". A pane command runs
//   eval "$(node bin/omp-env.js VAR...)"
// before omp, so the values reach omp's environment through this process's
// stdout and the shell's own `export` builtin: never argv (ps), never a tmux
// command or option, never a file or the pane's history. argv carries only
// variable names. Stdout is shell code and nothing else; problems go to
// stderr, which the pane shows as one line per variable.
const { resolveOmpEnv, VAR } = require("../api/omp-env");

function singleQuoted(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function main() {
  const names = process.argv.slice(2).filter((name) => VAR.test(name));
  if (!names.length) return;
  const { env, missing } = await resolveOmpEnv(names);
  for (const line of missing) process.stderr.write(`omp-web: ${line}\n`);
  const lines = [];
  for (const [name, value] of Object.entries(env)) {
    // Stored values are single-line (api/credentials.js); anything else could
    // end the export early, so it is skipped rather than emitted.
    if (/[\r\n\0]/.test(value)) {
      process.stderr.write(`omp-web: ${name} not passed to omp: value is not a single line\n`);
      continue;
    }
    lines.push(`export ${name}=${singleQuoted(value)}`);
  }
  if (lines.length) process.stdout.write(lines.join("\n") + "\n");
}

main().catch((error) => {
  // Launch proceeds without the variables; the reason never holds a value.
  process.stderr.write(`omp-web: keys for omp not resolved: ${error.message}\n`);
});
