"use strict";
// Where credential values live. Each store reads, writes and deletes one value
// by credential name; api/credentials.js owns the metadata and validation.
// Errors name the credential and the store, never the value.
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const config = require("../config");

const CREDENTIALS_FILE = config.credentialsFile;
const KEYCHAIN_SERVICE = "omp-web";
const SECURITY_BIN = "/usr/bin/security";
const SECURITY_TIMEOUT_MS = 10_000;
// `security -i` reads commands into a 4096-byte line buffer and silently
// stores a truncated password past it, so a keychain value must fit with the
// command around it.
const KEYCHAIN_LINE_LIMIT = 4000;
// Never a valid credential name (names start with [a-z0-9]), so the probe can
// not clobber a real item.
const PROBE_ACCOUNT = ".probe";

function storeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ---- file: OMP_WEB_HOME/credentials.json, 0600, re-read on every call ----

function readFileStore() {
  let text;
  try {
    text = fs.readFileSync(CREDENTIALS_FILE, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw storeError("ECREDENTIALSTORE", `credentials file unreadable (${error.code || "error"})`);
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through: never echo file contents in the error */
  }
  throw storeError("ECREDENTIALSTORE", "credentials file is not a JSON object");
}

// Serialized for the same reason as settings-store: two concurrent writes must
// not each drop the other's change.
let fileWrites = Promise.resolve();

function updateFileStore(mutate) {
  const run = fileWrites.catch(() => {}).then(async () => {
    const next = readFileStore();
    mutate(next);
    await fs.promises.mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true, mode: 0o700 });
    const temp = `${CREDENTIALS_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await fs.promises.rename(temp, CREDENTIALS_FILE);
  });
  fileWrites = run;
  return run;
}

const fileStore = {
  async read(name) {
    const value = readFileStore()[name];
    return typeof value === "string" && value ? value : null;
  },
  write(name, value) {
    return updateFileStore((all) => { all[name] = value; });
  },
  remove(name) {
    return updateFileStore((all) => { delete all[name]; });
  },
};

// ---- keychain: macOS login keychain via /usr/bin/security ----

function security(args, input) {
  return new Promise((resolve) => {
    const child = childProcess.execFile(
      SECURITY_BIN,
      args,
      { timeout: SECURITY_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
          // A keychain that wants a GUI prompt it cannot show may just hang.
          timedOut: Boolean(error && error.killed),
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      },
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

// security's own messages carry the failure ("User interaction is not
// allowed.") and never the password: it is only on stdin or stdout.
function securityReason(result) {
  const line = result.stderr.split("\n").map((part) => part.trim()).find(Boolean) || "";
  if (result.timedOut) return `the keychain did not answer within ${SECURITY_TIMEOUT_MS / 1000} s`;
  return line.replace(/^security:\s*/, "") || `security exited ${result.code}`;
}

function quoteForSecurity(text) {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function addCommand(account, value) {
  return `add-generic-password -U -s ${quoteForSecurity(KEYCHAIN_SERVICE)} -a ${quoteForSecurity(account)} -w ${quoteForSecurity(value)}\n`;
}

async function keychainRead(account) {
  const result = await security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"]);
  // 44 = errSecItemNotFound.
  if (result.code === 44) return null;
  if (result.code !== 0) throw storeError("ECREDENTIALSTORE", `keychain read failed: ${securityReason(result)}`);
  return result.stdout.replace(/\n$/, "");
}

async function keychainWrite(account, value) {
  const command = addCommand(account, value);
  if (Buffer.byteLength(command) > KEYCHAIN_LINE_LIMIT) {
    throw storeError("EBADCREDENTIAL", "value is too long for the keychain store; use the file store");
  }
  // The value travels on stdin, never in argv where `ps` would show it.
  const result = await security(["-i"], command);
  if (result.code !== 0) throw storeError("ECREDENTIALSTORE", `keychain write failed: ${securityReason(result)}`);
  // `security -i` exits 0 on some partial writes; a read-back proves the item.
  if ((await keychainRead(account)) !== value) {
    throw storeError("ECREDENTIALSTORE", "keychain did not store the value verbatim");
  }
}

async function keychainRemove(account) {
  const result = await security(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account]);
  if (result.code !== 0 && result.code !== 44) {
    throw storeError("ECREDENTIALSTORE", `keychain delete failed: ${securityReason(result)}`);
  }
}

// A LaunchAgent in a Background session gets "User interaction is not
// allowed" from the keychain while a terminal-launched server works, so
// availability is probed once per process with a throwaway item.
let probe = null;

function probeKeychain() {
  if (process.platform !== "darwin") {
    return Promise.resolve({ available: false, reason: "the keychain store is macOS only" });
  }
  if (!probe) {
    probe = (async () => {
      const marker = crypto.randomBytes(12).toString("hex");
      try {
        await keychainWrite(PROBE_ACCOUNT, marker);
        return { available: true };
      } catch (error) {
        return { available: false, reason: error.message };
      } finally {
        await keychainRemove(PROBE_ACCOUNT).catch(() => {});
      }
    })();
  }
  return probe;
}

const keychainStore = {
  read: keychainRead,
  write: keychainWrite,
  remove: keychainRemove,
};

const WRITABLE = { file: fileStore, keychain: keychainStore };

async function listStores() {
  const keychain = await probeKeychain();
  return [{ id: "file", available: true }, { id: "keychain", ...keychain }];
}

async function requireAvailable(store) {
  if (store !== "keychain") return;
  const keychain = await probeKeychain();
  if (!keychain.available) {
    throw storeError("ESTOREUNAVAILABLE", `keychain store unavailable: ${keychain.reason}`);
  }
}

module.exports = { WRITABLE, CREDENTIALS_FILE, listStores, requireAvailable, probeKeychain };
