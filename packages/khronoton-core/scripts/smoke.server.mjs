// Dist smoke — ESM `import` condition.
// Resolves the BARE published specifier through the exports map (via the
// workspace symlink), NOT a relative source path — so it exercises exactly what
// a consumer's `import` sees against the built dist/.
import * as server from "@ancientpantheon/khronoton-core/server";
import * as root from "@ancientpantheon/khronoton-core";

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
  console.error("[smoke.server.mjs] MISSING server:", missingServer, "root:", missingRoot);
  process.exit(1);
}

console.log("[smoke.server.mjs] ESM import OK —", serverValues.length, "server value exports +", rootValues.length, "root value exports resolved (seam TYPES verified by tsc, erased at runtime).");
