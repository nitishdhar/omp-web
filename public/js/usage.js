"use strict";

import { api } from "./api.js";
import { el, elem } from "./dom.js";

let refreshVersion = 0;


function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function percent(value) {
  const number = finite(value);
  return number == null ? null : Math.max(0, Math.min(100, number));
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function formatReset(value) {
  if (!value) return "";
  const resetAt = new Date(value);
  if (Number.isNaN(resetAt.getTime())) return "";
  const delta = resetAt.getTime() - Date.now();
  if (delta <= 0) return "resets soon";
  const hours = Math.ceil(delta / 3_600_000);
  return hours < 24 ? `resets in ${hours}h` : `resets in ${Math.ceil(hours / 24)}d`;
}

function usageState(remaining) {
  if (remaining == null || remaining >= 50) return "";
  return remaining >= 20 ? "warning" : "critical";
}

function limitDetails(limit) {
  const used = finite(limit.used);
  const maximum = finite(limit.limit);
  const unit = text(limit.unit);
  const details = [];
  if (used != null && maximum != null) details.push(`Used ${formatNumber(used)} of ${formatNumber(maximum)}${unit ? ` ${unit}` : ""}`);
  else if (used != null) details.push(`Used ${formatNumber(used)}${unit ? ` ${unit}` : ""}`);
  const reset = formatReset(limit.resetAt);
  if (reset) details.push(reset);
  const status = text(limit.status);
  if (status) details.push(status);
  return details;
}

function limitRow(limit, index) {
  const label = text(limit.label, `Usage window ${index + 1}`);
  const remaining = percent(limit.remainingPercent);
  const details = limitDetails(limit);
  const stateClass = usageState(remaining);
  const item = elem("li", { class: "usage-limit" });
  const heading = elem("div", { class: "usage-limit-head" },
    elem("span", { class: "usage-limit-label", text: label }),
  );
  if (remaining != null) heading.append(elem("span", {
    class: "usage-limit-percent",
    text: `${Math.round(remaining)}% remaining`,
  }));
  item.append(heading);
  if (remaining != null) {
    item.append(elem("progress", {
      class: `usage-progress ${stateClass}`.trim(),
      value: remaining,
      max: 100,
      "aria-label": `${label}: ${Math.round(remaining)}% remaining`,
    }));
  }
  if (details.length) item.append(elem("span", { class: "usage-limit-detail", text: details.join(" · ") }));
  return item;
}

function accountCard(account, index) {
  const limits = Array.isArray(account?.limits) ? account.limits : [];
  const notes = Array.isArray(account?.notes)
    ? account.notes.filter((note) => typeof note === "string")
    : [];
  const card = elem("section", {
    class: "usage-account",
    "aria-label": `Account ${index + 1}`,
  }, elem("h4", { class: "usage-account-title", text: `Account ${index + 1}` }));
  if (limits.length) {
    card.append(elem("ul", { class: "usage-limits" }, ...limits.map(limitRow)));
  } else {
    card.append(elem("p", { class: "usage-empty", text: "No limits reported for this account." }));
  }
  if (notes.length) {
    card.append(elem("ul", { class: "usage-notes", "aria-label": `Account ${index + 1} notes` },
      ...notes.map((note) => elem("li", { text: note })),
    ));
  }
  return card;
}

function providerCard(provider) {
  const accounts = Array.isArray(provider?.accounts) ? provider.accounts : [];
  const name = text(provider?.id, "Provider");
  const card = elem("article", { class: "usage-provider" },
    elem("h3", { class: "usage-provider-name", text: name }),
  );
  if (accounts.length) card.append(...accounts.map(accountCard));
  else card.append(elem("p", { class: "usage-empty", text: "No account limits reported." }));
  return card;
}

function setStatus(suffix = "") {
  el["usage-status"].textContent = `All configured providers${suffix ? ` · ${suffix}` : ""}`;
}

function render(snapshot) {
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
  if (snapshot?.unavailable) {
    el["usage-grid"].replaceChildren(elem("p", {
      class: "usage-empty usage-message",
      text: "Subscription usage is unavailable.",
    }));
    setStatus("unavailable");
    return;
  }
  if (!providers.length) {
    el["usage-grid"].replaceChildren(elem("p", {
      class: "usage-empty usage-message",
      text: "No subscription limits reported.",
    }));
    setStatus("no limits");
    return;
  }
  el["usage-grid"].replaceChildren(...providers.map(providerCard));
  setStatus();
}

async function refreshUsage() {
  const version = ++refreshVersion;
  setStatus("updating");
  try {
    const snapshot = await api("/usage");
    if (version !== refreshVersion) return;
    render(snapshot);
  } catch {
    if (version !== refreshVersion) return;
    render({ unavailable: true, providers: [] });
  }
}


function toggle() {
  const open = el["usage-popover"].hidden;
  el["profile-info-popover"].hidden = true;
  el["profile-info-btn"].setAttribute("aria-expanded", "false");
  el["usage-popover"].hidden = !open;
  el["usage-btn"].setAttribute("aria-expanded", String(open));
  if (open) refreshUsage();
}

export function wireUsage() {
  el["usage-btn"].addEventListener("click", toggle);
  document.addEventListener("click", (event) => {
    if (el["usage-popover"].hidden || el["usage-popover"].contains(event.target) || el["usage-btn"].contains(event.target)) return;
    el["usage-popover"].hidden = true;
    el["usage-btn"].setAttribute("aria-expanded", "false");
  });
  // The trigger now lives inside a menu that closes behind the popover, so
  // focus returns to the menu button instead.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || el["usage-popover"].hidden) return;
    el["usage-popover"].hidden = true;
    el["usage-btn"].setAttribute("aria-expanded", "false");
    el["session-actions-toggle"].focus();
  });
  setInterval(() => {
    if (!el["usage-popover"].hidden) refreshUsage();
  }, 60_000);
}
