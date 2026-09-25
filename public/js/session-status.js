"use strict";

const STATUS_LABELS = Object.freeze({
  starting: "Starting",
  working: "Working",
  waiting: "Waiting",
  done: "Recently done",
  idle: "Idle",
  shell: "Shell",
  unknown: "Unknown",
});

export function sessionStatus(session) {
  const value = session?.type === "shell" ? "shell" : session?.status;
  return Object.hasOwn(STATUS_LABELS, value) ? value : "unknown";
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.unknown;
}

// Relative age of a ms-epoch statusAt (server resolves from transcript
// timestamps, falling back to file mtime). Empty when unknown or absurd —
// callers join it into tooltips, never into rendered text.
export function statusAgeText(statusAt) {
  const ts = Number(statusAt) || 0;
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (!Number.isFinite(diff) || diff < 0) return "";
  if (diff < 90 * 1000) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

// Full hover/aria text for a session's agent status: label plus relative age
// from statusAt. Plain string — set via textContent, title, or aria-label
// only, never innerHTML.
export function statusTitle(session) {
  const status = sessionStatus(session);
  const parts = [statusLabel(status)];
  const age = statusAgeText(session?.statusAt);
  if (age) parts.push(age);
  return parts.join(" · ");
}
