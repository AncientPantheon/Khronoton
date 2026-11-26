/**
 * Shared test-only support for `generate.test.ts` + `cross-check.test.ts` —
 * both files need the SAME `ts.Program`, rooted at the SAME three files the
 * real build-time generator (`scripts/generate-raw-cronoton-schema.mjs`)
 * roots its own program at (see that script's own comment, and design.md's
 * deliverable 2). Kept as a single source of truth here so the two test
 * files can't drift from each other; the `.mjs` script's copy is intentionally
 * NOT unified with this one (different runtime, imports from `dist/` post-
 * build rather than from `src/` — see that script's own pointer comment).
 *
 * `buildProgram()` is deliberately NOT called fresh inside every `it()` —
 * both test files construct it ONCE in a `beforeAll` and reuse the same
 * `ts.Program` across every test case in the file. Nothing about correctness
 * depends on a fresh `ts.Program` per test: `generateRawCronotonSchema`
 * builds a fresh output object on every call regardless of whether the
 * `ts.Program` it reads from is shared, so reusing the Program is pure
 * speedup with no behavior change.
 */
import ts from "typescript";
import { createProgramForTypes } from "./type-schema.js";

const ROOT = process.cwd();

/** The Compiler-API root files the raw-cronoton schema is generated from —
 *  kept identical to `scripts/generate-raw-cronoton-schema.mjs`'s own list. */
export const RAW_CRONOTON_ROOT_FILES = ["src/handlers/chain.ts", "src/server/types.ts", "src/schedule.ts"];

export function buildProgram(): ts.Program {
  return createProgramForTypes(
    RAW_CRONOTON_ROOT_FILES.map((p) => `${ROOT}/${p}`),
    `${ROOT}/tsconfig.json`,
  );
}
