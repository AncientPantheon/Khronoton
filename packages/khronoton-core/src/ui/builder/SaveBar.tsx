/**
 * The always-visible edit-mode Save bar (see
 * `docs/work/khronoton-editor-save/design.md`). Rendered once above the
 * Pact-editor/tabs in `Builder.tsx` (only once the edited row has loaded —
 * see that file's `editReady` gate), visible regardless of which tab is
 * active: a Simulate button, a Save changes button, and a one-line status.
 * Receives `{ commit, gate }` as PROPS from `Builder.tsx`'s own single
 * `useCommitGate(state, sim)` call, rather than calling the hook itself —
 * `ExecuteTab` receives the identical values from the same call, so there is
 * exactly ONE `builderToCommit`/`canCommit` evaluation per render, not two
 * independent ones that happen to agree.
 *
 * An access denial (`!canMutate(access)`) takes precedence over any sim/gate
 * state: both buttons stay disabled — including their CLICK HANDLERS, not
 * just the `disabled` attribute, since a directly-dispatched click event
 * still reaches a React handler regardless of the DOM `disabled` state — and
 * the status reads exactly `ADMIN_ONLY_TITLE`, regardless of how "ready" the
 * form otherwise is.
 */
import type { CSSProperties, ReactNode } from "react";

import type { CommitBody } from "../../handlers/index.js";
import type { UseExecuteActionResult } from "../../hooks/index.js";
import type { SimulateEnvelope, SimulateView } from "../../provider/index.js";
import { canMutate, ADMIN_ONLY_TITLE, type Access } from "../access.js";
import { formatThousands, postponedMessage } from "./format.js";

export interface SaveBarProps {
  /** The commit body, computed once in `Builder.tsx` via `useCommitGate`. */
  commit: CommitBody;
  /** The blocking-reasons gate, computed once in `Builder.tsx` via `useCommitGate`. */
  gate: { ok: boolean; reasons: string[] };
  /** The shared `useSimulate()` result, hoisted to `Builder.tsx`. */
  sim: UseExecuteActionResult<[envelope: SimulateEnvelope], SimulateView>;
  /** Fired when Save changes is clicked and the gate is open. */
  onSave: () => void;
  /** True while the assembly's commit call is in flight — disables Save. */
  committing?: boolean;
  /** The viewer's access tier — a non-admin/logged-out viewer never gets an enabled Save. */
  access: Access;
}

const BAR_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "12px",
  padding: "10px 12px",
  marginBottom: "12px",
  border: "1px solid var(--khr-border)",
  borderRadius: "var(--khr-radius)",
  background: "var(--khr-panel)",
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

const SAVE_ENABLED_STYLE: CSSProperties = {
  padding: "7px 14px",
  border: "1px solid var(--khr-accent)",
  background: "var(--khr-accent-tint)",
  color: "var(--khr-accent)",
  borderRadius: "6px",
  cursor: "pointer",
  font: "inherit",
  fontSize: "12px",
  fontWeight: 600,
};

const SAVE_DISABLED_STYLE: CSSProperties = {
  ...SAVE_ENABLED_STYLE,
  borderColor: "var(--khr-border)",
  background: "var(--khr-panel)",
  color: "var(--khr-text-dim)",
  cursor: "not-allowed",
  opacity: 0.7,
};

const STATUS_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "12px",
  color: "var(--khr-text-dim)",
};

/** The status line's priority order — mirrors `ExecuteTab.tsx`'s own `onSimulate`
 *  precedence (postponed checked before ok/error), plus the two default states. */
function saveBarStatus(
  sim: UseExecuteActionResult<[envelope: SimulateEnvelope], SimulateView>,
  gate: { ok: boolean; reasons: string[] },
): string {
  if (sim.pending) return "Running dry-run…";
  const result = sim.result;
  if (result?.postponed) return postponedMessage(result.plannedCount);
  if (result && !result.ok) {
    return `Simulation failed — ${result.error ?? "unknown error"}`;
  }
  if (result?.ok && typeof result.calibratedGasLimit === "number") {
    return `Calibrated gas ${formatThousands(result.calibratedGasLimit)} — ready to save.`;
  }
  if (!gate.ok && gate.reasons.length > 0) return gate.reasons[0];
  return "Changes apply at the next fire.";
}

export function SaveBar({ commit, gate, sim, onSave, committing, access }: SaveBarProps): ReactNode {
  const mutable = canMutate(access);

  const onSimulate = (): void => {
    // Guarded the same way `onSaveClick` is guarded below: a bypassed
    // `disabled` attribute (e.g. a directly-dispatched click event) must
    // not be able to trigger a real sign + dry-run against the chain node
    // for a viewer who can't mutate.
    if (!mutable || sim.pending) return;
    void sim.run(commit.envelope as unknown as Record<string, unknown>);
  };

  const saveEnabled = gate.ok && !committing && mutable;

  const onSaveClick = (): void => {
    if (gate.ok && !committing && mutable) onSave();
  };

  const status = mutable ? saveBarStatus(sim, gate) : ADMIN_ONLY_TITLE;

  return (
    <div style={BAR_STYLE}>
      <button
        type="button"
        style={SIMULATE_BUTTON_STYLE}
        disabled={sim.pending || !mutable}
        onClick={onSimulate}
      >
        {sim.pending ? "Simulating…" : "Simulate"}
      </button>
      <button
        type="button"
        style={saveEnabled ? SAVE_ENABLED_STYLE : SAVE_DISABLED_STYLE}
        disabled={!saveEnabled}
        onClick={onSaveClick}
      >
        {committing ? "Saving…" : "Save changes"}
      </button>
      <p style={STATUS_STYLE}>{status}</p>
    </div>
  );
}
