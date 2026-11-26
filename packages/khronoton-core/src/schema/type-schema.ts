/**
 * Walks this package's OWN exported TypeScript types — via the TypeScript
 * Compiler API, never a hand-maintained duplicate literal — into the JSON
 * Schema fragments `generate.ts` assembles into the published raw-cronoton
 * schema. This is the "generate from types, don't hand-write" half of
 * `docs/work/chained-builder-raw-json-import/design.md`'s deliverable 2; the
 * sibling `builtin-descriptors-schema.ts` generates the other half (the
 * planner-params slice) from `BUILTIN_DESCRIPTORS`' own runtime data, since
 * `plannerParams` has no static type to walk.
 *
 * Deliberately a SINGLE general recursive type→schema function rather than
 * per-type special-casing: `checker.getPropertiesOfType`/
 * `getTypeOfSymbolAtLocation` work identically whether the type in hand is
 * one of this package's named exports (`CodexTxConfig`, …) or an anonymous
 * member of a union (e.g. one of `ScheduleConfig`'s 7 variants) — so one
 * walker correctly handles both without needing to know which case it's in.
 * `@minimum`/`@maximum` JSDoc tags on a field (added to the real source
 * declarations specifically for this generator — see `server/types.ts`'s
 * `CodexTxConfig` and `schedule.ts`'s per-mode fields) become the schema's
 * own `minimum`/`maximum`, since numeric ranges exist today only in
 * validator code, not in the bare type signatures.
 */
import { dirname, resolve } from "node:path";
import ts from "typescript";
import type { JsonSchema } from "./json-schema-types.js";

/** Create a `ts.Program` rooted at the given real source files, using this
 *  package's own compiler options (resolved from its real `tsconfig.json`)
 *  so the walk sees the SAME types the package itself compiles against. */
export function createProgramForTypes(rootFileNames: string[], tsconfigPath: string): ts.Program {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(`type-schema: failed to read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`);
  }
  // The tsconfig's OWN directory, never `process.cwd()` — this function must
  // resolve identically regardless of where the calling process happens to
  // have been launched from.
  const basePath = dirname(resolve(tsconfigPath));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, basePath);
  return ts.createProgram({ rootNames: rootFileNames, options: parsed.options });
}

/** Find a top-level `interface`/`type` declaration by name anywhere in the
 *  program's own (non-declaration) source files. THROWS if not found — a
 *  renamed/moved/deleted type must fail the BUILD, not silently vanish from
 *  the published schema (the strongest "no drift" guarantee this generator
 *  can give: it cannot succeed while its own assumptions are stale). */
function findNamedDeclaration(
  program: ts.Program,
  name: string,
): ts.InterfaceDeclaration | ts.TypeAliasDeclaration {
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    for (const statement of sourceFile.statements) {
      if (
        (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
        statement.name.text === name
      ) {
        return statement;
      }
    }
  }
  throw new Error(
    `type-schema: no exported interface/type named "${name}" found in the program — ` +
      `has it been renamed or moved? The raw-cronoton schema generator's assumptions are stale.`,
  );
}

function jsDocTagNumber(tags: readonly ts.JSDocTagInfo[], tagName: string): number | undefined {
  const tag = tags.find((t) => t.name === tagName);
  if (!tag || !tag.text) return undefined;
  const text = tag.text.map((part) => part.text).join("").trim();
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

function symbolDocComment(symbol: ts.Symbol, checker: ts.TypeChecker): string | undefined {
  const parts = symbol.getDocumentationComment(checker);
  const text = ts.displayPartsToString(parts).trim();
  return text.length > 0 ? text : undefined;
}

/** Is this an `Array<T>`/`T[]` type? Returns its element type if so. */
function arrayElementType(type: ts.Type): ts.Type | undefined {
  const ref = type as ts.TypeReference;
  if (ref.symbol?.getName() === "Array" && ref.typeArguments && ref.typeArguments.length === 1) {
    return ref.typeArguments[0];
  }
  return undefined;
}

/** Is this a `Record<K, V>` type? Returns its value type if so (the key type
 *  is always `string` for every real use in this package's own types). */
function recordValueType(type: ts.Type): ts.Type | undefined {
  const ref = type as ts.TypeReference;
  if (ref.symbol?.getName() === "Record" && ref.typeArguments && ref.typeArguments.length === 2) {
    return ref.typeArguments[1];
  }
  return undefined;
}

/** Strip a literal `undefined`/`null` member out of a union (optionality is
 *  handled separately, via the SYMBOL's own optional flag, not via a type
 *  union member — but a declared `X | null` like `description?: string |
 *  null` still needs the `null` member removed before converting the rest). */
function withoutNullish(types: readonly ts.Type[]): ts.Type[] {
  return types.filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
}

/** The single general recursive converter: any `ts.Type` → its JSON Schema
 *  fragment. Handles primitives, literals, string-literal unions (→ enum),
 *  other unions (→ oneOf), arrays, `Record<string,V>`, `unknown`/`any`, and
 *  falls back to walking the type's own properties as a plain object —
 *  which is exactly as correct for a NAMED interface (`CodexTxConfig`) as
 *  for an anonymous member of a union (one of `ScheduleConfig`'s variants). */
function typeToSchema(type: ts.Type, checker: ts.TypeChecker): JsonSchema {
  if (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) return {};
  if (type.flags & ts.TypeFlags.String) return { type: "string" };
  if (type.flags & ts.TypeFlags.Number) return { type: "number" };
  if (type.flags & ts.TypeFlags.Boolean) return { type: "boolean" };
  // The checker represents the bare `boolean` keyword type as a UNION of the
  // two `BooleanLiteral` types (`true`/`false`) at a property's resolved
  // type — NOT as a single type with the `Boolean` flag — so a boolean
  // literal must be collapsed to `{type:"boolean"}` before the generic
  // union/object-fallback logic below ever sees it (otherwise it falls all
  // the way through to the plain-object walker, which "discovers" `boolean`
  // literal types structurally expose a `valueOf` method and emits garbage).
  if (type.flags & ts.TypeFlags.BooleanLiteral) return { type: "boolean" };
  if (type.isStringLiteral()) return { type: "string", const: type.value };
  if (type.isNumberLiteral()) return { type: "number", const: type.value };

  if (type.isUnion()) {
    const members = withoutNullish(type.types);
    if (members.length === 1) return typeToSchema(members[0], checker);
    if (members.every((m) => m.flags & ts.TypeFlags.BooleanLiteral)) {
      return { type: "boolean" };
    }
    if (members.every((m) => m.isStringLiteral())) {
      return { type: "string", enum: members.map((m) => (m as ts.StringLiteralType).value) };
    }
    return { oneOf: members.map((m) => typeToSchema(m, checker)) };
  }

  const elementType = arrayElementType(type);
  if (elementType) return { type: "array", items: typeToSchema(elementType, checker) };

  const valueType = recordValueType(type);
  if (valueType) return { type: "object", additionalProperties: typeToSchema(valueType, checker) };

  // Fallback: a plain object type (named interface or an anonymous object-
  // literal union member) — walk its own properties.
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const propertySymbol of checker.getPropertiesOfType(type)) {
    const declaration = propertySymbol.valueDeclaration ?? propertySymbol.declarations?.[0];
    if (!declaration) continue;
    const propertyType = checker.getTypeOfSymbolAtLocation(propertySymbol, declaration);
    const fragment = typeToSchema(propertyType, checker);
    const description = symbolDocComment(propertySymbol, checker);
    const tags = propertySymbol.getJsDocTags(checker);
    const minimum = jsDocTagNumber(tags, "minimum");
    const maximum = jsDocTagNumber(tags, "maximum");
    const minItems = jsDocTagNumber(tags, "minItems");
    // `minimum`/`maximum` constrain NUMBER instances per JSON Schema — on an
    // array-typed field they must land on `items`, never as siblings of the
    // array's own `type`/`items` (a sibling placement is silently inert:
    // nothing validates/renders it there). `minItems` is array-cardinality
    // and stays on the container regardless.
    const isArray = fragment.type === "array" && fragment.items;
    const range = {
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
    };
    properties[propertySymbol.getName()] = {
      ...fragment,
      ...(isArray ? { items: { ...fragment.items, ...range } } : range),
      ...(description ? { description } : {}),
      ...(minItems !== undefined ? { minItems } : {}),
    };
    const isOptional = Boolean(propertySymbol.flags & ts.SymbolFlags.Optional);
    if (!isOptional) required.push(propertySymbol.getName());
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/** The public entry point: resolve a top-level type/interface BY NAME in the
 *  program and convert it. Throws (per `findNamedDeclaration`'s own
 *  contract) if the name no longer resolves — a build failure, not a silent
 *  gap, is the intended response to the generator's assumptions going stale. */
export function buildNamedTypeSchema(
  program: ts.Program,
  checker: ts.TypeChecker,
  name: string,
): JsonSchema {
  const declaration = findNamedDeclaration(program, name);
  const type = checker.getTypeAtLocation(declaration);
  return typeToSchema(type, checker);
}
