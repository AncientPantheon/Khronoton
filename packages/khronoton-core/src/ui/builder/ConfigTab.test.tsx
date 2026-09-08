// @vitest-environment jsdom
//
// Behavioral tests for the builder Config tab. This is a CONTROLLED component:
// it renders `state.config` and calls `onChange` with a patched BuilderState on
// every edit. We pin (a) each field + its verbatim helper reaching the DOM, (b)
// that edits produce the RIGHT config patch (expectation driven from the typed
// value, not a constant), (c) the AUTO/MANUAL toggle flips `autoGasLimit` and
// makes the input read-only, and (d) the Max Tx Fee display derives from
// gasPrice × gasLimit and moves when the config moves.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { ConfigTab } from "./ConfigTab.js";
import { makeEmptyBuilderState, type BuilderState } from "../builder-state.js";

afterEach(() => {
  cleanup();
});

function withConfig(patch: Partial<BuilderState["config"]>): BuilderState {
  const base = makeEmptyBuilderState();
  return { ...base, config: { ...base.config, ...patch } };
}

describe("ConfigTab — fields + verbatim helpers", () => {
  it("renders the section title and every field's helper verbatim", () => {
    render(<ConfigTab state={makeEmptyBuilderState()} onChange={vi.fn()} />);
    expect(screen.getByText("Transaction Configuration")).toBeDefined();
    expect(screen.getByText("Single chain per job (Stoa Network).")).toBeDefined();
    expect(
      screen.getByText("The chain's live minimum gas price right now. Refreshes automatically."),
    ).toBeDefined();
    expect(
      screen.getByText(
        "The transaction always pays the live floor at fire time, plus this. Leave at 0 unless you need priority over other pending transactions.",
      ),
    ).toBeDefined();
    expect(screen.getByText("Range: 60s (1 min) to 86,400s (24 hours).")).toBeDefined();
  });

  it("shows the default Chain ID as a mono control", () => {
    render(<ConfigTab state={makeEmptyBuilderState()} onChange={vi.fn()} />);
    const chain = screen.getByLabelText("Chain ID") as HTMLInputElement;
    expect(chain.value).toBe("0");
    expect(chain.style.fontFamily).toContain("var(--khr-mono-font)");
  });
});

describe("ConfigTab — edits produce the right config patch", () => {
  it("patches config.chainId (string) when Chain ID changes, preserving other state", () => {
    const onChange = vi.fn();
    const state = makeEmptyBuilderState();
    render(<ConfigTab state={state} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Chain ID"), { target: { value: "2" } });
    expect(onChange).toHaveBeenCalledWith({
      ...state,
      config: { ...state.config, chainId: "2" },
    });
  });

  it("patches config.gasPriceBufferAnu as a NUMBER when Priority Buffer changes", () => {
    const onChange = vi.fn();
    const state = makeEmptyBuilderState();
    render(<ConfigTab state={state} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Priority Buffer (ANU above floor)"), {
      target: { value: "500" },
    });
    expect(onChange).toHaveBeenCalledWith({
      ...state,
      config: { ...state.config, gasPriceBufferAnu: 500 },
    });
  });

  it("patches config.ttl as a NUMBER when Time To Live changes", () => {
    const onChange = vi.fn();
    const state = makeEmptyBuilderState();
    render(<ConfigTab state={state} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Time To Live (seconds)"), { target: { value: "1200" } });
    expect(onChange).toHaveBeenCalledWith({
      ...state,
      config: { ...state.config, ttl: 1200 },
    });
  });
});

describe("ConfigTab — Gas Limit MANUAL/AUTO toggle", () => {
  it("in MANUAL mode shows the MANUAL badge, a 'Switch to auto' toggle, and an editable input", () => {
    render(<ConfigTab state={withConfig({ autoGasLimit: false })} onChange={vi.fn()} />);
    expect(screen.getByText("MANUAL")).toBeDefined();
    expect(screen.getByRole("button", { name: "Switch to auto" })).toBeDefined();
    expect((screen.getByLabelText("Gas Limit") as HTMLInputElement).readOnly).toBe(false);
  });

  it("clicking 'Switch to auto' flips config.autoGasLimit to true", () => {
    const onChange = vi.fn();
    const state = withConfig({ autoGasLimit: false });
    render(<ConfigTab state={state} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to auto" }));
    expect(onChange).toHaveBeenCalledWith({
      ...state,
      config: { ...state.config, autoGasLimit: true },
    });
  });

  it("in AUTO mode shows the AUTO badge, a 'Switch to manual' toggle, a read-only input, and the calibrate helper", () => {
    render(<ConfigTab state={withConfig({ autoGasLimit: true })} onChange={vi.fn()} />);
    expect(screen.getByText("AUTO")).toBeDefined();
    expect(screen.getByRole("button", { name: "Switch to manual" })).toBeDefined();
    expect((screen.getByLabelText("Gas Limit") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText("Run Simulate to calibrate the auto gas limit.")).toBeDefined();
  });

  it("clicking 'Switch to manual' flips config.autoGasLimit back to false", () => {
    const onChange = vi.fn();
    const state = withConfig({ autoGasLimit: true });
    render(<ConfigTab state={state} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to manual" }));
    expect(onChange).toHaveBeenCalledWith({
      ...state,
      config: { ...state.config, autoGasLimit: false },
    });
  });

  it("in AUTO mode with a calibrated gas limit shows 'Calibrated: {n} gas' instead of the run-simulate helper", () => {
    render(
      <ConfigTab
        state={withConfig({ autoGasLimit: true, gasLimit: 1500 })}
        onChange={vi.fn()}
        calibratedGasLimit={1500}
      />,
    );
    expect(screen.getByText("Calibrated: 1,500 gas")).toBeDefined();
    expect(screen.queryByText("Run Simulate to calibrate the auto gas limit.")).toBeNull();
  });
});

describe("ConfigTab — Max Tx Fee derivation", () => {
  it("renders the default fee (floor 10000 + buffer 0) × 1500 = 15,000,000 ANU with the derivation caption", () => {
    render(<ConfigTab state={makeEmptyBuilderState()} onChange={vi.fn()} liveFloorAnu={10000} />);
    expect(screen.getByText(/15,000,000 ANU/)).toBeDefined();
    expect(screen.getByText("((floor + buffer) x gas limit)")).toBeDefined();
  });

  it("moves the fee when the config moves ((10000 + 500) × 2000 = 21,000,000 ANU)", () => {
    render(
      <ConfigTab
        state={withConfig({ gasPriceBufferAnu: 500, gasLimit: 2000 })}
        onChange={vi.fn()}
        liveFloorAnu={10000}
      />,
    );
    expect(screen.getByText(/21,000,000 ANU/)).toBeDefined();
  });

  it("shows a loading placeholder for the fee when the live floor hasn't resolved", () => {
    render(<ConfigTab state={makeEmptyBuilderState()} onChange={vi.fn()} />);
    expect(screen.getByText("…")).toBeDefined();
  });
});

describe("ConfigTab — live network floor display", () => {
  it("shows the live floor when provided, and a loading placeholder when not", () => {
    const { unmount } = render(
      <ConfigTab state={makeEmptyBuilderState()} onChange={vi.fn()} liveFloorAnu={10069} />,
    );
    expect(screen.getByText(/10,069 ANU/)).toBeDefined();
    unmount();

    render(<ConfigTab state={makeEmptyBuilderState()} onChange={vi.fn()} />);
    expect(screen.getByText("Loading…")).toBeDefined();
  });
});
