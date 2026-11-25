import { Suspense, lazy, useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

/**
 * The Pact-code editor rendered full-width at the top of the Builder: a
 * "PACT Code Editor" header (gold eyebrow) with an optional "Clear" control
 * and an optional `subBar` strip (e.g. the tx-size/gas meter), over a
 * CodeMirror source editor themed to match the Hub codex builder (dark
 * panel, gold caret, line numbers, clamped to ~7 lines with internal scroll).
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
   * Fill the parent's height instead of using a fixed `height`. The editor's
   * container must be bounded (e.g. a flex child with `minHeight: 0`). Lets the
   * editor grow/shrink with the pane, with no dead space and no clipping.
   */
  fill?: boolean;
  /**
   * Forces the plain-textarea fallback instead of CodeMirror. This is the
   * documented SSR/test seam — CodeMirror cannot measure DOM under jsdom.
   */
  forceFallback?: boolean;
  /**
   * Optional content rendered as a full-width strip between the header and
   * the editor body, e.g. a tx-size/gas meter.
   */
  subBar?: ReactNode;
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

const subBarWrapStyle: CSSProperties = {
  padding: "0 12px 10px",
  borderBottom: "1px solid var(--khr-border)",
};

export function PactCodeEditor({
  value,
  onChange,
  onClear,
  height = 460,
  fill = false,
  forceFallback = false,
  subBar,
}: PactCodeEditorProps): ReactNode {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const useCodeMirror =
    mounted && typeof window !== "undefined" && !forceFallback;

  // In fill mode the panel fills its (bounded) parent and the editor body flexes;
  // otherwise the body is a fixed `height` box (the original behaviour).
  const bodyHeight: number | string = fill ? "100%" : height;

  const fallbackStyle: CSSProperties = {
    width: "100%",
    height: fill ? "100%" : height,
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
    <div style={fill ? { ...panelStyle, height: "100%", minHeight: 0 } : panelStyle}>
      <div style={headerStyle}>
        <span style={eyebrowStyle}>PACT Code Editor</span>
        {onClear ? (
          <button type="button" onClick={onClear} style={clearButtonStyle}>
            Clear
          </button>
        ) : null}
      </div>
      {subBar ? (
        <div data-testid="pact-editor-subbar" style={subBarWrapStyle}>
          {subBar}
        </div>
      ) : null}
      <div style={fill ? { flex: 1, minHeight: 0 } : { height }}>
        {useCodeMirror ? (
          <Suspense fallback={fallback}>
            <LazyPactCodeMirror value={value} onChange={onChange} height={bodyHeight} />
          </Suspense>
        ) : (
          fallback
        )}
      </div>
    </div>
  );
}
