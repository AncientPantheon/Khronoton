import type { ReactNode } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { khronotonEditorTheme } from "./PactCodeMirror.js";

/**
 * The browser-only CodeMirror surface for the Raw JSON pane — the read-only
 * sibling of `PactCodeMirror.tsx`, kept in its own module for the exact same
 * reason: `@uiw/react-codemirror` touches `window`/DOM as its view
 * initialises, so it must only ever be reached via a dynamic `import()`
 * (`RawJsonViewer.tsx`'s own `lazy(...)` call), never statically imported
 * here or anywhere a server render or Node/jsdom module load could pull it.
 *
 * Reuses `khronotonEditorTheme` as-is (not a copy) so this pane matches the
 * Pact editor's exact dark-panel/gold-accent theme with zero drift risk.
 * `extensions={[json()]}` is the only real difference from `PactCodeMirror`
 * — the standard CodeMirror 6 JSON grammar (`@codemirror/lang-json`, a new
 * peer dep, same family as the already-required `@codemirror/*` packages)
 * in place of Pact's own language support.
 */

const JSON_BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: false,
  closeBrackets: false,
  autocompletion: false,
  highlightActiveLine: false,
};

export interface RawJsonCodeMirrorProps {
  value: string;
  /** Pixel height (number) or any CSS height (e.g. "100%" to fill a flex parent). */
  height: number | string;
}

export default function RawJsonCodeMirror({ value, height }: RawJsonCodeMirrorProps): ReactNode {
  return (
    <CodeMirror
      value={value}
      height={typeof height === "number" ? `${height}px` : height}
      theme={khronotonEditorTheme}
      extensions={[json()]}
      basicSetup={JSON_BASIC_SETUP}
      editable={false}
      readOnly
    />
  );
}
