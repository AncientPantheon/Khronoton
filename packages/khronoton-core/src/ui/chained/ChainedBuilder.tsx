/**
 * ChainedBuilder — the full-page multi-step cronoton builder, laid out as a
 * FILMSTRIP: a fixed step rail on the left (out of the page flow), then a
 * horizontal scroll-snap track where EACH PANE IS A FULL PAGE WIDTH:
 *
 *   [ Step rail ] │  ‹ Pact code ›  ·  ‹ Fields ›  ·  ‹ Raw JSON ›
 *     (sidebar)   │   (one page)       (one page)     (one page)
 *
 * You move between panes with the pager (or by scrolling the track). The Raw
 * Cronoton JSON pane shows only in the EXTENDED view; NORMAL is Pact + Fields.
 * The Pact pane and the Fields pane both reflect the SELECTED step (the rail's
 * selection); the Fields pane's top card (name / description / schedule /
 * trigger-only) is cronoton-level, not per-step.
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

export const DEFAULT_CHAINED_BUILDER_ROBOTS = "noindex,nofollow";

// ── Dry-run breakdown (one row per step / the single-tx variant) ──────────────
function SimRow({
  title,
  ok,
  gasUsed,
  detail,
  error,
}: {
  title: string;
  ok: boolean;
  gasUsed?: number;
  detail?: string;
  error?: string;
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
    </div>
  );
}

function SimPanel({ sim }: { sim: ChainSimulateView }): ReactNode {
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
          detail={[
            typeof s.plannedCount === "number" ? `${s.plannedCount} leg${s.plannedCount === 1 ? "" : "s"}` : "",
            s.yieldAs && s.yielded !== undefined ? `yields ${s.yieldAs}` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          error={s.error}
        />
      ))}
    </div>
  );
}

export interface ChainedBuilderProps {
  access: Access;
  onDone?: (id?: string) => void;
  robots?: string;
}

const label: CSSProperties = {
  display: "block",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--khr-text-dim)",
  marginBottom: 4,
};
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
  flex: "0 0 100%",
  scrollSnapAlign: "start",
  minWidth: 0,
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
  const [extended, setExtended] = useState(false);
  const [sim, setSim] = useState<ChainSimulateView | null>(null);
  const [simulating, setSimulating] = useState(false);

  // ── Filmstrip pager — one FULL-WIDTH pane visible at a time ──────────────────
  const trackRef = useRef<HTMLDivElement | null>(null);
  const paneRefs = useRef<Record<string, HTMLElement | null>>({});
  const [activePane, setActivePane] = useState<string>("pact");

  const panes = useMemo(
    () => [
      { key: "pact", label: "Pact code" },
      { key: "fields", label: "Fields" },
      ...(extended ? [{ key: "raw", label: "Raw JSON" }] : []),
    ],
    [extended],
  );

  const scrollToPane = useCallback((key: string) => {
    const el = paneRefs.current[key];
    const track = trackRef.current;
    if (!el || !track) return;
    track.scrollTo({ left: el.offsetLeft, behavior: "smooth" });
    setActivePane(key);
  }, []);

  // Active pane = the one whose centre is nearest the track's visible centre.
  const onTrackScroll = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const tc = track.getBoundingClientRect();
    const centre = tc.left + tc.width / 2;
    let best = "pact";
    let bestDist = Infinity;
    for (const [key, el] of Object.entries(paneRefs.current)) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - centre);
      if (d < bestDist) {
        bestDist = d;
        best = key;
      }
    }
    setActivePane(best);
  }, []);

  // If the Raw pane disappears (Extended → Normal) while it was active, fall back.
  useEffect(() => {
    if (!panes.some((p) => p.key === activePane)) {
      setActivePane(panes[panes.length - 1]?.key ?? "pact");
    }
  }, [panes, activePane]);

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
  // keystroke, not twice. `codeText` only (re)stringifies when the Raw JSON
  // pane can actually be shown (`extended`) — it's otherwise unreachable. It
  // mirrors `handleCommit`'s own routing: a single-step chain with no variant
  // commits via `singleCronotonBody()` (a plain `CommitBody`), not the chain
  // shape, so the preview must match.
  const commitBody = useMemo(() => chainedBuilderToCommit(state), [state]);
  const gate = useMemo(() => canCommitChain(state, commitBody.steps), [state, commitBody]);
  const codeText = useMemo(
    () =>
      extended ? JSON.stringify(isSingleCronoton ? singleCronotonBody() : commitBody, null, 2) : "",
    [commitBody, extended, isSingleCronoton, singleCronotonBody],
  );

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
    <div className="khronoton-ui" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <meta name="robots" content={robots} />

      {/* Header: title + Normal/Extended toggle. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>
          {isSingleCronoton ? "Cronoton" : "Chained cronoton"} builder
        </div>
        <div style={{ display: "flex", gap: 2, border: "1px solid var(--khr-border)", borderRadius: "var(--khr-radius)", padding: 2 }}>
          {([["normal", "Normal"], ["extended", "Extended · Raw JSON"]] as const).map(([v, lbl]) => {
            const active = (v === "extended") === extended;
            return (
              <button
                key={v}
                type="button"
                onClick={() => setExtended(v === "extended")}
                style={{
                  fontSize: 11,
                  padding: "4px 12px",
                  border: "none",
                  borderRadius: "var(--khr-radius)",
                  cursor: "pointer",
                  background: active ? "var(--khr-accent-tint)" : "transparent",
                  color: active ? "var(--khr-accent)" : "var(--khr-text-dim)",
                }}
              >
                {lbl}
              </button>
            );
          })}
        </div>
      </div>

      {/* The workspace: fixed step rail (sidebar) + a full-width filmstrip. */}
      <div style={{ display: "flex", gap: 14, alignItems: "stretch" }}>
        {/* Step rail — "out of the page width", always visible. */}
        <div style={{ width: 186, flexShrink: 0 }}>
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

        {/* The filmstrip column: pager + a horizontal scroll-snap track where
            each pane is one full page width. */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Pager. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              border: "1px solid var(--khr-border)",
              borderRadius: "var(--khr-radius)",
              padding: 3,
              background: "var(--khr-inset)",
            }}
          >
            {panes.map((p) => {
              const active = activePane === p.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => scrollToPane(p.key)}
                  style={{
                    fontSize: 12,
                    padding: "6px 16px",
                    borderRadius: "var(--khr-radius)",
                    border: "none",
                    cursor: "pointer",
                    fontWeight: active ? 600 : 400,
                    background: active ? "var(--khr-accent-tint)" : "transparent",
                    color: active ? "var(--khr-accent)" : "var(--khr-text-dim)",
                  }}
                >
                  {p.label}
                </button>
              );
            })}
            <span style={{ marginLeft: "auto", paddingRight: 8, fontSize: 11, color: "var(--khr-text-dim2)" }}>
              scroll ↔ or use the pager
            </span>
          </div>

          {/* Track. */}
          <div
            ref={trackRef}
            onScroll={onTrackScroll}
            style={{
              position: "relative",
              display: "flex",
              gap: 14,
              overflowX: "auto",
              scrollSnapType: "x mandatory",
              paddingBottom: 6,
              minHeight: 520,
            }}
          >
            {panes.map((p) => (
              <section
                key={p.key}
                ref={(el) => {
                  paneRefs.current[p.key] = el;
                }}
                style={paneStyle}
              >
                {p.key === "pact" && (
                  <div style={{ ...panel, flex: 1, display: "flex", flexDirection: "column", minHeight: 480 }}>
                    <div style={colTitle}>
                      {isVariant ? "Step 0 · single-tx variant" : stepLabel(state.steps, selected)} — code
                    </div>
                    {stepWorkspaceCommon ? (
                      <StepWorkspace {...stepWorkspaceCommon} pane="editor" liveFloorAnu={liveFloorAnu} editorHeight={460} />
                    ) : (
                      <p style={{ color: "var(--khr-text-dim)" }}>Select a step.</p>
                    )}
                  </div>
                )}

                {p.key === "fields" && (
                  <>
                    <div style={panel}>
                      <div style={colTitle}>Whole cronoton</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <div>
                          <label style={label}>Name</label>
                          <input
                            style={field}
                            value={state.name}
                            onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
                            placeholder="StoicismRewardFlow"
                          />
                        </div>
                        <div>
                          <label style={label}>Description (optional)</label>
                          <input
                            style={field}
                            value={state.description}
                            onChange={(e) => setState((s) => ({ ...s, description: e.target.value }))}
                          />
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
                    </div>

                    <div style={{ ...panel, flex: 1 }}>
                      <div style={colTitle}>
                        {isVariant ? "Variant config" : `${stepLabel(state.steps, selected)} config`} — changes per step
                      </div>
                      {stepWorkspaceCommon ? (
                        <StepWorkspace {...stepWorkspaceCommon} pane="fields" liveFloorAnu={liveFloorAnu} />
                      ) : (
                        <p style={{ color: "var(--khr-text-dim)" }}>Select a step.</p>
                      )}
                    </div>
                  </>
                )}

                {p.key === "raw" && (
                  <div style={{ ...panel, flex: 1, display: "flex", flexDirection: "column", minHeight: 480 }}>
                    <div style={colTitle}>Raw cronoton JSON (read-only)</div>
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
                      The form drives this live. Pasting your own raw code (unlock) is a follow-on.
                    </p>
                  </div>
                )}
              </section>
            ))}
          </div>
        </div>
      </div>

      {/* Footer — validation gate + dry-run + commit. */}
      <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 10 }}>
        {!gate.ok && (
          <ul style={{ margin: 0, paddingLeft: 18, color: "var(--khr-amber)", fontSize: 12 }}>
            {gate.reasons.slice(0, 6).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        {sim && <SimPanel sim={sim} />}
        <div style={{ display: "flex", gap: 10 }}>
          <button
            type="button"
            onClick={() => void handleSimulate()}
            disabled={simulating}
            style={{
              padding: "8px 16px",
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
          <button
            type="button"
            onClick={() => void handleCommit()}
            disabled={committing || !gate.ok || !canMutate(access)}
            style={{
              padding: "8px 16px",
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
        </div>
      </div>
    </div>
  );
}
