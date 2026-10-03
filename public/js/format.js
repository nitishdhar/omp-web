"use strict";
// Display formatters shared by views that report sizes and ages, plus the
// label → id slug both Settings add forms (panels, credentials) derive.

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// Epoch milliseconds in, coarse age out. Settings tables only need to rank
// "recent" against "weeks old", never minute precision.
export function formatAge(ms) {
  const t = Number(ms) || 0;
  if (!t) return "unknown";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 90) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Lowercase ASCII words joined by "-", trimmed to `max` without a trailing
// dash, so a typed label always yields an id the server's pattern accepts.
export function slugify(label, max) {
  return String(label).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
}
