import type { ReactNode } from "react";
import type { Extension } from "@codemirror/state";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { pactLanguageSupport, pactHighlightExtension } from "./pact-lang.js";

/**
 * The browser-only CodeMirror surface. It is kept in its own module so the
 * only way to reach it is a dynamic `import()` from `PactCodeEditor` — that
 * keeps CodeMirror (which reads `window`/DOM as it initialises its view) out
 * of any server render and out of Node/jsdom module loading.
 *
 * Theme mirrors the Hub codex-builder editor (dark panel, gold caret/focus,
 * 12px mono, gutter line numbers) but pulls its colours from the `--khr-*`
 * tokens so a consumer reskins the editor with the rest of the UI. Hardcoded
 * fallbacks match the token defaults for the case where the stylesheet is
 * absent. Gutter/active-line use the Hub's fixed `#0d1117`/`#161616` (no token
 * exists for those two editor-internal surfaces).
 */

const GUTTER_BG = "#0d1117";
const ACTIVE_LINE_BG = "#161616";

/**
 * The theme's raw style spec, kept as its own exported constant (rather than
 * inlined straight into `EditorView.theme(...)`) so a test can assert its
 * literal values directly — in particular `.cm-content`'s `lineHeight`, which
 * `Builder.tsx`'s `height={126}` (~7 visible lines) is derived from. A test
 * can't measure real computed CSS under jsdom (no layout engine — see this
 * file's own module docblock), so pinning the SOURCE spec value is the
 * reachable, still-meaningful guard against a silent regression here.
 */
export const KHRONOTON_EDITOR_THEME_SPEC = {
  "&": {
    backgroundColor: "var(--khr-panel, #0a0a0a)",
    color: "var(--khr-mono, #d2d3d4)",
    fontSize: "12px",
  },
  ".cm-content": {
    fontFamily: "var(--khr-mono-font, ui-monospace, monospace)",
    caretColor: "var(--khr-accent, #f0a500)",
    lineHeight: "1.4",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--khr-accent, #f0a500)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  "&.cm-editor.cm-focused": {
    outline: "1px solid var(--khr-accent, #f0a500)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "var(--khr-selection, #1e3a5f)",
    },
  ".cm-gutters": {
    backgroundColor: GUTTER_BG,
    color: "var(--khr-text-dim, #8a8f98)",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: ACTIVE_LINE_BG },
  ".cm-activeLineGutter": { backgroundColor: ACTIVE_LINE_BG },
};

const khronotonEditorTheme = EditorView.theme(KHRONOTON_EDITOR_THEME_SPEC, {
  dark: true,
});

/**
 * The Pact language + syntax-highlight extensions, bundled together so the
 * `<CodeMirror>` call site below only needs one `extensions` entry point.
 * Built ONCE at module load (not per render/per call) — `StreamLanguage`
 * instances are stateless, so there is no reason to construct a fresh one on
 * every render, and `@uiw/react-codemirror`'s `useCodeMirror` hook watches
 * `extensions` BY REFERENCE, dispatching a full `StateEffect.reconfigure`
 * (discarding tokenizer state) whenever that reference changes. Keeping this
 * a stable module-level array means the editor only reconfigures when it
 * actually should (e.g. a real extensions change), not on every keystroke.
 * `buildPactEditorExtensions()` stays a function (not a bare export) so
 * `PactCodeMirror.test.ts` keeps a call-site seam to exercise, without
 * rendering the React component or touching the DOM.
 */
const PACT_EDITOR_EXTENSIONS: Extension[] = [
  pactLanguageSupport(),
  pactHighlightExtension,
];

export function buildPactEditorExtensions(): Extension[] {
  return PACT_EDITOR_EXTENSIONS;
}

/**
 * `@uiw/react-codemirror`'s `useCodeMirror` hook watches `basicSetup` BY
 * REFERENCE too, alongside `extensions` — it's in the same reconfigure
 * effect's dependency array. A fresh object literal here on every render
 * would force the same full `StateEffect.reconfigure`/re-tokenize that
 * hoisting `extensions` above was meant to eliminate, just via a different
 * prop. Stable and stateless (no per-instance data), so one module-level
 * constant is correct.
 */
const BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: false,
  closeBrackets: false,
  autocompletion: false,
  highlightActiveLine: true,
};

export interface PactCodeMirrorProps {
  value: string;
  onChange: (value: string) => void;
  height: number;
}

export default function PactCodeMirror({
  value,
  onChange,
  height,
}: PactCodeMirrorProps): ReactNode {
  return (
    <CodeMirror
      value={value}
      height={`${height}px`}
      theme={khronotonEditorTheme}
      extensions={buildPactEditorExtensions()}
      basicSetup={BASIC_SETUP}
      onChange={onChange}
    />
  );
}
