"use strict";
// Inline SVG icon sprite. 14px by default; inherits currentColor.

const ICONS = {
  folder: `<path d="M2 4a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4Z"/>`,
  pin: `<path d="M9 1.5 12.5 5l-2.2.7-2.6 2.7.6 3.1-1.4 1.4-2-3.4L1.5 12l2.6-3.4-3.4-2L2.1 5.2l3.1.6L7.8 3.7 9 1.5Z"/>`,
  clock: `<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
  dots: `<circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/>`,
  bolt: `<path d="M8.8 1 3 9h3.5L6.5 15 13 7H9l-.2-6Z"/>`,
  plus: `<path d="M8 2v12M2 8h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
  terminal: `<path d="M2 3h12v10H2z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m4.5 6 2 2-2 2M8 10h3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  x: `<path d="m3 3 10 10M13 3 3 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
  list: `<path d="M2 4h12M2 8h12M2 12h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
};

export function icon(name, size = 14) {
  const span = document.createElement("span");
  span.className = "icon";
  span.style.width = `${size}px`;
  span.style.height = `${size}px`;
  span.innerHTML =
    `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  return span;
}