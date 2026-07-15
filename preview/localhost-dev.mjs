// Serves the Khronoton UI mockup on the port assigned in the central LocalHost
// registry (D:/_Claude/LocalHost/registry.json → 3011). Reuses the repo's own
// serve.mjs, which reads PORT from the environment. Falls back to 3011 if the
// registry is absent, so `npm run dev` still works standalone.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function port() {
  try {
    const reg = JSON.parse(readFileSync(resolve(here, "../../../LocalHost/registry.json"), "utf8"));
    const p = reg.projects.find((x) => x.key === "khronoton")?.port;
    return typeof p === "number" ? p : 3011;
  } catch {
    return 3011;
  }
}

process.env.PORT = String(port());
await import("./serve.mjs"); // serve.mjs binds process.env.PORT on load
