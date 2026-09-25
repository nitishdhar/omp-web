"use strict";
// Session-scoped attachment picker and upload state.

import { api } from "./api.js";
import { state } from "./state.js";

const bindings = [];
const wiredRoots = new WeakMap();
let attachmentSeq = 0;

const IMAGE_ATTACHMENT_ACCEPT = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".avif", ".heic", ".heif",
  "image/png", "image/x-png", "image/jpeg", "image/jpg", "image/pjpeg", "image/gif", "image/webp",
  "image/bmp", "image/x-ms-bmp", "image/tiff", "image/avif", "image/heic", "image/heif",
];
const DOCUMENT_ATTACHMENT_ACCEPT = [
  ".pdf", "application/pdf", "application/x-pdf",
  ".doc", "application/msword", "application/vnd.ms-word",
  ".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls", "application/vnd.ms-excel", "application/msexcel", "application/x-msexcel",
  ".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt", "application/vnd.ms-powerpoint", "application/mspowerpoint", "application/x-mspowerpoint",
  ".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt", "application/vnd.oasis.opendocument.text",
  ".ods", "application/vnd.oasis.opendocument.spreadsheet",
  ".odp", "application/vnd.oasis.opendocument.presentation",
  ".rtf", "application/rtf", "application/x-rtf", "text/rtf",
  ".txt", "text/plain",
  ".md", "text/markdown", "text/x-markdown",
  ".csv", "text/csv", "application/csv",
  ".tsv", "text/tab-separated-values",
  ".json", "application/json", "text/json",
  ".xml", "application/xml", "text/xml",
  ".yaml", ".yml", "application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml",
  ".log",
];

export const CHAT_ATTACHMENT_ACCEPT = [
  ...IMAGE_ATTACHMENT_ACCEPT,
  ...DOCUMENT_ATTACHMENT_ACCEPT,
].join(",");

function acceptTokens(value) {
  return String(value || "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function acceptsFile(file, tokens) {
  if (!tokens.length) return true;
  const name = String(file?.name || "").toLowerCase();
  const mime = String(file?.type || "").toLowerCase();
  return tokens.some((token) => {
    if (token.startsWith(".")) return name.endsWith(token);
    if (token.endsWith("/*")) return mime.startsWith(token.slice(0, -1));
    return mime === token;
  });
}

function clipboardImageFiles(clipboardData) {
  const fromItems = Array.from(clipboardData?.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file) => {
      if (!file) return false;
      const mime = String(file.type || "").toLowerCase();
      if (mime.startsWith("image/")) return true;
      return acceptsFile(file, IMAGE_ATTACHMENT_ACCEPT);
    });
  if (fromItems.length) return fromItems;
  return Array.from(clipboardData?.files || []).filter((file) => {
    const mime = String(file.type || "").toLowerCase();
    return mime.startsWith("image/") || acceptsFile(file, IMAGE_ATTACHMENT_ACCEPT);
  });
}

function revokePreview(attachment) {
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

function extensionLabel(name) {
  const match = String(name || "").match(/\.([a-z0-9]{1,8})$/i);
  return match ? match[1].toUpperCase() : "FILE";
}

function sessionState(binding, sessionId, create = true) {
  let value = binding.sessions.get(sessionId);
  if (!value && create) {
    value = {
      attachments: [],
      message: "",
      error: false,
      statusTimer: null,
      pendingUploads: 0,
    };
    binding.sessions.set(sessionId, value);
  }
  return value;
}

function renderStatus(binding) {
  const status = binding.status;
  if (!status) return;
  const current = sessionState(binding, binding.activeSessionId, false);
  const message = current?.message || "";
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle("error", Boolean(current?.error));
}

function removeAttachment(binding, sessionId, attachment) {
  const current = sessionState(binding, sessionId, false);
  if (!current) return;
  const index = current.attachments.findIndex((candidate) => candidate.id === attachment.id);
  if (index === -1) return;
  current.attachments.splice(index, 1);
  revokePreview(attachment);
  try {
    binding.removePath?.(attachment.path, {
      sessionId,
      context: attachment.context,
      attachment: attachment.response,
    });
  } catch (error) {
    setStatus(binding, sessionId, `Could not remove attachment path: ${error.message}`, { error: true });
  }
  if (binding.activeSessionId === sessionId) renderBinding(binding);
}

function attachmentNode(binding, sessionId, attachment) {
  const item = document.createElement("div");
  item.className = `attachment-item attachment-${attachment.kind}`;
  item.setAttribute("role", "listitem");

  let visual;
  if (attachment.kind === "image") {
    visual = document.createElement("img");
    visual.className = "attachment-preview";
    visual.src = attachment.previewUrl;
    visual.alt = `Preview of ${attachment.name}`;
  } else {
    visual = document.createElement("span");
    visual.className = "attachment-file-badge";
    visual.textContent = extensionLabel(attachment.name);
    visual.setAttribute("aria-hidden", "true");
  }

  const label = document.createElement("span");
  label.className = "attachment-name";
  label.textContent = attachment.name;
  label.title = attachment.name;

  const canRemovePath = typeof binding.removePath === "function";
  const action = canRemovePath
    ? `Remove ${attachment.name}`
    : `Dismiss attachment ${attachment.name}`;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "attachment-remove";
  remove.setAttribute("aria-label", action);
  remove.title = action;
  remove.textContent = "\u00d7";
  remove.addEventListener("click", () => removeAttachment(binding, sessionId, attachment));

  item.append(visual, label, remove);
  return item;
}

function renderBinding(binding) {
  const current = sessionState(binding, binding.activeSessionId, false);
  if (binding.tray) {
    binding.tray.replaceChildren();
    for (const attachment of current?.attachments || []) {
      binding.tray.append(attachmentNode(binding, binding.activeSessionId, attachment));
    }
    binding.tray.hidden = !current?.attachments.length;
  }
  binding.button.disabled = !binding.activeSessionId || Boolean(current?.pendingUploads);
  binding.button.toggleAttribute("aria-busy", Boolean(current?.pendingUploads));
  renderStatus(binding);
}

function setStatus(binding, sessionId, message, { error = false, clearAfter = 0 } = {}) {
  const current = sessionState(binding, sessionId);
  clearTimeout(current.statusTimer);
  current.message = message;
  current.error = error;
  if (binding.activeSessionId === sessionId) renderStatus(binding);
  if (clearAfter) {
    current.statusTimer = setTimeout(() => {
      if (binding.sessions.get(sessionId) !== current) return;
      current.message = "";
      current.error = false;
      if (binding.activeSessionId === sessionId) renderStatus(binding);
    }, clearAfter);
  }
}

function clearSession(binding, sessionId) {
  const current = sessionState(binding, sessionId, false);
  if (!current) return;
  clearTimeout(current.statusTimer);
  for (const attachment of current.attachments) revokePreview(attachment);
  binding.sessions.delete(sessionId);
  if (binding.activeSessionId === sessionId) renderBinding(binding);
}

function clearBinding(binding) {
  for (const sessionId of Array.from(binding.sessions.keys())) clearSession(binding, sessionId);
}

function addAttachment(binding, owner, file, response, path, context, sessionId) {
  const name = response.name || file.name || "attachment";
  const kind = typeof response.mime === "string" && response.mime.toLowerCase().startsWith("image/")
    ? "image"
    : "document";
  owner.attachments.push({
    id: `attachment:${++attachmentSeq}`,
    name,
    kind,
    path,
    context,
    response,
    previewUrl: kind === "image" ? URL.createObjectURL(file) : null,
  });
  if (binding.activeSessionId === sessionId) renderBinding(binding);
}

/**
 * Clear attachment state without crossing composer/session ownership.
 * Passing the controller returned by wireAttachments is preferred. The
 * no-argument form remains compatible and scopes itself by focused surface.
 */
export function clearAttachments(target = null) {
  if (target?.clear) {
    target.clear();
    return;
  }
  if (target && wiredRoots.has(target)) {
    const binding = wiredRoots.get(target);
    clearSession(binding, binding.activeSessionId);
    return;
  }

  const focused = bindings.find((binding) => binding.root.contains(document.activeElement));
  if (focused) {
    clearSession(focused, focused.activeSessionId);
    return;
  }
}

/**
 * Wire one scoped attachment surface. appendPath keeps its original first
 * argument; the additive second argument identifies the captured session.
 * Returns { clear(sessionId?), activate(sessionId, options?) }.
 */
export function wireAttachments({
  appendPath,
  removePath = null,
  captureContext = null,
  appendWhileInactive = false,
  root = document,
  dropTarget = null,
  accept = null,
  pasteTarget = null,
}) {
  const existing = wiredRoots.get(root);
  if (existing) return existing.controller;

  const picker = root.querySelector("[data-attachment-input]");
  const button = root.querySelector("[data-attach]");
  if (!picker || !button) return null;
  const allowed = accept === null ? picker.accept : accept;
  picker.accept = allowed;

  const binding = {
    root,
    picker,
    button,
    tray: root.querySelector("[data-attachment-tray]"),
    status: root.querySelector("[data-attachment-status]"),
    sessions: new Map(),
    activeSessionId: state.current || null,
    appendPath,
    removePath,
    captureContext,
    appendWhileInactive,
    controller: null,
    accept: acceptTokens(allowed),
  };
  const controller = {
    clear(sessionId = binding.activeSessionId) {
      clearSession(binding, sessionId);
    },
    activate(sessionId, { reset = false } = {}) {
      if (reset && sessionId) clearSession(binding, sessionId);
      binding.activeSessionId = sessionId || null;
      renderBinding(binding);
    },
  };
  binding.controller = controller;
  bindings.push(binding);
  wiredRoots.set(root, binding);
  renderBinding(binding);

  const upload = async (file) => {
    const sessionId = binding.activeSessionId || state.current;
    if (!file || !sessionId) {
      if (!sessionId) setStatus(binding, null, "Select a session first.", { error: true });
      return;
    }
    if (binding.activeSessionId !== sessionId) controller.activate(sessionId);
    if (!acceptsFile(file, binding.accept)) {
      setStatus(binding, sessionId, `Unsupported file type: ${file.name || "file"}.`, { error: true });
      picker.value = "";
      return;
    }

    const owner = sessionState(binding, sessionId);
    const context = captureContext?.(sessionId);
    owner.pendingUploads++;
    setStatus(binding, sessionId, "Uploading file\u2026");
    renderBinding(binding);

    try {
      const form = new FormData();
      form.append("attachment", file);
      const response = await api(`/sessions/${encodeURIComponent(sessionId)}/attachments`, {
        method: "POST",
        body: form,
      });
      const attachment = response?.attachment;
      if (!attachment || typeof attachment.path !== "string") {
        throw new Error("Invalid upload response.");
      }
      // A send/profile reset clears this exact owner object. Its late upload
      // must not append into the next draft that happens to share the same id.
      if (binding.sessions.get(sessionId) !== owner) return;
      if (!appendWhileInactive && state.current !== sessionId) {
        setStatus(binding, sessionId, "Upload finished after switching sessions. Attach it again.", {
          error: true,
        });
        return;
      }

      const path = attachment.path;
      const accepted = await appendPath(path, { sessionId, context, attachment });
      if (accepted === false) {
        setStatus(binding, sessionId, "Upload finished after the draft was sent. Attach it again.", {
          error: true,
        });
        return;
      }
      addAttachment(binding, owner, file, attachment, path, context, sessionId);
      setStatus(binding, sessionId, `Attached ${attachment.name || "file"}.`, { clearAfter: 2500 });
    } catch (error) {
      if (binding.sessions.get(sessionId) === owner) {
        setStatus(binding, sessionId, `Upload failed: ${error.message}`, { error: true });
      }
    } finally {
      if (binding.sessions.get(sessionId) === owner) {
        owner.pendingUploads = Math.max(0, owner.pendingUploads - 1);
        if (binding.activeSessionId === sessionId) renderBinding(binding);
      }
      picker.value = "";
    }
  };

  button.addEventListener("click", () => {
    const sessionId = binding.activeSessionId || state.current;
    if (!sessionId) {
      setStatus(binding, null, "Select a session first.", { error: true });
      return;
    }
    if (binding.activeSessionId !== sessionId) controller.activate(sessionId);
    picker.value = "";
    picker.click();
  });

  picker.addEventListener("change", () => upload(picker.files?.[0]));

  const drop = dropTarget || root;
  drop.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    drop.classList.add("attachment-drop-active");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("attachment-drop-active"));
  drop.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    drop.classList.remove("attachment-drop-active");
    upload(event.dataTransfer.files[0]);
  });

  pasteTarget?.addEventListener("paste", (event) => {
    const files = clipboardImageFiles(event.clipboardData);
    if (!files.length) return;
    // A clipboard may carry both an image and useful plain text. Let the
    // textarea perform its native text paste while uploading the image.
    if (!event.clipboardData?.getData("text/plain")) event.preventDefault();
    for (const file of files) void upload(file);
  });

  window.addEventListener("pagehide", () => clearBinding(binding), { once: true });
  return controller;
}
