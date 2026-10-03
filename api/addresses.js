"use strict";
// Every address this console answers on, and which one absolute links use.
// Shared by the server (Settings, /api/artifacts `link`) and the CLI, which
// must work while the server is down, so nothing here asks the server: it
// reads config (bind host/port), settings.json and the host's network state.
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const config = require("../config");
const { getSetting, setSetting } = require("./settings-store");

const TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const TAILSCALE_TIMEOUT_MS = 3000;
const TAILSCALE_BUFFER = 4 * 1024 * 1024;
const CACHE_MS = 30_000;
const LINK_ORDER = ["public", "tailscale-name", "tailscale-ip", "lan", "local"];
const LABELS = {
  public: "Public address",
  "tailscale-name": "Tailscale name",
  "tailscale-ip": "Tailscale IP",
  lan: "Local network",
  local: "This machine",
};

function settingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// -> normalized origin, or throws EBADSETTING. Paths are refused because every
// omp-web URL (/api, /a/...) is rooted at the origin.
function normalizePublicUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw settingError("EBADSETTING", "public address must be an absolute URL such as https://console.example");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw settingError("EBADSETTING", "public address must start with http:// or https://");
  }
  if (parsed.username || parsed.password) throw settingError("EBADSETTING", "public address must not carry credentials");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw settingError("EBADSETTING", "public address must be an origin only, without a path or query");
  }
  return parsed.origin;
}

// Set only in Settings → General (settings.json `publicUrl`). A hand-edited
// invalid value behaves as unset rather than stopping every link.
function publicUrl() {
  const stored = getSetting("publicUrl");
  if (typeof stored !== "string" || !stored) return "";
  try {
    return normalizePublicUrl(stored);
  } catch {
    return "";
  }
}

async function setPublicUrl(input) {
  if (input !== null && typeof input !== "string") throw settingError("EBADSETTING", "publicUrl must be a string");
  const raw = (input || "").trim();
  await setSetting("publicUrl", raw ? normalizePublicUrl(raw) : undefined);
}

// ---- Tailscale ---------------------------------------------------------------

function executableOnPath(name) {
  for (const dir of (process.env.PATH || "").split(":").filter(Boolean)) {
    const candidate = `${dir}/${name}`;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return "";
}

// The macOS app ships its CLI inside the bundle and does not put it on PATH.
function tailscaleBin() {
  const onPath = executableOnPath("tailscale");
  if (onPath) return onPath;
  try {
    fs.accessSync(TAILSCALE_APP, fs.constants.X_OK);
    return TAILSCALE_APP;
  } catch {
    return "";
  }
}

// -> { name, ip } (either may be ""), or null when Tailscale is absent, logged
// out or stopped. Never rejects.
function probeTailscale() {
  const bin = tailscaleBin();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    // The macOS app binary only acts as the CLI when told to; under launchd
    // (no terminal) it otherwise starts as a background helper and never
    // answers. Harmless for the plain `tailscale` CLI.
    childProcess.execFile(bin, ["status", "--json"], {
      timeout: TAILSCALE_TIMEOUT_MS,
      maxBuffer: TAILSCALE_BUFFER,
      encoding: "utf8",
      env: { ...process.env, TAILSCALE_BE_CLI: "1" },
    }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const status = JSON.parse(stdout);
        if (status?.BackendState !== "Running" || !status.Self) return resolve(null);
        const name = typeof status.Self.DNSName === "string" ? status.Self.DNSName.replace(/\.$/, "") : "";
        const ips = Array.isArray(status.Self.TailscaleIPs) ? status.Self.TailscaleIPs : [];
        const ip = ips.find((value) => typeof value === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(value)) || "";
        resolve(name || ip ? { name, ip } : null);
      } catch {
        resolve(null);
      }
    });
  });
}

// Shared so a burst of /api/artifacts calls runs one probe, not one each.
let tailscaleCache = null; // { at, promise }

function tailscale() {
  if (!tailscaleCache || Date.now() - tailscaleCache.at > CACHE_MS) {
    tailscaleCache = { at: Date.now(), promise: probeTailscale() };
  }
  return tailscaleCache.promise;
}

// ---- Local network -------------------------------------------------------------

// 100.64/10 is carrier-grade NAT space, which is where Tailscale lives;
// it is never the address a phone on the same Wi-Fi would use.
function isCgnat(ip) {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

function lanIPv4s(exclude) {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      if (entry.internal || exclude.has(entry.address) || isCgnat(entry.address)) continue;
      out.push(entry.address);
    }
  }
  return out;
}

// macOS always answers its Bonjour <name>.local; elsewhere mDNS is optional,
// so an IP is the dependable choice.
function lanHost(lanIps) {
  if (process.platform === "darwin") {
    const short = os.hostname().replace(/\.local$/i, "").split(".")[0];
    if (short) return `${short.toLowerCase()}.local`;
  }
  return lanIps[0] || "";
}

// ---- Bind ----------------------------------------------------------------------

function bindKind(host) {
  const value = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!value || value === "0.0.0.0" || value === "::") return "all";
  if (value === "localhost" || value === "::1" || /^127\./.test(value)) return "loopback";
  return "specific";
}

function origin(host) {
  return `http://${host}:${config.port}`;
}

// -> [{kind, url, label, reachable}] in link order.
async function listAddresses() {
  const host = String(config.host || "").trim().toLowerCase();
  const bind = bindKind(host);
  const out = [];
  const add = (kind, url, reachable) => out.push({ kind, url, label: LABELS[kind], reachable });

  // Someone else (a reverse proxy, Tailscale Serve) routes the public address
  // to this server, so the bind says nothing about it: the operator vouched.
  const pub = publicUrl();
  if (pub) add("public", pub, true);

  const ts = await tailscale();
  const tsIp = ts?.ip || "";
  // The name resolves to the Tailscale IP, so binding that IP serves it too.
  if (ts?.name) {
    add("tailscale-name", origin(ts.name), bind === "all" || host === tsIp || host === ts.name.toLowerCase());
  }
  if (tsIp) add("tailscale-ip", origin(tsIp), bind === "all" || host === tsIp);

  const lanIps = lanIPv4s(new Set(tsIp ? [tsIp] : []));
  // Bound to one LAN address: name that address, not a name that may resolve
  // to another interface.
  const lan = bind === "specific" && lanIps.includes(host) ? host : lanHost(lanIps);
  if (lan) add("lan", origin(lan), bind === "all" || host === lan);

  add("local", origin("127.0.0.1"), bind !== "specific");
  return out;
}

function pickLink(addresses) {
  for (const kind of LINK_ORDER) {
    const hit = addresses.find((address) => address.kind === kind && address.reachable);
    if (hit) return hit.url;
  }
  // Bound to a specific address none of the probes recognised (e.g. a
  // hostname): that bind is still the one address known to answer.
  return origin(config.host);
}

async function linkBase() {
  return pickLink(await listAddresses());
}

async function addressesStatus() {
  const addresses = await listAddresses();
  return {
    addresses,
    linkBase: pickLink(addresses),
    publicUrl: publicUrl(),
  };
}

async function setAddresses(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !("publicUrl" in input)) {
    throw settingError("EBADSETTING", "expected {publicUrl}");
  }
  await setPublicUrl(input.publicUrl);
  return addressesStatus();
}

module.exports = { listAddresses, linkBase, addressesStatus, setAddresses };
