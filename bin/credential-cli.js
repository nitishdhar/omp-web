"use strict";
// `omp-web credential list|set|import|rm`: manage omp-web's named secrets with
// the same modules as the server, so it works while the server is down and a
// running server sees the change on its next request. Values come from stdin
// or a one-time import, never from argv, so they stay out of `ps` and shell
// history.
const fs = require("fs");
const { listCredentials, putCredential, deleteCredential } = require("../api/credentials");

const USAGE = `usage: omp-web credential list [--json]
       <command printing the value> | omp-web credential set <name> [--label L] [--store file|keychain]
       omp-web credential import <name> (--env VAR | --file PATH [--key KEY]) [--label L] [--store file|keychain]
       omp-web credential rm <name>`;

function usageError(message) {
  return new Error(message ? `${message}\n${USAGE}` : USAGE);
}

function parseOptions(args, allowed) {
  const [name, ...rest] = args;
  if (!name || name.startsWith("-")) throw usageError("a credential name is required");
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!allowed.includes(flag)) throw usageError(`unknown option: ${flag}`);
    if (rest[index + 1] === undefined) throw usageError(`${flag} needs a value`);
    options[flag.slice(2)] = rest[index + 1];
  }
  return { name, options };
}

function singleLine(text, source) {
  if (!text) throw new Error(`${source} is empty`);
  if (/[\r\n]/.test(text)) throw new Error(`${source} must be one line`);
  return text;
}

async function readStdinValue() {
  if (process.stdin.isTTY) {
    throw usageError("pipe the value on stdin (it is never read from arguments or echoed)");
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return singleLine(Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, ""), "the value on stdin");
}

// One-time copy: once stored, the variable or file is no longer needed.
function importValue(options) {
  if ((options.env === undefined) === (options.file === undefined)) throw usageError("give exactly one of --env or --file");
  if (options.env !== undefined) {
    if (options.key !== undefined) throw usageError("--key goes with --file");
    return singleLine(process.env[options.env] || "", `environment variable ${options.env}`);
  }
  const text = fs.readFileSync(options.file, "utf8");
  if (options.key === undefined) return singleLine(text.trim(), options.file);
  // KEY=value, as in an env file; the last assignment wins like a shell's.
  let found;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (match && match[1] === options.key) found = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  if (found === undefined) throw new Error(`${options.key} not found in ${options.file}`);
  return singleLine(found, `${options.key} in ${options.file}`);
}

function printList(result) {
  if (!result.credentials.length) {
    console.log("No credentials. Add one with `omp-web credential set <name>` or in Settings → Credentials.");
  }
  for (const item of result.credentials) {
    const used = item.usedBy.length ? `used by ${item.usedBy.map((user) => user.label).join(", ")}` : "unused";
    console.log([item.name, `"${item.label}"`, item.store, item.hint && `…${item.hint}`, used, item.updatedAt].filter(Boolean).join("  "));
  }
  const keychain = result.stores.find((store) => store.id === "keychain");
  if (keychain && !keychain.available) console.log(`\nkeychain store unavailable here: ${keychain.reason}`);
}

async function save(name, options, value) {
  // The keychain answers this terminal session, but a server started by a
  // background service (LaunchAgent) may be refused it; Settings →
  // Credentials shows whether the running server can read it.
  if (options.store === "keychain" && process.platform === "darwin") {
    console.error("omp-web: note: a server running as a background service may not be able to read the keychain; check Settings → Credentials");
  }
  const item = await putCredential(name, { label: options.label, store: options.store, value });
  console.log(`saved ${item.name} (${item.store}${item.hint ? `, …${item.hint}` : ""})`);
}

async function runCredential(args) {
  const [command, ...rest] = args;
  try {
    if (command === "list") {
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--json")) throw usageError();
      const result = await listCredentials();
      if (rest[0] === "--json") console.log(JSON.stringify(result, null, 2));
      else printList(result);
    } else if (command === "set") {
      const { name, options } = parseOptions(rest, ["--label", "--store"]);
      await save(name, options, await readStdinValue());
    } else if (command === "import") {
      const { name, options } = parseOptions(rest, ["--env", "--file", "--key", "--label", "--store"]);
      await save(name, options, importValue(options));
    } else if (command === "rm") {
      if (rest.length !== 1) throw usageError("rm needs exactly one credential name");
      await deleteCredential(rest[0]);
      console.log(`removed ${rest[0]}`);
    } else if (command === "-h" || command === "--help" || command === "help") {
      console.log(USAGE);
    } else {
      throw usageError(command ? `unknown credential command: ${command}` : "");
    }
  } catch (error) {
    // fs errors carry the path, never file contents.
    console.error(`omp-web: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { runCredential };
