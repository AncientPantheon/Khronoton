/**
 * Renders the generated JSON Schema (`type-schema.ts` + `builtin-descriptors-
 * schema.ts`'s output, assembled by `generate.ts`) into the human field
 * reference the Hub links from `/docs`. The FIELD DEFINITIONS below are
 * walked generically off the schema object itself (never hand-copied field
 * names/types/ranges) — only the document's section order/connective prose
 * is a hand-arranged template, same as any generated-data report needs some
 * authored narrative around the generated tables.
 */
import type { JsonSchema } from "./json-schema-types.js";

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

/** A short, human type label for one schema fragment — "string", "number
 *  (60–86400)", "boolean", "array of <item>", "object (see below)", an enum
 *  list, or a oneOf summary. Drives the "Type" column of every table below. */
function typeLabel(fragment: JsonSchema): string {
  // Comma-separated, not `|`-separated — this label lands inside a markdown
  // table cell, where a literal `|` would read as another column delimiter.
  if (fragment.enum) return `enum: ${fragment.enum.map((v) => `\`${String(v)}\``).join(", ")}`;
  if (fragment.const !== undefined) return `const: \`${String(fragment.const)}\``;
  if (fragment.oneOf) return `one of ${fragment.oneOf.length} shapes (see below)`;
  if (fragment.anyOf) return `any of ${fragment.anyOf.length} shapes (see below)`;
  if (fragment.type === "array") {
    return `array of ${fragment.items ? typeLabel(fragment.items) : "unknown"}`;
  }
  if (fragment.type === "object") return "object (see below)";
  if (typeof fragment.type === "string") {
    const range =
      fragment.minimum !== undefined || fragment.maximum !== undefined
        ? ` (${fragment.minimum ?? "−∞"}–${fragment.maximum ?? "∞"})`
        : "";
    return `${fragment.type}${range}`;
  }
  return "any";
}

/** A readable label for one branch of a `oneOf` — prefers an explicit
 *  `title` (set for the planner-params branches, exactly one per real
 *  `BUILTIN_DESCRIPTORS` entry), falls back to a discriminant `mode`/`type`
 *  const property's value (every `ScheduleConfig` branch has one), falls
 *  back to the branch's own free-text `description`, falls back to an
 *  anonymous "Shape N" only when none of the above exist. */
function branchLabel(variant: JsonSchema, index: number): string {
  if (variant.title) return variant.title;
  const discriminant = variant.properties?.mode?.const ?? variant.properties?.type?.const;
  if (typeof discriminant === "string") return discriminant;
  return variant.description ?? `Shape ${index + 1}`;
}

/** A markdown table for one OBJECT schema's own `properties` — one row per
 *  field, Type/Required/Description columns. Nested object/array-of-object
 *  fragments (including ones found inside a `oneOf`/`anyOf` branch) are
 *  rendered in their own FOLLOW-UP section (by the caller, which walks
 *  `nestedObjectSections`) rather than inlined, so the table itself stays
 *  one level deep and readable. */
function renderObjectTable(schema: JsonSchema): string {
  if (!schema.properties) return "_(no fields)_\n";
  const required = new Set(schema.required ?? []);
  const rows = Object.entries(schema.properties).map(([name, fragment]) => {
    const desc = fragment.description ? escapeCell(fragment.description) : "";
    // `typeLabel` can itself contain literal `|` (an enum's own join
    // separator) — escape it same as the description, or those pipes get
    // read as extra table-cell delimiters and corrupt the row.
    return `| \`${name}\` | ${escapeCell(typeLabel(fragment))} | ${required.has(name) ? "yes" : "no"} | ${desc} |`;
  });
  return ["| Field | Type | Required | Description |", "| --- | --- | --- | --- |", ...rows].join("\n") + "\n";
}

/** Depth-first: every named (object-or-array-of-object) nested fragment
 *  worth its OWN "###" subsection, in field order, so a reader can follow
 *  "see below" links top-to-bottom instead of hunting. */
function nestedObjectSections(schema: JsonSchema, headingPrefix: string, depth: number): string[] {
  if (!schema.properties) return [];
  const sections: string[] = [];
  for (const [name, fragment] of Object.entries(schema.properties)) {
    const target = fragment.type === "array" ? fragment.items : fragment;
    if (target?.type === "object" && target.properties) {
      const heading = "#".repeat(Math.min(depth + 2, 6));
      sections.push(`${heading} \`${headingPrefix}${name}\`\n\n${target.description ? `${target.description}\n\n` : ""}${renderObjectTable(target)}`);
      sections.push(...nestedObjectSections(target, `${headingPrefix}${name}.`, depth + 1));
    } else if (target?.oneOf ?? target?.anyOf) {
      const branches = (target.oneOf ?? target.anyOf)!;
      const heading = "#".repeat(Math.min(depth + 2, 6));
      sections.push(
        `${heading} \`${headingPrefix}${name}\` — ${target.oneOf ? "one" : "any"} of ${branches.length} shapes\n\n` +
          branches.map((variant, i) => `**${branchLabel(variant, i)}**\n\n${renderObjectTable(variant)}`).join("\n"),
      );
      // Each branch can have its OWN nested object/array-of-object fields
      // (e.g. ScheduleConfig's `several-times-per-day` branch has a
      // `times: {hour,minute}[]` field) — recurse into every branch too, not
      // just the plain-object case above, or those fields get a dead "(see
      // below)" label with no "below" ever rendered. The branch's own label
      // is folded into the heading prefix so two branches that happen to
      // share a nested field name (e.g. both having an `hour`/`minute`
      // field) still get distinct, unambiguous subsections.
      for (const [i, variant] of branches.entries()) {
        sections.push(...nestedObjectSections(variant, `${headingPrefix}${name}.${branchLabel(variant, i)}.`, depth + 1));
      }
    }
  }
  return sections;
}

export interface RawCronotonSchemaDocInput {
  chainCommitBodySchema: JsonSchema;
  plannerNameSchema: JsonSchema;
  plannerParamsSchema: JsonSchema;
}

/**
 * Renders the full human field reference. Generated by `scripts/generate-
 * raw-cronoton-schema.mjs` as a build step — this function's OUTPUT is never
 * hand-edited; a desired wording change belongs in the real TypeScript
 * doc comments/JSDoc tags this file reads, or in the connective prose
 * template below, never in the published `.md` file directly.
 */
export function renderRawCronotonMarkdown(input: RawCronotonSchemaDocInput): string {
  const { chainCommitBodySchema, plannerNameSchema, plannerParamsSchema } = input;
  const parts: string[] = [];

  parts.push(
    "# Raw chained-cronoton JSON — field reference\n\n" +
      "This is the canonical JSON shape `chainedBuilderToCommit(state)` emits and " +
      "`jsonToChainedBuilderState(text)` (the `ChainedBuilder` UI's \"Paste / import\" " +
      "affordance) accepts back — the same document a `POST /chain` commit body is " +
      "shaped from. **Generated from `@ancientpantheon/khronoton-core`'s own exported " +
      "types and `BUILTIN_DESCRIPTORS`** — never hand-maintained — so this file can " +
      "never drift from what the package actually accepts.\n\n" +
      "A machine-readable JSON Schema sibling ships alongside this file as " +
      "`raw-cronoton.schema.json`.\n",
  );

  parts.push("## Top level\n\n" + renderObjectTable(chainCommitBodySchema));
  parts.push(
    "`schedule` and `externalFireable` are mutually exclusive — a trigger-only " +
      "cronoton (`externalFireable: true`) carries no `schedule` at all; everything " +
      "else carries exactly one `schedule`.\n",
  );

  parts.push(
    "## `{\"$yield\":\"name\"}` references\n\n" +
      "Any `payload`/`plannerParams` value may be the object `{\"$yield\":\"<name>\"}` " +
      "instead of a literal — resolved, before that step runs, against a name an " +
      "EARLIER step declared via its own `yieldAs`. A step's `yieldAs` names the value " +
      "it produces (its own confirmed on-chain result for a `single` step; the " +
      "planner's own reported yield for a `planner` step) for a LATER step to " +
      "reference this way. Referencing a yield that doesn't exist, or one declared by " +
      "a step at the same or a later position, is rejected before anything is " +
      "committed.\n",
  );

  for (const section of nestedObjectSections(chainCommitBodySchema, "", 0)) {
    parts.push(section + "\n");
  }

  parts.push(
    "## Planner names + `plannerParams` schemas\n\n" +
      "Only present on a `mode: \"planner\"` step (`plannerName`/`plannerParams`; a " +
      "planner step carries no `pactCode`/`payload` — the planner builds those). " +
      `Generated from \`BUILTIN_DESCRIPTORS\`' own registered entries — ${(plannerNameSchema.enum ?? []).length} ` +
      "built-ins as of this build.\n\n" +
      `**\`plannerName\`** — ${typeLabel(plannerNameSchema)}\n\n` +
      (plannerParamsSchema.anyOf ?? [])
        .map(
          (variant, i) =>
            `### \`${branchLabel(variant, i)}\`\n\n${variant.description ?? ""}\n\n${renderObjectTable(variant)}`,
        )
        .join("\n"),
  );

  return parts.join("\n");
}
