/**
 * `useCommitGate(state, sim)` — the shared commit/gate computation extracted
 * from `ExecuteTab.tsx` so both `ExecuteTab` and the always-visible `SaveBar`
 * (see `docs/work/khronoton-editor-save/design.md`) compute the identical
 * gate off the SAME formula, rather than risking two independent
 * `builderToCommit`/`canCommit` call sites drifting apart.
 *
 * `commit`/`gate` are memoized: neither depends on anything but `state` (and,
 * for `gate`, `simulateCalibrated`), so an unrelated prop change on the caller
 * doesn't re-run `builderToCommit`'s payload/signer mapping or `canCommit`'s
 * payload JSON-parse + full-pactCode regex scan for no reason.
 */
import { useMemo } from "react";

import { builderToCommit, canCommit, type BuilderState } from "../builder-state.js";
import type { CommitBody } from "../../handlers/index.js";
import type { UseExecuteActionResult } from "../../hooks/index.js";
import type { SimulateEnvelope, SimulateView } from "../../provider/index.js";

export function useCommitGate(
  state: BuilderState,
  sim: UseExecuteActionResult<[envelope: SimulateEnvelope], SimulateView>,
): { commit: CommitBody; gate: { ok: boolean; reasons: string[] }; simulateCalibrated: boolean } {
  const commit = useMemo(() => builderToCommit(state), [state]);

  // A successful Simulate that calibrated the AUTO gas limit opens the AUTO-gas
  // gate (the model waives it for server-resolver / trigger-only jobs on its own).
  const simulateCalibrated = Boolean(
    sim.result?.ok && typeof sim.result.calibratedGasLimit === "number",
  );
  const gate = useMemo(
    () => canCommit(state, { simulateCalibrated }),
    [state, simulateCalibrated],
  );

  return { commit, gate, simulateCalibrated };
}
