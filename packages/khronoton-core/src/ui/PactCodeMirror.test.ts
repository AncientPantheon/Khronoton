import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  buildPactEditorExtensions,
  KHRONOTON_EDITOR_THEME_SPEC,
} from "./PactCodeMirror.js";

/**
 * Plain `.ts` (not `.tsx`) — only the pure `buildPactEditorExtensions` export
 * is exercised here, never the React component itself. The real CodeMirror
 * `EditorView` reads `window`/DOM as it initialises, so it cannot be
 * constructed under jsdom/Node the way `pact-lang.test.ts` already documents
 * for the language/highlight extensions alone; this file stays at that same
 * safe boundary — asserting the extension array is well-formed and that a
 * headless `EditorState` (no view) accepts it without throwing.
 */

describe("buildPactEditorExtensions", () => {
  it("returns the Pact language support and highlight extension together", () => {
    const extensions = buildPactEditorExtensions();
    expect(Array.isArray(extensions)).toBe(true);
    expect(extensions.length).toBeGreaterThanOrEqual(2);
  });

  it("is accepted by EditorState.create without throwing", () => {
    expect(() =>
      EditorState.create({
        doc: "(defun x () 1)",
        extensions: buildPactEditorExtensions(),
      }),
    ).not.toThrow();
  });

  it("returns the SAME array reference across calls, so CodeMirror never sees an unnecessary reconfigure", () => {
    // `@uiw/react-codemirror`'s useCodeMirror hook watches `extensions` BY
    // REFERENCE and dispatches a full StateEffect.reconfigure (discarding
    // tokenizer state) whenever that reference changes. If this ever starts
    // returning a fresh array/Language instance per call again, every
    // Builder re-render (not just a Pact-code edit) would force the editor
    // to reconfigure/re-tokenize from scratch.
    expect(buildPactEditorExtensions()).toBe(buildPactEditorExtensions());
  });
});

describe("KHRONOTON_EDITOR_THEME_SPEC", () => {
  it("pins .cm-content's line-height to 1.4 — the value Builder.tsx's height={126} (~7 visible lines) is derived from", () => {
    // jsdom has no real layout engine, so a DOM-computed-style assertion
    // isn't reachable here (see this file's own docblock) — pinning the
    // theme's source spec value is the closest reachable guard: it fails if
    // a future edit changes/removes the line-height this height math
    // depends on.
    expect(KHRONOTON_EDITOR_THEME_SPEC[".cm-content"].lineHeight).toBe("1.4");
  });
});
