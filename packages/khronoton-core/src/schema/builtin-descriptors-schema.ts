/**
 * Generates the `plannerName`/`plannerParams` slice of the raw-cronoton JSON
 * Schema FROM `BUILTIN_DESCRIPTORS`' own runtime data — the one piece of the
 * canonical raw-JSON shape that genuinely has no static TYPE to walk
 * (`ChainStepInput.plannerParams` is `unknown` on the wire; each planner's
 * real param shape only exists as `BuiltinDescriptor.params:
 * BuiltinParamField[]`). Pure data transformation — no TypeScript Compiler
 * API needed here, unlike `type-schema.ts`.
 */
import type { BuiltinDescriptor, BuiltinParamField } from "../builtins/descriptors.js";
import type { JsonSchema } from "./json-schema-types.js";

/**
 * One `BuiltinParamField.type` → the JSON Schema fragment describing its
 * syntax. Mirrors the SAME shape guards `descriptors.ts`'s own `toFragment`
 * implementations enforce at runtime (`ACCOUNT_SHAPE`, `isLiteralDecimal`),
 * so the published schema and the real validation agree on what's valid.
 */
function fieldTypeSchema(field: BuiltinParamField): JsonSchema {
  switch (field.type) {
    case "decimal":
      // A literal Pact decimal (`/^\d+\.\d+$/`, e.g. "50.0") — or, when
      // `allowExpr` is set, ALSO a hand-authored Pact expression string, in
      // which case no single regex covers both forms; the field stays a
      // plain string and the choice is documented instead.
      return field.allowExpr
        ? { type: "string", description: "A literal Pact decimal (e.g. \"50.0\") OR a hand-authored Pact expression string." }
        : { type: "string", pattern: "^\\d+\\.\\d+$", description: "A literal Pact decimal, e.g. \"50.0\" (not \"50\")." };
    case "account":
      return {
        type: "string",
        pattern: "^[kc]:[A-Za-z0-9_-]+$",
        description: "A k:/c: Kadena account.",
      };
    case "glyph-account":
      return { type: "string", description: "An Ouronet glyph account (e.g. \"\u047a.\u2026\"/\"\u03a3.\u2026\")." };
    case "enum":
      return { type: "string", enum: field.options ?? [] };
    case "string":
    default:
      return { type: "string" };
  }
}

/** One field → its full schema fragment, folding in the field's own `help`
 *  text into the `description`. `field.help` is often safety-critical,
 *  author-written guidance (e.g. a warning about a hard on-chain revert) —
 *  it must always be surfaced when present, never silently dropped just
 *  because `fieldTypeSchema` already set a generic type-shape description
 *  for that field's type (true for every `decimal`/`account`/`glyph-account`
 *  field). When both exist, `help` leads and the generic shape description
 *  follows in parentheses, so neither is lost. */
function paramFieldSchema(field: BuiltinParamField): JsonSchema {
  const base = fieldTypeSchema(field);
  if (!field.help) return base;
  const description = base.description ? `${field.help} (${base.description})` : field.help;
  return { ...base, description };
}

/** One `BuiltinDescriptor` → the JSON Schema for its `plannerParams` object. */
function plannerParamsSchemaFor(descriptor: BuiltinDescriptor): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of descriptor.params) {
    properties[field.name] = paramFieldSchema(field);
    if (field.required) required.push(field.name);
  }
  return {
    type: "object",
    description: `${descriptor.label} (${descriptor.kind}) — ${descriptor.description}`,
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: true,
  };
}

/**
 * The full planner slice: a `plannerName` enum (every registered built-in's
 * name) and an `anyOf` over each one's own `plannerParams` object shape,
 * each branch `title`d with the exact plannerName it applies to.
 *
 * Deliberately `anyOf`, not `oneOf`: these branches are NOT independently
 * tied to the sibling `plannerName` property (this package's generator
 * intentionally stays within the small JSON Schema subset `json-schema-
 * types.ts` declares, rather than a step-level `if/then` keyed off
 * `plannerName` — documented via each branch's `title`/`description`
 * instead, for a human/doc-renderer to match by eye). A validator checking
 * a bare `plannerParams` object against this list has no visibility into
 * which `plannerName` it's actually paired with, so if TWO planners'
 * required-field sets both happen to be satisfied by the same params object
 * (e.g. one planner has few/no required fields), `oneOf`'s "EXACTLY one
 * branch may match" semantics would reject every such document outright —
 * confirmed as a real, reproducible failure by this module's own `cross-
 * check.test.ts` before this was caught and fixed. `anyOf`'s "at least one
 * branch matches" is the correct, weaker guarantee this flat structure can
 * actually deliver: it still catches a `plannerParams` blob that matches NO
 * registered planner's shape at all (the one thing worth validating without
 * cross-referencing the sibling field), without the false-rejection risk.
 */
export function buildPlannerSchema(descriptors: Record<string, BuiltinDescriptor>): {
  plannerNameSchema: JsonSchema;
  plannerParamsSchema: JsonSchema;
} {
  const names = Object.keys(descriptors).sort();
  const plannerNameSchema: JsonSchema = { type: "string", enum: names };
  const plannerParamsSchema: JsonSchema = {
    anyOf: names.map((name) => {
      const fragment = plannerParamsSchemaFor(descriptors[name]);
      // `title` carries the EXACT plannerName this branch applies to (never
      // overwritten by `fragment`, which sets only `description`), so a
      // consuming editor/doc renderer — or a test — can match a branch to
      // its planner reliably, not by substring-searching free text.
      return { ...fragment, title: name, description: `When plannerName is "${name}": ${fragment.description ?? ""}`.trim() };
    }),
  };
  return { plannerNameSchema, plannerParamsSchema };
}
