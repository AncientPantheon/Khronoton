// @vitest-environment jsdom
//
// Signatures-tab suite. Opts into jsdom via the top-of-file docblock (the phase
// convention); cleanup is registered explicitly because this repo runs without
// `globals: true`. The tab is a controlled component (`state`/`onChange`), so
// interactions are exercised through a small stateful harness that feeds
// `onChange` back into `state` — that way add/remove/toggle actually re-render
// and the assertions pin the resulting DOM, not a one-shot callback argument.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { useState } from "react";

import type { CodexSignerDescriptor } from "../../handlers/index.js";
import {
  makeEmptyBuilderState,
  type BuilderState,
  type GasPayerState,
} from "../builder-state.js";
import { SignaturesTab } from "./SignaturesTab.js";

afterEach(() => {
  cleanup();
});

function stateWith(overrides: Partial<BuilderState>): BuilderState {
  return { ...makeEmptyBuilderState(), ...overrides };
}

function Harness({
  initial,
  signers,
}: {
  initial: BuilderState;
  signers?: CodexSignerDescriptor[];
}) {
  const [state, setState] = useState(initial);
  return <SignaturesTab state={state} onChange={setState} signers={signers} />;
}

const GAS_STATION: GasPayerState = { type: "gas-station", signingKey: "k:9f3a4dc21b" };
const CODEX: GasPayerState = { type: "codex", address: "k:codex-acct" };

describe("SignaturesTab — locked gas-payer signer (derived from state.gasPayer)", () => {
  it("shows the gas-station capability line `(ouronet-ns.DALOS.GAS_PAYER \"\" 0 0.0)` when the gas payer is the gas station", () => {
    render(<Harness initial={stateWith({ gasPayer: GAS_STATION })} />);
    expect(screen.getByText('(ouronet-ns.DALOS.GAS_PAYER "" 0 0.0)')).toBeTruthy();
    expect(screen.queryByText("coin.GAS")).toBeNull();
  });

  it("shows the codex capability line `coin.GAS` when the gas payer is a codex account", () => {
    render(<Harness initial={stateWith({ gasPayer: CODEX })} />);
    expect(screen.getByText("coin.GAS")).toBeTruthy();
    expect(screen.queryByText('(ouronet-ns.DALOS.GAS_PAYER "" 0 0.0)')).toBeNull();
  });

  it("renders the locked signer's pubkey, amber 'Gas Payer' badge, and the auto-added note so the user knows it is managed", () => {
    render(<Harness initial={stateWith({ gasPayer: GAS_STATION })} />);
    expect(screen.getByText("k:9f3a4dc21b")).toBeTruthy();
    expect(screen.getByText("Gas Payer")).toBeTruthy();
    expect(
      screen.getByText("Auto-added from the gas payer — its capability is managed for you."),
    ).toBeTruthy();
  });

  it("omits the locked signer entirely when the gas payer has no key yet (nothing to lock)", () => {
    render(<Harness initial={stateWith({ gasPayer: { type: "gas-station" } })} />);
    expect(screen.queryByText("Gas Payer")).toBeNull();
    expect(screen.queryByText('(ouronet-ns.DALOS.GAS_PAYER "" 0 0.0)')).toBeNull();
  });
});

describe("SignaturesTab — count + empty state", () => {
  it("shows the empty guidance when there are no signers and the gas payer is unconfigured", () => {
    render(<Harness initial={stateWith({ gasPayer: { type: "gas-station" } })} />);
    expect(
      screen.getByText("No signers added. Select a gas payer or add codex keys below."),
    ).toBeTruthy();
  });

  it("counts the auto gas-payer signer plus manual signers in the title", () => {
    render(
      <Harness
        initial={stateWith({
          gasPayer: GAS_STATION,
          signers: [
            {
              id: "s1",
              publicKey: "k:manual",
              label: "",
              source: "derived",
              capabilityMode: "pure",
              capabilities: "",
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("Signers (2)")).toBeTruthy();
  });

  it("counts only manual signers when the gas payer is unconfigured", () => {
    render(
      <Harness
        initial={stateWith({
          gasPayer: { type: "gas-station" },
          signers: [
            {
              id: "s1",
              publicKey: "k:manual",
              label: "",
              source: "foreign",
              capabilityMode: "pure",
              capabilities: "",
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("Signers (1)")).toBeTruthy();
  });
});

describe("SignaturesTab — add / remove manual signers", () => {
  const descriptors: CodexSignerDescriptor[] = [
    { publicKey: "k:operator", display: "foreign" },
  ];

  it("adds a manual signer from the codex-keys list, promoting the row to 'Added'", () => {
    render(
      <Harness
        initial={stateWith({ gasPayer: { type: "gas-station" } })}
        signers={descriptors}
      />,
    );
    expect(screen.queryByText("Added")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add signer k:operator" }));

    // The manual row now exists (source badge) and the add-list marks it Added.
    expect(screen.getByText("Signers (1)")).toBeTruthy();
    expect(screen.getByText("Added")).toBeTruthy();
  });

  it("removes a manual signer when its remove control is clicked", () => {
    render(
      <Harness
        initial={stateWith({
          gasPayer: { type: "gas-station" },
          signers: [
            {
              id: "s1",
              publicKey: "k:manual",
              label: "",
              source: "derived",
              capabilityMode: "pure",
              capabilities: "",
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("Signers (1)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove signer k:manual" }));

    expect(
      screen.getByText("No signers added. Select a gas payer or add codex keys below."),
    ).toBeTruthy();
  });

  it("marks a descriptor that matches the gas payer as 'Gas Payer' (not addable)", () => {
    render(
      <Harness
        initial={stateWith({ gasPayer: { type: "gas-station", signingKey: "k:operator" } })}
        signers={descriptors}
      />,
    );
    const list = screen.getByTestId("add-signer-list");
    expect(within(list).getByText("Gas Payer")).toBeTruthy();
    expect(
      within(list).queryByRole("button", { name: "Add signer k:operator" }),
    ).toBeNull();
  });
});

describe("SignaturesTab — pure/scoped capability scoping", () => {
  function scopedState(capabilityMode: "pure" | "scoped", capabilities = ""): BuilderState {
    return stateWith({
      gasPayer: { type: "gas-station" },
      signers: [
        {
          id: "s1",
          publicKey: "k:manual",
          label: "",
          source: "derived",
          capabilityMode,
          capabilities,
        },
      ],
    });
  }

  it("hides the capabilities textarea while the signer is pure", () => {
    render(<Harness initial={scopedState("pure")} />);
    expect(screen.queryByPlaceholderText("(coin.GAS)")).toBeNull();
  });

  it("reveals the capabilities textarea after toggling the signer to scoped", () => {
    render(<Harness initial={scopedState("pure")} />);
    fireEvent.click(screen.getByRole("button", { name: "scoped" }));
    const textarea = screen.getByPlaceholderText("(coin.GAS)") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
  });

  it("labels the scoped textarea with the capabilities helper", () => {
    render(<Harness initial={scopedState("scoped")} />);
    expect(
      screen.getByText("Capabilities (one per line, e.g. (coin.GAS))"),
    ).toBeTruthy();
  });

  it("writes edited capability lines back through onChange", () => {
    render(<Harness initial={scopedState("scoped")} />);
    const textarea = screen.getByPlaceholderText("(coin.GAS)") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "(coin.GAS)" } });
    expect((screen.getByPlaceholderText("(coin.GAS)") as HTMLTextAreaElement).value).toBe(
      "(coin.GAS)",
    );
  });
});
