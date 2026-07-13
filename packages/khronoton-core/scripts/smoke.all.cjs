// Dist smoke — CJS `require` condition across EVERY published JS subpath.
//
// The 0.1.1 lesson: a CJS/tsx consumer must be able to `require` each subpath
// through the exports map without ERR_PACKAGE_PATH_NOT_EXPORTED, and Node
// >=20.19/>=22.12 then loads the ESM build via require(esm). This resolves each
// BARE specifier (exercising the exports map, not a relative path) and asserts a
// representative value export per subpath. The React subpaths (`/provider`,
// `/hooks`, `/ui`) pull `react` from the workspace here; in a consumer it is the
// declared peer.
const PKG = "@ancientpantheon/khronoton-core";

/** Each subpath → the representative value exports that must resolve. */
const EXPECT = {
  "": ["computeNextFire", "summariseSchedule", "tickOnce", "InvalidScheduleConfigError"],
  "/server": ["installSchema", "codexCronotonTickOnce", "startKhronotonLoop", "registerServerResolver"],
  "/handlers": ["mapStoreError", "executeNow", "json", "err", "NeedsConfirmError"],
  "/provider": ["KhronotonProvider", "createFetchAdapter", "createMemoryAdapter", "runGated", "assertAdapter"],
  "/hooks": ["useCronotons", "useCronoton", "useCronotonActions", "useExecuteNow", "useCronotonFires"],
  "/ui": ["KhronotonUiRoot", "List", "Detail", "Builder", "Public", "RelativeTime", "CronotonStatusBadge"],
  // The chain adapter is lazy — importing the subpath resolves the factory export
  // without loading `@stoachain/*` (those load only when the factory is called).
  "/blockchain/stoachain": ["createStoachainRuntime"],
};

const failures = [];
for (const [sub, names] of Object.entries(EXPECT)) {
  const spec = PKG + sub;
  let mod;
  try {
    mod = require(spec);
  } catch (e) {
    failures.push(`${spec}: require threw — ${e.code || e.message}`);
    continue;
  }
  const missing = names.filter((n) => mod[n] === undefined);
  if (missing.length) failures.push(`${spec}: missing exports ${missing.join(", ")}`);
}

// The stylesheet subpath resolves to a real file (string export, not conditions).
try {
  require.resolve(PKG + "/ui.css");
} catch (e) {
  failures.push(`${PKG}/ui.css: unresolvable — ${e.code || e.message}`);
}

if (failures.length) {
  console.error("[smoke.all.cjs] FAIL:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log(
  "[smoke.all.cjs] CJS require OK — all 7 JS subpaths + ui.css resolved via the exports map (require(esm)).",
);
