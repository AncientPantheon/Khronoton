// @vitest-environment jsdom
//
// Gas Payer tab suite. Pins the three-radio-card parity from the builder spec:
// (A) Pay with Codex Key, (B) Pay with Foreign Key (permanently disabled), and
// (C) Ouronet Gas Station (the default selection). Every card switch and key /
// account pick must flow back through `onChange` as a new `BuilderState` whose
// `gasPayer` slice matches the wire shape the executor expects. The warn lines
// gate the commit — they must appear exactly when a required selection is
// missing.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { GasPayerTab } from "./GasPayerTab.js";
import {
  makeEmptyBuilderState,
  type BuilderState,
  type GasPayerState,
} from "../builder-state.js";
import type { CodexSignerDescriptor } from "../../handlers/index.js";

afterEach(() => {
  cleanup();
});

const SIGNERS: CodexSignerDescriptor[] = [
  { publicKey: "aaaa1111", display: "derived" },
  { publicKey: "bbbb2222", display: "foreign" },
];

function stateWith(gasPayer: GasPayerState): BuilderState {
  return { ...makeEmptyBuilderState(), gasPayer };
}

function renderTab(
  gasPayer: GasPayerState = { type: "gas-station" },
  signers: CodexSignerDescriptor[] | undefined = SIGNERS,
) {
  const onChange = vi.fn();
  render(<GasPayerTab state={stateWith(gasPayer)} onChange={onChange} signers={signers} />);
  return { onChange };
}

describe("<GasPayerTab> structure", () => {
  it("renders exactly the three gas-payer radio cards", () => {
    renderTab();
    expect(screen.getByRole("radio", { name: "Pay with Codex Key" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Pay with Foreign Key" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Ouronet Gas Station" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it("selects Ouronet Gas Station by default (the spec's default gas payer)", () => {
    renderTab();
    const gasStation = screen.getByRole("radio", { name: "Ouronet Gas Station" }) as HTMLInputElement;
    const codex = screen.getByRole("radio", { name: "Pay with Codex Key" }) as HTMLInputElement;
    expect(gasStation.checked).toBe(true);
    expect(codex.checked).toBe(false);
  });

  it("keeps the Foreign Key card disabled and shows the Unavailable badge + reason", () => {
    renderTab();
    const foreign = screen.getByRole("radio", { name: "Pay with Foreign Key" }) as HTMLInputElement;
    expect(foreign.disabled).toBe(true);
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(
      screen.getByText(
        "Foreign-key gas payment isn't available for scheduled codex transactions — the Hub signs only from the sealed codex.",
      ),
    ).toBeTruthy();
  });

  it("shows the gas-station chip and DALOS.GAS_PAYER explanation", () => {
    renderTab();
    expect(
      screen.getByText("Ouronet Gas Station (STOA_AUTONOMIC_OURONETGASSTATION)"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "The Ouronet Gas Station pays gas on the job's behalf. Pick the codex key that signs the DALOS.GAS_PAYER capability.",
      ),
    ).toBeTruthy();
  });
});

describe("<GasPayerTab> card switching", () => {
  it("emits a codex gas payer (no address yet) when the Codex Key card is picked", () => {
    const { onChange } = renderTab();
    fireEvent.click(screen.getByRole("radio", { name: "Pay with Codex Key" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].gasPayer).toEqual({ type: "codex" });
  });

  it("emits a gas-station gas payer when the Gas Station card is re-picked from codex", () => {
    const { onChange } = renderTab({ type: "codex", address: "aaaa1111" });
    fireEvent.click(screen.getByRole("radio", { name: "Ouronet Gas Station" }));
    expect(onChange.mock.calls[0][0].gasPayer).toEqual({ type: "gas-station" });
  });
});

describe("<GasPayerTab> Codex Key account picker", () => {
  it("groups descriptors into Seed Accounts and Pure Keys when codex is selected", () => {
    renderTab({ type: "codex" });
    const groups = document.querySelectorAll("optgroup");
    const labels = Array.from(groups).map((g) => g.getAttribute("label"));
    expect(labels).toContain("Seed Accounts");
    expect(labels).toContain("Pure Keys");
  });

  it("warns to select a codex account while none is chosen", () => {
    renderTab({ type: "codex" });
    expect(screen.getByText("Select a codex account to pay gas.")).toBeTruthy();
  });

  it("emits the picked account address and drops the warning once chosen", () => {
    const { onChange } = renderTab({ type: "codex" });
    const select = screen.getByLabelText("Codex Account") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "aaaa1111" } });
    expect(onChange.mock.calls[0][0].gasPayer).toEqual({ type: "codex", address: "aaaa1111" });
  });

  it("does not warn once an account address is present", () => {
    renderTab({ type: "codex", address: "aaaa1111" });
    expect(screen.queryByText("Select a codex account to pay gas.")).toBeNull();
  });
});

describe("<GasPayerTab> gas-station signing key picker", () => {
  it("warns to select a signing key while none is chosen", () => {
    renderTab({ type: "gas-station" });
    expect(
      screen.getByText("Select a key to sign the DALOS.GAS_PAYER capability."),
    ).toBeTruthy();
  });

  it("emits the picked signing key on the gas-station payer", () => {
    const { onChange } = renderTab({ type: "gas-station" });
    const select = screen.getByLabelText(
      "Signing Key (DALOS.GAS_PAYER capability)",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "bbbb2222" } });
    expect(onChange.mock.calls[0][0].gasPayer).toEqual({
      type: "gas-station",
      signingKey: "bbbb2222",
    });
  });

  it("does not warn once a signing key is present", () => {
    renderTab({ type: "gas-station", signingKey: "bbbb2222" });
    expect(
      screen.queryByText("Select a key to sign the DALOS.GAS_PAYER capability."),
    ).toBeNull();
  });
});

describe("<GasPayerTab> without a signers source", () => {
  it("still renders the key picker shell when no descriptors are supplied", () => {
    // Omit the `signers` prop entirely — a host that hasn't wired a key store.
    render(<GasPayerTab state={stateWith({ type: "gas-station" })} onChange={vi.fn()} />);
    const select = screen.getByLabelText(
      "Signing Key (DALOS.GAS_PAYER capability)",
    ) as HTMLSelectElement;
    // Shell has only the placeholder option — no descriptor rows to choose from.
    expect(select.querySelectorAll("option[value]:not([value=''])")).toHaveLength(0);
  });
});
