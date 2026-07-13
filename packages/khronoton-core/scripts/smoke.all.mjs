// Dist smoke — ESM `import` condition across EVERY published JS subpath.
//
// The mirror of smoke.all.cjs: a bundler/ESM consumer resolves the `import`
// condition. This dynamically imports each BARE specifier (exercising the exports
// map) and asserts a representative value export per subpath. The React subpaths
// (`/provider`, `/hooks`, `/ui`) pull `react` from the workspace here; in a
// consumer it is the declared peer.
const PKG = "@ancientpantheon/khronoton-core";

const EXPECT = {
  "": ["computeNextFire", "summariseSchedule", "tickOnce", "InvalidScheduleConfigError"],
  "/server": ["installSchema", "codexCronotonTickOnce", "startKhronotonLoop", "registerServerResolver"],
  "/handlers": ["mapStoreError", "executeNow", "json", "err", "NeedsConfirmError"],
  "/provider": ["KhronotonProvider", "createFetchAdapter", "createMemoryAdapter", "runGated", "assertAdapter"],
  "/hooks": ["useCronotons", "useCronoton", "useCronotonActions", "useExecuteNow", "useCronotonFires"],
  "/ui": ["KhronotonUiRoot", "List", "Detail", "Builder", "Public", "RelativeTime", "CronotonStatusBadge"],
};

const failures = [];
for (const [sub, names] of Object.entries(EXPECT)) {
  const spec = PKG + sub;
  let mod;
  try {
    mod = await import(spec);
  } catch (e) {
    failures.push(`${spec}: import threw — ${e.code || e.message}`);
    continue;
  }
  const missing = names.filter((n) => mod[n] === undefined);
  if (missing.length) failures.push(`${spec}: missing exports ${missing.join(", ")}`);
}

if (failures.length) {
  console.error("[smoke.all.mjs] FAIL:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log(
  "[smoke.all.mjs] ESM import OK — all 6 JS subpaths resolved via the exports map.",
);
