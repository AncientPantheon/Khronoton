// @vitest-environment jsdom
//
// `SaveBar` — the always-visible edit-mode Save bar (see
// `docs/work/khronoton-editor-save/design.md`). Renders a Simulate button, a
// Save changes button, and a one-line status computed by `saveBarStatus`, all
// gated by `useCommitGate`'s `gate` plus the viewer's `Access` tier. No real
// provider is mounted — `sim` is built as a plain object literal matching
// `UseExecuteActionResult`'s shape, mirroring `use-commit-gate.test.ts`'s own
// `makeSim` helper.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { builderToCommit, canCommit, makeEmptyBuilderState } from "../builder-state.js";
import type { BuilderState } from "../builder-state.js";
import type { UseExecuteActionResult } from "../../hooks/index.js";
import type { SimulateEnvelope, SimulateView } from "../../provider/index.js";
import type { Access } from "../access.js";
import { SaveBar } from "./SaveBar.js";

/** Mirrors `useCommitGate`'s own formula exactly (not the hook itself — no
 *  component/renderHook needed here since SaveBar now takes `commit`/`gate`
 *  as plain props, computed once by `Builder.tsx` in production). */
function commitGateFor(
  state: BuilderState,
  sim: UseExecuteActionResult<[envelope: SimulateEnvelope], SimulateView>,
) {
  const simulateCalibrated = Boolean(
    sim.result?.ok && typeof sim.result.calibratedGasLimit === "number",
  );
  return { commit: builderToCommit(state), gate: canCommit(state, { simulateCalibrated }) };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

const adminAccess: Access = { tier: "admin" };

function mount(
  state: BuilderState,
  sim: UseExecuteActionResult<[envelope: SimulateEnvelope], SimulateView>,
  opts: {
    onSave?: ReturnType<typeof vi.fn<() => void>>;
    committing?: boolean;
    access?: Access;
  } = {},
) {
  const onSave = opts.onSave ?? vi.fn<() => void>();
  const { commit, gate } = commitGateFor(state, sim);
  render(
    <SaveBar
      commit={commit}
      gate={gate}
      sim={sim}
      onSave={onSave}
      committing={opts.committing}
      access={opts.access ?? adminAccess}
    />,
  );
  return { onSave };
}

describe("SaveBar", () => {
  it("renders the Simulate and Save changes buttons", () => {
    mount(validState(), makeSim(undefined));
    expect(screen.getByRole("button", { name: "Simulate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
  });

  it("disables Save changes when gate.ok is false, and shows the gate reason verbatim", () => {
    // The fresh default (AUTO gas, no sim result) blocks the gate.
    mount(validState(), makeSim(undefined));

    const save = screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/AUTO gas requires a successful Simulate to calibrate/)).toBeTruthy();
  });

  it("clicking Simulate calls sim.run with the hook's commit.envelope", () => {
    const sim = makeSim(undefined);
    const state = validState();
    mount(state, sim);

    fireEvent.click(screen.getByRole("button", { name: "Simulate" }));

    expect(sim.run).toHaveBeenCalledTimes(1);
    const [arg] = (sim.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(arg).toEqual(expect.objectContaining({ pactCode: expect.any(String) }));
  });

  it("shows 'Running dry-run…' while sim.pending is true", () => {
    const sim = { ...makeSim(undefined), pending: true };
    mount(validState(), sim);

    expect(screen.getByText("Running dry-run…")).toBeTruthy();
  });

  it("shows the calibrated-gas status and enables Save when sim.result is a calibrated ok", () => {
    const sim = makeSim({ ok: true, calibratedGasLimit: 1400 });
    mount(
      validState({ config: { ...makeEmptyBuilderState().config, autoGasLimit: true } }),
      sim,
    );

    expect(screen.getByText("Calibrated gas 1,400 — ready to save.")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });

  it("shows 'Simulation failed — boom' when sim.result is ok:false with an error", () => {
    // Matches ExecuteTab's own phrasing exactly — both surfaces can render
    // the SAME failed-simulate event simultaneously (edit mode, Execute tab
    // active), so the wording must not diverge between them.
    const sim = makeSim({ ok: false, error: "boom" });
    mount(validState(), sim);

    expect(screen.getByText("Simulation failed — boom")).toBeTruthy();
  });

  it("shows the postponed status with pluralised planned-transaction count", () => {
    const sim = makeSim({ ok: false, postponed: true, plannedCount: 3 });
    mount(validState(), sim);

    expect(screen.getByText("Simulation postponed — 3 planned transactions.")).toBeTruthy();
  });

  it("shows 'Changes apply at the next fire.' when the gate is open and there's no sim result", () => {
    const state = validState({
      config: { ...makeEmptyBuilderState().config, autoGasLimit: false },
    });
    mount(state, makeSim(undefined));

    expect(screen.getByText("Changes apply at the next fire.")).toBeTruthy();
  });

  it("disables both buttons and shows 'Ancient admins only' for non-admin/logged-out access, even when gate.ok is true", () => {
    const state = validState({
      config: { ...makeEmptyBuilderState().config, autoGasLimit: false },
    });

    for (const tier of ["non-admin", "logged-out"] as const) {
      cleanup();
      mount(state, makeSim(undefined), { access: { tier } });

      const simulateBtn = screen.getByRole("button", { name: "Simulate" }) as HTMLButtonElement;
      const saveBtn = screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
      expect(simulateBtn.disabled).toBe(true);
      expect(saveBtn.disabled).toBe(true);
      expect(screen.getByText("Ancient admins only")).toBeTruthy();
    }
  });

  it("clicking Simulate never calls sim.run for a non-admin/logged-out viewer, even via a bypassed disabled attribute", () => {
    // A directly-dispatched click event (what `fireEvent.click` does) still
    // reaches a React onClick handler regardless of the DOM `disabled`
    // attribute — `onSimulate` must guard `mutable` itself, the same way
    // `onSaveClick` already does, or a non-admin's Simulate click would
    // still sign + dry-run a real transaction server-side.
    for (const tier of ["non-admin", "logged-out"] as const) {
      cleanup();
      const sim = makeSim(undefined);
      mount(validState(), sim, { access: { tier } });

      fireEvent.click(screen.getByRole("button", { name: "Simulate" }));
      expect(sim.run).not.toHaveBeenCalled();
    }
  });

  it("clicking Save calls onSave exactly once when open + admin, and never when disabled by gate or access", () => {
    const openState = validState({
      config: { ...makeEmptyBuilderState().config, autoGasLimit: false },
    });

    const { onSave: onSaveOpen } = mount(openState, makeSim(undefined));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSaveOpen).toHaveBeenCalledTimes(1);

    cleanup();

    // Blocked by the gate (fresh AUTO default, no sim result).
    const { onSave: onSaveGateBlocked } = mount(validState(), makeSim(undefined));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSaveGateBlocked).not.toHaveBeenCalled();

    cleanup();

    // Blocked by access, even though the gate itself would be open.
    const { onSave: onSaveAccessBlocked } = mount(openState, makeSim(undefined), {
      access: { tier: "non-admin" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSaveAccessBlocked).not.toHaveBeenCalled();
  });
});
