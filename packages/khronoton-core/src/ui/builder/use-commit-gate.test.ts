// @vitest-environment jsdom
//
// `useCommitGate` — the shared `commit`/`gate`/`simulateCalibrated` computation
// extracted from `ExecuteTab.tsx` so `SaveBar.tsx` (added in a later task) can
// compute the identical gate independently, off the SAME `useMemo` formula,
// rather than risking two call sites drifting apart. `renderHook` needs a DOM,
// hence the jsdom docblock even though this hook renders no markup itself. The
// `sim` arg is built as a plain object literal matching `UseExecuteActionResult`'s
// shape, mirroring `TxMeters.test.tsx`'s own `makeSim` helper — no provider needed.

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { builderToCommit, makeEmptyBuilderState } from "../builder-state.js";
import type { BuilderState } from "../builder-state.js";
import type { UseExecuteActionResult } from "../../hooks/index.js";
import type { SimulateEnvelope, SimulateView } from "../../provider/index.js";
import { useCommitGate } from "./use-commit-gate.js";

/** A `useSimulate()`-shaped result built directly, no provider/adapter needed. */
function makeSim(
  result?: SimulateView,
): UseExecuteActionResult<[envelope: SimulateEnvelope], SimulateView> {
  return { run: vi.fn(), pending: false, error: null, result };
}

/** A gas-station state with a signing key set — the minimum that clears the gate. */
function validState(patch: Partial<BuilderState> = {}): BuilderState {
  return {
    ...makeEmptyBuilderState(),
    name: "Daily payout",
    gasPayer: { type: "gas-station", signingKey: "k:payer" },
    ...patch,
  };
}

describe("useCommitGate", () => {
  it("commit equals builderToCommit(state) for a representative state", () => {
    const state = validState();
    const { result } = renderHook(() => useCommitGate(state, makeSim(undefined)));

    expect(result.current.commit).toEqual(builderToCommit(state));
  });

  it("gate.ok is false with the AUTO-gas reason for a fresh autoGasLimit:true state with no sim result", () => {
    const state = validState({
      config: { ...makeEmptyBuilderState().config, autoGasLimit: true },
    });
    const { result } = renderHook(() => useCommitGate(state, makeSim(undefined)));

    expect(result.current.gate.ok).toBe(false);
    expect(result.current.gate.reasons).toContain(
      "AUTO gas requires a successful Simulate to calibrate, or switch to manual.",
    );
    expect(result.current.simulateCalibrated).toBe(false);
  });

  it("gate.ok becomes true once sim.result reports a calibrated gas limit", () => {
    const state = validState({
      config: { ...makeEmptyBuilderState().config, autoGasLimit: true },
    });
    const sim = makeSim({ ok: true, gasUsed: 700, calibratedGasLimit: 42 });
    const { result } = renderHook(() => useCommitGate(state, sim));

    expect(result.current.simulateCalibrated).toBe(true);
    expect(result.current.gate.ok).toBe(true);
  });

  it("commit/gate keep the same object reference across a re-render when state is unchanged", () => {
    const state = validState();
    const { result, rerender } = renderHook(
      (_props: { unrelated: number }) => useCommitGate(state, makeSim(undefined)),
      { initialProps: { unrelated: 1 } },
    );

    const firstCommit = result.current.commit;
    const firstGate = result.current.gate;

    rerender({ unrelated: 2 });

    expect(result.current.commit).toBe(firstCommit);
    expect(result.current.gate).toBe(firstGate);
  });
});
