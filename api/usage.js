"use strict";

const { execFile } = require("child_process");
const { promisify } = require("util");
const config = require("../config");
const { listProfiles } = require("./util");
const { withOmpCredentials } = require("./omp-env");

const execFileAsync = promisify(execFile);
const CACHE_MS = 60_000;
const MAX_PROFILES = 16;
const MAX_PROVIDERS = 32;
const MAX_ACCOUNTS_PER_PROVIDER = 16;
const MAX_LIMITS_PER_ACCOUNT = 32;
const MAX_NOTES_PER_ACCOUNT = 16;
const MAX_ID_LENGTH = 96;
const IDENTITY_KEYS = ["accountId", "orgId", "email", "subject", "userId", "id"];
const MAX_TEXT_LENGTH = 240;


let cached = null;
let loading = null;

function boundedString(value, maximum = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maximum);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentage(value) {
  const numeric = finiteNumber(value);
  if (numeric == null) return null;
  return Math.round(Math.max(0, Math.min(1, numeric)) * 100);
}


function timestamp(value) {
  const date = typeof value === "number"
    ? new Date(value)
    : typeof value === "string"
      ? new Date(value)
      : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function firstString(source, keys, maximum) {
  for (const key of keys) {
    const value = boundedString(source[key], maximum);
    if (value) return value;
  }
  return "";
}

function firstNumber(source, keys) {
  for (const key of keys) {
    const value = finiteNumber(source[key]);
    if (value != null) return value;
  }
  return null;
}

function normalizeLimit(source, index) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const amount = source.amount && typeof source.amount === "object" && !Array.isArray(source.amount)
    ? source.amount
    : {};
  const window = source.window && typeof source.window === "object" && !Array.isArray(source.window)
    ? source.window
    : {};

  const id = firstString(source, ["id"], MAX_ID_LENGTH) || `limit-${index + 1}`;
  const label = firstString(source, ["label"], MAX_TEXT_LENGTH) || id;
  const used = firstNumber(amount, ["used"]);
  const limit = firstNumber(amount, ["limit"]);
  const remaining = firstNumber(amount, ["remaining"]);
  let usedPercent = percentage(amount.usedFraction);
  if (usedPercent == null && used != null && limit != null && limit > 0) {
    usedPercent = Math.round(Math.max(0, Math.min(100, (used / limit) * 100)));
  }

  let remainingPercent = percentage(amount.remainingFraction);
  if (remainingPercent == null && remaining != null && limit != null && limit > 0) {
    remainingPercent = Math.round(Math.max(0, Math.min(100, (remaining / limit) * 100)));
  }
  if (remainingPercent == null && usedPercent != null) remainingPercent = 100 - usedPercent;

  return {
    id,
    label,
    usedPercent,
    remainingPercent,
    unit: firstString(amount, ["unit"], MAX_ID_LENGTH),
    used,
    limit,
    remaining,
    resetAt: timestamp(window.resetsAt),
    status: firstString(source, ["status"], MAX_ID_LENGTH),
  };
}

function normalizeNotes(source) {
  if (!Array.isArray(source)) return [];
  const notes = [];
  for (const raw of source) {
    const note = boundedString(raw);
    if (note) notes.push(note);
    if (notes.length >= MAX_NOTES_PER_ACCOUNT) break;
  }
  return notes;
}

// Identity comes from redacted native metadata so the same credential seen
// through several profiles collapses to one account. These values are used as
// map keys only; they never reach the browser.
function accountIdentity(source, limits) {
  const metadata = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
    ? source.metadata
    : {};
  const parts = [];
  for (const key of IDENTITY_KEYS) {
    const value = metadata[key];
    if (typeof value === "string" || typeof value === "number") {
      parts.push(`${key}=${String(value).slice(0, MAX_ID_LENGTH)}`);
    }
  }
  if (parts.length) return parts.join("\u0000");
  // No identifying metadata: window ids are stable across profiles, unlike the
  // drifting used/reset amounts each profile fetches independently.
  return `limits=${limits.map((limit) => limit.id).sort().join(",")}`;
}

function normalizeReport(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const provider = boundedString(source.provider, MAX_ID_LENGTH);
  if (!provider) return null;

  const limits = [];
  if (Array.isArray(source.limits)) {
    for (const raw of source.limits) {
      const limit = normalizeLimit(raw, limits.length);
      if (limit) limits.push(limit);
      if (limits.length >= MAX_LIMITS_PER_ACCOUNT) break;
    }
  }

  return {
    provider,
    identity: accountIdentity(source, limits),
    fetchedAt: finiteNumber(source.fetchedAt) || 0,
    account: { limits, notes: normalizeNotes(source.notes) },
  };
}

function normalize(payloads) {
  const providerMap = new Map();
  const accountsByIdentity = new Map();
  let generatedAt = null;

  for (const payload of payloads) {
    const generated = timestamp(payload.generatedAt) || timestamp(payload.fetchedAt);
    if (generated && (!generatedAt || generated > generatedAt)) generatedAt = generated;
    if (!Array.isArray(payload.reports)) continue;

    for (const raw of payload.reports) {
      const report = normalizeReport(raw);
      if (!report) continue;
      let provider = providerMap.get(report.provider);
      if (!provider) {
        if (providerMap.size >= MAX_PROVIDERS) continue;
        provider = { id: report.provider, accounts: [] };
        providerMap.set(report.provider, provider);
      }

      const key = `${report.provider}\u0000${report.identity}`;
      const known = accountsByIdentity.get(key);
      if (known) {
        // Same credential from another profile: keep the freshest fetch.
        if (report.fetchedAt > known.fetchedAt) {
          provider.accounts[known.index] = report.account;
          known.fetchedAt = report.fetchedAt;
        }
        continue;
      }
      if (provider.accounts.length >= MAX_ACCOUNTS_PER_PROVIDER) continue;
      accountsByIdentity.set(key, { index: provider.accounts.length, fetchedAt: report.fetchedAt });
      provider.accounts.push(report.account);
    }
  }

  return {
    generatedAt,
    providers: [...providerMap.values()],
    unavailable: false,
  };
}

function unavailable() {
  return { generatedAt: null, providers: [], unavailable: true };
}

async function collectProfile(profile) {
  const args = profile === "default"
    ? ["usage", "--json", "--redact"]
    : [`--profile=${profile}`, "usage", "--json", "--redact"];
  try {
    const { stdout } = await execFileAsync(config.ompBin, args, {
      env: await withOmpCredentials(process.env),
      timeout: 10_000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
    });
    const payload = JSON.parse(stdout);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

async function collect() {
  const profiles = listProfiles().slice(0, MAX_PROFILES);
  const payloads = (await Promise.all(profiles.map(collectProfile))).filter(Boolean);
  payloads.sort((left, right) =>
    (Array.isArray(right.reports) ? right.reports.length : 0) -
    (Array.isArray(left.reports) ? left.reports.length : 0));
  return payloads.length ? normalize(payloads) : unavailable();
}

async function getUsage() {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  if (!loading) {
    loading = collect()
      .then((value) => {
        cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => { loading = null; });
  }
  return loading;
}

module.exports = { getUsage };
