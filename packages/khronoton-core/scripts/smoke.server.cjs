// Dist smoke — CJS `require` condition (the 0.1.1 lesson: a tsx/CJS consumer,
// e.g. Mnemosyne's worker, must be able to `require` the subpath without
// ERR_PACKAGE_PATH_NOT_EXPORTED). Node >=20.19/>=22.12 loads the ESM build via
// require(esm). Resolves the BARE specifier through the exports map.
const server = require("@ancientpantheon/khronoton-core/server");
const root = require("@ancientpantheon/khronoton-core");

const serverValues = [
  "installSchema",
  "codexCronotonTickOnce",
  "processDueManualBatchesOnce",
  "executeCodexTransaction",
  "startKhronotonLoop",
  "registerServerResolver",
  "getServerResolver",
  "fireByServerResolver",
];
const rootValues = ["computeNextFire", "summariseSchedule", "InvalidScheduleConfigError", "tickOnce"];

const missingServer = serverValues.filter((n) => typeof server[n] !== "function");
const missingRoot = rootValues.filter((n) => typeof root[n] !== "function");

if (missingServer.length || missingRoot.length) {
  console.error("[smoke.server.cjs] MISSING server:", missingServer, "root:", missingRoot);
  process.exit(1);
}

console.log("[smoke.server.cjs] CJS require OK —", serverValues.length, "server value exports +", rootValues.length, "root value exports resolved via require(esm).");
