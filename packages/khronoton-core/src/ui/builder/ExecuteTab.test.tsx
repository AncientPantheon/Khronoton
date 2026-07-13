// @vitest-environment jsdom
//
// ExecuteTab suite. Opts into jsdom via the top-of-file docblock (the global
// vitest env stays `node` for the engine/handler suites). The tab is the
// builder's final surface: a read-only Transaction Summary, a Simulate control
// wired to `useSimulate` (so it needs a real provider over a fake adapter), the
// embedded ScheduleStep (or the trigger-only box), and the commit gate. A small
// stateful harness feeds the tab's own `onChange` back as `state` so the
// calibrate-back-into-state path re-renders exactly as it will in the assembly.

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

import { KhronotonProvider } from "../../provider/KhronotonProvider.js";
import type { KhronotonAdapter } from "../../provider/adapter.js";
import { ExecuteTab } from "./ExecuteTab.js";
import { makeEmptyBuilderState } from "../builder-state.js";
import type { BuilderState, SignerRow } from "../builder-state.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A complete 16-method fake adapter whose `simulate` is overridable; the rest are
 *  inert so `assertAdapter` passes at mount and calls stay observable. */
function makeAdapter(overrides: Partial<KhronotonAdapter> = {}): KhronotonAdapter {
  const inert = () => vi.fn(async () => ({ ok: true }));
  return {
    list: inert(),
    get: inert(),
    fires: inert(),
    signers: inert(),
    commit: inert(),
    edit: inert(),
    pause: inert(),
    resume: inert(),
    delete: inert(),
    simulate: inert(),
    executeNow: inert(),
    trigger: inert(),
    startBatch: inert(),
    getBatch: inert(),
    cancelBatch: inert(),
    recover: inert(),
    ...overrides,
  } as unknown as KhronotonAdapter;
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

interface MountResult {
  onChange: ReturnType<typeof vi.fn>;
  onCommit: ReturnType<typeof vi.fn>;
  current: () => BuilderState;
}

/** Mount the tab in a stateful harness over a provider so onChange edits re-render. */
function mount(
  start: BuilderState,
  opts: { adapter?: KhronotonAdapter; committing?: boolean } = {},
): MountResult {
  const adapter = opts.adapter ?? makeAdapter();
  const onChange = vi.fn<(next: BuilderState) => void>();
  const onCommit = vi.fn();
  let latest = start;

  function Harness() {
    const [state, setState] = React.useState<BuilderState>(start);
    latest = state;
    return (
      <ExecuteTab
        state={state}
        onChange={(next) => {
          onChange(next);
          setState(next);
        }}
        onCommit={onCommit}
        committing={opts.committing}
      />
    );
  }

  render(
    <KhronotonProvider adapter={adapter}>
      <Harness />
    </KhronotonProvider>,
  );
  return { onChange, onCommit, current: () => latest };
}

const scopedSigner = (id: string, caps: string): SignerRow => ({
  id,
  publicKey: `pk-${id}`,
  label: "",
  source: "foreign",
  capabilityMode: "scoped",
  capabilities: caps,
});

describe("ExecuteTab — transaction summary", () => {
  it("renders the gas line thousands-grouped with the '@ price ANU' + (AUTO) suffix", () => {
    // gasLimit 1500 groups to 1,500; the raw gas price is NOT grouped; AUTO is on.
    mount(
      validState({
        config: { chainId: "0", gasPriceAnu: 10000, gasLimit: 1500, autoGasLimit: true, ttl: 600 },
      }),
    );
    expect(screen.getByTestId("summary-gas").textContent).toContain("1,500 @ 10000 ANU (AUTO)");
  });

  it("omits the (AUTO) suffix for a manual gas limit", () => {
    mount(
      validState({
        config: { chainId: "0", gasPriceAnu: 10000, gasLimit: 1500, autoGasLimit: false, ttl: 600 },
      }),
    );
    const gas = screen.getByTestId("summary-gas").textContent ?? "";
    expect(gas).toContain("1,500 @ 10000 ANU");
    expect(gas).not.toContain("AUTO");
  });

  it("counts effective signers (incl. the gas-payer-derived one) and total scoped cap lines", () => {
    // Two scoped signers with 2 + 1 cap lines, plus a pure signer, plus the
    // gas-station-derived signer ⇒ N = 3 manual + 1 derived = 4, M = 3 cap lines.
    const signers: SignerRow[] = [
      scopedSigner("a", "coin.TRANSFER a b 1\ncoin.GAS"),
      scopedSigner("b", "coin.ROTATE k"),
      { id: "c", publicKey: "pk-c", label: "", source: "foreign", capabilityMode: "pure", capabilities: "" },
    ];
    mount(validState({ signers }));
    expect(screen.getByTestId("summary-signers").textContent).toContain("4 (3 caps)");
  });

  it("shows the human schedule summary for a schedule-based job", () => {
    mount(validState()); // default daily {hours:[12], minute:0}
    expect(screen.getByTestId("summary-schedule").textContent).toContain("Daily at 12:00 UTC");
  });

  it("labels a trigger-only job's schedule as external / manual", () => {
    mount(validState({ runtimeArgKeysText: "amount" }));
    expect(screen.getByTestId("summary-schedule").textContent).toContain(
      "Trigger-only (external / manual)",
    );
  });
});

describe("ExecuteTab — embedded schedule", () => {
  it("embeds the ScheduleStep editor for a schedule-based job", () => {
    mount(validState());
    // ScheduleStep exposes a labelled Mode select; the trigger-only box does not.
    expect(screen.getByLabelText("Mode")).toBeTruthy();
  });

  it("renders the trigger-only notice (no schedule editor) when runtime-arg keys are declared", () => {
    mount(validState({ runtimeArgKeysText: "amount, recipient" }));
    expect(screen.queryByLabelText("Mode")).toBeNull();
    expect(screen.getByText(/never runs on a timer/i)).toBeTruthy();
  });
});

describe("ExecuteTab — simulate", () => {
  it("passes the built envelope to simulate and shows a green ok banner", async () => {
    const simulate = vi.fn(async (_env: Record<string, unknown>) => ({ ok: true as const }));
    const adapter = makeAdapter({ simulate: simulate as unknown as KhronotonAdapter["simulate"] });
    mount(validState(), { adapter });

    fireEvent.click(screen.getByRole("button", { name: "Simulate" }));

    await waitFor(() => expect(simulate).toHaveBeenCalledTimes(1));
    // The envelope carries the tx parts the simulate route reads.
    expect(simulate.mock.calls[0][0]).toMatchObject({ pactCode: "", gasPayer: { type: "gas-station" } });

    const banner = await screen.findByTestId("simulate-banner");
    expect(banner.textContent).toMatch(/ok|succeed/i);
    expect(banner.getAttribute("style")).toContain("var(--khr-success)");
  });

  it("shows a gold postponed banner carrying the planned count", async () => {
    const simulate = vi.fn(async () => ({ ok: true as const, postponed: true, plannedCount: 5 }));
    const adapter = makeAdapter({ simulate: simulate as unknown as KhronotonAdapter["simulate"] });
    mount(validState({ serverResolver: "resolver.js" }), { adapter });

    fireEvent.click(screen.getByRole("button", { name: "Simulate" }));

    const banner = await screen.findByTestId("simulate-banner");
    expect(banner.textContent).toContain("5");
    expect(banner.getAttribute("style")).toContain("var(--khr-accent)");
  });

  it("shows a red error banner surfacing the failure message on ok:false", async () => {
    const simulate = vi.fn(async () => ({ ok: false as const, error: "gas estimation failed" }));
    const adapter = makeAdapter({ simulate: simulate as unknown as KhronotonAdapter["simulate"] });
    mount(validState(), { adapter });

    fireEvent.click(screen.getByRole("button", { name: "Simulate" }));

    const banner = await screen.findByTestId("simulate-banner");
    expect(banner.textContent).toContain("gas estimation failed");
    expect(banner.getAttribute("style")).toContain("var(--khr-error)");
  });

  it("calibrates a returned gas limit back into builder state (gasLimit + AUTO)", async () => {
    const simulate = vi.fn(async () => ({ ok: true as const, calibratedGasLimit: 42000 }));
    const adapter = makeAdapter({ simulate: simulate as unknown as KhronotonAdapter["simulate"] });
    // Start from a MANUAL config so the calibrate flips autoGasLimit on.
    const { onChange, current } = mount(
      validState({
        config: { chainId: "0", gasPriceAnu: 10000, gasLimit: 1500, autoGasLimit: false, ttl: 600 },
      }),
      { adapter },
    );

    fireEvent.click(screen.getByRole("button", { name: "Simulate" }));

    await waitFor(() => {
      const next = current();
      expect(next.config.gasLimit).toBe(42000);
      expect(next.config.autoGasLimit).toBe(true);
    });
    expect(onChange).toHaveBeenCalled();
    // The summary re-renders with the calibrated, thousands-grouped figure.
    expect(screen.getByTestId("summary-gas").textContent).toContain("42,000 @ 10000 ANU (AUTO)");
  });
});

describe("ExecuteTab — commit gate", () => {
  it("disables Commit and lists the blocking reasons when the form is incomplete", () => {
    mount(makeEmptyBuilderState());

    const button = screen.getByRole("button", { name: "Commit Codex Cronoton" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // The blocking reasons render as a list so the operator sees every gate.
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toContain("Name is required.");
    expect(items).toContain("Select a key to sign the DALOS.GAS_PAYER capability.");
    expect(items).toContain("At least one signer is required.");
  });

  it("enables Commit for a valid state and fires onCommit on click", () => {
    const { onCommit } = mount(validState());

    const button = screen.getByRole("button", { name: "Commit Codex Cronoton" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("disables Commit (and does not fire onCommit) while a commit is in flight", () => {
    const { onCommit } = mount(validState(), { committing: true });

    const button = screen.getByRole("button", { name: "Commit Codex Cronoton" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
