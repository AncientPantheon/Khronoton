import type { ReactNode } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";

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

const khronotonEditorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--khr-panel, #0a0a0a)",
      color: "var(--khr-mono, #d2d3d4)",
      fontSize: "12px",
    },
    ".cm-content": {
      fontFamily: "var(--khr-mono-font, ui-monospace, monospace)",
      caretColor: "var(--khr-accent, #f0a500)",
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
        backgroundColor: "var(--khr-accent-tint, #1a1500)",
      },
    ".cm-gutters": {
      backgroundColor: GUTTER_BG,
      color: "var(--khr-text-dim, #8a8f98)",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: ACTIVE_LINE_BG },
    ".cm-activeLineGutter": { backgroundColor: ACTIVE_LINE_BG },
  },
  { dark: true },
);

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
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        closeBrackets: false,
        autocompletion: false,
        highlightActiveLine: true,
      }}
      onChange={onChange}
    />
  );
}
