// @vitest-environment jsdom
//
// PayloadTab suite. Opts into jsdom via the top-of-file docblock. The tab is a
// controlled view over `BuilderState.payload`: every edit must call `onChange`
// with the NEXT payload object, and the typed↔raw toggle must flip
// `payload.rawMode`. The adaptive Value control is driven by the row `type`, and
// the amber banner surfaces the undefined-keyset reference `validatePayload`
// reports. Assertions drive expectations from the emitted payload patch, not
// from constants, so they fail if the wiring drifts.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { KhronotonUiRoot } from "../KhronotonUiRoot.js";
import { makeEmptyBuilderState } from "../builder-state.js";
import type { BuilderState, PayloadState } from "../builder-state.js";
import { PayloadTab } from "./PayloadTab.js";

afterEach(() => {
  cleanup();
});

function stateWith(payload: Partial<PayloadState>, rest: Partial<BuilderState> = {}): BuilderState {
  const base = makeEmptyBuilderState();
  return { ...base, ...rest, payload: { ...base.payload, ...payload } };
}

function renderTab(state: BuilderState, onChange = vi.fn()) {
  render(
    <KhronotonUiRoot>
      <PayloadTab state={state} onChange={onChange} />
    </KhronotonUiRoot>,
  );
  return { onChange };
}

describe("PayloadTab", () => {
  it("renders the 'Payload (env-data)' section header", () => {
    renderTab(stateWith({}));
    expect(screen.getByText("Payload (env-data)")).toBeTruthy();
  });

  it("flips payload.rawMode true when the 'Switch to raw JSON' toggle is clicked", () => {
    const { onChange } = renderTab(stateWith({ rawMode: false }));
    fireEvent.click(screen.getByRole("button", { name: "Switch to raw JSON" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ rawMode: true }));
  });

  it("flips payload.rawMode false when the 'Switch to typed' toggle is clicked in raw mode", () => {
    const { onChange } = renderTab(stateWith({ rawMode: true }));
    fireEvent.click(screen.getByRole("button", { name: "Switch to typed" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ rawMode: false }));
  });

  it("shows the raw JSON textarea (default '{}') and emits edits to payload.rawJson in raw mode", () => {
    const { onChange } = renderTab(stateWith({ rawMode: true, rawJson: "{}" }));
    const textarea = screen.getByLabelText("Raw payload JSON (object)") as HTMLTextAreaElement;
    expect(textarea.value).toBe("{}");
    fireEvent.change(textarea, { target: { value: '{ "amount": 1.0 }' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ rawJson: '{ "amount": 1.0 }' }),
    );
  });

  it("does not render typed rows/keysets while in raw mode", () => {
    renderTab(stateWith({ rawMode: true }));
    expect(screen.queryByRole("button", { name: "+ Add data entry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Add keyset" })).toBeNull();
  });

  it("appends a fresh env-data row when '+ Add data entry' is clicked", () => {
    const { onChange } = renderTab(stateWith({ entries: [] }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add data entry" }));
    const next = onChange.mock.calls[0][0] as PayloadState;
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]).toMatchObject({ key: "", type: "string" });
  });

  it("emits the edited key for an env-data row", () => {
    const { onChange } = renderTab(
      stateWith({ entries: [{ key: "", type: "string", value: "" }] }),
    );
    fireEvent.change(screen.getByLabelText("Data entry key"), { target: { value: "amount" } });
    const next = onChange.mock.calls[0][0] as PayloadState;
    expect(next.entries[0].key).toBe("amount");
  });

  it("changes the row type and emits it so the Value control can adapt", () => {
    const { onChange } = renderTab(
      stateWith({ entries: [{ key: "flag", type: "string", value: "" }] }),
    );
    fireEvent.change(screen.getByLabelText("Data entry type"), { target: { value: "boolean" } });
    const next = onChange.mock.calls[0][0] as PayloadState;
    expect(next.entries[0].type).toBe("boolean");
  });

  it("renders a checkbox Value control for a boolean row and emits 'true' when checked", () => {
    const { onChange } = renderTab(
      stateWith({ entries: [{ key: "flag", type: "boolean", value: "false" }] }),
    );
    const box = screen.getByLabelText("Data entry value") as HTMLInputElement;
    expect(box.type).toBe("checkbox");
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    const next = onChange.mock.calls[0][0] as PayloadState;
    expect(next.entries[0].value).toBe("true");
  });

  it("renders a textarea Value control for a json row", () => {
    renderTab(stateWith({ entries: [{ key: "meta", type: "json", value: "{}" }] }));
    const control = screen.getByLabelText("Data entry value");
    expect(control.tagName).toBe("TEXTAREA");
  });

  it("renders a numeric input Value control for a number row", () => {
    renderTab(stateWith({ entries: [{ key: "amt", type: "number", value: "1" }] }));
    const control = screen.getByLabelText("Data entry value") as HTMLInputElement;
    expect(control.tagName).toBe("INPUT");
    expect(control.type).toBe("number");
  });

  it("removes an env-data row when its Remove control is clicked", () => {
    const { onChange } = renderTab(
      stateWith({
        entries: [
          { key: "a", type: "string", value: "" },
          { key: "b", type: "string", value: "" },
        ],
      }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    const next = onChange.mock.calls[0][0] as PayloadState;
    expect(next.entries.map((e) => e.key)).toEqual(["b"]);
  });

  it("appends a fresh keyset card when '+ Add keyset' is clicked", () => {
    const { onChange } = renderTab(stateWith({ keysets: [] }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add keyset" }));
    const next = onChange.mock.calls[0][0] as PayloadState;
    expect(next.keysets).toHaveLength(1);
    expect(next.keysets[0]).toMatchObject({ name: "", predicate: "keys-all" });
  });

  it("emits the chosen predicate for a keyset card", () => {
    const { onChange } = renderTab(
      stateWith({ keysets: [{ name: "ks", predicate: "keys-all", keysText: "" }] }),
    );
    fireEvent.change(screen.getByLabelText("Keyset predicate"), { target: { value: "keys-any" } });
    const next = onChange.mock.calls[0][0] as PayloadState;
    expect(next.keysets[0].predicate).toBe("keys-any");
  });

  it("emits the edited keys text for a keyset card", () => {
    const { onChange } = renderTab(
      stateWith({ keysets: [{ name: "ks", predicate: "keys-all", keysText: "" }] }),
    );
    fireEvent.change(screen.getByLabelText("Keys (one 64-hex public key per line)"), {
      target: { value: "abc\ndef" },
    });
    const next = onChange.mock.calls[0][0] as PayloadState;
    expect(next.keysets[0].keysText).toBe("abc\ndef");
  });

  it("removes a keyset card when its Remove control is clicked", () => {
    const { onChange } = renderTab(
      stateWith({
        keysets: [
          { name: "ks1", predicate: "keys-all", keysText: "" },
          { name: "ks2", predicate: "keys-all", keysText: "" },
        ],
      }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    const next = onChange.mock.calls[0][0] as PayloadState;
    expect(next.keysets.map((k) => k.name)).toEqual(["ks2"]);
  });

  it("shows the amber banner naming a keyset the Pact code references but the payload omits", () => {
    renderTab(stateWith({ entries: [], keysets: [] }, { pactCode: '(read-keyset "admin-ks")' }));
    expect(
      screen.getByText(
        'Pact code references keyset "admin-ks" which is not defined in the payload.',
      ),
    ).toBeTruthy();
  });

  it("omits the warning banner when every referenced keyset is defined in the payload", () => {
    renderTab(
      stateWith(
        { keysets: [{ name: "admin-ks", predicate: "keys-all", keysText: "abc" }] },
        { pactCode: '(read-keyset "admin-ks")' },
      ),
    );
    expect(screen.queryByText(/which is not defined in the payload/)).toBeNull();
  });
});
