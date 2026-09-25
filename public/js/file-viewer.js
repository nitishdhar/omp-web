"use strict";
// Session-scoped local-file viewer. Raw bytes are fetched through the shared
// authenticated response helper, then kept only in a revocable object URL.

import { apiResponse } from "./api.js";
import { state } from "./state.js";
import { el, elem } from "./dom.js";
import { renderMarkdown } from "./chat/transcript.js";

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "avif", "heic", "heif",
]);
const MARKDOWN_EXTENSIONS = new Set(["md"]);
const TEXT_EXTENSIONS = new Set(["txt", "csv", "tsv", "json", "xml", "yaml", "yml", "log"]);
const TEXT_MIMES = new Set(["application/json", "application/xml", "application/yaml"]);

let requestController = null;
let objectUrl = null;
let requestVersion = 0;
let returnFocus = null;
let wired = false;

function extensionOf(path) {
  const match = String(path || "").match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : "";
}
function previewKind(response, name) {
  const mime = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/markdown") return "markdown";
  if (mime.startsWith("text/") || TEXT_MIMES.has(mime)) return "text";
  const extension = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  return "download";
}


function fallbackName(path) {
  const parts = String(path || "").split(/[\\/]/);
  return parts[parts.length - 1] || "File";
}

function responseName(response, path) {
  const encoded = response.headers.get("x-omp-file-name");
  if (!encoded) return fallbackName(path);
  try { return decodeURIComponent(encoded); } catch { return fallbackName(path); }
}

function releaseFile() {
  requestController?.abort();
  requestController = null;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  el["file-viewer-content"]?.replaceChildren();
  const download = el["file-viewer-download"];
  if (download) {
    download.removeAttribute("href");
    download.hidden = true;
  }
}

function setStatus(message = "", error = false) {
  const status = el["file-viewer-status"];
  if (!status) return;
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle("error", error);
}

function showDownload(name) {
  const download = el["file-viewer-download"];
  if (!download || !objectUrl) return;
  download.href = objectUrl;
  download.download = name;
  download.hidden = false;
}
function renderBlob(blob, name, kind) {
  const content = el["file-viewer-content"];
  if (!content) return;
  const url = objectUrl = URL.createObjectURL(blob);
  showDownload(name);

  if (kind === "image") {
    content.append(elem("img", {
      class: "file-viewer-image",
      src: url,
      alt: name,
    }));
    return;
  }
  if (kind === "pdf") {
    content.append(elem("iframe", {
      class: "file-viewer-pdf",
      src: url,
      title: name,
    }));
    return;
  }
  if (kind === "markdown" || kind === "text") {
    blob.text().then((text) => {
      if (objectUrl !== url) return;
      if (kind === "markdown") {
        content.append(elem("article", { class: "file-viewer-markdown" }, renderMarkdown(text)));
      } else {
        content.append(elem("pre", { class: "file-viewer-text", text }));
      }
    }).catch(() => {
      if (objectUrl === url) setStatus("Could not read this text file.", true);
    });
    return;
  }
  content.append(elem("div", { class: "file-viewer-fallback" },
    elem("p", { text: "This file type cannot be previewed here." }),
    elem("p", { class: "side-sub", text: "Download it to open it in its native application." }),
  ));
}

function wireViewer() {
  if (wired) return;
  wired = true;
  el["file-viewer-close"]?.addEventListener("click", closeFileViewer);
  el["file-viewer"]?.addEventListener("click", (event) => {
    if (event.target === el["file-viewer"]) closeFileViewer();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el["file-viewer"]?.hidden) closeFileViewer();
  });
}

export function closeFileViewer() {
  const viewer = el["file-viewer"];
  if (!viewer || viewer.hidden) return;
  requestVersion++;
  releaseFile();
  setStatus();
  viewer.hidden = true;
  const focus = returnFocus;
  returnFocus = null;
  if (focus?.isConnected) focus.focus();
}

export async function openFileViewer({ sessionId, path }) {
  wireViewer();
  const viewer = el["file-viewer"];
  if (!viewer) return;
  requestVersion++;
  const version = requestVersion;
  releaseFile();
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  viewer.hidden = false;
  viewer.setAttribute("aria-busy", "true");
  el["file-viewer-title"].textContent = fallbackName(path);
  setStatus("Loading file…");
  el["file-viewer-close"]?.focus();

  if (!sessionId) {
    viewer.removeAttribute("aria-busy");
    setStatus("Select an active session before opening a file.", true);
    return;
  }

  requestController = new AbortController();
  try {
    const response = await apiResponse(
      `/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`,
      { signal: requestController.signal },
    );
    const blob = await response.blob();
    if (version !== requestVersion) return;
    if (sessionId !== state.current) {
      closeFileViewer();
      return;
    }
    const name = responseName(response, path);
    el["file-viewer-title"].textContent = name;
    setStatus();
    renderBlob(blob, name, previewKind(response, name));
  } catch (error) {
    if (error.name === "AbortError" || version !== requestVersion) return;
    setStatus(error.message || "Could not open this file.", true);
  } finally {
    if (version === requestVersion) viewer.removeAttribute("aria-busy");
  }
}
