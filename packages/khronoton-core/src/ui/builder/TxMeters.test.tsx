// @vitest-environment jsdom
//
// TxMeters suite. Opts into jsdom via the top-of-file docblock (the global
// vitest env stays `node` for the engine/handler suites). TxMeters is a pure-
// props component — no hook of its own calls the provider — so its `sim` prop
// is built directly as a plain object literal matching `UseExecuteActionResult`'s
// shape, following the task's own guidance, rather than mounting a fake adapter.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

import { makeEmptyBuilderState } from "../builder-state.js";
import type { BuilderState } from "../builder-state.js";
import type { UseExecuteActionResult } from "../../hooks/index.js";
import type { SimulateEnvelope, SimulateView } from "../../provider/index.js";
import { TxMeters } from "./TxMeters.js";

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

function stateWithGasLimit(gasLimit: number): BuilderState {
  const state = makeEmptyBuilderState();
  return { ...state, config: { ...state.config, gasLimit } };
}

describe("TxMeters — Gas row", () => {
  it('shows "Run Simulate" before any Simulate result exists', () => {
    render(<TxMeters state={makeEmptyBuilderState()} sim={makeSim(undefined)} />);
    expect(screen.getByText("Run Simulate")).toBeTruthy();
  });

  it("renders gasUsed / gasLimit once a Simulate result exists", () => {
    render(
      <TxMeters
        state={stateWithGasLimit(2000)}
        sim={makeSim({ ok: true, gasUsed: 1500 })}
      />,
    );
    expect(screen.getByText("1,500 / 2,000")).toBeTruthy();
  });

  it("flags an over-limit gas result with a warning marker", () => {
    render(
      <TxMeters
        state={stateWithGasLimit(2000)}
        sim={makeSim({ ok: true, gasUsed: 3000 })}
      />,
    );
    expect(screen.getByText("3,000 > 2,000 ⚠")).toBeTruthy();
  });

  it('still shows "Run Simulate" for a FAILED simulate result, even if it carries a truthy gasUsed', () => {
    // SimulateView isn't a discriminated union — { ok: false, gasUsed: N } is
    // type-legal from any KhronotonAdapter implementation, even though the
    // bundled server never produces it. Without gating on `ok`, this would
    // render a "successful"-looking gas bar for a simulate that actually
    // failed, contradicting ExecuteTab's own failure banner for the same
    // result.
    render(
      <TxMeters
        state={stateWithGasLimit(2000)}
        sim={makeSim({ ok: false, gasUsed: 1500, error: "chain error" })}
      />,
    );
    expect(screen.getByText("Run Simulate")).toBeTruthy();
    expect(screen.queryByText("1,500 / 2,000")).toBeNull();
  });
});

describe("TxMeters — Tx Size row", () => {
  it("resolves the async byte estimate after mount, replacing the ellipsis placeholder", async () => {
    const state = { ...makeEmptyBuilderState(), pactCode: "(module-body)" };
    render(<TxMeters state={state} sim={makeSim(undefined)} />);

    await waitFor(() => {
      expect(screen.queryByText("…")).toBeNull();
    });

    expect(screen.getByText(/‰/)).toBeTruthy();
  });
});
