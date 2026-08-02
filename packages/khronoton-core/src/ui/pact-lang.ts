import { StreamLanguage, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { StringStream } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Tag } from "@lezer/highlight";

/**
 * Hand-rolled Pact tokenizer wired through `@codemirror/language`'s
 * `StreamLanguage.define()` — a plain JS token function, no `.grammar` file,
 * no `@lezer/generator` codegen step. Ported keyword-for-keyword and
 * tag-for-tag from OuronetUI's real Lezer grammar so the token *categories*
 * (and therefore the visual result) match exactly; see
 * `docs/work/khronoton-builder-pact-editor/design.md`'s "Change 1" section
 * for why this approach was chosen over porting the compiled grammar.
 *
 * Precedence matters: each `stream.match(...)` below is tried in order, and
 * the first one that matches wins. Identifiers can never start with a
 * digit/operator/comment/quote character, so this order has no ambiguity —
 * in particular, step 12 always consumes the FULL identifier before
 * classifying it, which is what keeps `my-defun-helper` a `variableName`
 * instead of matching `defun` as a substring.
 */

const DEFINITION_KEYWORDS = new Set([
  "defun",
  "defcap",
  "defconst",
  "defpact",
  "defschema",
  "deftable",
  "module",
  "interface",
  "defproperty",
]);

const KEYWORDS = new Set([
  "if",
  "let",
  "let*",
  "lambda",
  "cond",
  "use",
  "namespace",
  "implements",
  "bless",
  "with-read",
  "with-default-read",
  "with-capability",
  "bind",
  "step",
  "step-with-rollback",
  "resume",
  "yield",
  "enforce",
  "enforce-one",
  "enforce-keyset",
  "enforce-guard",
  "require-capability",
  "compose-capability",
  "read",
  "write",
  "update",
  "select",
  "where",
  "and",
  "or",
  "not",
  "try",
  "format",
  "map",
  "fold",
  "filter",
  "define-keyset",
  "define-namespace",
]);

const TYPE_NAMES = new Set([
  "integer",
  "decimal",
  "time",
  "bool",
  "string",
  "list",
  "value",
  "keyset",
  "guard",
  "object",
  "table",
]);

function token(stream: StringStream): string | null {
  if (stream.eatSpace()) return null;

  if (stream.match(";;")) {
    stream.skipToEnd();
    return "lineComment";
  }

  if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";

  if (stream.match(/^\d+(\.\d+)?/)) return "number";

  if (stream.match(/^'[a-zA-Z_-][a-zA-Z0-9_-]*/)) return "atom";

  if (stream.match(/^@[a-zA-Z_][a-zA-Z0-9_-]*/)) return "meta";

  if (stream.match(/^(:=|::)/)) return "operator";

  if (stream.match(/^[+\-*/=<>!]=?/)) return "operator";

  if (stream.match(/^[()]/)) return "paren";

  if (stream.match(/^[[\]]/)) return "squareBracket";

  if (stream.match(/^[{}]/)) return "brace";

  const identifierMatch = stream.match(
    /^[a-zA-Z_][a-zA-Z0-9_\-.%#+&$@<>=?*!|/]*/,
  );
  if (identifierMatch) {
    // `StringStream.match`'s declared return type (`true | RegExpMatchArray
    // | null`) covers both its string- and RegExp-pattern overloads, but at
    // runtime a RegExp pattern (the only kind used here) only ever resolves
    // to `null` or the actual `RegExpMatchArray` — never the bare boolean
    // `true`, which that type only allows for the string-pattern case. The
    // assertion reflects that real behavior, not an assumption.
    const word = (identifierMatch as RegExpMatchArray)[0];
    if (DEFINITION_KEYWORDS.has(word)) return "definitionKeyword";
    if (KEYWORDS.has(word)) return "keyword";
    if (TYPE_NAMES.has(word)) return "typeName";
    if (word === "true" || word === "false") return "bool";
    return "variableName";
  }

  stream.next();
  return null;
}

/**
 * Every custom token name `token()` can return, mapped to its
 * `@lezer/highlight` tag. Exported as its own constant (rather than inlined
 * into `StreamLanguage.define`) so a test can cross-check that every tag
 * named here also has a color rule in `pactHighlightExtension` below — the
 * two lists drifting out of sync (a tag registered here with no matching
 * `HighlightStyle` entry) is exactly the bug class that let `meta` render
 * unstyled for a while: correctly tagged, silently uncolored.
 */
export const PACT_TOKEN_TABLE: Record<string, Tag> = {
  definitionKeyword: t.definitionKeyword,
  keyword: t.keyword,
  typeName: t.typeName,
  bool: t.bool,
  string: t.string,
  number: t.number,
  lineComment: t.lineComment,
  variableName: t.variableName,
  atom: t.atom,
  operator: t.operator,
  meta: t.meta,
  paren: t.paren,
  squareBracket: t.squareBracket,
  brace: t.brace,
};

/**
 * The Pact `StreamLanguage`, usable directly inside a CodeMirror
 * `extensions` array (a `Language` instance satisfies CodeMirror's
 * structural `Extension` protocol via its own `.extension` property).
 * Exposed as a function per the module's public API so callers don't share
 * a single language instance's identity across editors — `StreamLanguage`
 * instances are cheap and stateless to construct.
 */
export function pactLanguageSupport(): StreamLanguage<unknown> {
  return StreamLanguage.define({
    token,
    languageData: {
      commentTokens: { line: ";;" },
      closeBrackets: { brackets: ["(", "[", "{", '"'] },
    },
    tokenTable: PACT_TOKEN_TABLE,
  });
}

/**
 * Maps every custom token tag above to a `--khr-*` CSS custom property, so
 * `PactCodeMirror.tsx` colors Pact source using the package's existing theme
 * tokens rather than hardcoded hex (unlike OuronetUI's own hardcoded-hex
 * `HighlightStyle`, which this ports the token *categories* from but not the
 * literal colors). Kept as its own exported array (rather than inlined into
 * `HighlightStyle.define`) so a test can assert every tag in
 * `PACT_TOKEN_TABLE` has a matching entry here.
 */
export const PACT_HIGHLIGHT_SPECS = [
  { tag: t.keyword, color: "var(--khr-syntax-keyword, #c586c0)" },
  {
    tag: t.definitionKeyword,
    color: "var(--khr-accent, #f0a500)",
    fontWeight: "bold",
  },
  { tag: t.typeName, color: "var(--khr-syntax-type, #4ec9b0)" },
  { tag: t.bool, color: "var(--khr-blue, #60a5fa)" },
  { tag: t.string, color: "var(--khr-syntax-string, #ce9178)" },
  { tag: t.number, color: "var(--khr-syntax-number, #b5cea8)" },
  {
    tag: t.lineComment,
    color: "var(--khr-text-dim2, #6b7280)",
    fontStyle: "italic",
  },
  { tag: t.variableName, color: "var(--khr-mono, #d2d3d4)" },
  { tag: t.atom, color: "var(--khr-syntax-atom, #d7ba7d)" },
  // Reuses --khr-blue (also used for `bool`) — `@doc`/`@model` meta tags
  // and `true`/`false` literals never appear adjacent in real Pact
  // source, so sharing the color carries no real ambiguity risk, and it
  // avoids a brand-new token for a single rare-elsewhere role.
  { tag: t.meta, color: "var(--khr-blue, #60a5fa)" },
  { tag: t.operator, color: "var(--khr-text-dim, #8a8f98)" },
  { tag: t.paren, color: "var(--khr-text-dim, #8a8f98)" },
  { tag: t.squareBracket, color: "var(--khr-text-dim, #8a8f98)" },
  { tag: t.brace, color: "var(--khr-text-dim, #8a8f98)" },
];

export const pactHighlightExtension = syntaxHighlighting(
  HighlightStyle.define(PACT_HIGHLIGHT_SPECS),
);
