import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import {
  pactLanguageSupport,
  pactHighlightExtension,
  PACT_TOKEN_TABLE,
  PACT_HIGHLIGHT_SPECS,
} from "./pact-lang.js";

/**
 * Walks the full syntax tree produced by a headless `EditorState` and
 * returns every node whose name matches `nodeName`, as `{ from, to, text }`.
 *
 * `StreamLanguage`-based parsers expose the token-type string returned by
 * `token()` directly as the node's `name` (verified against
 * `@codemirror/language`'s own `StreamLanguage`/`syntaxTree` behaviour before
 * writing these tests) — so this is a real, non-tautological check of the
 * classification logic in `pact-lang.ts`'s `token()` function, not an
 * assertion on an implementation detail invented for the test.
 */
function findNodes(
  doc: string,
  nodeName: string,
): { from: number; to: number; text: string }[] {
  const state = EditorState.create({
    doc,
    extensions: [pactLanguageSupport()],
  });
  const found: { from: number; to: number; text: string }[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === nodeName) {
        found.push({
          from: node.from,
          to: node.to,
          text: state.doc.sliceString(node.from, node.to),
        });
      }
    },
  });
  return found;
}

describe("pactLanguageSupport", () => {
  it("tags a defun's name as definitionKeyword, catching a regression that would leave definitions unstyled", () => {
    const nodes = findNodes("(defun foo () 1)", "definitionKeyword");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].text).toBe("defun");
  });

  it("tags `if` as keyword and both `true`/1/2-adjacent booleans as bool, not lumping keywords and numbers together", () => {
    const keywordNodes = findNodes("(if true 1 2)", "keyword");
    expect(keywordNodes).toHaveLength(1);
    expect(keywordNodes[0].text).toBe("if");

    const boolNodes = findNodes("(if true 1 2)", "bool");
    expect(boolNodes).toHaveLength(1);
    expect(boolNodes[0].text).toBe("true");

    const numberNodes = findNodes("(if true 1 2)", "number");
    expect(numberNodes).toHaveLength(2);
    expect(numberNodes.map((n) => n.text)).toEqual(["1", "2"]);
  });

  it("never classifies an identifier containing 'defun' as a substring as definitionKeyword, since the whole-token match must run before keyword comparison", () => {
    const doc = "(let ((my-defun-helper 1)) my-defun-helper)";
    const defKwNodes = findNodes(doc, "definitionKeyword");
    expect(defKwNodes).toHaveLength(0);

    const varNodes = findNodes(doc, "variableName");
    const helperOccurrences = varNodes.filter(
      (n) => n.text === "my-defun-helper",
    );
    expect(helperOccurrences).toHaveLength(2);
  });

  it("tags a ;; line comment through to end of line, not including the trailing newline", () => {
    const nodes = findNodes(";; a comment\n(x)", "lineComment");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].text).toBe(";; a comment");
  });

  it("tags a string containing an escaped quote as a single string token spanning the whole literal", () => {
    const doc = '"a \\"quoted\\" string"';
    const nodes = findNodes(doc, "string");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].text).toBe(doc);
  });

  it("tags an @doc meta tag distinctly from the string that follows it", () => {
    const nodes = findNodes('@doc "desc"', "meta");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].text).toBe("@doc");
  });

  it("tags the `integer` builtin as typeName, not as a plain variableName", () => {
    const nodes = findNodes("(integer)", "typeName");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].text).toBe("integer");
  });

  it("tags a 'symbol atom including its leading quote as a single atom token", () => {
    const nodes = findNodes("'my-symbol", "atom");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].text).toBe("'my-symbol");
  });
});

describe("pactHighlightExtension", () => {
  it("is a real, non-null CodeMirror extension usable alongside the language extension", () => {
    expect(pactHighlightExtension).toBeTruthy();
    expect(() =>
      EditorState.create({
        doc: "(defun foo () 1)",
        extensions: [pactLanguageSupport(), pactHighlightExtension],
      }),
    ).not.toThrow();
  });

  it("has a color rule for every tag registered in PACT_TOKEN_TABLE — a token correctly classified but never colored (exactly what happened to `meta` for a while) fails this test", () => {
    const styledTags = new Set(PACT_HIGHLIGHT_SPECS.map((spec) => spec.tag));
    const missing = Object.entries(PACT_TOKEN_TABLE)
      .filter(([, tag]) => !styledTags.has(tag))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });
});
