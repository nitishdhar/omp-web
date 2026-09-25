"use strict";
// Voice input: accept a short browser-recorded audio clip and forward it to an
// OpenAI-compatible /audio/transcriptions endpoint. The provider key lives
// only in server config and never reaches the browser. Audio is held in
// memory, never written to disk.

const config = require("../config");
const { multipartBoundary, readLimitedBody, parseMultipart } = require("./attachments");

// Bound in-memory audio independently of the user's transcription provider.
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 60_000;

const AUDIO_MIME = new Set([
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/ogg",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/aac",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "",
  "application/octet-stream",
]);

function voiceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function baseType(mime) {
  return String(mime || "").split(";")[0].trim().toLowerCase();
}

async function transcribeVoice(req) {
  if (!config.transcribeBaseUrl || !config.transcribeApiKey || !config.transcribeModel) {
    throw voiceError("ENOTRANSCRIBER", "voice input is not configured");
  }
  const boundary = multipartBoundary(req.headers["content-type"]);
  const body = await readLimitedBody(req);
  // Exactly one part: the parser rejects anything else, so whatever field
  // name the browser used, this is the clip.
  const clip = parseMultipart(body, boundary);
  if (!clip.data || clip.data.length === 0) {
    throw voiceError("EBADVOICE", "voice clip must not be empty");
  }
  if (clip.data.length > MAX_VOICE_BYTES) {
    throw voiceError("EVOICETOOLARGE", "voice clip must be 10 MiB or smaller");
  }
  const mime = baseType(clip.headers["content-type"]);
  if (!AUDIO_MIME.has(mime)) {
    throw voiceError("EBADVOICE", "voice clip must be audio");
  }

  const forward = new FormData();
  forward.set("model", config.transcribeModel);
  forward.set("file", new Blob([clip.data], { type: mime || "audio/webm" }), "voice.webm");

  const endpoint = config.transcribeBaseUrl.replace(/\/+$/, "") + "/audio/transcriptions";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${config.transcribeApiKey}` },
      body: forward,
      signal: controller.signal,
    });
  } catch (error) {
    if (error && error.name === "AbortError") throw voiceError("EVOICETIMEOUT", "transcription timed out");
    throw voiceError("EVOICEUPSTREAM", "transcription service unreachable");
  } finally {
    clearTimeout(timeout);
  }
  let payload = null;
  try {
    payload = await upstream.json();
  } catch {
    throw voiceError("EVOICEUPSTREAM", "transcription service returned invalid JSON");
  }
  if (!upstream.ok) {
    const detail = payload && typeof payload.error === "object" ? payload.error.message : payload && payload.error;
    throw voiceError("EVOICEUPSTREAM", String(detail || `transcription failed (${upstream.status})`));
  }
  const text = payload && typeof payload.text === "string" ? payload.text.trim() : "";
  return { text };
}

module.exports = { transcribeVoice, MAX_VOICE_BYTES };
