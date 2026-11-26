/**
 * ChainedBuilder — the full-page multi-step cronoton builder, laid out as a
 * CENTERED, WIDTH-CAPPED FILMSTRIP: a fixed step rail on the left, then up to
 * `fit` panes side by side — Pact code / Fields / Raw JSON — each a toggle
 * chip (shown/hidden), never more than the measured width can hold, so there
 * is NO horizontal scroll at any width. Adding a pane past capacity drops the
 * oldest; the whole rail+panes block is measured via a `ResizeObserver` and
 * capped + centred so the void on an ultrawide splits evenly instead of all
 * trailing on the right.
 *
 * The Pact pane and the Fields pane both reflect the SELECTED step (the
 * rail's selection). The Fields pane is itself split into two tabs — "Step
 * config" (default, the dominant per-step surface) and "Whole cronoton"
 * (name / description / schedule / trigger-only), the latter flashing amber
 * until a name is entered. The Pact editor flex-fills its pane's height (no
 * fixed pixel height, no clip, no vertical scroll) — see `PactCodeEditor`'s
 * `fill` prop; its ancestor chain MUST stay bounded (see that component's own
 * doc for the exact chain) and this component itself must be mounted with a
 * bounded height (see `ChainedBuilderProps` usage note below) or it collapses.
 *
 * Commit routing: exactly ONE `single` step + no variant → `adapter.commit`
 * (a plain single cronoton, the "Step 0" case); otherwise → `adapter.commitChain`.
 * Whole-chain dry-run → `adapter.simulateChain`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { ChainSimulateView, CodexSignerDescriptor, CommitBody } from "../../handlers/index.js";
import { useKhronotonAdapter, useKhronotonConfig } from "../../provider/context.js";
import { runGated } from "../../provider/runGated.js";
import { canMutate, type Access } from "../access.js";
import { builderToCommit, makeEmptyBuilderState, type BuilderState } from "../builder-state.js";
import { errorMessage } from "../confirm-flows.js";
import {
  appendStep,
  canCommitChain,
  chainedBuilderToCommit,
  clearVariantIfOrphaned,
  earlierYields,
  isSingleStepChain,
  jsonToChainedBuilderState,
  makeEmptyChainedBuilderState,
  makeEmptyStepState,
  moveStep,
  removeStep,
  replaceStep,
  selectedAfterMove,
  stepLabel,
  type ChainedBuilderState,
  type StepState,
} from "../chained-builder-state.js";
import { ScheduleStep } from "../builder/ScheduleStep.js";
import { useLiveGasFloor } from "../builder/live-gas-floor.js";
import { StepRail, VARIANT_SELECTION } from "./StepRail.js";
import { StepWorkspace } from "./StepWorkspace.js";
import { formatStepResult } from "./step-result-text.js";

export const DEFAULT_CHAINED_BUILDER_ROBOTS = "noindex,nofollow";

// ── Dry-run breakdown (one row per step / the single-tx variant) ──────────────
function SimRow({
  title,
  ok,
  gasUsed,
  detail,
  error,
  resultLine,
}: {
  title: string;
  ok: boolean;
  gasUsed?: number;
  detail?: string;
  error?: string;
  /** The deterministic, structured-yield-derived result line (formatStepResult). */
  resultLine?: string;
}): ReactNode {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        flexWrap: "wrap",
        padding: "6px 8px",
        borderRadius: "var(--khr-radius)",
        background: "var(--khr-inset)",
        borderLeft: `3px solid ${ok ? "var(--khr-success)" : "var(--khr-error)"}`,
      }}
    >
      <span style={{ fontWeight: 600, fontSize: 12, minWidth: 120 }}>{title}</span>
      <span style={{ fontSize: 11, color: ok ? "var(--khr-success)" : "var(--khr-error)" }}>
        {ok ? "✓ ok" : "✗ failed"}
      </span>
      {typeof gasUsed === "number" && (
        <span style={{ fontSize: 11, color: "var(--khr-text-dim)" }}>gas {gasUsed}</span>
      )}
      {detail && <span style={{ fontSize: 11, color: "var(--khr-text-dim)" }}>{detail}</span>}
      {error && (
        <span style={{ fontSize: 11, color: "var(--khr-error)", flexBasis: "100%", fontFamily: "var(--khr-mono-font)" }}>
          {error}
        </span>
      )}
      {resultLine && (
        <span
          style={{
            fontSize: 11,
            color: "var(--khr-text-dim)",
            flexBasis: "100%",
            fontFamily: "var(--khr-mono-font)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
          title="Deterministic result line (formatStepResult) — rendered from the structured yield"
        >
          {resultLine}
        </span>
      )}
    </div>
  );
}

function SimPanel({ sim, cronotonName }: { sim: ChainSimulateView; cronotonName: string }): ReactNode {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: sim.ok ? "var(--khr-success)" : "var(--khr-error)" }}>
          Dry run: {sim.ok ? "chain OK" : "chain failed"}
        </span>
        <span style={{ fontSize: 11, color: "var(--khr-text-dim)" }}>
          {sim.steps.filter((s) => s.ok).length}/{sim.steps.length} steps ok · signed /local (true mode)
        </span>
      </div>
      {sim.error && (
        <div style={{ fontSize: 11, color: "var(--khr-error)", fontFamily: "var(--khr-mono-font)" }}>{sim.error}</div>
      )}
      {sim.singleTx && (
        <SimRow
          title="Step 0 · single-tx"
          ok={sim.singleTx.ok}
          gasUsed={sim.singleTx.gasUsed}
          detail={
            sim.singleTx.fits
              ? "fits the ceiling"
              : sim.singleTx.hardFailure
                ? "would error at fire time"
                : "would not be used"
          }
          error={sim.singleTx.error}
        />
      )}
      {sim.steps.map((s) => (
        <SimRow
          key={s.stepIndex}
          title={`Step ${s.stepIndex + 1} · ${s.mode}`}
          ok={s.ok}
          gasUsed={s.gasUsed}
          detail={
            typeof s.plannedCount === "number" ? `${s.plannedCount} leg${s.plannedCount === 1 ? "" : "s"}` : ""
          }
          error={s.error}
          resultLine={formatStepResult({
            cronotonName,
            stepIndex: s.stepIndex,
            totalSteps: sim.steps.length,
            ok: s.ok,
            yieldAs: s.yieldAs,
            yielded: s.yielded,
            error: s.error,
          })}
        />
      ))}
    </div>
  );
}

/**
 * Mount contract: `<ChainedBuilder>` renders `height: 100%` and expects its
 * parent to be BOUNDED (a fixed height, or `calc(100vh - <chrome>)`, etc.) —
 * it flex-fills whatever height it's given rather than growing the page, so
 * an unbounded ancestor (e.g. `height: auto` all the way up) collapses it to
 * zero. The reference preview harness uses
 * `#root { height: calc(100vh - 40px); overflow: hidden }`.
 */
export interface ChainedBuilderProps {
  access: Access;
  onDone?: (id?: string) => void;
  robots?: string;
}

const field: CSSProperties = {
  width: "100%",
  background: "var(--khr-inset)",
  border: "1px solid var(--khr-border)",
  color: "var(--khr-text)",
  borderRadius: "var(--khr-radius)",
  padding: "6px 8px",
  fontSize: 12,
  outline: "none",
};
const panel: CSSProperties = {
  border: "1px solid var(--khr-border)",
  borderRadius: "var(--khr-radius-lg)",
  background: "var(--khr-panel)",
  padding: 14,
};
const colTitle: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--khr-accent)",
  marginBottom: 8,
  fontWeight: 600,
};
// One filmstrip pane = a FULL page width that scroll-snaps into place. It is a
// plain column (cards inside carry the borders), so a pane can hold one card
// (Pact / Raw) or two (Fields = whole-cronoton + per-step).
const paneStyle: CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden", // the pane fills; its single card scrolls internally if needed
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

export function ChainedBuilder({
  access,
  onDone,
  robots = DEFAULT_CHAINED_BUILDER_ROBOTS,
}: ChainedBuilderProps): ReactNode {
  const adapter = useKhronotonAdapter();
  const config = useKhronotonConfig();
  const liveFloorAnu = useLiveGasFloor();

  const [state, setState] = useState<ChainedBuilderState>(() => makeEmptyChainedBuilderState());
  const [selected, setSelected] = useState<number>(0);
  const [signers, setSigners] = useState<CodexSignerDescriptor[]>([]);
  const [committing, setCommitting] = useState(false);
  const [sim, setSim] = useState<ChainSimulateView | null>(null);
  const [simulating, setSimulating] = useState(false);

  // Raw JSON pane's unlock/paste/import affordance (the pane itself stays
  // read-only — this is a separate, explicit "load a new state" flow).
  const [importOpen, setImportOpen] = useState(false);
  const [importDraft, setImportDraft] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

  // ── Panes / columns ──────────────────────────────────────────────────────────
  // The three panes (Pact / Fields / Raw JSON) are ALWAYS present; `fit` only
  // changes how many show side-by-side. Each pane has a MAX width (PANE_MAX) so
  // it stays a readable column on an ultrawide instead of stretching — the whole
  // workspace caps at `fit × PANE_MAX` and centres. "Auto" picks the most panes
  // that clear PANE_MIN for the measured column width; 1/2/3 force it.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [fitMode, setFitMode] = useState<"auto" | 1 | 2 | 3>("auto");
  const [rootWidth, setRootWidth] = useState(0);
  // Which panes are on screen. We never render more than `fit`, so there is NO
  // horizontal scroll — the pager toggles which panes occupy the slots. Default:
  // the selected step's code + its fields.
  const [visiblePanes, setVisiblePanes] = useState<string[]>(["pact", "fields"]);
  // The Fields pane is split into two top-level tabs so the step config (default,
  // dominant) isn't crowded by the whole-cronoton config (name / schedule).
  const [fieldsTab, setFieldsTab] = useState<"step" | "whole">("step");
  // Whole-cronoton Name / Description share ONE field (a sub-toggle) to save height.
  const [wholeField, setWholeField] = useState<"name" | "description">("name");

  const panes = useMemo(
    () => [
      { key: "pact", label: "Pact code" },
      { key: "fields", label: "Fields" },
      { key: "raw", label: "Raw JSON" },
    ],
    [],
  );

  // Measure the FULL builder width (stable — independent of the capped body
  // below) so "Auto" picks the pane count and the body can cap + centre as one
  // block without the cap feeding back into the pane count.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setRootWidth(entries[0]?.contentRect.width ?? el.clientWidth));
    ro.observe(el);
    setRootWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const GAP = 14;
  const RAIL = 210; // left column (actions + gate + step rail) fixed width
  const PANE_MIN = 360; // below this a pane is too cramped → fewer panes
  const PANE_MAX = 600; // above this a pane just wastes width → cap + centre
  // Width the panes may use once the rail is taken out, measured from the FULL
  // builder — so capping the body below never feeds back into the pane count.
  const availPanes = Math.max(0, rootWidth - RAIL - GAP);
  const autoFit = Math.max(
    1,
    Math.min(panes.length, Math.floor((availPanes + GAP) / (PANE_MIN + GAP)) || 1),
  );
  // `fit` = how many panes the width can HOLD (the capacity the Fit control caps).
  const fit = Math.min(panes.length, fitMode === "auto" ? autoFit : fitMode);
  // The panes actually rendered: the toggled-on ones, capped at the capacity (so
  // the strip never overflows → no horizontal scroll). The pager drops the oldest.
  const renderedPanes = panes.filter((p) => visiblePanes.includes(p.key)).slice(-fit);
  const shown = Math.max(1, renderedPanes.length);
  // Size the panes to how many are ACTUALLY shown (not the capacity), capped at
  // PANE_MAX — so 2 visible panes get the full width each, not a third's share.
  const paneW = Math.max(
    PANE_MIN,
    Math.min(PANE_MAX, Math.floor((availPanes - (shown - 1) * GAP) / shown) || PANE_MAX),
  );
  const workspaceMaxWidth = shown * paneW + (shown - 1) * GAP;
  // The whole block (rail + gap + workspace) caps here and CENTRES, so the void
  // on an ultrawide splits evenly left/right instead of all trailing on the right.
  const bodyMaxWidth = RAIL + GAP + workspaceMaxWidth;
  // The Whole-cronoton tab flashes while nothing identifies the cronoton yet, so
  // the operator knows to fill it in even though the default view is Step config.
  const wholeIncomplete = state.name.trim().length === 0;

  // Pager: toggle a pane on/off. Adding one past the `fit` cap drops the oldest,
  // so at most `fit` render and the strip stays scroll-free. Never empties.
  //
  // While an import is open, "raw" is PINNED — never one of the dropped-oldest
  // panes — because the entire import UI (textarea, draft, Capture/Cancel, any
  // inline error) only renders inside the `p.key === "raw"` branch below; were
  // it evicted mid-edit by clicking some OTHER pane's chip, the whole thing
  // would unmount with zero on-screen trace that anything was pending (the
  // state itself survives, but there's no way to see or Cancel it until "Raw
  // JSON" is toggled back on). Evict the next-oldest NON-"raw" pane(s) instead;
  // if there's no room left once "raw" is excluded, the newly-toggled pane
  // simply doesn't fit yet (same as any other fit-capacity miss).
  const togglePane = useCallback(
    (key: string) =>
      setVisiblePanes((cur) => {
        if (cur.includes(key)) return cur.length > 1 ? cur.filter((k) => k !== key) : cur;
        const next = [...cur, key];
        if (next.length <= fit) return next;
        if (importOpen && next.includes("raw")) {
          const toDrop = next.length - fit;
          const dropped = new Set<string>();
          for (const k of next) {
            if (dropped.size >= toDrop) break;
            if (k !== "raw") dropped.add(k);
          }
          return next.filter((k) => !dropped.has(k));
        }
        return next.slice(next.length - fit);
      }),
    [fit, importOpen],
  );

  // Signer descriptors (once) — the Gas Payer + Signatures pickers read them.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const v = await adapter.signers();
        if (active && v.ok) setSigners(v.signers);
      } catch {
        /* optional */
      }
    })();
    return () => {
      active = false;
    };
  }, [adapter]);

  // The commit-routing predicate + the single-cronoton body it routes to, both
  // needed up front: `codeText` (below) must preview whichever shape
  // `handleCommit` will actually send, not always the chain shape.
  const isSingleCronoton = isSingleStepChain(state);

  const singleCronotonBody = useCallback((): CommitBody => {
    const step = state.steps[0];
    const synthetic: BuilderState = {
      ...makeEmptyBuilderState(),
      name: state.name,
      description: state.description,
      pactCode: step.pactCode,
      config: step.config,
      payload: step.payload,
      gasPayer: step.gasPayer,
      signers: step.signers,
      schedule: state.schedule,
      externalFireable: state.externalFireable,
    };
    return builderToCommit(synthetic);
  }, [state]);

  // `commitBody` already maps every step through `stepStateToStepInput` once;
  // `canCommitChain` reuses that mapping (`commitBody.steps`) instead of
  // re-deriving it independently, so the per-step pipeline runs once per
  // keystroke, not twice. `codeText` mirrors `handleCommit`'s own routing: a
  // single-step chain with no variant commits via `singleCronotonBody()` (a
  // plain `CommitBody`), not the chain shape, so the Raw JSON pane matches.
  const commitBody = useMemo(() => chainedBuilderToCommit(state), [state]);
  const gate = useMemo(() => canCommitChain(state, commitBody.steps), [state, commitBody]);
  // `JSON.stringify` recurses once per nesting level, with no depth cap of
  // its own — a pathologically deep (but otherwise perfectly valid) raw-mode
  // payload or planner-params value, typed directly into the existing
  // Payload/Planner-params raw-JSON textareas (stored as plain text with no
  // serialize step of its own, so nothing rejects it on the way in), can
  // overflow the call stack right here on every render. Unlike
  // `jsonToChainedBuilderState`'s own internal re-serialize (guarded, since a
  // deep IMPORT target is rejected with a clean parse error before ever
  // reaching state), this live preview has no earlier guarded call to lean
  // on — it must guard itself, or the whole component crashes on render
  // instead of the Raw JSON pane merely failing to preview.
  const codeText = useMemo(() => {
    try {
      return JSON.stringify(isSingleCronoton ? singleCronotonBody() : commitBody, null, 2);
    } catch (e) {
      return `Could not render the Raw JSON preview: ${errorMessage(e)}`;
    }
  }, [commitBody, isSingleCronoton, singleCronotonBody]);

  // ── Mutations ────────────────────────────────────────────────────────────────
  const patchStep = useCallback(
    (index: number, next: StepState) =>
      setState((s) => ({ ...s, steps: replaceStep(s.steps, index, next) })),
    [],
  );
  const patchVariant = useCallback(
    (next: StepState) => setState((s) => ({ ...s, singleTxVariant: next })),
    [],
  );
  const addStep = useCallback(() => {
    setState((s) => ({ ...s, steps: appendStep(s.steps) }));
    setSelected(state.steps.length); // select the new last step
  }, [state.steps.length]);
  const onRemove = useCallback(
    (index: number) => {
      // Shrinking back to 1 step hides the rail's variant row (and with it the
      // only control that can disable the variant) — clear an orphaned variant
      // here, same as `onToggleVariant(false)` does when unchecked explicitly.
      const nextLength = removeStep(state.steps, index).length;
      setState((s) => {
        const steps = removeStep(s.steps, index);
        return { ...s, steps, singleTxVariant: clearVariantIfOrphaned(steps, s.singleTxVariant) };
      });
      setSelected((cur) => {
        if (cur === VARIANT_SELECTION) return nextLength < 2 ? 0 : cur;
        return cur >= index && cur > 0 ? cur - 1 : cur;
      });
    },
    [state.steps],
  );
  const onMove = useCallback(
    (index: number, delta: number) => {
      setState((s) => ({ ...s, steps: moveStep(s.steps, index, delta) }));
      // Follow the moved content so the editor/fields panes (which derive
      // purely from `state.steps[selected]`) don't silently keep showing
      // whatever landed in the OLD slot.
      setSelected((cur) => selectedAfterMove(cur, index, delta, state.steps.length));
    },
    [state.steps.length],
  );
  const onToggleVariant = useCallback((enable: boolean) => {
    setState((s) => ({ ...s, singleTxVariant: enable ? makeEmptyStepState("single") : null }));
    if (!enable) setSelected((cur) => (cur === VARIANT_SELECTION ? 0 : cur));
  }, []);

  // ── Commit ───────────────────────────────────────────────────────────────────
  // (`isSingleCronoton` / `singleCronotonBody` are defined above, alongside
  // `codeText`, which previews whichever body this actually sends.)
  const handleCommit = useCallback(async () => {
    setCommitting(true);
    try {
      if (isSingleCronoton) {
        const res = await runGated((opts) => adapter.commit(singleCronotonBody(), opts), {
          onNeedConfirm: config.onNeedConfirm,
        });
        onDone?.(res.codexCronotonId);
      } else {
        if (!adapter.commitChain) {
          window.alert("This backend does not support chained cronotons (no commitChain).");
          return;
        }
        const res = await runGated((opts) => adapter.commitChain!(chainedBuilderToCommit(state), opts), {
          onNeedConfirm: config.onNeedConfirm,
        });
        onDone?.(res.codexCronotonId);
      }
    } catch (e) {
      window.alert(errorMessage(e));
    } finally {
      setCommitting(false);
    }
  }, [adapter, config.onNeedConfirm, isSingleCronoton, onDone, singleCronotonBody, state]);

  // ── Simulate the whole chain ─────────────────────────────────────────────────
  const handleSimulate = useCallback(async () => {
    if (!adapter.simulateChain) {
      window.alert("This backend does not support whole-chain simulation (no simulateChain).");
      return;
    }
    setSimulating(true);
    setSim(null);
    try {
      const res = await runGated((opts) => adapter.simulateChain!(chainedBuilderToCommit(state), opts), {
        onNeedConfirm: config.onNeedConfirm,
      });
      setSim(res);
    } catch (e) {
      window.alert(errorMessage(e));
    } finally {
      setSimulating(false);
    }
  }, [adapter, config.onNeedConfirm, state]);

  // ── Raw JSON pane: unlock / paste / import ───────────────────────────────────
  // The pane itself stays read-only by default (no accidental typing) — these
  // three only control the IMPORT affordance layered on top of it.
  const handleCaptureImport = useCallback(() => {
    const result = jsonToChainedBuilderState(importDraft);
    if (!result.ok) {
      setImportError(result.error);
      return;
    }
    // A LOAD, not a merge — the new state's shape may not match the old
    // selection/dry-run at all, so reset every bit of derived UI state that
    // assumed the PREVIOUS state's shape, same as a fresh mount would.
    setState(result.state);
    setSelected(0);
    setFieldsTab("step");
    setWholeField("name");
    setSim(null);
    setImportOpen(false);
    setImportDraft("");
    setImportError(null);
  }, [importDraft]);

  const handleImportFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setImportDraft(reader.result);
        setImportError(null);
      } else {
        setImportError("Could not read the selected file.");
      }
    };
    reader.onerror = () => setImportError("Could not read the selected file.");
    reader.readAsText(file);
  }, []);

  const closeImportPanel = useCallback(() => {
    setImportOpen(false);
    setImportDraft("");
    setImportError(null);
  }, []);

  // ── Schedule (reuse ScheduleStep via a synthesized BuilderState) ─────────────
  const scheduleHostState: BuilderState = {
    ...makeEmptyBuilderState(),
    schedule: state.schedule,
    externalFireable: state.externalFireable,
  };
  const onScheduleChange = (next: BuilderState) =>
    setState((s) => ({ ...s, schedule: next.schedule }));

  const selectedStep: StepState | null =
    selected === VARIANT_SELECTION ? state.singleTxVariant : state.steps[selected] ?? null;
  const isVariant = selected === VARIANT_SELECTION;

  const stepWorkspaceCommon = selectedStep
    ? {
        step: selectedStep,
        onChange: (next: StepState) => (isVariant ? patchVariant(next) : patchStep(selected, next)),
        descriptors: signers,
        earlierYieldNames: isVariant ? [] : earlierYields(state.steps, selected),
        variant: isVariant,
      }
    : null;

  return (
    <div
      ref={rootRef}
      className="khronoton-ui"
      style={{ display: "flex", flexDirection: "column", gap: 14, width: "100%", height: "100%", minHeight: 0 }}
    >
      <meta name="robots" content={robots} />
      <style>{`@keyframes khr-attn-pulse{0%,100%{opacity:1}50%{opacity:.4}}.khr-attn{animation:khr-attn-pulse 1.1s ease-in-out infinite;color:var(--khr-amber)!important;}`}</style>

      {/* Header: title only — all display controls now live on the control line. */}
      <div style={{ fontSize: 15, fontWeight: 700, flexShrink: 0 }}>
        {isSingleCronoton ? "Cronoton" : "Chained cronoton"} builder
      </div>

      {/* The workspace fills the remaining height: left column (actions + gate +
          step rail) + the panes. Both columns are height-bounded here, so the
          rail and the panes scroll on their own instead of growing the page. */}
      <div style={{ flex: 1, minHeight: 0, width: "100%", maxWidth: bodyMaxWidth, alignSelf: "center", display: "flex", gap: 14, alignItems: "stretch" }}>
        {/* Left column: Simulate / Create as menu items, the gate, then the rail. */}
        <div style={{ width: 210, flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button
              type="button"
              onClick={() => void handleCommit()}
              disabled={committing || !gate.ok || !canMutate(access)}
              style={{
                width: "100%",
                padding: "9px 12px",
                borderRadius: "var(--khr-radius)",
                border: "1px solid var(--khr-accent)",
                background: gate.ok ? "var(--khr-accent)" : "var(--khr-inset)",
                color: gate.ok ? "var(--khr-bg)" : "var(--khr-text-dim)",
                cursor: committing || !gate.ok ? "default" : "pointer",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {committing ? "Creating…" : isSingleCronoton ? "Create cronoton" : "Create chained cronoton"}
            </button>
            <button
              type="button"
              onClick={() => void handleSimulate()}
              disabled={simulating}
              style={{
                width: "100%",
                padding: "8px 12px",
                borderRadius: "var(--khr-radius)",
                border: "1px solid var(--khr-border)",
                background: "var(--khr-inset)",
                color: "var(--khr-text)",
                cursor: simulating ? "default" : "pointer",
                fontSize: 13,
              }}
            >
              {simulating ? "Simulating…" : "Simulate chain"}
            </button>
          </div>

          {/* Validation gate — why Create is disabled. */}
          {!gate.ok && (
            <ul style={{ margin: 0, paddingLeft: 16, color: "var(--khr-amber)", fontSize: 11, lineHeight: 1.45, display: "flex", flexDirection: "column", gap: 2 }}>
              {gate.reasons.slice(0, 6).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}

          {/* Step rail — scrolls on its own when there are more steps than fit. */}
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", margin: "-2px", padding: 2 }}>
            <StepRail
              steps={state.steps}
              variant={state.singleTxVariant}
              selected={selected}
              onSelect={setSelected}
              onAdd={addStep}
              onRemove={onRemove}
              onMove={onMove}
              onToggleVariant={onToggleVariant}
            />
          </div>
        </div>

        {/* The panes column — now ≈ workspaceMaxWidth wide (the body caps + centres). */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {/* The workspace caps at `fit × PANE_MAX` and centres, so panes stay a
              readable width on an ultrawide instead of stretching. */}
          <div
            style={{
              width: "100%",
              maxWidth: workspaceMaxWidth,
              alignSelf: "flex-start",
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
          {/* ── Single control line: panes · fit ─────────────────────────────── */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 10,
              border: "1px solid var(--khr-border)",
              borderRadius: "var(--khr-radius)",
              padding: 4,
              background: "var(--khr-inset)",
            }}
          >
            {/* Panes: toggle which panes are on screen (at most `fit` at once). */}
            <div style={{ display: "flex", gap: 2 }}>
              {panes.map((p) => {
                const on = visiblePanes.includes(p.key);
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => togglePane(p.key)}
                    aria-pressed={on}
                    title={on ? `Hide ${p.label}` : `Show ${p.label}`}
                    style={{
                      fontSize: 12,
                      padding: "5px 14px",
                      borderRadius: "var(--khr-radius)",
                      border: "none",
                      cursor: "pointer",
                      fontWeight: on ? 600 : 400,
                      background: on ? "var(--khr-accent-tint)" : "transparent",
                      color: on ? "var(--khr-accent)" : "var(--khr-text-dim)",
                    }}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>

            {/* Fit: how many panes side-by-side (Auto = as many as the width clears). */}
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--khr-text-dim)" }}>Fit</span>
              <div style={{ display: "flex", gap: 2, border: "1px solid var(--khr-border)", borderRadius: "var(--khr-radius)", padding: 2 }}>
                {(["auto", 1, 2, 3] as const).map((m) => {
                  const active = fitMode === m;
                  const forcedTooMany = typeof m === "number" && m > panes.length;
                  const labelTxt = m === "auto" ? `Auto${fitMode === "auto" ? ` (${fit})` : ""}` : String(m);
                  return (
                    <button
                      key={String(m)}
                      type="button"
                      disabled={forcedTooMany}
                      onClick={() => setFitMode(m)}
                      title={m === "auto" ? "Fit as many panes as the width allows" : `Show ${m} pane${m === 1 ? "" : "s"} side by side`}
                      style={{
                        fontSize: 11,
                        padding: "3px 10px",
                        borderRadius: "var(--khr-radius)",
                        border: "none",
                        cursor: forcedTooMany ? "not-allowed" : "pointer",
                        opacity: forcedTooMany ? 0.35 : 1,
                        fontWeight: active ? 600 : 400,
                        background: active ? "var(--khr-accent-tint)" : "transparent",
                        color: active ? "var(--khr-accent)" : "var(--khr-text-dim)",
                      }}
                    >
                      {labelTxt}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Track — fills the remaining column height; holds at most `fit` panes
              so it never scrolls sideways. Each pane fills its own height (the
              Pact editor fills; the Fields pane scrolls inside its active tab). */}
          <div
            style={{
              position: "relative",
              display: "flex",
              alignItems: "stretch",
              gap: 14,
              flex: 1,
              minHeight: 300,
            }}
          >
            {renderedPanes.map((p) => (
              <section
                key={p.key}
                style={{ ...paneStyle, flex: `0 0 ${paneW}px`, overflow: "hidden" }}
              >
                {p.key === "pact" && (
                  <div style={{ ...panel, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
                    <div style={colTitle}>
                      {isVariant ? "Step 0 · single-tx variant" : stepLabel(state.steps, selected)} — code
                    </div>
                    {stepWorkspaceCommon ? (
                      <StepWorkspace {...stepWorkspaceCommon} pane="editor" liveFloorAnu={liveFloorAnu} fillEditor />
                    ) : (
                      <p style={{ color: "var(--khr-text-dim)" }}>Select a step.</p>
                    )}
                  </div>
                )}

                {p.key === "fields" && (
                  <div style={{ ...panel, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
                    {/* Two top-level tabs: Step config (default, dominant) · Whole
                        cronoton. The whole-cronoton tab flashes until it's filled. */}
                    <div
                      style={{
                        display: "flex",
                        gap: 2,
                        border: "1px solid var(--khr-border)",
                        borderRadius: "var(--khr-radius)",
                        padding: 2,
                        background: "var(--khr-inset)",
                        marginBottom: 12,
                        flexShrink: 0,
                      }}
                    >
                      {([
                        { key: "step", label: isVariant ? "Variant config" : "Step config" },
                        { key: "whole", label: "Whole cronoton" },
                      ] as const).map((t) => {
                        const active = fieldsTab === t.key;
                        const flash = t.key === "whole" && wholeIncomplete && !active;
                        return (
                          <button
                            key={t.key}
                            type="button"
                            onClick={() => setFieldsTab(t.key)}
                            className={flash ? "khr-attn" : undefined}
                            style={{
                              flex: 1,
                              fontSize: 12,
                              padding: "7px 4px",
                              borderRadius: "var(--khr-radius)",
                              border: "none",
                              cursor: "pointer",
                              fontWeight: active ? 600 : 400,
                              background: active ? "var(--khr-accent-tint)" : "transparent",
                              color: active ? "var(--khr-accent)" : "var(--khr-text-dim)",
                            }}
                          >
                            {t.label}
                            {t.key === "whole" && wholeIncomplete && (
                              <span style={{ marginLeft: 6, color: "var(--khr-amber)" }}>•</span>
                            )}
                          </button>
                        );
                      })}
                    </div>

                    {/* Active tab body — scrolls inside the pane when tall. */}
                    <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                      {fieldsTab === "step" ? (
                        <>
                          <div style={colTitle}>
                            {isVariant ? "Step 0 · single-tx variant" : `${stepLabel(state.steps, selected)} config`} — changes per step
                          </div>
                          {stepWorkspaceCommon ? (
                            <StepWorkspace {...stepWorkspaceCommon} pane="fields" liveFloorAnu={liveFloorAnu} />
                          ) : (
                            <p style={{ color: "var(--khr-text-dim)" }}>Select a step.</p>
                          )}
                        </>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                          {/* Name / Description share ONE field (sub-toggle) to save height. */}
                          <div>
                            <div style={{ display: "flex", gap: 2, marginBottom: 6 }}>
                              {([
                                { key: "name", label: "Name" },
                                { key: "description", label: "Description" },
                              ] as const).map((f) => {
                                const active = wholeField === f.key;
                                return (
                                  <button
                                    key={f.key}
                                    type="button"
                                    onClick={() => setWholeField(f.key)}
                                    style={{
                                      fontSize: 11,
                                      padding: "4px 12px",
                                      borderRadius: "var(--khr-radius)",
                                      border: "none",
                                      cursor: "pointer",
                                      fontWeight: active ? 600 : 400,
                                      background: active ? "var(--khr-accent-tint)" : "transparent",
                                      color: active ? "var(--khr-accent)" : "var(--khr-text-dim)",
                                    }}
                                  >
                                    {f.label}
                                    {f.key === "name" && wholeIncomplete && (
                                      <span style={{ marginLeft: 5, color: "var(--khr-amber)" }}>•</span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                            {wholeField === "name" ? (
                              <input
                                style={field}
                                value={state.name}
                                onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
                                placeholder="StoicismRewardFlow"
                              />
                            ) : (
                              <input
                                style={field}
                                value={state.description}
                                onChange={(e) => setState((s) => ({ ...s, description: e.target.value }))}
                                placeholder="What this cronoton does (optional)"
                              />
                            )}
                          </div>

                          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--khr-text-dim)" }}>
                            <input
                              type="checkbox"
                              checked={state.externalFireable}
                              onChange={(e) => setState((s) => ({ ...s, externalFireable: e.target.checked }))}
                            />
                            Trigger-only (no schedule — fired on demand)
                          </label>
                          {!state.externalFireable && <ScheduleStep state={scheduleHostState} onChange={onScheduleChange} />}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {p.key === "raw" && (
                  <div style={{ ...panel, flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                      <div style={colTitle}>Raw cronoton JSON{importOpen ? " — import" : " (read-only)"}</div>
                      <button
                        type="button"
                        onClick={() => (importOpen ? closeImportPanel() : setImportOpen(true))}
                        style={{
                          fontSize: 11,
                          padding: "4px 10px",
                          borderRadius: "var(--khr-radius)",
                          border: "1px solid var(--khr-border)",
                          background: importOpen ? "var(--khr-accent-tint)" : "transparent",
                          color: importOpen ? "var(--khr-accent)" : "var(--khr-text-dim)",
                          cursor: "pointer",
                        }}
                      >
                        {importOpen ? "Close" : "Paste / import"}
                      </button>
                    </div>

                    {importOpen ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 }}>
                        <p style={{ fontSize: 10, color: "var(--khr-text-dim2)", margin: 0 }}>
                          Paste a raw chained-cronoton JSON document, or upload a <code>.json</code> file, then
                          Capture — this REPLACES the whole form below with what you load.
                        </p>
                        <label
                          style={{
                            fontSize: 11,
                            color: "var(--khr-accent)",
                            cursor: "pointer",
                            alignSelf: "flex-start",
                          }}
                        >
                          Upload .json file
                          <input
                            type="file"
                            accept=".json,application/json"
                            style={{ display: "none" }}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) handleImportFile(file);
                              e.target.value = "";
                            }}
                          />
                        </label>
                        <textarea
                          aria-label="Import JSON"
                          value={importDraft}
                          onChange={(e) => {
                            setImportDraft(e.target.value);
                            setImportError(null);
                          }}
                          spellCheck={false}
                          placeholder='{ "name": "...", "steps": [ ... ] }'
                          style={{
                            flex: 1,
                            minHeight: 120,
                            resize: "none",
                            background: "var(--khr-inset)",
                            border: "1px solid var(--khr-border)",
                            borderRadius: "var(--khr-radius)",
                            padding: 10,
                            fontFamily: "var(--khr-mono-font)",
                            fontSize: 12,
                            color: "var(--khr-text)",
                          }}
                        />
                        {importError && (
                          <p style={{ fontSize: 11, color: "var(--khr-error)", margin: 0, fontFamily: "var(--khr-mono-font)" }}>
                            {importError}
                          </p>
                        )}
                        <div style={{ display: "flex", gap: 8 }}>
                          <button
                            type="button"
                            onClick={handleCaptureImport}
                            disabled={importDraft.trim().length === 0}
                            style={{
                              fontSize: 12,
                              padding: "6px 14px",
                              borderRadius: "var(--khr-radius)",
                              border: "1px solid var(--khr-accent)",
                              background: "var(--khr-accent)",
                              color: "var(--khr-bg)",
                              cursor: importDraft.trim().length === 0 ? "default" : "pointer",
                              opacity: importDraft.trim().length === 0 ? 0.5 : 1,
                            }}
                          >
                            Capture &amp; parse
                          </button>
                          <button
                            type="button"
                            onClick={closeImportPanel}
                            style={{
                              fontSize: 12,
                              padding: "6px 14px",
                              borderRadius: "var(--khr-radius)",
                              border: "1px solid var(--khr-border)",
                              background: "transparent",
                              color: "var(--khr-text-dim)",
                              cursor: "pointer",
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <pre
                          style={{
                            margin: 0,
                            flex: 1,
                            overflow: "auto",
                            background: "var(--khr-inset)",
                            border: "1px solid var(--khr-border)",
                            borderRadius: "var(--khr-radius)",
                            padding: 10,
                            fontFamily: "var(--khr-mono-font)",
                            fontSize: 12,
                            color: "var(--khr-mono)",
                            whiteSpace: "pre",
                          }}
                        >
                          {codeText}
                        </pre>
                        <p style={{ fontSize: 10, color: "var(--khr-text-dim2)", marginTop: 6 }}>
                          The form drives this live. Use "Paste / import" above to load your own raw JSON instead.
                        </p>
                      </>
                    )}
                  </div>
                )}
              </section>
            ))}
          </div>

          {/* Dry-run results — appears under the panes after Simulate, spanning
              the workspace width (its action button lives in the left column). */}
          {sim && (
            <div style={panel}>
              <SimPanel sim={sim} cronotonName={state.name} />
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
