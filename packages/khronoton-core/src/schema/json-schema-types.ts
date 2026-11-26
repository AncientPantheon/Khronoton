/**
 * The tiny JSON Schema (draft-07-ish) shape this package's generator emits.
 * Deliberately NOT the full draft-07 spec — only the subset the generator
 * (`type-schema.ts`/`builtin-descriptors-schema.ts`/`generate.ts`) actually
 * produces, kept in one place so every piece of the generator agrees on one
 * shape.
 */
export interface JsonSchema {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minItems?: number;
  enum?: unknown[];
  const?: unknown;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  nullable?: boolean;
}
