"use strict";
// DOM handle registry + tiny helpers. Elements come from index.html; sidebar
// internals are built dynamically and registered by their modules.

export const el = {};

function reg(id) {
  const node = document.getElementById(id);
  if (node) el[id] = node;
  return node;
}

// Static shell ids (keep in sync with index.html).
export function initDom() {
  ["main", "session-list", "side-foot", "sidebar", "term-title", "conn",
    "link-modal", "link-text", "link-error", "link-cancel", "link-open", "link-copy", "copy-flash",
    "file-viewer", "file-viewer-title", "file-viewer-status", "file-viewer-content",
    "file-viewer-download", "file-viewer-close",
    "hold-indicator", "scroll-status", "scroll-scrubber", "scroll-scrubber-label",
    "scroll-scrubber-thumb", "sel-handles", "sel-handle-start", "sel-handle-end",
    "copy-bar", "copy-bar-dismiss", "copy-bar-copy",
    "kill-btn", "quickkeys", "mobile-input", "terminal-voice", "terminal-voice-status",
    "terminal-unsent", "terminal-unsent-retry", "modal", "f-name", "f-folder",
    "f-profile", "f-profile-summary", "m-error", "authgate", "auth-input", "auth-error",
    "auth-submit", "profile-btn", "reload-modal", "r-profile", "r-profile-summary", "r-model",
    "r-error", "r-cancel", "r-reload", "new-btn", "empty-new-btn", "m-cancel", "m-create",
    "sidebar-close", "theme-btn", "palette", "palette-input", "palette-results",
    "settings", "settings-btn", "settings-close", "settings-profiles", "settings-legend", "settings-about",
    "settings-preview-roots", "settings-preview-root-form", "settings-preview-root-input", "settings-preview-root-add",
    "menu-btn", "reload-btn", "update-btn", "usage-btn", "usage-popover",
    "profile-info-btn", "profile-info-popover", "profile-info-title", "profile-info-status",
    "profile-info-grid", "quickkeys-toggle", "notify-btn",
    "usage-grid", "usage-status", "term", "term-wrap", "session-search",
    "session-actions-toggle", "session-actions",
    "mode-toggle",
    "chat-mode", "chat-log", "chat-panels-toggle", "chat-panels-content",
    "chat-activity", "chat-ask", "chat-todo", "chat-agents", "chat-status",
    "chat-empty", "chat-empty-resume", "chat-landing-target", "chat-loading", "chat-jump-latest", "chat-input", "chat-attach", "chat-send",
    "chat-interrupt", "chat-voice", "chat-voice-status", "chat-advisor",
    "ghost-mode", "ghost-title", "ghost-summary", "ghost-meta",
    "ghost-restore-btn", "ghost-copy-btn", "ghost-forget-btn",
  ].forEach(reg);
}

export function elem(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}