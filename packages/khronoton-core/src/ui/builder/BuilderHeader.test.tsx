// @vitest-environment jsdom
//
// Builder header block suite (Rows A/B/C). Pins the parity contract:
// - Row A: Name + Description controls edit their BuilderState fields.
// - Row B: the Server-resolver <select> is REGISTRY-DRIVEN (REQ-G05) — its
//   options come from `serverResolverOptions`, never a baked-in "stoicism-mint";
//   a selected resolver surfaces that option's note when one is provided.
// - Row C is CREATE-ONLY (REQ-G06): the externally-fireable checkbox + the
//   runtime-arg-keys input appear on create and are ABSENT in edit mode.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { BuilderHeader } from "./BuilderHeader.js";
import { makeEmptyBuilderState, type BuilderState } from "../builder-state.js";
import type { ServerResolverOption } from "../../provider/context.js";

afterEach(() => {
  cleanup();
});

/** A registry entry carrying a note — the genericized replacement for the Hub's baked stoicism-mint. */
const MINT: ServerResolverOption = {
  value: "stoicism-mint",
  label: "Stoicism mint (fills stoicism-values/targets + settles)",
  note: "Fills stoicism-values/targets and settles on success.",
};

function renderHeader(
  overrides: Partial<BuilderState> = {},
  props: { isEdit?: boolean; serverResolverOptions?: ServerResolverOption[] } = {},
) {
  const state = { ...makeEmptyBuilderState(), ...overrides };
  const onChange = vi.fn();
  render(
    <BuilderHeader
      state={state}
      onChange={onChange}
      isEdit={props.isEdit ?? false}
      serverResolverOptions={props.serverResolverOptions}
    />,
  );
  return { state, onChange };
}

describe("BuilderHeader — Row A (name/description)", () => {
  it("edits name into BuilderState, keeping the rest of the state intact", () => {
    const { onChange } = renderHeader({ description: "keep me" });
    fireEvent.change(screen.getByPlaceholderText("Daily payout"), {
      target: { value: "Weekly airdrop" },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as BuilderState;
    expect(next.name).toBe("Weekly airdrop");
    expect(next.description).toBe("keep me");
  });

  it("edits the optional description into BuilderState", () => {
    const { onChange } = renderHeader();
    fireEvent.change(screen.getByPlaceholderText("What this codex cronoton does"), {
      target: { value: "Pays the pool" },
    });
    expect((onChange.mock.calls[0][0] as BuilderState).description).toBe("Pays the pool");
  });
});

describe("BuilderHeader — Row B (registry-driven server resolver)", () => {
  it("renders ONLY the base None option when the registry is empty — no baked stoicism-mint (REQ-G05)", () => {
    renderHeader({}, { serverResolverOptions: [] });
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(["None (ordinary cronoton)"]);
    expect(screen.queryByText(/Stoicism mint/i)).toBeNull();
  });

  it("renders registry options after the base None option", () => {
    renderHeader({}, { serverResolverOptions: [MINT] });
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["", "stoicism-mint"]);
    expect(screen.getByRole("option", { name: MINT.label })).toBeTruthy();
  });

  it("writes the chosen resolver value into BuilderState", () => {
    const { onChange } = renderHeader({}, { serverResolverOptions: [MINT] });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "stoicism-mint" } });
    expect((onChange.mock.calls[0][0] as BuilderState).serverResolver).toBe("stoicism-mint");
  });

  it("clears the resolver back to undefined when None is picked", () => {
    const { onChange } = renderHeader(
      { serverResolver: "stoicism-mint" },
      { serverResolverOptions: [MINT] },
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    expect((onChange.mock.calls[0][0] as BuilderState).serverResolver).toBeUndefined();
  });

  it("shows the selected resolver's note, and hides it when no resolver is chosen", () => {
    renderHeader({ serverResolver: "stoicism-mint" }, { serverResolverOptions: [MINT] });
    expect(screen.getByText(MINT.note as string)).toBeTruthy();
    cleanup();
    renderHeader({ serverResolver: undefined }, { serverResolverOptions: [MINT] });
    expect(screen.queryByText(MINT.note as string)).toBeNull();
  });
});

describe("BuilderHeader — Row C (create-only external-fire + runtime args)", () => {
  const fireableLabel = "Externally fireable (allow the external HMAC trigger endpoint to fire this)";
  const argsPlaceholder = "comma or newline separated, e.g. amount, recipient";
  const argsHelper =
    "env-data keys a trigger supplies at fire time (read via read-string). Declaring any key makes this cronoton trigger-only — the scheduler will not auto-fire it. Leave empty for an ordinary fixed cronoton.";

  it("renders the externally-fireable checkbox (default off) and toggles it into state", () => {
    const { onChange } = renderHeader({}, { isEdit: false });
    const checkbox = screen.getByLabelText(fireableLabel) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect((onChange.mock.calls[0][0] as BuilderState).externalFireable).toBe(true);
  });

  it("renders the runtime-arg-keys input with its verbatim helper and writes edits to state", () => {
    const { onChange } = renderHeader({}, { isEdit: false });
    expect(screen.getByText(argsHelper)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(argsPlaceholder), {
      target: { value: "amount, recipient" },
    });
    expect((onChange.mock.calls[0][0] as BuilderState).runtimeArgKeysText).toBe("amount, recipient");
  });

  it("omits the whole create-only row in edit mode (runtime args + external fire are create-only)", () => {
    renderHeader({}, { isEdit: true });
    expect(screen.queryByLabelText(fireableLabel)).toBeNull();
    expect(screen.queryByPlaceholderText(argsPlaceholder)).toBeNull();
  });
});
