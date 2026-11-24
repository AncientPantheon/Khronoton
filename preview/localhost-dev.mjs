// Serves the Khronoton UI mockup on the port assigned in the central LocalHost
// registry (ClaudeWS/LocalHost/registry.json → 3008, key "khronoton"). Reuses
// the repo's own serve.mjs, which reads PORT from the environment. Falls back
// to 3011 if the registry is absent, so `npm run dev` still works standalone.
//
// `here` is `.../AncientPantheon/constructors/Khronoton/preview` — reaching
// `ClaudeWS/LocalHost/` needs FOUR `..` segments (preview -> Khronoton ->
// constructors -> AncientPantheon -> ClaudeWS), not three. A fix caught this:
// the three-segment path silently resolved to a nonexistent
// `AncientPantheon/LocalHost/registry.json`, so the registry lookup always
// threw, was swallowed by the catch below, and every run silently fell back
// to port 3011 instead of the registry's real 3008 assignment — which then
// failed outright once an earlier orphaned run of this same fallback was
// left listening on 3011 (EADDRINUSE).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function port() {
  try {
    const reg = JSON.parse(readFileSync(resolve(here, "../../../../LocalHost/registry.json"), "utf8"));
    const p = reg.projects.find((x) => x.key === "khronoton")?.port;
    return typeof p === "number" ? p : 3011;
  } catch {
    return 3011;
  }
}

process.env.PORT = String(port());
await import("./serve.mjs"); // serve.mjs binds process.env.PORT on load
