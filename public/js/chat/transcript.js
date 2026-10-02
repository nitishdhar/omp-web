"use strict";
// Bounded transcript renderer. Payloads remain in memory for navigation, while
// only one fixed-size timeline window and explicitly opened tool details exist
// in the DOM.

import { apiResponse } from "../api.js";
import { el, elem } from "../dom.js";
import { icon } from "../icons.js";
import { state, emit } from "../state.js";

const WINDOW_SIZE = 240;
const HISTORY_STEP = 200;
const TAIL_THRESHOLD_PX = 24;
const USER_PREVIEW_CHAR_LIMIT = 500;
const USER_PREVIEW_LINE_LIMIT = 6;

/** @type {Map<string, ChatItem>} */
const itemData = new Map();
/** @type {Map<string, string>} */
const timestamps = new Map();
/** @type {Map<string, Element>} timeline id -> rendered outer node */
const nodes = new Map();
/** @type {Map<string, ToolGroup>} tool id -> group */
const toolGroups = new Map();
/** @type {Map<string, ToolGroup>} group id -> group */
const groups = new Map();
const timeline = [];
const openToolIds = new Set();
const visibleTimeIds = new Set();
const expandedUserIds = new Set();

// Regenerate replays the last user input, so only the latest assistant turn
// offers it; older replies keep history read-only instead of forking it.
let lastAssistantId = null;

function tailAssistantId() {
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = itemData.get(timeline[index]);
    if (item && item.kind === "assistant") return item.id;
  }
  return null;
}
let currentToolGroup = null;
let groupSequence = 0;
let windowStart = 0;
let followTail = true;
let tailWired = false;
let observedScrollTop = 0;
// iOS Safari scrolls scrollable regions itself while the keyboard animates
// open/closed. Those system scrolls are indistinguishable from a fast user
// flick by delta alone, so the viewport-resize path below opens a short
// window where scroll events cannot flip followTail to false.
let suppressScrollUntil = 0;
function tailStart() {
  return Math.max(0, timeline.length - WINDOW_SIZE);
}

function isTailWindow() {
  return windowStart >= tailStart();
}

function tailGap(container) {
  return container.scrollHeight - container.scrollTop - container.clientHeight;
}

function syncJumpButton() {
  if (el["chat-jump-latest"]) el["chat-jump-latest"].hidden = followTail;
}

function setFollowTail(next) {
  followTail = next;
  syncJumpButton();
}
function scrollToTail(container, refreshWindow = true) {
  windowStart = tailStart();
  if (refreshWindow) syncRenderedWindow(container);
  container.scrollTop = container.scrollHeight;
  observedScrollTop = container.scrollTop;
  setFollowTail(true);
}

function wireTailFollow(container) {
  if (tailWired) return;
  tailWired = true;
  observedScrollTop = container.scrollTop;
  container.addEventListener("scroll", () => {
    if (Date.now() < suppressScrollUntil) {
      observedScrollTop = container.scrollTop;
      return;
    }
    if (Math.abs(container.scrollTop - observedScrollTop) < 1) return;
    observedScrollTop = container.scrollTop;
    setFollowTail(isTailWindow() && tailGap(container) <= TAIL_THRESHOLD_PX);
  }, { passive: true });
  new ResizeObserver(() => {
    if (followTail) scrollToTail(container, false);
  }).observe(container);
  el["chat-jump-latest"]?.addEventListener("click", () => scrollToTail(container));
  syncJumpButton();
}
/** Ignore scroll events for a short window (keyboard open/close adjustment). */
export function suppressTailScroll(ms = 450) {
  suppressScrollUntil = Math.max(suppressScrollUntil, Date.now() + ms);
}

/**
 * Re-pin the tail in the same task as a layout change we caused ourselves
 * (the composer growing a row). The container ResizeObserver would also
 * catch it, but only on its own callback, which leaves the transcript one
 * composer-row off the tail in between.
 */
export function repinTail() {
  const container = el["chat-log"];
  if (container && followTail && isTailWindow()) scrollToTail(container, false);
}

/** Pin the log to the newest entry regardless of current follow state. */
export function pinToTail() {
  const container = el["chat-log"];
  if (!container) return;
  scrollToTail(container, false);
}

function copyButton(text, label = "Copy", extraClass = "", feedback = null) {
  const iconOnly = Boolean(feedback);
  const button = elem("button", {
    class: `ghost chat-action-btn${extraClass ? ` ${extraClass}` : ""}`,
    type: "button",
    title: label,
    "aria-label": label,
  }, iconOnly
    ? elem("span", { class: "chat-copy-icon", "aria-hidden": "true" })
    : label);
  let resetTimer = null;
  button.addEventListener("click", async () => {
    let result;
    try {
      await navigator.clipboard.writeText(text);
      result = "Copied";
    } catch {
      result = "Copy failed";
    }
    if (feedback) feedback.textContent = result;
    else button.textContent = result;
    button.title = result;
    button.setAttribute("aria-label", result);
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      if (feedback) feedback.textContent = "";
      else button.textContent = label;
      button.title = label;
      button.setAttribute("aria-label", label);
    }, 1400);
  });
  return button;
}
function compactUserTextEnd(text) {
  let end = Math.min(text.length, USER_PREVIEW_CHAR_LIMIT);
  let lines = 1;
  for (let index = 0; index < end; index++) {
    if (text.charCodeAt(index) !== 10) continue;
    lines++;
    if (lines > USER_PREVIEW_LINE_LIMIT) {
      end = index > 0 && text.charCodeAt(index - 1) === 13 ? index - 1 : index;
      break;
    }
  }
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (
    end > 0
    && end < text.length
    && previous >= 0xD800
    && previous <= 0xDBFF
    && next >= 0xDC00
    && next <= 0xDFFF
  ) {
    end--;
  }
  return end;
}

function makeCodeBlock(text) {
  const pre = elem("pre", { class: "chat-code-block" });
  const code = elem("code");
  code.textContent = text;
  pre.append(code);
  return elem("div", { class: "chat-code-wrap" },
    copyButton(text, "Copy code", "chat-code-copy"),
    pre,
  );
}

function formatTime(at) {
  if (!at) return "";
  const value = new Date(at);
  return Number.isNaN(value.getTime()) ? String(at) : value.toLocaleString();
}

// Turn anchors repeat down the whole log, so they carry the least that still
// locates a turn: clock time today, date and time before that. The full
// timestamp stays one clock-toggle away on the message itself.
function formatTurnTime(at) {
  if (!at) return "";
  const value = new Date(at);
  if (Number.isNaN(value.getTime())) return "";
  const time = value.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const now = new Date();
  const sameDay = value.getFullYear() === now.getFullYear()
    && value.getMonth() === now.getMonth()
    && value.getDate() === now.getDate();
  if (sameDay) return time;
  const date = value.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${date} · ${time}`;
}

function messageActions(item, text) {
  const actions = elem("div", {
    class: "chat-message-actions",
    role: "group",
    "aria-label": "Message actions",
  });
  const feedback = typeof text === "string"
    ? elem("span", {
      class: "chat-action-feedback",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    })
    : null;
  if (feedback) {
    actions.append(
      feedback,
      copyButton(text, "Copy message", "chat-icon-action chat-copy-action", feedback),
    );
  }
  const formatted = formatTime(item.at);
  if (formatted) {
    const shown = visibleTimeIds.has(item.id);
    const time = elem("time", {
      class: "chat-message-time",
      datetime: item.at,
      hidden: !shown,
    }, formatted);
    const toggle = elem("button", {
      class: "ghost chat-action-btn chat-icon-action",
      type: "button",
      title: shown ? "Hide message time" : "Show message time",
      "aria-label": shown ? "Hide message time" : "Show message time",
      "aria-expanded": String(shown),
    }, icon("clock", 13));
    toggle.addEventListener("click", () => {
      const next = time.hidden;
      time.hidden = !next;
      const label = next ? "Hide message time" : "Show message time";
      toggle.title = label;
      toggle.setAttribute("aria-label", label);
      toggle.setAttribute("aria-expanded", String(next));
      if (next) visibleTimeIds.add(item.id);
      else visibleTimeIds.delete(item.id);
    });
    actions.prepend(time);
    actions.append(toggle);
  }

  // A delivered user turn is resendable as a new turn through the composer;
  // pending and failed messages keep their own inline Retry/Edit instead.
  if (item.kind === "user" && !item.pending && !item.failed
    && typeof item.text === "string" && item.text) {
    const edit = elem("button", {
      class: "ghost chat-action-btn",
      type: "button",
      title: "Edit and resend as a new message",
      "aria-label": "Edit and resend as a new message",
    }, "Edit");
    edit.addEventListener("click", () => emit("chat:edit", { id: item.id }));
    actions.append(edit);
  }
  return actions;
}

// ── Minimal markdown (no dependency) ────────────────────────────────────────

const MAX_BLOCKQUOTE_DEPTH = 8;

export function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  renderMarkdownInto(text, frag, 0);
  return frag;
}

function renderMarkdownInto(text, container, quoteDepth) {
  // Anchoring prevents a quoted fence (`> ````) from being consumed before
  // its blockquote marker is stripped.
  const fence = /^ {0,3}```[^\n]*\r?\n([\s\S]*?)^ {0,3}```[ \t]*\r?$/gm;
  let pos = 0;
  let match;
  while ((match = fence.exec(text)) !== null) {
    if (match.index > pos) renderMathBlocks(text.slice(pos, match.index), container, quoteDepth);
    container.append(makeCodeBlock(match[1]));
    pos = match.index + match[0].length;
  }
  if (pos < text.length) renderMathBlocks(text.slice(pos), container, quoteDepth);
}

const DISPLAY_MATH_OPEN = /^[\t ]*\\\[[\t ]*\r?$/;
const DISPLAY_MATH_CLOSE = /^[\t ]*\\\][\t ]*\r?$/;

function normalizeMath(text) {
  return text
    .replace(/\\\$/g, "$")
    .replace(/\\(?:qquad|quad|[,;:!> ])/g, " ")
    .replace(/\\times\b/g, "×")
    .replace(/\\cdot\b/g, "·")
    .replace(/\\div\b/g, "÷")
    .replace(/\\(?:leq|le)\b/g, "≤")
    .replace(/\\(?:geq|ge)\b/g, "≥")
    .replace(/\\(?:neq|ne)\b/g, "≠")
    .replace(/\\approx\b/g, "≈")
    .replace(/\s*([+×÷=≤≥≠≈])\s*/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeMathBlock(text) {
  return elem("div", { class: "chat-math-block", role: "math", text: normalizeMath(text) });
}

function makeMathInline(text) {
  return elem("span", { class: "chat-math-inline", role: "math", text: normalizeMath(text) });
}

function renderMathBlocks(text, container, quoteDepth) {
  const lines = text.split("\n");
  let textStart = 0;
  for (let index = 0; index < lines.length; index++) {
    if (!DISPLAY_MATH_OPEN.test(lines[index])) continue;
    let close = index + 1;
    while (close < lines.length && !DISPLAY_MATH_CLOSE.test(lines[close])) close++;
    if (close === lines.length) continue;
    if (index > textStart) renderParas(lines.slice(textStart, index).join("\n"), container, quoteDepth);
    container.append(makeMathBlock(lines.slice(index + 1, close).join("\n")));
    textStart = close + 1;
    index = close;
  }
  if (textStart < lines.length) renderParas(lines.slice(textStart).join("\n"), container, quoteDepth);
}

const BULLET = /^\s*[-*]\s+/;
const ORDERED = /^\s*\d+[.)]\s+/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?$/;
const BLOCKQUOTE = /^[ \t]{0,3}>[ \t]?/;

// Nesting is semantic: agent output routinely puts a checklist under a step,
// and flattening it re-parents every child onto the turn. Two columns is the
// smallest indent any of our providers emit, so it is the level unit.
const LIST_INDENT_UNIT = 2;
const MAX_LIST_DEPTH = 6;

function listIndent(line) {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4;
    else break;
  }
  return width;
}

function buildList(items) {
  const root = elem(items[0].kind, { class: "chat-list" });
  const stack = [{ indent: items[0].indent, list: root, li: null }];
  for (const item of items) {
    while (stack.length > 1 && item.indent < stack[stack.length - 1].indent) stack.pop();
    let top = stack[stack.length - 1];
    if (top.li && stack.length < MAX_LIST_DEPTH && item.indent >= top.indent + LIST_INDENT_UNIT) {
      const sub = elem(item.kind, { class: "chat-list" });
      top.li.append(sub);
      top = { indent: item.indent, list: sub, li: null };
      stack.push(top);
    }
    const li = elem("li");
    renderInline(item.text, li);
    top.list.append(li);
    top.li = li;
  }
  return root;
}
function stripBlockquoteRun(line) {
  let offset = 0;
  while (offset < line.length) {
    let cursor = offset;
    let padding = 0;
    while (padding < 3 && (line[cursor] === " " || line[cursor] === "\t")) {
      cursor++;
      padding++;
    }
    if (line[cursor] !== ">") break;
    cursor++;
    if (line[cursor] === " " || line[cursor] === "\t") cursor++;
    offset = cursor;
  }
  return line.slice(offset);
}
const TABLE_DELIMITER_CELL = /^:?-{3,}:?$/;

function splitTableRow(line) {
  if (!line.includes("|")) return null;
  const source = line.trim();
  const cells = [];
  let cell = "";
  let separators = 0;
  let codeTicks = 0;

  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (char === "`") {
      let end = index + 1;
      while (source[end] === "`") end++;
      const runLength = end - index;
      if (!codeTicks) codeTicks = runLength;
      else if (codeTicks === runLength) codeTicks = 0;
      cell += source.slice(index, end);
      index = end;
      continue;
    }
    if (!codeTicks && char === "\\") {
      let end = index + 1;
      while (source[end] === "\\") end++;
      const slashCount = end - index;
      if (source[end] === "|") {
        cell += "\\".repeat(Math.floor(slashCount / 2));
        if (slashCount % 2) {
          cell += "|";
          index = end + 1;
          continue;
        }
        index = end;
        continue;
      }
      cell += source.slice(index, end);
      index = end;
      continue;
    }
    if (!codeTicks && char === "|") {
      cells.push(cell.trim());
      cell = "";
      separators++;
      index++;
      continue;
    }
    cell += char;
    index++;
  }

  if (!separators) return null;
  cells.push(cell.trim());
  if (cells[0] === "") cells.shift();
  if (cells[cells.length - 1] === "") cells.pop();
  return cells.length ? cells : null;
}

function parseTable(lines, start) {
  const header = splitTableRow(lines[start]);
  if (!header || start + 1 >= lines.length) return null;
  const delimiters = splitTableRow(lines[start + 1]);
  if (
    !delimiters
    || delimiters.length !== header.length
    || delimiters.some((cell) => !TABLE_DELIMITER_CELL.test(cell))
  ) return null;

  const alignments = delimiters.map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  });
  const rows = [];
  let end = start + 2;
  while (end < lines.length) {
    const row = splitTableRow(lines[end]);
    if (!row) break;
    rows.push(row);
    end++;
  }
  return { header, alignments, rows, end };
}

function renderTableCell(tag, text, alignment) {
  const cell = elem(tag, {
    class: `chat-table-align-${alignment}`,
    scope: tag === "th" ? "col" : null,
  });
  renderInline(text || "", cell);
  return cell;
}

function makeMarkdownTable({ header, alignments, rows }) {
  const headRow = elem("tr");
  header.forEach((text, index) => {
    headRow.append(renderTableCell("th", text, alignments[index]));
  });
  const body = elem("tbody");
  for (const row of rows) {
    const tr = elem("tr");
    alignments.forEach((alignment, index) => {
      tr.append(renderTableCell("td", row[index], alignment));
    });
    body.append(tr);
  }
  return elem("div", { class: "chat-table-wrap", role: "region", "aria-label": "Scrollable table", tabindex: "0" },
    elem("table", { class: "chat-table" },
      elem("thead", {}, headRow),
      body,
    ),
  );
}

function renderParas(text, container, quoteDepth) {
  for (const block of text.split(/\n{2,}/)) {
    const source = block.trim();
    if (!source) continue;
    let run = [];
    let runKind = null;
    let para = [];

    const flushPara = () => {
      if (!para.length) return;
      const p = elem("p", { class: "chat-para" });
      para.forEach((line, index) => {
        if (index) p.append(elem("br"));
        renderInline(line, p);
      });
      container.append(p);
      para = [];
    };
    const flushRun = () => {
      if (!run.length) return;
      container.append(buildList(run));
      run = [];
      runKind = null;
    };

    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (BLOCKQUOTE.test(lines[index])) {
        flushRun();
        flushPara();
        const quoted = [];
        let end = index;
        while (end < lines.length && BLOCKQUOTE.test(lines[end])) {
          quoted.push(lines[end].replace(BLOCKQUOTE, ""));
          end++;
        }
        const quote = elem("blockquote", { class: "chat-blockquote" });
        const quoteText = quoted.join("\n");
        const nextDepth = quoteDepth + 1;
        if (nextDepth < MAX_BLOCKQUOTE_DEPTH) {
          renderMarkdownInto(quoteText, quote, nextDepth);
        } else {
          // Preserve bounded semantic nesting, then flatten any remaining
          // markers iteratively so hostile input cannot recurse per `>`.
          const flattened = quoteText.split("\n").map(stripBlockquoteRun).join("\n");
          renderMarkdownInto(flattened, quote, nextDepth);
        }
        container.append(quote);
        index = end - 1;
        continue;
      }
      const table = parseTable(lines, index);
      if (table) {
        flushRun();
        flushPara();
        container.append(makeMarkdownTable(table));
        index = table.end - 1;
        continue;
      }
      const line = lines[index];
      const heading = line.match(HEADING);
      if (heading) {
        flushRun();
        flushPara();
        const h = elem(`h${heading[1].length}`, { class: "chat-heading" });
        renderInline(heading[2], h);
        container.append(h);
        continue;
      }
      const kind = BULLET.test(line) ? "ul" : ORDERED.test(line) ? "ol" : null;
      if (kind) {
        const indent = listIndent(line);
        // Only a change of marker at the *base* level starts a new list; a
        // different marker deeper in is ordinary nesting.
        if (runKind && kind !== runKind && indent < run[0].indent + LIST_INDENT_UNIT) flushRun();
        flushPara();
        if (!runKind) runKind = kind;
        run.push({ kind, indent, text: line.replace(kind === "ol" ? ORDERED : BULLET, "") });
      } else if (run.length && line.trim() && listIndent(line) >= run[run.length - 1].indent + LIST_INDENT_UNIT) {
        // Lazy continuation: an indented wrapped line belongs to the item above,
        // not to a new paragraph that would terminate the list.
        run[run.length - 1].text += ` ${line.trim()}`;
      } else {
        flushRun();
        para.push(line);
      }
    }
    flushRun();
    flushPara();
  }
}

function renderInline(text, container) {
  for (const part of text.split(/(`[^`\n]+`)/)) {
    if (part.length > 2 && part[0] === "`" && part[part.length - 1] === "`") {
      const path = part.slice(1, -1);
      const target = openableFilePath(path);
      if (target) {
        const link = elem("button", {
          type: "button",
          class: "chat-inline-code chat-file-link",
          text: path,
          "aria-label": `Open file ${target}`,
          onclick: () => emit("file:open", { path: target }),
        });
        container.append(link);
      } else {
        container.append(elem("code", { class: "chat-inline-code", text: path }));
      }
    } else if (part) {
      renderBold(part, container);
    }
  }
}

const FILE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "avif", "heic", "heif",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
  "txt", "md", "csv", "tsv", "json", "xml", "yaml", "yml", "log",
]);
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;
// `notes.md:67-86` is how agents cite a location; the suffix is not part of the
// file name. It also has to go before the scheme test, which otherwise reads
// `notes.md:` as a URI scheme.
const LINE_SUFFIX = /:\d+(?:[-:]\d+)*$/;
// `profiles/<name>/config.yml`, `{a,b}.yml` and `agents/*.md` name a pattern,
// not a file; linking them only ever produced a 404.
const PATTERN_CHARS = /[<>{}*?|]/;

/** The path to open for a cited file, or null when it is not an openable file. */
function openableFilePath(value) {
  if (!value || value !== value.trim() || /[\0\r\n]/.test(value)) return null;
  const candidate = value.replace(LINE_SUFFIX, "");
  if (URI_SCHEME.test(candidate) || PATTERN_CHARS.test(candidate)) return null;
  // A bare extension (`.txt`) names a file type, not a file.
  if (/(^|[\\/])\.[a-z0-9]+$/i.test(candidate)) return null;
  const match = candidate.match(/\.([a-z0-9]+)$/i);
  return match && FILE_EXTENSIONS.has(match[1].toLowerCase()) ? candidate : null;
}

// The authenticated metadata root plus the backend's
// /<active-session>/<32-hex>.<type> filename invariant distinguishes uploaded
// attachments from look-alike workspace image paths. New chat uploads use
// JSON-string tokens so spaces and quote characters remain unambiguous; the
// other token forms keep old transcripts.
const ATTACHMENT_PATH_TOKEN = /"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]+'|\/[^\s'"]+/g;
const ATTACHMENT_IMAGE_RELATIVE = /^([A-Za-z0-9_-]{1,40})\/[a-f0-9]{32}\.(?:png|jpe?g|gif|webp|bmp|tiff?|avif|heic|heif)$/i;
const imagePreviewResources = new WeakMap();
let imagePreviewObserver = null;

function decodeAttachmentPathToken(token) {
  if (token.startsWith('"')) {
    try {
      const value = JSON.parse(token);
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  }
  if (token.startsWith("'")) return token.slice(1, -1);
  return token;
}

function attachmentImageReferences(text) {
  ATTACHMENT_PATH_TOKEN.lastIndex = 0;
  const references = [];
  const configuredRoot = String(state.meta.attachmentsRoot || "");
  if (!configuredRoot) return references;
  const rootPrefix = configuredRoot === "/" ? "/" : `${configuredRoot.replace(/\/+$/, "")}/`;
  let match;
  while ((match = ATTACHMENT_PATH_TOKEN.exec(text)) !== null) {
    const path = decodeAttachmentPathToken(match[0]);
    if (!path.startsWith(rootPrefix)) continue;
    const relative = path.slice(rootPrefix.length);
    const identity = relative.match(ATTACHMENT_IMAGE_RELATIVE);
    if (!identity || identity[1] !== state.current) continue;
    references.push({ end: ATTACHMENT_PATH_TOKEN.lastIndex, path, start: match.index });
  }
  return references;
}

function attachmentImagePaths(text) {
  const paths = [];
  const seen = new Set();
  for (const reference of attachmentImageReferences(text)) {
    if (seen.has(reference.path)) continue;
    seen.add(reference.path);
    paths.push(reference.path);
  }
  return paths;
}

function stripAttachmentImagePaths(text) {
  const references = attachmentImageReferences(text);
  if (!references.length) return text;
  let display = "";
  let start = 0;
  for (const reference of references) {
    display += text.slice(start, reference.start);
    start = reference.end;
  }
  return (display + text.slice(start))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function releaseImagePreview(card) {
  imagePreviewObserver?.unobserve(card);
  const resource = imagePreviewResources.get(card);
  if (!resource) return;
  resource.controller?.abort();
  if (resource.url) URL.revokeObjectURL(resource.url);
  imagePreviewResources.delete(card);
}

function releaseImagePreviews(root) {
  if (!root) return;
  if (root.matches?.(".chat-image-preview")) releaseImagePreview(root);
  for (const card of root.querySelectorAll?.(".chat-image-preview") || []) {
    releaseImagePreview(card);
  }
}

async function loadImagePreview(card) {
  const resource = imagePreviewResources.get(card);
  if (!resource || resource.started || !card.isConnected) return;
  resource.started = true;
  resource.controller = new AbortController();
  try {
    const response = await apiResponse(
      `/sessions/${encodeURIComponent(resource.sessionId)}/file?path=${encodeURIComponent(resource.path)}`,
      { signal: resource.controller.signal },
    );
    const mime = String(response.headers.get("content-type") || "").toLowerCase();
    if (!mime.startsWith("image/")) throw new Error("File is not an image");
    const blob = await response.blob();
    if (!card.isConnected || resource.sessionId !== state.current) return;
    const url = URL.createObjectURL(blob);
    resource.url = url;
    resource.controller = null;
    const image = elem("img", { class: "chat-image-preview-image", alt: "" });
    image.addEventListener("load", () => { card.dataset.state = "ready"; }, { once: true });
    image.addEventListener("error", () => {
      if (resource.url === url) {
        URL.revokeObjectURL(url);
        resource.url = null;
      }
      card.dataset.state = "error";
      card.replaceChildren(elem("span", { class: "chat-image-preview-label" }, "Preview unavailable"));
    }, { once: true });
    image.src = url;
    card.replaceChildren(image);
  } catch (error) {
    if (error.name === "AbortError" || !card.isConnected) return;
    resource.controller = null;
    card.dataset.state = "error";
    card.replaceChildren(elem("span", { class: "chat-image-preview-label" }, "Preview unavailable"));
  }
}

function observeImagePreview(card) {
  if (!("IntersectionObserver" in window)) {
    void loadImagePreview(card);
    return;
  }
  if (!imagePreviewObserver) {
    imagePreviewObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        imagePreviewObserver.unobserve(entry.target);
        void loadImagePreview(entry.target);
      }
    }, { root: el["chat-log"], rootMargin: "240px 0px" });
  }
  imagePreviewObserver.observe(card);
}

function buildImagePreviews(paths) {
  if (!paths.length) return null;
  const sessionId = state.current;
  const grid = elem("div", {
    class: `chat-image-grid${paths.length === 1 ? " chat-image-grid-single" : ""}`,
  });
  paths.forEach((path, index) => {
    const card = elem("button", {
      type: "button",
      class: "chat-image-preview",
      "aria-label": paths.length === 1 ? "Open attached image" : `Open attached image ${index + 1}`,
      onclick: () => emit("file:open", { path }),
    }, elem("span", { class: "chat-image-preview-label" }, "Loading image…"));
    imagePreviewResources.set(card, {
      controller: null,
      path,
      sessionId,
      started: false,
      url: null,
    });
    grid.append(card);
    observeImagePreview(card);
  });
  return grid;
}

function renderBold(text, container) {
  for (const part of text.split(/(\*\*[^*\n]+\*\*)/)) {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      const bold = elem("strong");
      renderEmphasis(part.slice(2, -2), bold);
      container.append(bold);
    } else if (part) {
      renderEmphasis(part, container);
    }
  }
}

function renderEmphasis(text, container) {
  for (const part of text.split(/(\*[^*\n]+\*)/)) {
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
      const emphasis = elem("em");
      renderLinks(part.slice(1, -1), emphasis);
      container.append(emphasis);
    } else if (part) {
      renderLinks(part, container);
    }
  }
}

const LINK = /\[([^\]\n]+)\]\(([^()\s]+)\)|(https?:\/\/[^\s<]+)/gi;
const TRAILING_URL_PUNCTUATION = /[.,;:!?)]$/;

function appendLink(label, href, container) {
  const target = openableFilePath(href);
  if (target) {
    const button = elem("button", {
      type: "button",
      class: "chat-link chat-file-reference",
      title: target,
      "aria-label": `Open file ${target}`,
      onclick: () => emit("file:open", { path: target }),
    }, label);
    container.append(button);
    return true;
  }
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const link = elem("a", {
      class: "chat-link",
      href: url.href,
      target: "_blank",
      rel: "noopener noreferrer",
    }, label);
    container.append(link);
    return true;
  } catch {
    return false;
  }
}

const INLINE_MATH = /\\\((.*?)\\\)/g;

function appendTextWithMath(text, container) {
  INLINE_MATH.lastIndex = 0;
  let pos = 0;
  let match;
  while ((match = INLINE_MATH.exec(text)) !== null) {
    if (match.index > pos) container.append(document.createTextNode(text.slice(pos, match.index)));
    container.append(makeMathInline(match[1]));
    pos = match.index + match[0].length;
  }
  if (pos < text.length) container.append(document.createTextNode(text.slice(pos)));
}

function renderLinks(text, container) {
  LINK.lastIndex = 0;
  let pos = 0;
  let match;
  while ((match = LINK.exec(text)) !== null) {
    if (match.index > pos) appendTextWithMath(text.slice(pos, match.index), container);
    let href = match[2] || match[3];
    let trailing = "";
    if (!match[2]) {
      while (TRAILING_URL_PUNCTUATION.test(href)) {
        trailing = href.slice(-1) + trailing;
        href = href.slice(0, -1);
      }
    }
    if (!appendLink(match[1] || href, href, container)) {
      appendTextWithMath(match[0], container);
      trailing = "";
    }
    if (trailing) appendTextWithMath(trailing, container);
    pos = match.index + match[0].length;
  }
  if (pos < text.length) appendTextWithMath(text.slice(pos), container);
}

// ── Per-kind builders ────────────────────────────────────────────────────────

function buildUser(item) {
  const text = item.text || "";
  const imagePaths = attachmentImagePaths(text);
  const displayText = imagePaths.length ? stripAttachmentImagePaths(text) : text;
  const previewEnd = compactUserTextEnd(displayText);
  const previewText = displayText.slice(0, previewEnd);
  const hasCompactPreview = previewEnd < displayText.length;
  const expanded = hasCompactPreview && expandedUserIds.has(item.id);
  const userText = displayText
    ? elem("div", {
      class: `chat-user-text${hasCompactPreview && !expanded ? " is-collapsed" : ""}`,
    }, expanded ? displayText : previewText)
    : null;
  const bubble = elem(
    "div",
    { class: `chat-bubble${imagePaths.length ? " has-images" : ""}${displayText ? "" : " image-only"}` },
    buildImagePreviews(imagePaths),
    userText,
  );
  if (hasCompactPreview) {
    const disclosure = elem("button", {
      class: "ghost chat-user-disclosure",
      type: "button",
      "aria-expanded": String(expanded),
    }, expanded ? "Show less" : "Show more");
    disclosure.addEventListener("click", () => {
      const next = disclosure.getAttribute("aria-expanded") !== "true";
      if (next) {
        expandedUserIds.add(item.id);
        setFollowTail(false);
      } else {
        expandedUserIds.delete(item.id);
      }
      disclosure.setAttribute("aria-expanded", String(next));
      disclosure.textContent = next ? "Show less" : "Show more";
      userText.textContent = next ? displayText : previewText;
      userText.classList.toggle("is-collapsed", !next);
      if (!next) bubble.scrollIntoView({ block: "nearest" });
    });
    bubble.append(disclosure);
  }

  const meta = elem("div", { class: "chat-user-meta" });
  if (item.pending) {
    meta.append(elem("span", { class: "chat-user-state" }, item.statusText || "Queued"));
  } else if (item.failed) {
    const label = item.deliveryUnknown ? "Delivery unknown" : (item.errorText || "Send failed");
    meta.append(elem("span", { class: "chat-user-state" }, label));
    const retry = elem("button", { class: "ghost chat-action-btn", type: "button" }, "Retry");
    retry.addEventListener("click", () => emit("chat:retry", { id: item.id }));
    const edit = elem("button", { class: "ghost chat-action-btn", type: "button" }, "Edit");
    edit.addEventListener("click", () => emit("chat:edit", { id: item.id }));
    meta.append(elem("div", {
      class: "chat-message-actions chat-delivery-actions",
      role: "group",
      "aria-label": "Delivery actions",
    }, retry, edit));
  }
  if (item.truncated) {
    meta.append(elem("span", { class: "chat-message-truncated chat-user-state" }, "Truncated preview"));
  }
  meta.append(messageActions(item, text));
  const content = elem("div", { class: "chat-user-content" }, bubble, meta);
  // A user message is where a turn begins, and it is the only anchor the
  // transcript has: without it the log is continuous prose and scrolling back
  // means reading rather than scanning. The per-message clock toggle stays for
  // individual messages; this one is always on.
  const startedAt = formatTurnTime(item.at);
  const turnStart = elem("div", { class: "chat-turn-start", "aria-hidden": "true" },
    elem("span", { class: "chat-turn-rule" }),
    startedAt ? elem("time", { class: "chat-turn-time", datetime: item.at }, startedAt) : null);
  return elem("div", {
    class: `chat-item chat-user${item.pending ? " chat-user-pending" : ""}${item.failed ? " chat-user-failed" : ""}`,
    "data-id": item.id,
  }, turnStart, content);
}

function buildAssistant(item) {
  const body = elem("div", { class: "chat-assistant-body" });
  // Agent identity, reference-style: a small name line opens each run of
  // assistant turns; CSS hides it on consecutive assistant items.
  const label = elem("div", { class: "chat-agent-label", "aria-hidden": "true" },
    elem("span", { class: "chat-agent-mark" }, "◆"),
    elem("span", { class: "chat-agent-name" }, "omp"),
  );
  body.append(label);
  if (item.text) {
    body.append(renderMarkdown(item.text));
    const previews = buildImagePreviews(attachmentImagePaths(item.text));
    if (previews) body.append(previews);
  }
  if (item.truncated) {
    body.append(elem("span", { class: "chat-message-truncated chat-chip chat-chip-trunc" }, "Truncated preview"));
  }
  const actions = messageActions(item, item.text || "");
  if (item.id === lastAssistantId) {
    // The shared resumption path replays the last user input as a new turn;
    // the transcript reaches it directly so no new event names are needed.
    const regenerate = elem("button", {
      class: "ghost chat-action-btn",
      type: "button",
      title: "Regenerate reply from the last message",
      "aria-label": "Regenerate reply from the last message",
    }, "Regenerate");
    regenerate.addEventListener("click", () => {
      if (typeof window !== "undefined" && typeof window.regenerateLast === "function") {
        window.regenerateLast();
      }
    });
    actions.append(regenerate);
  }
  body.append(actions);
  return elem("div", { class: "chat-item chat-assistant", "data-id": item.id }, body);
}

function buildToolSections(item) {
  const frag = document.createDocumentFragment();
  if (item.args != null) {
    frag.append(elem("div", { class: "chat-tool-section" },
      elem("div", { class: "chat-section-label" }, "args"),
      makeCodeBlock(item.args),
    ));
  }
  if (item.resultText != null) {
    frag.append(elem("div", { class: "chat-tool-section" },
      elem("div", { class: "chat-section-label" }, "result"),
      makeCodeBlock(item.resultText),
    ));
  }
  if (Array.isArray(item.changes) && item.changes.length) {
    const list = elem("div", { class: "chat-tool-changes" });
    for (const change of item.changes) {
      const stats = [];
      if (typeof change.added === "number") stats.push(`+${change.added}`);
      if (typeof change.removed === "number") stats.push(`−${change.removed}`);
      list.append(elem("div", { class: "chat-tool-change" },
        elem("span", { class: "chat-change-path" }, change.path || ""),
        stats.length ? elem("span", { class: "chat-change-stats" }, stats.join(" ")) : null,
      ));
    }
    if (item.changesTruncated) {
      list.append(elem("span", { class: "chat-chip chat-chip-trunc" }, "More files omitted"));
    }
    frag.append(elem("div", { class: "chat-tool-section" },
      elem("div", { class: "chat-section-label" }, "changed files"),
      list,
    ));
  }
  return frag;
}

function buildTool(item, group) {
  const state = item.state || "running";
  const badge = elem("span", { class: `chat-state-badge chat-state-${state}` }, state);
  const summary = elem("summary", { class: "chat-tool-summary" },
    elem("span", { class: "chat-tool-name" }, item.name || "(tool)"),
    item.intent ? elem("span", { class: "chat-tool-intent" }, item.intent) : null,
    badge,
  );
  const chips = [];
  if (item.exitCode != null) chips.push(elem("span", { class: "chat-chip chat-chip-err" }, `exit ${item.exitCode}`));
  if (item.durationMs != null) chips.push(elem("span", { class: "chat-chip" }, formatDuration(item.durationMs)));
  if (item.truncated) chips.push(elem("span", { class: "chat-chip chat-chip-trunc" }, "…truncated"));
  if (chips.length) summary.append(elem("span", { class: "chat-tool-chips" }, ...chips));

  const details = elem("details", { class: `chat-tool-details chat-tool-${state}` }, summary);
  const populate = () => {
    if (details.childElementCount === 1) details.append(buildToolSections(item));
  };
  if (openToolIds.has(item.id)) {
    details.open = true;
    populate();
  }
  details.addEventListener("toggle", () => {
    if (details.open) {
      openToolIds.add(item.id);
      populate();
    } else {
      openToolIds.delete(item.id);
      while (details.childElementCount > 1) details.lastElementChild.remove();
    }
  });
  const node = elem("div", { class: "chat-item chat-tool", "data-id": item.id }, details);
  group.toolNodes.set(item.id, node);
  return node;
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60000) return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)}s`;
  const minutes = Math.floor(durationMs / 60000);
  return `${minutes}m ${Math.round((durationMs % 60000) / 1000)}s`;
}

// A thinking item joins the group so reasoning between two tool calls does not
// split one run into three timeline rows, but it is not a tool: it contributes
// only its headline, never a name, duration or failure count.
function isGroupMember(item) {
  return Boolean(item) && (item.kind === "tool" || item.kind === "thinking");
}

// Codex's approach: models bold the conclusion of a reasoning step, so the last
// bold span is the closest thing to a one-line "what I am doing now".
function thinkingHeadline(text) {
  const source = String(text || "");
  let headline = "";
  for (const match of source.matchAll(/\*\*([^*\n]{3,120})\*\*/g)) headline = match[1];
  if (!headline) {
    headline = (source.split("\n").find((line) => line.trim()) || "")
      .replace(/[`*_#>\[\]]/g, "");
  }
  headline = headline.replace(/\s+/g, " ").trim();
  const stop = headline.search(/[.!?]\s/);
  if (stop > 8) headline = headline.slice(0, stop + 1);
  return headline.length > 80 ? headline.slice(0, 79).trimEnd() + "\u2026" : headline;
}

function buildGroupMember(item, group) {
  return item.kind === "thinking" ? buildThinking(item) : buildTool(item, group);
}

function buildThinking(item) {
  const body = elem("div", { class: "chat-thinking-body" });
  body.append(renderMarkdown(item.text || ""));
  const node = elem("div", { class: "chat-thinking", "data-id": item.id }, body);
  if (item.truncated) {
    node.append(elem("span", { class: "chat-chip chat-chip-trunc" }, "truncated"));
  }
  return node;
}

function updateGroupStats(group, item, direction) {
  if (item.kind === "thinking") {
    group.thinking += direction;
    if (direction > 0) group.headline = thinkingHeadline(item.text);
    return;
  }
  const name = item.name || "(tool)";
  const next = (group.counts.get(name) || 0) + direction;
  if (next > 0) group.counts.set(name, next);
  else group.counts.delete(name);
  group.total += direction;
  if ((item.state || "running") === "running") group.running += direction;
  if (item.state === "error") group.failed += direction;
  if (Number.isFinite(item.durationMs)) group.durationMs += direction * item.durationMs;
  for (const change of Array.isArray(item.changes) ? item.changes : []) {
    const path = typeof change?.path === "string" ? change.path : "";
    if (!path) continue;
    const next = (group.changed.get(path) || 0) + direction;
    if (next > 0) group.changed.set(path, next);
    else group.changed.delete(path);
  }
  if (item.changesTruncated && direction > 0) group.changedTruncated = true;
}

// Collapsed group headers speak plain language, never backend tool names.
// toolKind folds the open-ended upstream tool namespace into fixed human
// categories; the names below are matched, never rendered.
function toolKind(name) {
  switch (String(name || "").toLowerCase()) {
    case "edit":
    case "apply_patch":
    case "ast_edit":
    case "write":
      return "edit";
    case "bash":
    case "exec":
      return "command";
    case "read":
      return "read";
    case "grep":
    case "glob":
    case "web_search":
    case "search":
      return "search";
    case "task":
      return "task";
    default:
      return "other";
  }
}

// One plain phrase per kind present, e.g. "Edited 3 files". The file count
// prefers structured change evidence (one batched edit can touch many
// files) and falls back to the edit-call count (writes leave no changes).
function groupKindPhrases(group) {
  const totals = new Map();
  for (const [name, count] of group.counts) {
    const kind = toolKind(name);
    totals.set(kind, (totals.get(kind) || 0) + count);
  }
  const phrases = [];
  const fromChanges = group.changed.size > 0;
  const edited = fromChanges ? group.changed.size : (totals.get("edit") || 0);
  if (edited > 0) {
    // A truncated change list understates the count; say so with a +.
    const more = fromChanges && group.changedTruncated;
    phrases.push(`Edited ${edited}${more ? "+" : ""} file${edited === 1 && !more ? "" : "s"}`);
  }
  const commands = totals.get("command") || 0;
  if (commands > 0) phrases.push(`Ran ${commands} command${commands === 1 ? "" : "s"}`);
  const reads = totals.get("read") || 0;
  if (reads > 0) phrases.push(`Looked at ${reads} file${reads === 1 ? "" : "s"}`);
  const searches = totals.get("search") || 0;
  if (searches > 0) phrases.push(`Ran ${searches} search${searches === 1 ? "" : "es"}`);
  const tasks = totals.get("task") || 0;
  if (tasks > 0) phrases.push(`Ran ${tasks} task${tasks === 1 ? "" : "s"}`);
  const other = totals.get("other") || 0;
  if (other > 0) phrases.push(`Did ${other} other step${other === 1 ? "" : "s"}`);
  return phrases;
}

// A live group's current step is the latest running tool's own intent text,
// already human and written by the agent. A raw tool name is never a
// headline; with nothing human to show the fallback is "Thinking".
function liveStepHeadline(group) {
  let step = "";
  for (const id of group.memberIds) {
    const member = itemData.get(id);
    if (member && member.kind === "tool" && (member.state || "running") === "running" && member.intent) {
      step = member.intent;
    }
  }
  return step;
}

function renderToolGroupSummary(group) {
  if (!group.summary) return;
  const phrases = groupKindPhrases(group);
  const duration = group.durationMs > 0 ? formatDuration(group.durationMs) : "";
  const label = group.running ? "Working" : (group.total === 0 ? "Thought" : "Worked");
  // The agent's own words first: the latest reasoning headline, then the
  // live step's intent while work is in flight. Settled groups rest on the
  // counts; a live group with nothing human yet says "Thinking".
  const headline = group.headline || (group.running ? (liveStepHeadline(group) || "Thinking") : "");
  const stateParts = [];
  if (group.running) stateParts.push(`${group.running} running`);
  if (group.failed) stateParts.push(`${group.failed} failed`);
  if (group.thinking) stateParts.push(`${group.thinking} thought${group.thinking === 1 ? "" : "s"}`);
  if (!stateParts.length) stateParts.push("complete");
  const durationDescription = duration ? `${duration} total` : "";
  group.summary.setAttribute("aria-label", [
    label,
    ...phrases,
    headline,
    ...stateParts,
    durationDescription,
  ].filter(Boolean).join("; "));
  group.summary.title = [
    phrases.join(" · "),
    ...stateParts,
    durationDescription,
  ].filter(Boolean).join(" · ");
  // Native replaceChildren stringifies null (unlike elem()).
  group.summary.replaceChildren(elem("span", { class: "chat-tool-group-label" }, label));
  if (phrases.length) group.summary.append(elem("span", { class: "chat-tool-group-counts" }, phrases.join(" · ")));
  if (headline) group.summary.append(
    elem("span", { class: "chat-tool-group-headline" }, headline),
  );
  if (duration) group.summary.append(
    elem("span", { class: "chat-tool-group-duration" }, duration),
  );
  if (group.failed) group.summary.append(
    elem("span", { class: "chat-tool-group-failure" }, `${group.failed} failed`),
  );
}

function renderToolGroupBody(group) {
  if (!group.body) return;
  const frag = document.createDocumentFragment();
  group.toolNodes.clear();
  for (const id of group.memberIds) {
    const item = itemData.get(id);
    if (item) frag.append(buildGroupMember(item, group));
  }
  group.body.replaceChildren(frag);
}

function buildToolGroup(group) {
  const summary = elem("summary", { class: "chat-tool-group-summary" });
  const body = elem("div", { class: "chat-tool-group-body" });
  const details = elem("details", { class: "chat-tool-group-details" }, summary, body);
  group.summary = summary;
  group.body = body;
  group.details = details;
  renderToolGroupSummary(group);
  if (group.open) {
    details.open = true;
    renderToolGroupBody(group);
  }
  details.addEventListener("toggle", () => {
    group.open = details.open;
    if (group.open) renderToolGroupBody(group);
    else {
      body.replaceChildren();
      group.toolNodes.clear();
    }
  });
  return elem("div", { class: "chat-item chat-tool-group", "data-id": group.id }, details);
}

function buildNotice(item) {
  return elem("div", { class: "chat-item chat-notice", "data-id": item.id },
    elem("span", { class: "chat-notice-attr" }, item.attribution || "system"),
    elem("span", { class: "chat-notice-text" }, item.text || ""),
  );
}

// Error cards always offer a resumption path. The descriptor rides along as an
// optional `action` so old payloads without one still resolve: well-known ids
// fall back to their retry kind, anything else regenerates the last turn.
function errorRetryKind(item) {
  const name = item && item.action && item.action.action;
  if (name === "retry-poll" || name === "retry-interrupt" || name === "regenerate") return name;
  if (item && item.id === "chat-poll-error") return "retry-poll";
  if (item && item.id === "chat-interrupt-error") return "retry-interrupt";
  return "regenerate";
}

function buildError(item) {
  const node = elem("div", { class: "chat-item chat-error", "data-id": item.id, role: "alert" },
    elem("strong", { class: "chat-error-label" }, item.status ? `Error ${item.status}` : "Session error"),
    elem("div", { class: "chat-error-text" }, item.text || "The session could not continue."),
  );
  if (item.truncated) node.append(elem("span", { class: "chat-message-truncated chat-chip chat-chip-trunc" }, "Truncated preview"));
  // Direct window calls keep this working without new emit/get names, which
  // would unbalance the check:events contract main.js relies on.
  const retry = elem("button", { class: "ghost chat-action-btn chat-error-retry", type: "button" }, "Retry");
  retry.setAttribute("aria-label", "Retry");
  retry.addEventListener("click", () => {
    const sessionId = item && item.action && item.action.sessionId;
    const kind = errorRetryKind(item);
    if (kind === "retry-poll") window.retryPollTurn?.(sessionId);
    else if (kind === "retry-interrupt") window.retryInterrupt?.(sessionId);
    else window.regenerateLast?.(sessionId);
  });
  node.append(elem("div", {
    class: "chat-error-actions",
    role: "group",
    "aria-label": "Error actions",
  }, retry));
  return node;
}

function buildEvent(item) {
  return elem("div", { class: "chat-item chat-event", "data-id": item.id }, item.text || "");
}

function buildItem(item) {
  switch (item.kind) {
    case "user": return buildUser(item);
    case "assistant": return buildAssistant(item);
    case "notice": return buildNotice(item);
    case "error": return buildError(item);
    case "event": return buildEvent(item);
    default: return null;
  }
}

// ── Timeline model and bounded DOM window ────────────────────────────────────

function insertTimeline(id, at) {
  timestamps.set(id, at || "");
  if (!at || timeline.length === 0) {
    timeline.push(id);
    return;
  }
  for (let index = timeline.length - 1; index >= 0; index--) {
    if ((timestamps.get(timeline[index]) || "") <= at) {
      timeline.splice(index + 1, 0, id);
      return;
    }
  }
  timeline.unshift(id);
}

function createToolGroup(item) {
  const group = {
    id: `tool-group:${groupSequence++}:${item.id}`,
    at: item.at || "",
    memberIds: [],
    thinking: 0,
    headline: "",
    counts: new Map(),
    total: 0,
    running: 0,
    failed: 0,
    durationMs: 0,
    // Which files this turn actually touched, sourced only from structured
    // successful edit results (item.changes), never from prose. Feeds the
    // collapsed "Edited N files" count.
    changed: new Map(),
    changedTruncated: false,
    open: false,
    summary: null,
    body: null,
    details: null,
    toolNodes: new Map(),
  };
  groups.set(group.id, group);
  insertTimeline(group.id, group.at);
  currentToolGroup = group;
  return group;
}

function addGroupMember(item) {
  let group = currentToolGroup;
  if (!group || timeline[timeline.length - 1] !== group.id) group = createToolGroup(item);
  group.memberIds.push(item.id);
  toolGroups.set(item.id, group);
  itemData.set(item.id, item);
  timestamps.set(item.id, item.at || "");
  updateGroupStats(group, item, 1);
  renderToolGroupSummary(group);
  if (group.open && group.body) group.body.append(buildGroupMember(item, group));
}

function entryNode(id) {
  let node = nodes.get(id);
  if (node) return node;
  const group = groups.get(id);
  node = group ? buildToolGroup(group) : buildItem(itemData.get(id));
  if (node) nodes.set(id, node);
  return node;
}

function detachEntry(id) {
  const node = nodes.get(id);
  if (node) {
    releaseImagePreviews(node);
    node.remove();
  }
  nodes.delete(id);
  const group = groups.get(id);
  if (group) {
    group.summary = null;
    group.body = null;
    group.details = null;
    group.toolNodes.clear();
  }
}

function historyButton(direction, hiddenCount, container) {
  const count = Math.min(HISTORY_STEP, hiddenCount);
  const earlier = direction === "earlier";
  const button = elem("button", {
    class: `ghost chat-history-reveal chat-history-${direction}`,
    type: "button",
  }, `${earlier ? "Show" : "Return to"} ${count} ${earlier ? "earlier" : "later"}`);
  button.addEventListener("click", () => {
    windowStart = earlier
      ? Math.max(0, windowStart - HISTORY_STEP)
      : Math.min(tailStart(), windowStart + HISTORY_STEP);
    setFollowTail(false);
    syncRenderedWindow(container);
    container.scrollTop = earlier ? container.scrollHeight : 0;
    observedScrollTop = container.scrollTop;
  });
  return button;
}

function placeActivityNode(container) {
  const activity = el["chat-activity"];
  if (!activity) return;
  if (!isTailWindow()) {
    activity.remove();
    return;
  }
  if (activity.parentNode !== container || activity !== container.lastElementChild) {
    container.append(activity);
  }
}

function syncRenderedWindow(container) {
  const maxStart = tailStart();
  windowStart = Math.max(0, Math.min(windowStart, maxStart));
  const desired = timeline.slice(windowStart, windowStart + WINDOW_SIZE);
  const desiredSet = new Set(desired);
  for (const id of Array.from(nodes.keys())) {
    if (!desiredSet.has(id)) detachEntry(id);
  }

  const frag = document.createDocumentFragment();
  if (windowStart > 0) frag.append(historyButton("earlier", windowStart, container));
  for (const id of desired) {
    const node = entryNode(id);
    if (node) frag.append(node);
  }
  const laterCount = timeline.length - (windowStart + desired.length);
  if (laterCount > 0) frag.append(historyButton("later", laterCount, container));
  container.replaceChildren(frag);
  placeActivityNode(container);
}

function replaceRenderedItem(item) {
  const existing = nodes.get(item.id);
  if (!existing) return;
  const fresh = buildItem(item);
  if (!fresh) return;
  releaseImagePreviews(existing);
  existing.replaceWith(fresh);
  nodes.set(item.id, fresh);
}

function replaceRenderedTool(group, item) {
  renderToolGroupSummary(group);
  if (!group.open || !group.body) return;
  const existing = group.toolNodes.get(item.id);
  if (!existing) {
    renderToolGroupBody(group);
    return;
  }
  const fresh = buildTool(item, group);
  existing.replaceWith(fresh);
}

// ── Public API ───────────────────────────────────────────────────────────────
export function syncActivityNode() {
  const container = el["chat-log"];
  if (!container) return;
  placeActivityNode(container);
  if (followTail && isTailWindow()) scrollToTail(container, false);
}


// Delivered user text for edit-and-resend: the composer owns the draft, so
// chat.js resolves the text here while the original turn stays untouched (a
// resend is a new turn, never a rewrite).
export function deliveredUserText(id) {
  const item = itemData.get(id);
  if (!item || item.kind !== "user" || item.pending || item.failed) return "";
  return typeof item.text === "string" ? item.text : "";
}

export function upsertItems(items) {
  const container = el["chat-log"];
  if (!container || !Array.isArray(items)) return;
  wireTailFollow(container);
  let structuralChange = false;

  for (const item of items) {
    if (!item || !item.id) continue;
    const previous = itemData.get(item.id);
    if (previous) {
      if (isGroupMember(previous) && previous.kind === item.kind) {
        const group = toolGroups.get(item.id);
        if (!group) continue;
        updateGroupStats(group, previous, -1);
        itemData.set(item.id, item);
        timestamps.set(item.id, item.at || "");
        updateGroupStats(group, item, 1);
        replaceRenderedTool(group, item);
      } else if (previous.kind === item.kind) {
        itemData.set(item.id, item);
        timestamps.set(item.id, item.at || "");
        replaceRenderedItem(item);
      } else {
        removeItem(item.id);
        structuralChange = true;
        if (isGroupMember(item)) addGroupMember(item);
        else {
          currentToolGroup = null;
          itemData.set(item.id, item);
          insertTimeline(item.id, item.at);
        }
      }
      continue;
    }

    structuralChange = true;
    if (isGroupMember(item)) {
      addGroupMember(item);
    } else {
      currentToolGroup = null;
      itemData.set(item.id, item);
      insertTimeline(item.id, item.at);
    }
  }
  if (structuralChange) lastAssistantId = tailAssistantId();
  if (followTail) windowStart = tailStart();
  if (structuralChange) syncRenderedWindow(container);
  if (followTail) scrollToTail(container, false);
}

export function removeItem(id) {
  const item = itemData.get(id);
  if (!item) return;
  const container = el["chat-log"];
  if (isGroupMember(item)) {
    const group = toolGroups.get(id);
    if (group) {
      updateGroupStats(group, item, -1);
      group.memberIds = group.memberIds.filter(toolId => toolId !== id);
      group.toolNodes.get(id)?.remove();
      group.toolNodes.delete(id);
      toolGroups.delete(id);
      if (!group.memberIds.length) {
        const index = timeline.indexOf(group.id);
        if (index !== -1) timeline.splice(index, 1);
        detachEntry(group.id);
        groups.delete(group.id);
        timestamps.delete(group.id);
        if (currentToolGroup === group) currentToolGroup = null;
      } else {
        renderToolGroupSummary(group);
      }
    }
  } else {
    const index = timeline.indexOf(id);
    if (index !== -1) timeline.splice(index, 1);
    detachEntry(id);
  }
  openToolIds.delete(id);
  visibleTimeIds.delete(id);
  expandedUserIds.delete(id);
  itemData.delete(id);
  // A removed assistant may have owned the Regenerate affordance; the sync
  // below rebuilds the tail, so refresh which turn it points at first.
  lastAssistantId = tailAssistantId();
  if (container) {
    if (followTail) windowStart = tailStart();
    syncRenderedWindow(container);
    if (followTail) scrollToTail(container, false);
  }
}

export function clearLog() {
  const container = el["chat-log"];
  for (const node of nodes.values()) releaseImagePreviews(node);
  itemData.clear();
  timestamps.clear();
  nodes.clear();
  toolGroups.clear();
  groups.clear();
  timeline.length = 0;
  openToolIds.clear();
  visibleTimeIds.clear();
  expandedUserIds.clear();
  lastAssistantId = null;
  currentToolGroup = null;
  groupSequence = 0;
  windowStart = 0;
  setFollowTail(true);
  if (container) {
    container.replaceChildren();
    placeActivityNode(container);
    observedScrollTop = container.scrollTop;
  }
}
