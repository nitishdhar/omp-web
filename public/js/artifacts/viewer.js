"use strict";
// Artifact viewer: one sandboxed frame per opened artifact, kept alive like
// panel frames so going back to the gallery and in again keeps scroll and
// page state.
//
// The sandbox never grants allow-same-origin: the page runs in an opaque
// origin, so it can read its own files through the capability URL but not
// this app's token, storage or DOM. The server's CSP sandbox header repeats
// the same flags for pages opened outside the frame.

import { el, elem } from "../dom.js";
import { copyWithNotice } from "../notice.js";

const SANDBOX = "allow-scripts allow-forms allow-popups allow-modals allow-downloads";
const frames = new Map(); // slug -> { frame, url }
let shown = null; // the artifact object on screen, null in the gallery

// Links leave this tab (new tab, chat apps, the phone), so they must carry
// an origin other devices reach: the server's `link` (api/addresses.js), else
// whatever origin this tab is on.
export function absoluteUrl(artifact) {
  return artifact.link || new URL(artifact.url, location.origin).href;
}

export function showViewer(artifact) {
  let entry = frames.get(artifact.slug);
  if (!entry) {
    const frame = elem("iframe", {
      class: "art-frame",
      sandbox: SANDBOX,
      referrerpolicy: "no-referrer",
      title: artifact.title || artifact.slug,
      src: artifact.url,
    });
    entry = { frame, url: artifact.url };
    frames.set(artifact.slug, entry);
    el["artifact-frames"].append(frame);
  }
  for (const [slug, item] of frames) item.frame.hidden = slug !== artifact.slug;
  shown = artifact;
  el["artifact-title"].textContent = artifact.title || artifact.slug;
  el["artifact-title"].title = artifact.description || "";
  el["artifact-open"].href = absoluteUrl(artifact);
  el["artifacts-gallery"].hidden = true;
  el["artifact-viewer"].hidden = false;
}

export function hideViewer() {
  shown = null;
  el["artifact-viewer"].hidden = true;
  el["artifacts-gallery"].hidden = false;
}

// A frame whose artifact was deleted, or whose link changed because the key
// was rotated, must not keep showing the old page on the next open.
export function pruneFrames(list) {
  const urls = new Map(list.map((a) => [a.slug, a.url]));
  for (const [slug, entry] of frames) {
    if (urls.get(slug) === entry.url) continue;
    entry.frame.remove();
    frames.delete(slug);
  }
}

export function wireViewer() {
  // Assigning src navigates even when unchanged; the opaque-origin frame
  // refuses contentWindow.location.reload() from this side.
  el["artifact-reload"].onclick = () => {
    const entry = shown && frames.get(shown.slug);
    if (entry) entry.frame.src = entry.url;
  };
  el["artifact-copy"].onclick = () => {
    if (shown) copyWithNotice(absoluteUrl(shown), "Link copied");
  };
}
