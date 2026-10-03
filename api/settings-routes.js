"use strict";
// /api/settings/* and /api/stats*: what the Settings page reads and saves.
const { sendJson, sendError, readBody } = require("./util");
const { listPreviewRoots, setPreviewRoots } = require("./preview-roots");
const { listPanels, setPanels, checkPanel } = require("./panel-config");
const { runtimeSettings, setRuntimeSettings } = require("./runtime-settings");
const { getStats } = require("./stats");
const { getStorage } = require("./storage-stats");

async function jsonBody(req) {
  return JSON.parse((await readBody(req)) || "{}") || {};
}

// Resolves true when it answered, false to let routes.js fall through to 404.
async function handleSettings(req, res, sub, url) {
  const route = `${req.method} ${sub.join("/")}`;
  try {
    switch (route) {
      case "GET settings/preview-roots":
        sendJson(res, 200, { roots: listPreviewRoots() });
        return true;
      case "PUT settings/preview-roots":
        sendJson(res, 200, { roots: await setPreviewRoots((await jsonBody(req)).roots) });
        return true;
      case "GET settings/panels":
        sendJson(res, 200, { panels: listPanels() });
        return true;
      case "PUT settings/panels":
        sendJson(res, 200, { panels: await setPanels((await jsonBody(req)).panels) });
        return true;
      case "POST settings/panels/check":
        sendJson(res, 200, await checkPanel((await jsonBody(req)).url));
        return true;
      case "GET settings/runtime":
        sendJson(res, 200, runtimeSettings());
        return true;
      case "PUT settings/runtime":
        sendJson(res, 200, await setRuntimeSettings(await jsonBody(req)));
        return true;
      case "GET stats":
        sendJson(res, 200, await getStats());
        return true;
      case "GET stats/storage":
        sendJson(res, 200, await getStorage({ refresh: url.searchParams.get("refresh") === "1" }));
        return true;
      default:
        return false;
    }
  } catch (error) {
    sendError(res, error);
    return true;
  }
}

module.exports = { handleSettings };
