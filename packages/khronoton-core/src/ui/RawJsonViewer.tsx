import { Suspense, lazy, useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

/**
 * `<RawJsonViewer>` — the read-only, syntax-highlighted body of the Raw JSON
 * pane. Mirrors `PactCodeEditor.tsx`'s own SSR/jsdom-safety contract exactly
 * (same reason: `@uiw/react-codemirror` touches `window`/DOM at view init):
 *
 *   - a server render (no effects run) always emits the fallback `<pre>`;
 *   - Node/jsdom module loading never pulls CodeMirror (it's reached only via
 *     `lazy(() => import("./RawJsonCodeMirror.js"))`);
 *   - the first client paint matches the server paint, so hydration is clean;
 *   - `forceFallback` is the documented test seam (mirrors `PactCodeEditor`'s
 *     own prop of the same name) for exercising the fallback deterministically
 *     without mounting real CodeMirror under jsdom.
 *
 * The fallback (pre-mount, SSR, or `forceFallback`) is the SAME `<pre
 * data-testid="chained-builder-raw-json-pre">` this pane has always rendered
 * — every existing Raw-JSON-pane test (the 0.23.0 pretty-print regression,
 * the dirty check, every resolver-select test that reads this pane's text)
 * keeps passing unchanged; only a real mounted browser gets the CodeMirror
 * line-number-gutter + JSON-mode upgrade. Unlike `PactCodeEditor`, this is a
 * VIEWER, not an editor — there is no `onChange`/`Clear`; the fallback is a
 * read-only `<pre>`, never an editable `<textarea>`.
 */

const LazyRawJsonCodeMirror = lazy(() => import("./RawJsonCodeMirror.js"));

export interface RawJsonViewerProps {
  /** The pretty-printed JSON text to display. */
  value: string;
  /**
   * Forces the plain `<pre>` fallback instead of CodeMirror. Documented
   * SSR/test seam — CodeMirror cannot measure DOM under jsdom.
   */
  forceFallback?: boolean;
}

const fallbackStyle: CSSProperties = {
  margin: 0,
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  background: "var(--khr-inset)",
  border: "1px solid var(--khr-border)",
  borderRadius: "var(--khr-radius)",
  padding: 10,
  fontFamily: "var(--khr-mono-font)",
  fontSize: 12,
  color: "var(--khr-mono)",
  whiteSpace: "pre",
};

const codeMirrorWrapStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  border: "1px solid var(--khr-border)",
  borderRadius: "var(--khr-radius)",
  overflow: "hidden",
};

export function RawJsonViewer({ value, forceFallback = false }: RawJsonViewerProps): ReactNode {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const useCodeMirror = mounted && typeof window !== "undefined" && !forceFallback;

  const fallback = (
    <pre data-testid="chained-builder-raw-json-pre" style={fallbackStyle}>
      {value}
    </pre>
  );

  if (!useCodeMirror) {
    return fallback;
  }

  return (
    <Suspense fallback={fallback}>
      <div data-testid="chained-builder-raw-json-pre" style={codeMirrorWrapStyle}>
        <LazyRawJsonCodeMirror value={value} height="100%" />
      </div>
    </Suspense>
  );
}
