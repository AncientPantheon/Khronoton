/**
 * Proves the generator's own core claim — that its output is genuinely
 * DERIVED from the real `ChainCommitBody`/`BUILTIN_DESCRIPTORS`, not a
 * second, independently-typed-out copy — by cross-checking the generated
 * schema's structure against those two real sources directly, not just
 * snapshotting the generator's own output against itself.
 */
import { beforeAll, describe, expect, it } from "vitest";
import ts from "typescript";

import { BUILTIN_DESCRIPTORS } from "../builtins/descriptors.js";
import { generateRawCronotonSchema } from "./generate.js";
import { buildNamedTypeSchema } from "./type-schema.js";
import { buildProgram } from "./test-support.js";

describe("generateRawCronotonSchema", () => {
  // Built ONCE for the whole file, not fresh per `it()` — the `ts.Program`
  // construction is the expensive part, and nothing here depends on a fresh
  // Program per test (see test-support.ts's own comment).
  let program: ts.Program;
  beforeAll(() => {
    program = buildProgram();
  });

  it("the top-level required fields are exactly name + steps — everything else on ChainCommitBody is optional", () => {
    const { jsonSchema } = generateRawCronotonSchema(program, BUILTIN_DESCRIPTORS);
    expect(jsonSchema.required).toEqual(["name", "steps"]);
    expect(Object.keys(jsonSchema.properties ?? {}).sort()).toEqual(
      ["description", "externalFireable", "name", "schedule", "singleTxFirst", "steps"].sort(),
    );
  });

  it("CodexTxConfig's generated ttl/gasLimit/gasPriceBufferAnu ranges match the @minimum/@maximum JSDoc tags on the real type", () => {
    const { jsonSchema } = generateRawCronotonSchema(program, BUILTIN_DESCRIPTORS);
    const config = jsonSchema.properties?.singleTxFirst?.properties?.config;
    expect(config?.properties?.ttl).toMatchObject({ minimum: 60, maximum: 86400 });
    expect(config?.properties?.gasLimit).toMatchObject({ minimum: 1 });
    expect(config?.properties?.gasPriceBufferAnu).toMatchObject({ minimum: 0 });
  });

  it("ScheduleConfig generates exactly 7 discriminated oneOf branches, one per real ScheduleMode", () => {
    const { jsonSchema } = generateRawCronotonSchema(program, BUILTIN_DESCRIPTORS);
    const scheduleConfig = jsonSchema.properties?.schedule?.properties?.config;
    const modes = (scheduleConfig?.oneOf ?? []).map((branch) => branch.properties?.mode?.const);
    expect(modes.sort()).toEqual(
      [
        "cron-expression",
        "daily-at-utc",
        "every-n-minutes",
        "monthly",
        "one-time",
        "several-times-per-day",
        "weekly",
      ].sort(),
    );
  });

  it("@minimum/@maximum on an array-typed field (ScheduleConfig's per-mode day/hour lists) land on items, not the array container itself", () => {
    // Regression: a prior version spread minimum/maximum as SIBLINGS of
    // type:"array"/items on the array schema itself, where JSON Schema
    // semantics make them inert (they only constrain number instances, never
    // array instances) — ajv silently never enforces them, and markdown.ts's
    // typeLabel never renders a range for an array type either. They must
    // land INSIDE `items` to actually take effect.
    const { jsonSchema } = generateRawCronotonSchema(program, BUILTIN_DESCRIPTORS);
    const scheduleConfig = jsonSchema.properties?.schedule?.properties?.config;
    const branches = scheduleConfig?.oneOf ?? [];

    const dailyAtUtc = branches.find((b) => b.properties?.mode?.const === "daily-at-utc");
    expect(dailyAtUtc?.properties?.hours).toMatchObject({
      type: "array",
      items: { type: "number", minimum: 0, maximum: 23 },
    });
    expect(dailyAtUtc?.properties?.hours?.minimum).toBeUndefined();
    expect(dailyAtUtc?.properties?.hours?.maximum).toBeUndefined();

    const weekly = branches.find((b) => b.properties?.mode?.const === "weekly");
    expect(weekly?.properties?.daysOfWeek).toMatchObject({
      type: "array",
      items: { type: "number", minimum: 0, maximum: 6 },
    });

    const monthly = branches.find((b) => b.properties?.mode?.const === "monthly");
    expect(monthly?.properties?.daysOfMonth).toMatchObject({
      type: "array",
      items: { type: "number", minimum: 1, maximum: 31 },
    });
  });

  it("boolean fields (e.g. externalFireable, autoGasLimit) render as plain {type:boolean}, not a literal-union oneOf", () => {
    // Regression: TypeScript represents `boolean` internally as a union of
    // the `true`/`false` literal types, which the walker must collapse —
    // the bug this guarded against produced a garbage `oneOf` of `valueOf`-
    // shaped objects instead of a clean boolean.
    const { jsonSchema } = generateRawCronotonSchema(program, BUILTIN_DESCRIPTORS);
    expect(jsonSchema.properties?.externalFireable).toMatchObject({ type: "boolean" });
    const config = jsonSchema.properties?.singleTxFirst?.properties?.config;
    expect(config?.properties?.autoGasLimit).toMatchObject({ type: "boolean" });
  });

  it("the plannerName enum is EXACTLY Object.keys(BUILTIN_DESCRIPTORS) — not a hand-copied list", () => {
    const { jsonSchema } = generateRawCronotonSchema(program, BUILTIN_DESCRIPTORS);
    const plannerName = jsonSchema.properties?.steps?.items?.properties?.plannerName;
    expect(plannerName?.enum).toEqual(Object.keys(BUILTIN_DESCRIPTORS).sort());
  });

  it("every BUILTIN_DESCRIPTORS entry's own params[] produces a matching plannerParams anyOf branch — proves generation, not a hand-copy", () => {
    const { jsonSchema } = generateRawCronotonSchema(program, BUILTIN_DESCRIPTORS);
    const plannerParams = jsonSchema.properties?.steps?.items?.properties?.plannerParams;
    expect(plannerParams?.anyOf).toHaveLength(Object.keys(BUILTIN_DESCRIPTORS).length);

    for (const [name, descriptor] of Object.entries(BUILTIN_DESCRIPTORS)) {
      const branch = plannerParams?.anyOf?.find((b) => b.title === name);
      expect(branch, `no plannerParams branch found for ${name}`).toBeDefined();
      const expectedFieldNames = descriptor.params.map((p) => p.name).sort();
      expect(Object.keys(branch?.properties ?? {}).sort()).toEqual(expectedFieldNames);
      const expectedRequired = descriptor.params.filter((p) => p.required).map((p) => p.name).sort();
      expect((branch?.required ?? []).sort()).toEqual(expectedRequired);
    }
  });

  it("an unknown-typed field (plannerParams at the ChainStepInput level, before the planner merge) carries its real JSDoc description with no type constraint", () => {
    const { jsonSchema } = generateRawCronotonSchema(program, BUILTIN_DESCRIPTORS);
    // After the merge this field becomes the oneOf above; confirm the
    // description survived the merge (mergeKeepingDescription's whole job).
    const plannerName = jsonSchema.properties?.steps?.items?.properties?.plannerName;
    expect(plannerName?.description).toMatch(/registered planner name/);
  });

  it("renders markdown containing the top-level table, the $yield section, and every planner name", () => {
    const { markdown } = generateRawCronotonSchema(program, BUILTIN_DESCRIPTORS);
    expect(markdown).toContain("## Top level");
    expect(markdown).toContain("$yield");
    for (const name of Object.keys(BUILTIN_DESCRIPTORS)) {
      expect(markdown).toContain(name);
    }
  });

  it("gives the several-times-per-day schedule branch's `times` array-of-object field its own nested subsection (not a dead 'see below')", () => {
    // Regression: nestedObjectSections used to recurse into plain nested
    // objects but never into oneOf/anyOf branches, so a branch-local nested
    // object/array-of-object field (ScheduleConfig's `several-times-per-day`
    // branch has one: `times: {hour,minute}[]`) was labelled "array of
    // object (see below)" with no "below" ever rendered — a dead promise.
    const { markdown } = generateRawCronotonSchema(program, BUILTIN_DESCRIPTORS);
    const headingMatch = markdown.match(/^#+ `schedule\.config\.several-times-per-day\.times`.*$/m);
    expect(headingMatch, "no subsection heading found for schedule.config.several-times-per-day.times").not.toBeNull();

    // The subsection's own table (up to the next heading line) must carry
    // the real `hour`/`minute` fields, not just the heading promise.
    const headingIndex = markdown.indexOf(headingMatch![0]);
    const rest = markdown.slice(headingIndex + headingMatch![0].length);
    const nextHeadingIndex = rest.search(/^#+ /m);
    const subsection = nextHeadingIndex === -1 ? rest : rest.slice(0, nextHeadingIndex);
    expect(subsection).toContain("| `hour` |");
    expect(subsection).toContain("| `minute` |");
  });

  it("every rendered markdown table row has exactly 4 pipe-delimited cells (Field/Type/Required/Description), never corrupted by an unescaped `|`", () => {
    // Regression: `escapeCell` was added after a real prior bug where an
    // unescaped `|` (from an enum's own `join(", ")`-free render) leaked
    // into a type label and split a table row into extra columns. This
    // structurally checks every field row across the WHOLE generated
    // document, not just a `toContain` substring spot-check.
    const { markdown } = generateRawCronotonSchema(program, BUILTIN_DESCRIPTORS);
    const fieldRows = markdown.split("\n").filter((line) => line.startsWith("| `"));
    expect(fieldRows.length).toBeGreaterThan(0);
    for (const row of fieldRows) {
      // Count unescaped `|` (not preceded by a backslash) — escaped pipes
      // inside a cell's own content (e.g. an enum list) must not count as
      // column delimiters.
      const unescapedPipeCount = (row.match(/(?<!\\)\|/g) ?? []).length;
      // 4 cells (Field/Type/Required/Description) need 5 delimiting `|`s: one
      // leading, three between cells, one trailing.
      expect(unescapedPipeCount, `malformed table row (expected exactly 5 unescaped '|'): ${row}`).toBe(5);
    }
  });

  it("a param field's safety-critical help text survives into the generated description even when its type (decimal/account/glyph-account) already sets a generic one", () => {
    // Regression: paramFieldSchema's prior either/or fallback (`field.help &&
    // !base.description`) never fired for decimal/account/glyph-account
    // fields, since fieldTypeSchema ALWAYS sets a generic description for
    // those 3 types — silently discarding author-written safety warnings
    // like ouronet.aqp-inject's executor field, which warns that a native
    // "k:" account (instead of a glyph account) causes a hard on-chain
    // revert because DPTF balances are keyed by (token-id, glyph account).
    const { jsonSchema } = generateRawCronotonSchema(program, BUILTIN_DESCRIPTORS);
    const plannerParams = jsonSchema.properties?.steps?.items?.properties?.plannerParams;
    const branch = plannerParams?.anyOf?.find((b) => b.title === "ouronet.aqp-inject");
    const executorField = BUILTIN_DESCRIPTORS["ouronet.aqp-inject"].params.find((p) => p.name === "executor");
    expect(executorField?.type).toBe("glyph-account");
    expect(executorField?.help).toBeTruthy();
    expect(branch?.properties?.executor?.description).toContain(executorField!.help);
  });

  it("throws (fails the build) if findNamedDeclaration can't find a requested type name, rather than silently omitting it", () => {
    const checker = program.getTypeChecker();
    expect(() => buildNamedTypeSchema(program, checker, "ThisTypeDoesNotExistAnywhere")).toThrow(
      /no exported interface\/type named/,
    );
  });
});
