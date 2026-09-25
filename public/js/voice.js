"use strict";
// Voice input: record a short clip with MediaRecorder and POST it to
// /api/transcribe (server holds the provider key). Transcribed text is
// delivered through the target's transcribed callback; this module never touches
// composer state directly.

import { api } from "./api.js";

const MAX_RECORD_MS = 120_000;
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

function pickMime() {
  if (typeof MediaRecorder === "undefined") return "";
  for (const mime of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      /* ignore */
    }
  }
  return "";
}

export function createVoiceController() {
  let recorder = null;
  let chunks = [];
  let recordingContext = null;
  let activeTarget = null;
  let starting = false;
  let stopping = false;
  let transcribing = false;
  let stopTimer = 0;
  let startedAt = 0;
  let tickTimer = 0;
  let available = false;
  const targets = new Map();

  function setStatus(target, message, { error = false } = {}) {
    const node = target?.status;
    if (!node) return;
    if (!message) {
      node.hidden = true;
      node.textContent = "";
      return;
    }
    node.hidden = false;
    node.textContent = message;
    node.dataset.error = error ? "true" : "";
  }

  function paintButton(target = activeTarget) {
    const btn = target?.button;
    if (!btn) return;
    const ownsActivity = target === activeTarget;
    const recording = Boolean(recorder && ownsActivity);
    const phase = ownsActivity && stopping
      ? "stopping"
      : ownsActivity && transcribing
        ? "transcribing"
        : ownsActivity && starting
          ? "starting"
          : recording
            ? "recording"
            : "idle";
    const busy = phase === "starting" || phase === "stopping" || phase === "transcribing";
    btn.dataset.state = phase;
    btn.classList.toggle("recording", recording);
    btn.setAttribute("aria-pressed", String(recording));
    if (busy) btn.setAttribute("aria-busy", "true");
    else btn.removeAttribute("aria-busy");
    if (phase === "recording") {
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      btn.setAttribute("aria-label", `Stop recording (${secs}s)`);
      btn.title = "Stop and transcribe";
    } else if (phase === "starting") {
      btn.setAttribute("aria-label", "Starting dictation");
      btn.title = "Starting microphone";
    } else if (phase === "stopping") {
      btn.setAttribute("aria-label", "Finishing recording");
      btn.title = "Finishing recording";
    } else if (phase === "transcribing") {
      btn.setAttribute("aria-label", "Transcribing dictation");
      btn.title = "Transcribing";
    } else {
      btn.setAttribute("aria-label", target.label);
      btn.title = "Dictate";
    }
  }

  function tick() {
    paintButton();
  }

  async function stopAndSend() {
    if (stopping || transcribing) return;
    const target = activeTarget;
    const track = recorder;
    if (!track || track.state === "inactive") {
      recorder = null;
      chunks = [];
      recordingContext = null;
      paintButton(target);
      setStatus(target, "");
      return;
    }
    stopping = true;
    clearTimeout(stopTimer);
    clearInterval(tickTimer);
    paintButton(target);
    setStatus(target, "Finishing recording…");
    const done = new Promise((resolve) => {
      track.addEventListener("stop", resolve, { once: true });
    });
    try {
      track.stop();
    } catch {
      recorder = null;
      chunks = [];
      recordingContext = null;
      stopping = false;
      for (const streamTrack of (track.stream?.getTracks() || [])) {
        try {
          streamTrack.stop();
        } catch {
          /* ignore */
        }
      }
      paintButton(target);
      setStatus(target, "");
      return;
    }
    await done;
    for (const streamTrack of (track.stream?.getTracks() || [])) {
      try {
        streamTrack.stop();
      } catch {
        /* ignore */
      }
    }
    const blob = new Blob(chunks, { type: track.mimeType || "audio/webm" });
    const context = recordingContext;
    chunks = [];
    recordingContext = null;
    recorder = null;
    stopping = false;
    if (!blob.size) {
      paintButton(target);
      setStatus(target, "");
      return;
    }
    transcribing = true;
    paintButton(target);
    setStatus(target, "Transcribing…");
    const form = new FormData();
    form.set("audio", blob, "voice.webm");
    let text = "";
    try {
      const result = await api("/transcribe", { method: "POST", body: form });
      text = typeof result?.text === "string" ? result.text.trim() : "";
    } catch (error) {
      transcribing = false;
      paintButton(target);
      setStatus(target, error?.message || "Transcription failed", { error: true });
      return;
    }
    transcribing = false;
    paintButton(target);
    setStatus(target, "");
    if (!text) {
      setStatus(target, "Heard nothing to transcribe", { error: true });
      return;
    }
    target?.transcribed?.(text, context);
  }

  async function startRecording(target) {
    if (starting || stopping || transcribing) return;
    activeTarget = target;
    starting = true;
    paintButton(target);
    setStatus(target, "Starting microphone…");
    const context = target.capture?.() || null;
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      starting = false;
      paintButton(target);
      setStatus(target, "Voice input needs a browser with microphone recording", { error: true });
      return;
    }
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      starting = false;
      paintButton(target);
      setStatus(target, "Microphone blocked — allow access to dictate", { error: true });
      return;
    }
    const mime = pickMime();
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      starting = false;
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
      paintButton(target);
      setStatus(target, "Could not start recording", { error: true });
      return;
    }
    starting = false;
    recordingContext = context;
    chunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    });
    recorder.addEventListener("error", () => {
      stopAndSend();
    });
    startedAt = Date.now();
    recorder.start();
    paintButton(target);
    tickTimer = setInterval(tick, 1000);
    stopTimer = setTimeout(() => stopAndSend(), MAX_RECORD_MS);
    setStatus(target, "Recording — tap mic to finish");
  }

  function toggle(event) {
    const target = targets.get(event.currentTarget);
    const btn = target?.button;
    if (!btn || btn.disabled || starting || stopping || transcribing) return;
    if (recorder) stopAndSend();
    else {
      setStatus(target, "");
      startRecording(target);
    }
  }

  function setAvailable(on) {
    available = Boolean(on);
    for (const target of targets.values()) {
      target.button.hidden = !available;
      if (!available) setStatus(target, "");
    }
    if (!available && recorder) stopAndSend();
  }

  function registerTarget({
    button,
    status,
    label = "Dictate message",
    transcribed,
    capture,
  }) {
    if (!button || targets.has(button)) return;
    const target = { button, status, label, transcribed, capture };
    targets.set(button, target);
    button.hidden = !available;
    button.addEventListener("click", toggle);
    paintButton(target);
  }

  return { registerTarget, setAvailable };
}
