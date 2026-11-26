/**
 * Assembles the full published raw-cronoton artifact from the two generated
 * halves: `type-schema.ts`'s walk of `ChainCommitBody` (and everything it
 * references) via the TypeScript Compiler API, and `builtin-descriptors-
 * schema.ts`'s walk of `BUILTIN_DESCRIPTORS`' own runtime data for the
 * `plannerName`/`plannerParams` slice neither static type can carry. Pure
 * (no file I/O) and independently testable — `scripts/generate-raw-
 * cronoton-schema.mjs` is the thin build-time wrapper that supplies a real
 * `ts.Program` + the real `BUILTIN_DESCRIPTORS` and writes this function's
 * output to `dist/schema/*`.
 */
import type ts from "typescript";
import type { BuiltinDescriptor } from "../builtins/descriptors.js";
import { buildPlannerSchema } from "./builtin-descriptors-schema.js";
import type { JsonSchema } from "./json-schema-types.js";
import { renderRawCronotonMarkdown } from "./markdown.js";
import { buildNamedTypeSchema } from "./type-schema.js";

export interface GeneratedRawCronotonSchema {
  jsonSchema: JsonSchema;
  markdown: string;
}

/** Keep a type-derived field's own description (from the real JSDoc comment
 *  on `ChainStepInput.plannerName`/`.plannerParams`) while replacing its
 *  type-level constraint with the descriptor-derived one — a plain object
 *  spread in either order would lose one or the other. */
function mergeKeepingDescription(typeDerived: JsonSchema | undefined, descriptorDerived: JsonSchema): JsonSchema {
  return {
    ...descriptorDerived,
    ...(typeDerived?.description ? { description: typeDerived.description } : {}),
  };
}

export function generateRawCronotonSchema(
  program: ts.Program,
  builtinDescriptors: Record<string, BuiltinDescriptor>,
): GeneratedRawCronotonSchema {
  const checker = program.getTypeChecker();
  const chainCommitBodySchema = buildNamedTypeSchema(program, checker, "ChainCommitBody");
  const { plannerNameSchema, plannerParamsSchema } = buildPlannerSchema(builtinDescriptors);

  const stepsItems = chainCommitBodySchema.properties?.steps?.items;
  if (!stepsItems?.properties?.plannerName || !stepsItems.properties.plannerParams) {
    // The generator's own assumption about ChainStepInput's shape went
    // stale (a field was renamed/removed) — fail the BUILD, don't publish a
    // schema silently missing the planner slice.
    throw new Error(
      "generate: ChainStepInput no longer has both plannerName " +
        "and plannerParams at the expected shape — update generate.ts's merge step.",
    );
  }
  stepsItems.properties.plannerName = mergeKeepingDescription(stepsItems.properties.plannerName, plannerNameSchema);
  stepsItems.properties.plannerParams = mergeKeepingDescription(stepsItems.properties.plannerParams, plannerParamsSchema);

  const jsonSchema: JsonSchema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Raw chained-cronoton JSON",
    description:
      "The canonical JSON shape chainedBuilderToCommit(state) emits and " +
      "jsonToChainedBuilderState(text) accepts back. Generated from " +
      "@ancientpantheon/khronoton-core's own types + BUILTIN_DESCRIPTORS.",
    ...chainCommitBodySchema,
  };

  const markdown = renderRawCronotonMarkdown({ chainCommitBodySchema: jsonSchema, plannerNameSchema, plannerParamsSchema });

  return { jsonSchema, markdown };
}
