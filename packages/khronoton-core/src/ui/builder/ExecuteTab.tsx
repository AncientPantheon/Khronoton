/**
 * Builder "Execute" tab — the final review + fire surface of the codex-cronoton
 * builder.
 *
 * A CONTROLLED tab over the whole {@link BuilderState}: it renders a read-only
 * Transaction Summary, a Simulate control, the embedded schedule editor (or the
 * trigger-only notice), and the commit gate. The commit body and the blocking-
 * reasons gate (`commit`/`gate` props) come from `Builder.tsx`'s single
 * `useCommitGate(state, sim)` call — shared with the always-visible `SaveBar`
 * so there is exactly one `builderToCommit`/`canCommit` evaluation per render,
 * not two independent call sites that happen to agree. `maxTxFee`,
 * `effectiveSignerCount`, and `isTriggerOnly` are still read directly from the
 * pure model in `builder-state.ts`, and the human schedule line comes from the
 * shipped `summariseSchedule`. No commit/gate/fee math is re-derived here.
 *
 * The tab never fires the commit itself: it renders the Commit button and calls
 * `onCommit` when it is clicked and the gate is open; the assembly runs
 * `create.run(builderToCommit(state))`. A successful Simulate that returns a
 * calibrated gas limit is written back into builder state via `onChange` (AUTO
 * on), which also opens the AUTO-gas gate for the commit.
 */
import { useState, type CSSProperties, type ReactNode } from "react";

import { summariseSchedule } from "../../index.js";
import type { CommitBody } from "../../handlers/index.js";
import type { UseExecuteActionResult } from "../../hooks/index.js";
import type { SimulateEnvelope, SimulateView } from "../../provider/index.js";
import {
  effectiveSignerCount,
  isTriggerOnly,
  type BuilderState,
  type GasPayerState,
} from "../builder-state.js";
import { Panel, Title } from "../primitives.js";
import { ScheduleStep } from "./ScheduleStep.js";
import { formatThousands, postponedMessage } from "./format.js";

export interface ExecuteTabProps {
  /** The whole builder form state (read-only here, save the calibrate write-back). */
  state: BuilderState;
  /** Emits the next full `BuilderState` (schedule edits + gas calibration). */
  onChange: (next: BuilderState) => void;
  /** Fired when the Commit button is clicked and the gate is open. */
  onCommit?: () => void;
  /** True while the assembly's commit call is in flight — disables Commit. */
  committing?: boolean;
  /**
   * True when the selected server resolver declares itself event-driven. Derived
   * in `Builder.tsx` from the resolver options; makes the cronoton scheduler-off,
   * so this tab swaps the ScheduleStep for an event-driven notice and labels the
   * schedule summary "Event-driven (host-fired)".
   */
  eventDrivenResolver?: boolean;
  /**
   * The shared `useSimulate()` result, hoisted to `Builder.tsx` so its last
   * result can also drive the Builder-level Gas meter (see
   * `docs/work/khronoton-builder-pact-editor/design.md`, Change 3 — "State
   * hoisting required"). This tab no longer calls `useSimulate()` itself.
   */
  sim: UseExecuteActionResult<[envelope: SimulateEnvelope], SimulateView>;
  /**
   * The live network gas floor (`useLiveGasFloor()`, hoisted to `Builder.tsx`).
   * `null`/absent while the first poll hasn't resolved yet — the gas summary
   * line shows a loading placeholder in that state.
   */
  liveFloorAnu?: number | null;
  /**
   * True when this tab is rendered inside an edit (not create) flow — swaps
   * the Commit button's label to "Save changes" / "Saving…", matching the
   * always-visible edit-mode `SaveBar`. No other behavior changes: same gate,
   * same disabled state, same access (none, as today).
   */
  isEdit?: boolean;
  /**
   * The commit body, computed once in `Builder.tsx` via `useCommitGate` and
   * shared with the always-visible `SaveBar` — this tab no longer computes
   * its own copy, so there is exactly ONE `builderToCommit` evaluation per
   * render, not two independent ones that happen to agree.
   */
  commit: CommitBody;
  /** The blocking-reasons gate, computed once in `Builder.tsx` via `useCommitGate`. */
  gate: { ok: boolean; reasons: string[] };
}

const ROW_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "12px",
  padding: "6px 0",
  fontSize: "12.5px",
  borderTop: "1px solid var(--khr-border)",
};

const ROW_LABEL_STYLE: CSSProperties = {
  color: "var(--khr-text-dim)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  fontSize: "11px",
};

const ROW_VALUE_STYLE: CSSProperties = {
  color: "var(--khr-text)",
  fontFamily: "var(--khr-mono-font)",
  textAlign: "right",
};

const SIMULATE_BUTTON_STYLE: CSSProperties = {
  border: "1px solid var(--khr-border)",
  background: "var(--khr-panel)",
  color: "var(--khr-text)",
  padding: "7px 14px",
  borderRadius: "6px",
  cursor: "pointer",
  font: "inherit",
  fontSize: "12px",
};

const BANNER_BASE_STYLE: CSSProperties = {
  marginTop: "10px",
  padding: "9px 12px",
  borderRadius: "6px",
  fontSize: "12px",
  border: "1px solid",
};

const TRIGGER_BOX_STYLE: CSSProperties = {
  padding: "13px 14px",
  border: "1px dashed var(--khr-border)",
  borderRadius: "var(--khr-radius)",
  color: "var(--khr-text-dim)",
  fontSize: "12.5px",
  lineHeight: 1.5,
};

const COMMIT_ENABLED_STYLE: CSSProperties = {
  width: "100%",
  padding: "11px 14px",
  border: "1px solid var(--khr-accent)",
  background: "var(--khr-accent-tint)",
  color: "var(--khr-accent)",
  borderRadius: "6px",
  cursor: "pointer",
  font: "inherit",
  fontSize: "13px",
  fontWeight: 600,
};

const COMMIT_DISABLED_STYLE: CSSProperties = {
  ...COMMIT_ENABLED_STYLE,
  borderColor: "var(--khr-border)",
  background: "var(--khr-panel)",
  color: "var(--khr-text-dim)",
  cursor: "not-allowed",
  opacity: 0.7,
};

const REASONS_STYLE: CSSProperties = {
  margin: "10px 0 0",
  paddingLeft: "18px",
  fontSize: "12px",
  color: "var(--khr-amber)",
  lineHeight: 1.6,
};

const TRIGGER_ONLY_SCHEDULE = "Trigger-only (external / manual)";
const EVENT_DRIVEN_SCHEDULE = "Event-driven (host-fired)";
const EVENT_DRIVEN_NOTICE =
  "Event-driven — the host application fires this when its trigger condition is met; " +
  "there is no schedule.";

/** The gas summary line: grouped limit @ (live floor + buffer), with an AUTO suffix. */
function gasLine(state: BuilderState, liveFloorAnu?: number | null): string {
  const c = state.config;
  const suffix = c.autoGasLimit ? " (AUTO)" : "";
  const buffer = c.gasPriceBufferAnu;
  if (liveFloorAnu == null) return `${formatThousands(c.gasLimit)} @ … ANU${suffix}`;
  const total = liveFloorAnu + buffer;
  // A negative buffer can only exist transiently while the operator is
  // mid-edit — `validateConfig` blocks the commit itself — but this summary
  // renders on every keystroke regardless, so it must never label a
  // below-floor total as plainly "(floor)": that would read as though the
  // shown total were the unmodified floor when it is actually less.
  const priceLabel =
    buffer > 0
      ? `${formatThousands(total)} ANU (floor + ${formatThousands(buffer)})`
      : buffer < 0
        ? `${formatThousands(total)} ANU (floor - ${formatThousands(Math.abs(buffer))})`
        : `${formatThousands(total)} ANU (floor)`;
  return `${formatThousands(c.gasLimit)} @ ${priceLabel}${suffix}`;
}

/** A short label for the configured gas payer. */
function gasPayerLabel(gasPayer: GasPayerState): string {
  if (gasPayer.type === "gas-station") return "Gas Station";
  return gasPayer.address ? `Codex ${gasPayer.address}` : "Codex account";
}

/** Total scoped capability lines across every signer (blank lines dropped). */
function scopedCapLineCount(state: BuilderState): number {
  return state.signers
    .filter((s) => s.capabilityMode === "scoped")
    .reduce(
      (sum, s) => sum + s.capabilities.split("\n").filter((l) => l.trim().length > 0).length,
      0,
    );
}

/** `N (M caps)` — effective signers (incl. gas-payer-derived) and scoped cap lines. */
function signersLine(state: BuilderState): string {
  return `${effectiveSignerCount(state)} (${scopedCapLineCount(state)} caps)`;
}

/**
 * The schedule summary: the host-fired label for an event-driven resolver, the
 * external/manual label for a trigger-only / external-fireable job, else the human
 * schedule line.
 */
function scheduleLine(state: BuilderState, eventDrivenResolver?: boolean): string {
  if (eventDrivenResolver) return EVENT_DRIVEN_SCHEDULE;
  if (isTriggerOnly(state) || state.externalFireable) return TRIGGER_ONLY_SCHEDULE;
  return summariseSchedule(state.schedule.mode, state.schedule.config);
}

function SummaryRow({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}): ReactNode {
  return (
    <div style={ROW_STYLE} data-testid={testId}>
      <span style={ROW_LABEL_STYLE}>{label}</span>
      <span style={ROW_VALUE_STYLE}>{value}</span>
    </div>
  );
}

export function ExecuteTab({
  state,
  onChange,
  onCommit,
  committing,
  eventDrivenResolver,
  sim,
  liveFloorAnu,
  isEdit,
  commit,
  gate,
}: ExecuteTabProps): ReactNode {
  const [banner, setBanner] = useState<ReactNode>(null);

  const payloadKeyCount = Object.keys(commit.envelope.payload ?? {}).length;

  const triggerOnly = isTriggerOnly(state);
  // The scheduler is off — and the ScheduleStep swapped for a notice — for a
  // trigger-only job, an externally-fireable one, or an event-driven resolver.
  const schedulerOff = triggerOnly || state.externalFireable || Boolean(eventDrivenResolver);

  const onSimulate = async (): Promise<void> => {
    const view = await sim.run(commit.envelope as unknown as Record<string, unknown>);
    if (!view) {
      setBanner(renderBanner("var(--khr-error)", "Simulation failed — network error."));
      return;
    }
    if (view.postponed) {
      setBanner(renderBanner("var(--khr-accent)", postponedMessage(view.plannedCount)));
      return;
    }
    if (view.ok) {
      if (typeof view.calibratedGasLimit === "number") {
        onChange({
          ...state,
          config: { ...state.config, gasLimit: view.calibratedGasLimit, autoGasLimit: true },
        });
        setBanner(
          renderBanner(
            "var(--khr-success)",
            `Simulation succeeded — calibrated ${formatThousands(view.calibratedGasLimit)} gas.`,
          ),
        );
        return;
      }
      setBanner(renderBanner("var(--khr-success)", "Simulation succeeded."));
      return;
    }
    setBanner(
      renderBanner("var(--khr-error)", `Simulation failed — ${view.error ?? "unknown error"}`),
    );
  };

  const onCommitClick = (): void => {
    if (gate.ok && !committing) onCommit?.();
  };

  const commitEnabled = gate.ok && !committing;

  return (
    <div>
      <Title>Execute</Title>

      <Panel style={{ marginBottom: "16px" }}>
        <div style={{ ...ROW_LABEL_STYLE, marginBottom: "4px" }}>Transaction Summary</div>
        <SummaryRow label="Chain" value={state.config.chainId} testId="summary-chain" />
        <SummaryRow label="Gas" value={gasLine(state, liveFloorAnu)} testId="summary-gas" />
        <SummaryRow label="TTL" value={`${state.config.ttl}s`} testId="summary-ttl" />
        <SummaryRow label="Payload keys" value={String(payloadKeyCount)} testId="summary-payload" />
        <SummaryRow label="Gas payer" value={gasPayerLabel(state.gasPayer)} testId="summary-gaspayer" />
        <SummaryRow label="Signers" value={signersLine(state)} testId="summary-signers" />
        <SummaryRow label="Schedule" value={scheduleLine(state, eventDrivenResolver)} testId="summary-schedule" />
      </Panel>

      <div style={{ marginBottom: "16px" }}>
        <button
          type="button"
          style={SIMULATE_BUTTON_STYLE}
          disabled={sim.pending}
          onClick={onSimulate}
        >
          {sim.pending ? "Simulating…" : "Simulate"}
        </button>
        {banner}
      </div>

      <div style={{ marginBottom: "16px" }}>
        {schedulerOff ? (
          eventDrivenResolver ? (
            <div style={TRIGGER_BOX_STYLE}>{EVENT_DRIVEN_NOTICE}</div>
          ) : (
            <div style={TRIGGER_BOX_STYLE}>
              Trigger-only. This cronoton never runs on a timer — it fires only via the external
              trigger endpoint or a manual run.
            </div>
          )
        ) : (
          <ScheduleStep state={state} onChange={onChange} />
        )}
      </div>

      <div>
        <button
          type="button"
          style={commitEnabled ? COMMIT_ENABLED_STYLE : COMMIT_DISABLED_STYLE}
          disabled={!commitEnabled}
          onClick={onCommitClick}
        >
          {isEdit ? (committing ? "Saving…" : "Save changes") : "Commit Codex Cronoton"}
        </button>
        {!gate.ok ? (
          <ul style={REASONS_STYLE}>
            {gate.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/** A coloured result banner (border + text share the passed CSS var). */
function renderBanner(color: string, message: string): ReactNode {
  return (
    <div
      data-testid="simulate-banner"
      style={{ ...BANNER_BASE_STYLE, borderColor: color, color }}
    >
      {message}
    </div>
  );
}
