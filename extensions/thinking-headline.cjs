"use strict";
// Live reasoning headline shared by the TUI status extension (ESM under omp's
// Bun) and the RPC bridge (CommonJS under Node). CommonJS is the one format
// both runtimes load without a build step: Bun and Node ESM import it as a
// default export, Node requires it directly.

const THINKING_MAX = 120;
const THINKING_WRITE_MS = 1_000;
const THINKING_BUFFER = 4_000;

// Models bold the conclusion of a reasoning step, so the last bold span is
// the closest thing to a one-line "what I am doing now". Without one, fall
// back to the last completed sentence rather than a half-written clause.
function headlineFrom(buffer) {
  let headline = "";
  for (const match of buffer.matchAll(/\*\*([^*\n]{3,120})\*\*/g)) headline = match[1];
  if (!headline) {
    const sentences = buffer.split(/(?<=[.!?])\s+/);
    for (let i = sentences.length - 1; i >= 0; i--) {
      const candidate = sentences[i].trim();
      if (candidate.length >= 8 && /[.!?]$/.test(candidate)) { headline = candidate; break; }
    }
  }
  headline = headline.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return headline.length > THINKING_MAX
    ? headline.slice(0, THINKING_MAX - 1).trimEnd() + "\u2026"
    : headline;
}

// Feeds `assistantMessageEvent`s in; calls write(headline) at most once per
// THINKING_WRITE_MS, and write("") once when the headline should disappear.
function createThinkingTracker(write) {
  let buffer = "";
  let published = "";
  let timer = null;

  const flush = () => {
    clearTimeout(timer);
    timer = null;
    const headline = headlineFrom(buffer);
    if (!headline || headline === published) return;
    published = headline;
    write(headline);
  };

  const clear = () => {
    clearTimeout(timer);
    timer = null;
    buffer = "";
    if (!published) return;
    published = "";
    write("");
  };

  const update = (event) => {
    if (!event) return;
    if (event.type === "thinking_start") {
      buffer = "";
      return;
    }
    if (event.type === "thinking_delta" && typeof event.delta === "string") {
      buffer = (buffer + event.delta).slice(-THINKING_BUFFER);
      if (!timer) timer = setTimeout(flush, THINKING_WRITE_MS);
      return;
    }
    // Text or a tool call means the reasoning produced something the normal
    // activity row can name; the headline would only go stale.
    if (event.type === "text_start" || event.type === "toolcall_start") clear();
  };

  return { update, clear };
}

module.exports = { headlineFrom, createThinkingTracker };
