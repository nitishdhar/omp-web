"use strict";
// REST credentials stay out of request URLs; fetch options retain AbortSignal
// and FormData behavior for session-scoped work.

import { state, emit } from "./state.js";

export async function apiResponse(path, opts = {}) {
  const headers = new Headers(opts.headers);
  if (state.token) headers.set("x-omp-web-token", state.token);
  const res = await fetch(`/api${path}`, { cache: "no-store", ...opts, headers });
  if (!res.ok) {
    let body;
    try { body = await res.json(); } catch {}
    const err = new Error(body?.error || res.statusText);
    err.status = res.status;
    err.code = body?.code;
    if (res.status === 401) emit("auth:required");
    throw err;
  }
  return res;
}

export async function api(path, opts = {}) {
  return (await apiResponse(path, opts)).json();
}