/**
 * The "no drift" safety net design.md's deliverable 2 describes: feeds the
 * EXACT SAME structural fixtures `jsonToChainedBuilderState`'s own test
 * suite (`../ui/chained-builder-state.test.ts`) uses through the GENERATED
 * schema's real `ajv` validation, and asserts the two surfaces agree on
 * accept/reject for every case that's actually EXPRESSIBLE in JSON Schema
 * (`required`/`enum`/`type` — the structural rules). This does NOT rewire
 * `jsonToChainedBuilderState` itself to depend on `ajv` at runtime (`ajv` is
 * a dev-only dependency, never shipped in the published package) — see
 * design.md's "Cross-check, not a runtime rewrite" section for why.
 *
 * Deliberately scoped to the STRUCTURAL hard-error cases only: the parser's
 * LENIENT per-field defaults (a malformed `config`, a dropped bad signer,
 * …) are intentionally NOT hard rejections in either surface — the schema
 * correctly marks those fields optional (matching the real TS types), and
 * the parser correctly degrades them to a default rather than rejecting —
 * so there is nothing to disagree about there. Pure semantic rules neither
 * surface can express in JSON Schema at all (the yield-graph ordering rule,
 * the decimal-amount tripwire) are out of scope for this specific test by
 * design, not an oversight — they live in `chained-validation.ts` and have
 * their own dedicated test suite there.
 */
import { beforeAll, describe, expect, it } from "vitest";
import ts from "typescript";
import Ajv from "ajv";

import { BUILTIN_DESCRIPTORS } from "../builtins/descriptors.js";
import { jsonToChainedBuilderState } from "../ui/chained-builder-state.js";
import { generateRawCronotonSchema } from "./generate.js";
import { buildProgram } from "./test-support.js";

describe("generated schema vs. jsonToChainedBuilderState — structural agreement", () => {
  // Built ONCE for the whole file, not fresh per `it()` — see test-support.ts.
  let program: ts.Program;
  beforeAll(() => {
    program = buildProgram();
  });

  function compileValidator() {
    const { jsonSchema } = generateRawCronotonSchema(program, BUILTIN_DESCRIPTORS);
    const ajv = new Ajv({ allErrors: true, strict: false });
    return ajv.compile(jsonSchema);
  }

  it.each([
    ["{}", "missing steps"],
    ['{"name":"X","steps":[]}', "empty steps array"],
    ['{"name":"X","steps":"nope"}', "non-array steps"],
  ])("both reject %s (%s)", (text) => {
    const validate = compileValidator();
    const parsed: unknown = JSON.parse(text);
    const parserResult = jsonToChainedBuilderState(text);

    expect(parserResult.ok).toBe(false);
    expect(validate(parsed)).toBe(false);
  });

  it.each([
    ["[]", "non-object top level: array"],
    ["null", "non-object top level: null"],
    ['"hello"', "non-object top level: string"],
    ["42", "non-object top level: number"],
  ])("both reject %s (%s)", (text) => {
    const validate = compileValidator();
    const parsed: unknown = JSON.parse(text);
    const parserResult = jsonToChainedBuilderState(text);

    expect(parserResult.ok).toBe(false);
    expect(validate(parsed)).toBe(false);
  });

  it("both reject a step with an invalid mode", () => {
    const validate = compileValidator();
    const doc = { name: "X", steps: [{ mode: "bogus" }] };
    const parserResult = jsonToChainedBuilderState(JSON.stringify(doc));

    expect(parserResult.ok).toBe(false);
    expect(validate(doc)).toBe(false);
  });

  it("both accept a minimal valid single-step document", () => {
    const validate = compileValidator();
    const doc = { name: "Minimal", steps: [{ mode: "single", pactCode: "(+ 1 2)" }] };
    const parserResult = jsonToChainedBuilderState(JSON.stringify(doc));

    expect(parserResult.ok).toBe(true);
    expect(validate(doc)).toBe(true);
  });

  it("both accept a planner step naming a REAL registered built-in with its real params shape", () => {
    const validate = compileValidator();
    const doc = {
      name: "Planner chain",
      steps: [
        {
          mode: "planner",
          plannerName: "ouronet.stoa-wrap",
          plannerParams: { patronAccount: "k:abc", amount: "50.0", amountCeiling: "100.0", namespace: "free" },
        },
      ],
    };
    const parserResult = jsonToChainedBuilderState(JSON.stringify(doc));

    expect(parserResult.ok).toBe(true);
    expect(validate(doc)).toBe(true);
  });

  it("the schema rejects a plannerName that ISN'T one of the real registered built-ins (the parser itself is lenient here, by design — this is schema-only coverage)", () => {
    const validate = compileValidator();
    const doc = { name: "X", steps: [{ mode: "planner", plannerName: "not-a-real-planner" }] };
    // jsonToChainedBuilderState deliberately does NOT hard-reject an unknown
    // plannerName (the author picks a real one from the UI's dropdown after
    // import; design.md treats this as lenient, not structural) — but the
    // schema, generated from the REAL registered set, correctly flags it as
    // not matching the enum, which is exactly the kind of drift-prevention
    // value a schema-aware editor gets that the importer's own tolerance
    // doesn't provide.
    expect(validate(doc)).toBe(false);
  });

  it("every real BUILTIN_DESCRIPTORS name validates against the generated enum (no planner silently missing from the schema)", () => {
    const validate = compileValidator();
    for (const name of Object.keys(BUILTIN_DESCRIPTORS)) {
      const doc = { name: "X", steps: [{ mode: "planner", plannerName: name }] };
      expect(validate(doc), `plannerName "${name}" unexpectedly rejected`).toBe(true);
    }
  });
});
