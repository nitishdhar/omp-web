"use strict";
// Renders ./data.json into #app. Agents change the page by rewriting
// data.json (write data.json.tmp, then rename it over data.json); this file
// only holds the layout. Data text is only ever set through textContent.
const app = document.getElementById("app");
let stamp = null;
let stampValue = "";

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Only absolute http(s) and mailto links become anchors; anything else
// (javascript:, data:, relative paths) renders as plain text.
function link(href, label) {
  let safe = null;
  if (typeof href === "string") {
    try {
      const parsed = new URL(href.trim());
      if (["http:", "https:", "mailto:"].includes(parsed.protocol)) safe = parsed.href;
    } catch {
      safe = null;
    }
  }
  return safe
    ? h("a", { href: safe, target: "_blank", rel: "noopener noreferrer" }, label)
    : h("span", null, label);
}

function relativeTime(value) {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return "";
  const seconds = Math.round((Date.now() - time) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(time).toLocaleDateString();
}

function updateStamp() {
  if (!stamp) return;
  const text = relativeTime(stampValue);
  stamp.textContent = text ? `Updated ${text}` : "";
  stamp.title = text ? new Date(stampValue).toLocaleString() : "";
}

function header(data) {
  const title = typeof data.title === "string" && data.title ? data.title : "Untitled";
  document.title = title;
  stamp = h("p", { class: "updated" });
  stampValue = data.updatedAt;
  updateStamp();
  return h("header", null, h("h1", null, title), stamp);
}

function emptyState(message) {
  return h("p", { class: "empty" }, message);
}

function showError(error) {
  stamp = null;
  app.replaceChildren(
    h("div", { class: "error", role: "alert" },
      h("h1", null, "Could not load this page's data"),
      h("p", null, String(error && error.message || error)),
      h("button", { type: "button", id: "retry" }, "Try again")),
  );
  document.getElementById("retry").addEventListener("click", load);
}

async function load() {
  try {
    const response = await fetch("./data.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`data.json answered HTTP ${response.status}`);
    const data = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("data.json must hold a JSON object");
    app.replaceChildren(header(data), render(data));
  } catch (error) {
    showError(error);
  }
}

function card(entry) {
  const title = typeof entry.title === "string" ? entry.title : "";
  return h("article", { class: "card" },
    h("h2", null, entry.link ? link(entry.link, title) : title),
    typeof entry.body === "string" && entry.body ? h("p", { class: "card-body" }, entry.body) : null,
    typeof entry.meta === "string" && entry.meta ? h("p", { class: "meta" }, entry.meta) : null);
}

function render(data) {
  const cards = Array.isArray(data.cards) ? data.cards.filter((entry) => entry && typeof entry === "object") : [];
  if (!cards.length) return h("main", null, emptyState("No cards yet."));
  return h("main", { class: "cards" }, cards.map(card));
}

// Reload when the tab comes back, so a page left open shows the latest data.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") load();
});
setInterval(updateStamp, 60_000);
load();
