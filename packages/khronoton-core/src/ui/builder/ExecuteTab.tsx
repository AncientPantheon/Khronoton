/**
 * Builder "Execute" tab — the final review + fire surface of the codex-cronoton
 * builder.
 *
 * A CONTROLLED tab over the whole {@link BuilderState}: it renders a read-only
 * Transaction Summary, a Simulate control, the embedded schedule editor (or the
 * trigger-only notice), and the commit gate. Every derived figure comes from the
 * pure model in `builder-state.ts` — `builderToCommit` (the wire body + the
 * simulate envelope), `canCommit` (the blocking-reasons gate), `maxTxFee`,
 * `effectiveSignerCount`, and `isTriggerOnly` — and the human schedule line comes
 * from the shipped `summariseSchedule`. No commit/gate/fee math is re-derived
 * here.
 *
 * The tab never fires the commit itself: it renders the Commit button and calls
 * `onCommit` when it is clicked and the gate is open; the assembly runs
 * `create.run(builderToCommit(state))`. A successful Simulate that returns a
 * calibrated gas limit is written back into builder state via `onChange` (AUTO
 * on), which also opens the AUTO-gas gate for the commit.
 */
import { useState, type CSSProperties, type ReactNode } from "react";

import { summariseSchedule } from "../../index.js";
import { useSimulate } from "../../hooks/index.js";
import {
  builderToCommit,
  canCommit,
  effectiveSignerCount,
  isTriggerOnly,
  type BuilderState,
  type GasPayerState,
} from "../builder-state.js";
import { Panel, Title } from "../primitives.js";
import { ScheduleStep } from "./ScheduleStep.js";

export interface ExecuteTabProps {
  /** The whole builder form state (read-only here, save the calibrate write-back). */
  state: BuilderState;
  /** Emits the next full `BuilderState` (schedule edits + gas calibration). */
  onChange: (next: BuilderState) => void;
  /** Fired when the Commit button is clicked and the gate is open. */
  onCommit?: () => void;
  /** True while the assembly's commit call is in flight — disables Commit. */
  committing?: boolean;
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

/** Thousands-grouped integer, e.g. 42000 → "42,000" (locale-pinned to en-US). */
function formatThousands(n: number): string {
  return n.toLocaleString("en-US");
}

/** The gas summary line: grouped limit @ raw price, with an AUTO suffix. */
function gasLine(state: BuilderState): string {
  const c = state.config;
  const suffix = c.autoGasLimit ? " (AUTO)" : "";
  return `${formatThousands(c.gasLimit)} @ ${c.gasPriceAnu} ANU${suffix}`;
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

/** The schedule summary, or the external/manual label for a trigger-only job. */
function scheduleLine(state: BuilderState): string {
  return isTriggerOnly(state)
    ? TRIGGER_ONLY_SCHEDULE
    : summariseSchedule(state.schedule.mode, state.schedule.config);
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

export function ExecuteTab({ state, onChange, onCommit, committing }: ExecuteTabProps): ReactNode {
  const sim = useSimulate();
  const [banner, setBanner] = useState<ReactNode>(null);

  const commit = builderToCommit(state);
  const payloadKeyCount = Object.keys(commit.envelope.payload ?? {}).length;

  // A successful Simulate that calibrated the AUTO gas limit opens the AUTO-gas
  // gate (the model waives it for server-resolver / trigger-only jobs on its own).
  const simulateCalibrated = Boolean(
    sim.result?.ok && typeof sim.result.calibratedGasLimit === "number",
  );
  const gate = canCommit(state, { simulateCalibrated });

  const triggerOnly = isTriggerOnly(state);

  const onSimulate = async (): Promise<void> => {
    const view = await sim.run(commit.envelope as unknown as Record<string, unknown>);
    if (!view) {
      setBanner(renderBanner("var(--khr-error)", "Simulation failed — network error."));
      return;
    }
    if (view.postponed) {
      const detail =
        typeof view.plannedCount === "number"
          ? ` — ${view.plannedCount} planned transaction${view.plannedCount === 1 ? "" : "s"}`
          : "";
      setBanner(renderBanner("var(--khr-accent)", `Simulation postponed${detail}.`));
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
        <SummaryRow label="Gas" value={gasLine(state)} testId="summary-gas" />
        <SummaryRow label="TTL" value={`${state.config.ttl}s`} testId="summary-ttl" />
        <SummaryRow label="Payload keys" value={String(payloadKeyCount)} testId="summary-payload" />
        <SummaryRow label="Gas payer" value={gasPayerLabel(state.gasPayer)} testId="summary-gaspayer" />
        <SummaryRow label="Signers" value={signersLine(state)} testId="summary-signers" />
        <SummaryRow label="Schedule" value={scheduleLine(state)} testId="summary-schedule" />
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
        {triggerOnly ? (
          <div style={TRIGGER_BOX_STYLE}>
            Trigger-only. This cronoton declares runtime arguments and never runs on a timer — it
            fires only via the external trigger endpoint or a manual run.
          </div>
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
          Commit Codex Cronoton
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
