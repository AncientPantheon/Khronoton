// Generates the published raw-cronoton-JSON schema + field reference as a
// BUILD step — `dist/schema/raw-cronoton.schema.json` + `dist/schema/raw-
// cronoton.md` are never git-committed, only ever a fresh build artifact, so
// there is no second copy that can go stale (see docs/work/chained-builder-
// raw-json-import/design.md's deliverable 2). Runs AFTER `tsc` (so the real
// generator logic — `src/schema/generate.ts` et al. — already exists as
// compiled `dist/schema/*.js`) and after `tsup` (so `dist/builtins/
// descriptors.js`'s REAL runtime `BUILTIN_DESCRIPTORS` exists too), mirroring
// `bundle-css.mjs`'s own position in the `build` script.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const distDir = join(pkgRoot, "dist");
const schemaDir = join(distDir, "schema");

const { generateRawCronotonSchema } = await import(join(distDir, "schema", "generate.js"));
const { createProgramForTypes } = await import(join(distDir, "schema", "type-schema.js"));
const { BUILTIN_DESCRIPTORS } = await import(join(distDir, "builtins", "descriptors.js"));

// The TYPE WALK reads the real SOURCE `.ts` files (JSDoc comments included),
// not the compiled output — `src/handlers/chain.ts` transitively references
// everything else this schema needs (`CodexTxConfig`/`CodexGasPayer`/
// `CodexSigner`/`ScheduleMode`/`ScheduleConfig`), but `server/types.ts` and
// `schedule.ts` are listed explicitly too so the Compiler API's program
// definitely includes them as root files, not just as transitive references.
// `src/schema/test-support.ts` enumerates this SAME root-file list for
// `generate.test.ts`/`cross-check.test.ts` (they root their own test-time
// `ts.Program`s against the real source too). If `ChainCommitBody`'s
// transitive type closure ever needs a new root file, update it there too.
const program = createProgramForTypes(
  ["src/handlers/chain.ts", "src/server/types.ts", "src/schedule.ts"].map((p) => join(pkgRoot, p)),
  join(pkgRoot, "tsconfig.json"),
);

const { jsonSchema, markdown } = generateRawCronotonSchema(program, BUILTIN_DESCRIPTORS);

mkdirSync(schemaDir, { recursive: true });
writeFileSync(join(schemaDir, "raw-cronoton.schema.json"), `${JSON.stringify(jsonSchema, null, 2)}\n`, "utf8");
writeFileSync(join(schemaDir, "raw-cronoton.md"), markdown, "utf8");

console.log(
  `[generate-raw-cronoton-schema] wrote dist/schema/raw-cronoton.schema.json ` +
    `+ raw-cronoton.md (${Object.keys(BUILTIN_DESCRIPTORS).length} planners)`,
);
