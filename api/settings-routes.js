"use strict";
// /api/settings/* and /api/stats*: what the Settings page reads and saves.
const { sendJson, sendError, readBody } = require("./util");
const { listPreviewRoots, setPreviewRoots } = require("./preview-roots");
const { listPanels, setPanels, checkPanel } = require("./panel-config");
const { runtimeSettings, setRuntimeSettings } = require("./runtime-settings");
const { getStats } = require("./stats");
const { getStorage } = require("./storage-stats");
const { skillsStatus, setSkillsInstalled } = require("./skills");
const { addressesStatus, setAddresses } = require("./addresses");
const { listCredentials, putCredential, deleteCredential } = require("./credentials");
const { voiceSettings, setVoiceSettings, testVoice } = require("./voice-settings");
const { ompEnvSettings, setOmpEnv } = require("./omp-env");

async function jsonBody(req) {
  return JSON.parse((await readBody(req)) || "{}") || {};
}

// Resolves true when it answered, false to let routes.js fall through to 404.
async function handleSettings(req, res, sub, url) {
  const route = `${req.method} ${sub.join("/")}`;
  try {
    // settings/credentials/:name — the only parameterised settings route.
    if (sub[0] === "settings" && sub[1] === "credentials" && sub.length === 3) {
      const name = decodeURIComponent(sub[2]);
      if (req.method === "PUT") {
        sendJson(res, 200, await putCredential(name, await jsonBody(req)));
        return true;
      }
      if (req.method === "DELETE") {
        sendJson(res, 200, await deleteCredential(name));
        return true;
      }
      return false;
    }
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
      case "GET settings/skills":
        sendJson(res, 200, await skillsStatus());
        return true;
      case "PUT settings/skills":
        sendJson(res, 200, await setSkillsInstalled(await jsonBody(req)));
        return true;
      case "GET settings/addresses":
        sendJson(res, 200, await addressesStatus());
        return true;
      case "PUT settings/addresses":
        sendJson(res, 200, await setAddresses(await jsonBody(req)));
        return true;
      case "GET settings/credentials":
        sendJson(res, 200, await listCredentials());
        return true;
      case "GET settings/voice":
        sendJson(res, 200, await voiceSettings());
        return true;
      case "PUT settings/voice":
        sendJson(res, 200, await setVoiceSettings(await jsonBody(req)));
        return true;
      case "POST settings/voice/test":
        sendJson(res, 200, await testVoice(await jsonBody(req)));
        return true;
      case "GET settings/omp-env":
        sendJson(res, 200, await ompEnvSettings());
        return true;
      case "PUT settings/omp-env":
        sendJson(res, 200, await setOmpEnv(await jsonBody(req)));
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
