"use strict";
// Hover "…" popover menu. One instance, repositioned per open. Click-outside
// and Escape close it.

import { elem } from "../dom.js";
import { icon } from "../icons.js";

let menuEl = null;
let opener = null;
let open = false;

function focusableItems() {
  return menuEl ? [...menuEl.querySelectorAll(".pop-item")] : [];
}

function ensure() {
  if (menuEl) return menuEl;
  menuEl = elem("div", {
    class: "pop-menu",
    id: "pop-menu",
    role: "menu",
    hidden: true,
  });
  menuEl.addEventListener("click", (e) => e.stopPropagation());
  menuEl.addEventListener("keydown", (e) => {
    const items = focusableItems();
    const current = items.indexOf(document.activeElement);
    let next = null;
    if (e.key === "ArrowDown") next = items[(current + 1) % items.length];
    else if (e.key === "ArrowUp") next = items[(current - 1 + items.length) % items.length];
    else if (e.key === "Home") next = items[0];
    else if (e.key === "End") next = items[items.length - 1];
    else if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    } else if (e.key === "Tab") {
      close({ restoreFocus: false });
      return;
    }
    if (next) {
      e.preventDefault();
      next.focus();
    }
  });
  document.body.appendChild(menuEl);
  document.addEventListener("click", (e) => {
    if (!open || menuEl.contains(e.target) || opener?.contains(e.target)) return;
    close({ restoreFocus: false });
  });
  document.addEventListener("keydown", (e) => {
    if (open && e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  window.addEventListener("resize", () => close());
  return menuEl;
}

export function close({ restoreFocus = true } = {}) {
  const returnTo = opener;
  if (menuEl) menuEl.hidden = true;
  if (returnTo) returnTo.setAttribute("aria-expanded", "false");
  opener = null;
  open = false;
  if (restoreFocus && returnTo?.isConnected) returnTo.focus();
}

// items: [{ label, icon?, danger?, action: fn }]
// detail: optional [{ label, value }] grid rendered under the title — the
// session's "what/where/when" card that used to exist only as a hover tooltip.
export function show(anchor, title, items, detail = null) {
  const m = ensure();
  if (open && opener === anchor) {
    close();
    return;
  }
  if (open) close({ restoreFocus: false });
  opener = anchor;
  anchor.setAttribute("aria-expanded", "true");
  anchor.setAttribute("aria-controls", "pop-menu");
  m.setAttribute("aria-label", title ? `Actions for ${title}` : "Actions");
  const detailNode = detail && detail.length
    ? elem("dl", { class: "pop-detail" },
        ...detail.flatMap(({ label, value }) => [
          elem("dt", { text: label }),
          elem("dd", { text: String(value ?? "—") }),
        ]))
    : "";
  m.replaceChildren(
    title ? elem("div", { class: "pop-title", text: title }) : "",
    detailNode,
    ...items.map((item) =>
      elem("button", {
        class: "pop-item" + (item.danger ? " danger" : ""),
        type: "button",
        role: "menuitem",
        onclick: () => {
          close({ restoreFocus: false });
          item.action();
        },
      }, item.icon ? icon(item.icon, 13) : "", elem("span", { text: item.label })),
    ),
  );
  m.hidden = false;
  open = true;

  const r = anchor.getBoundingClientRect();
  m.style.visibility = "hidden";
  requestAnimationFrame(() => {
    if (!open || opener !== anchor) return;
    const mw = m.offsetWidth, mh = m.offsetHeight;
    const x = Math.min(r.right - mw, window.innerWidth - mw - 8);
    let y = r.bottom + 4;
    if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 4);
    m.style.left = `${Math.max(8, x)}px`;
    m.style.top = `${y}px`;
    m.style.visibility = "";
    focusableItems()[0]?.focus();
  });
}

export function isOpen() { return open; }