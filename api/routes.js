"use strict";
const fs = require("fs");
const path = require("path");
const config = require("../config");
const sessions = require("../sessions");
const { sendJson, sendError, readBody, listFolders, listProfiles, listProfileDetails } = require("./util");
const { saveAttachment } = require("./attachments");
const { getUsage } = require("./usage");
const { handleChat } = require("./chat-routes");
const { getGitStatus } = require("./git-status");
const { transcribeVoice } = require("./transcribe");
const { servePreviewFile } = require("./file-preview");
const { listPreviewRoots, setPreviewRoots } = require("./preview-roots");

const INDEX_PATH = path.join(__dirname, "..", "public", "index.html");

// Every versioned asset, in document order — watching main.js alone meant a
// CSS-only change shipped silently and open tabs never saw the reload prompt.
function frontendVersion() {
  try {
    const html = fs.readFileSync(INDEX_PATH, "utf8");
    const versions = [...html.matchAll(/\?v=([^"'&\s>]+)/g)].map((m) => m[1]);
    return versions.join(".");
  } catch {
    return "";
  }
}

function routeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const sub = parts.slice(1);

  if (req.method === "GET" && sub[0] === "meta") {
    return sendJson(res, 200, {
      attachmentsRoot: config.attachmentsDir,
      workspaceRoot: config.workspaceRoot,
      extraRoots: config.extraRoots,
      // The browser abbreviates paths for display; `~` has to mean $HOME, not
      // the workspace root, or it prints paths that do not exist.
      homeDir: config.homeDir,
      profiles: listProfiles(),
      profileDetails: listProfileDetails(),
      folders: listFolders(),
      transcribe: Boolean(config.transcribeBaseUrl && config.transcribeApiKey && config.transcribeModel),
    });
  }
  if (sub[0] === "settings" && sub[1] === "preview-roots" && sub.length === 2) {
    if (req.method === "GET") return sendJson(res, 200, { roots: listPreviewRoots() });
    if (req.method === "PUT") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        return sendJson(res, 200, { roots: await setPreviewRoots(body.roots) });
      } catch (error) {
        return sendError(res, error);
      }
    }
  }
  if (req.method === "GET" && sub[0] === "version" && sub.length === 1) {
    return sendJson(res, 200, { version: frontendVersion() });
  }
  if (req.method === "GET" && sub[0] === "usage" && sub.length === 1) {
    return sendJson(res, 200, await getUsage());
  }
  if (req.method === "GET" && sub[0] === "sessions" && sub.length === 1) {
    return sendJson(res, 200, { sessions: await sessions.list(), restorable: await sessions.restorable() });
  }
  if (req.method === "POST" && sub[0] === "sessions" && sub[1] === "restore" && sub.length === 2) {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const ids = body.ids === "all"
        ? (await sessions.restorable()).map((row) => row.id)
        : Array.isArray(body.ids) ? body.ids : [];
      return sendJson(res, 200, { results: await sessions.restore(ids, { folder: body.folder }) });
    } catch (error) {
      return sendError(res, error);
    }
  }
  if (req.method === "DELETE" && sub[0] === "sessions" && sub[1] && sub[2] === "ghost" && sub.length === 3) {
    try {
      const ok = sessions.forgetGhost(sub[1]);
      return sendJson(res, 200, { ok });
    } catch (error) {
      return sendError(res, error);
    }
  }
  if (sub[0] === "sessions" && sub[1] && sub[2] === "chat") {
    return handleChat(req, res, sub, url);
  }
  if (req.method === "GET" && sub[0] === "sessions" && sub[1] && sub[2] === "git" && sub.length === 3) {
    try {
      const session = await sessions.get(sub[1]);
      if (!session) throw routeError("ENOSESSION", "session not found");
      const status = await getGitStatus(session.folder);
      return sendJson(res, 200, status);
    } catch (error) {
      return sendError(res, error);
    }
  }
  if (req.method === "POST" && sub[0] === "sessions" && sub.length === 1) {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body.name || !String(body.name).trim()) {
        throw routeError("EBADNAME", "name is required");
      }
      const type = String(body.type || "agent").trim() || "agent";
      if (type !== "agent" && type !== "shell") {
        throw routeError("EBADTYPE", "session type must be agent or shell");
      }
      const profile = type === "shell"
        ? "default"
        : String(body.profile || "default").trim() || "default";
      if (type === "agent" && !listProfiles().includes(profile)) {
        throw routeError("EBADPROFILE", `unknown profile: ${profile}`);
      }
      const session = await sessions.create({
        name: body.name,
        folder: body.folder,
        profile,
        type,
        // Explicit opt-in/out: resume:false forces a clean start, otherwise
        // create() resumes the largest substantive transcript under this
        // profile when one exists (recover --list relies on this default).
        resume: body.resume === false ? false : body.resume === true ? true : undefined,
      });
      return sendJson(res, 201, { session });
    } catch (error) {
      return sendError(res, error);
    }
  }
  if (
    req.method === "POST" &&
    sub[0] === "sessions" &&
    sub[1] &&
    sub[2] === "attachments" &&
    sub.length === 3
  ) {
    const id = sub[1];
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || !(await sessions.exists(id))) {
      req.resume();
      return sendError(res, routeError("ENOSESSION", "session not found"));
    }
    try {
      const attachment = await saveAttachment(req, id);
      return sendJson(res, 201, { attachment });
    } catch (error) {
      return sendError(res, error);
    }
  }
  if (req.method === "GET" && sub[0] === "sessions" && sub[1] && sub[2] === "file" && sub.length === 3) {
    try {
      return await servePreviewFile(res, sub[1], url.searchParams.get("path"));
    } catch (error) {
      return sendError(res, error);
    }
  }
  if (req.method === "GET" && sub[0] === "sessions" && sub[1] && sub[2] === "scroll" && sub.length === 3) {
    try {
      return sendJson(res, 200, { scroll: await sessions.scrollState(sub[1]) });
    } catch (error) {
      return sendError(res, error);
    }
  }
  if (
    req.method === "POST" &&
    sub[0] === "sessions" &&
    sub[1] &&
    sub[2] === "scroll" &&
    sub.length === 3
  ) {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const scroll = body.position === undefined
        ? await sessions.scroll(sub[1], body.direction, body.steps)
        : await sessions.setScrollPosition(sub[1], body.position);
      return sendJson(res, 200, { ok: true, scroll });
    } catch (error) {
      return sendError(res, error);
    }
  }
  if (req.method === "POST" && sub[0] === "sessions" && sub[1] && sub[2] === "profile" && sub.length === 3) {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const wanted = String(body.profile || "").trim();
      if (!wanted) throw routeError("EBADPROFILE", "profile is required");
      if (!listProfiles().includes(wanted)) {
        throw routeError("EBADPROFILE", `unknown profile: ${wanted}`);
      }
      const session = await sessions.reloadProfile(sub[1], { profile: wanted, model: body.model });
      return sendJson(res, 200, { session });
    } catch (error) {
      return sendError(res, error);
    }
  }
  if (req.method === "PUT" && sub[0] === "sessions" && sub[1] && sub[2] === "pin" && sub.length === 3) {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const session = await sessions.setPinned(sub[1], Boolean(body.pinned));
      return sendJson(res, 200, { session });
    } catch (error) {
      return sendError(res, error);
    }
  }
  if (req.method === "DELETE" && sub[0] === "sessions" && sub[1] && sub.length === 2) {
    try {
      await sessions.kill(sub[1]);
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendError(res, error);
    }
  }
  if (req.method === "POST" && sub[0] === "transcribe" && sub.length === 1) {
    try {
      return sendJson(res, 200, await transcribeVoice(req));
    } catch (error) {
      return sendError(res, error);
    }
  }
  return sendError(res, routeError("ENOTFOUND", "not found"));
}

module.exports = { handleApi };
