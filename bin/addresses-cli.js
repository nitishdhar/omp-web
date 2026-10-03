"use strict";
// `omp-web addresses [--json]`: every address this console answers on and the
// one links use. Reads the same resolver as the server, so it also works
// while the server is down.
const config = require("../config");
const { addressesStatus } = require("../api/addresses");

const USAGE = "usage: omp-web addresses [--json]";

async function runAddresses(args) {
  const json = args.length === 1 && args[0] === "--json";
  if (args.length && !json) {
    console.error(`omp-web: ${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const status = await addressesStatus();
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  const kindWidth = Math.max(...status.addresses.map((address) => address.kind.length));
  const urlWidth = Math.max(...status.addresses.map((address) => address.url.length));
  for (const address of status.addresses) {
    const marker = address.url === status.linkBase ? "*" : " ";
    const state = address.reachable ? "reachable" : `not reachable (bound to ${config.host})`;
    console.log(`${marker} ${address.kind.padEnd(kindWidth)}  ${address.url.padEnd(urlWidth)}  ${state}`);
  }
  if (!status.addresses.some((address) => address.url === status.linkBase)) {
    console.log(`* links use ${status.linkBase} (the bind address)`);
  }
  console.log(`\n* = used for links (omp-web artifact url). Server binds ${config.host}:${config.port}.`);
  if (status.publicUrl.error) console.log(`warning: ${status.publicUrl.error}`);
  else if (!status.publicUrl.value) console.log("Set a public address in Settings → General, or OMP_WEB_PUBLIC_URL.");
}

module.exports = { runAddresses };
