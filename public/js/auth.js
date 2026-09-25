"use strict";
// Token capture (URL -> localStorage), 401 gate UI.

import { state } from "./state.js";
import { el } from "./dom.js";

const LS_KEY = "omp_web_token";

export function captureUrlToken() {
  const urlToken = new URLSearchParams(location.search).get("token") || "";
  if (urlToken) {
    try { localStorage.setItem(LS_KEY, urlToken); } catch {}
    try { history.replaceState(null, "", location.pathname); } catch {}
  }
  let stored = "";
  try { stored = localStorage.getItem(LS_KEY) || ""; } catch {}
  state.token = urlToken || stored;
}

export function storeToken(t) {
  state.token = t;
  try { localStorage.setItem(LS_KEY, t); } catch {}
}

export function showAuth(message) {
  el.authgate.hidden = false;
  el["auth-error"].textContent = message || "";
  el["auth-error"].hidden = !message;
  el["auth-input"].value = "";
  el["auth-input"].focus();
}

export function submitAuth(boot) {
  const t = el["auth-input"].value.trim();
  if (!t) return;
  storeToken(t);
  el.authgate.hidden = true;
  boot();
}

export function wireAuth(boot) {
  el["auth-submit"].onclick = () => submitAuth(boot);
  el["auth-input"].addEventListener("keydown", (e) => { if (e.key === "Enter") submitAuth(boot); });
}