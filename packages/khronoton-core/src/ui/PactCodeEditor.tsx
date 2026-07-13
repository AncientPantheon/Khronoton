import { Suspense, lazy, useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

/**
 * The builder's left pane: a "PACT Code Editor" header (gold eyebrow) with an
 * optional "Clear" control, over a CodeMirror source editor themed to match the
 * Hub codex builder (dark panel, gold caret, line numbers, ~460px).
 *
 * SSR / jsdom safety — the phase's top-flagged risk. `@uiw/react-codemirror`
 * touches `window`/DOM as its view initialises, so it is NEVER statically
 * imported here: it lives in `PactCodeMirror.tsx` and is reached only via
 * `lazy(() => import(...))`. Until the component has (a) mounted client-side,
 * (b) confirmed `window` exists, and (c) not been asked to stay on the
 * fallback, it renders a plain controlled `<textarea>`. That means:
 *   - a server render (no effects run) always emits the textarea — no crash;
 *   - Node/jsdom module loading never pulls CodeMirror;
 *   - the first client paint matches the server paint, so hydration is clean;
 *   - `forceFallback` is a seam tests use to drive the full value/onChange/Clear
 *     contract deterministically, since jsdom lacks the DOM measurement
 *     CodeMirror needs.
 */

const LazyPactCodeMirror = lazy(() => import("./PactCodeMirror.js"));

export interface PactCodeEditorProps {
  /** Current Pact source. */
  value: string;
  /** Called with the full updated source on every edit. */
  onChange: (value: string) => void;
  /** When provided, renders a "Clear" control that invokes this handler. */
  onClear?: () => void;
  /** Editor body height in pixels. Defaults to 460 (the Hub builder height). */
  height?: number;
  /**
   * Forces the plain-textarea fallback instead of CodeMirror. This is the
   * documented SSR/test seam — CodeMirror cannot measure DOM under jsdom.
   */
  forceFallback?: boolean;
}

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  background: "var(--khr-panel)",
  border: "1px solid var(--khr-border)",
  borderRadius: "var(--khr-radius)",
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 12px",
  borderBottom: "1px solid var(--khr-border)",
};

const eyebrowStyle: CSSProperties = {
  color: "var(--khr-accent)",
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontWeight: 600,
};

const clearButtonStyle: CSSProperties = {
  background: "transparent",
  border: "1px solid var(--khr-border)",
  borderRadius: "var(--khr-radius)",
  color: "var(--khr-text-dim)",
  fontSize: "11px",
  padding: "3px 10px",
  cursor: "pointer",
};

export function PactCodeEditor({
  value,
  onChange,
  onClear,
  height = 460,
  forceFallback = false,
}: PactCodeEditorProps): ReactNode {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const useCodeMirror =
    mounted && typeof window !== "undefined" && !forceFallback;

  const fallbackStyle: CSSProperties = {
    width: "100%",
    height,
    boxSizing: "border-box",
    resize: "none",
    background: "var(--khr-panel)",
    color: "var(--khr-mono)",
    fontFamily: "var(--khr-mono-font)",
    fontSize: "12px",
    border: "none",
    outline: "none",
    padding: "8px 12px",
  };

  const fallback = (
    <textarea
      aria-label="PACT code"
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={fallbackStyle}
    />
  );

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span style={eyebrowStyle}>PACT Code Editor</span>
        {onClear ? (
          <button type="button" onClick={onClear} style={clearButtonStyle}>
            Clear
          </button>
        ) : null}
      </div>
      <div style={{ height }}>
        {useCodeMirror ? (
          <Suspense fallback={fallback}>
            <LazyPactCodeMirror value={value} onChange={onChange} height={height} />
          </Suspense>
        ) : (
          fallback
        )}
      </div>
    </div>
  );
}
