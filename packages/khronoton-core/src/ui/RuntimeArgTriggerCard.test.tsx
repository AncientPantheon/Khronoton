// @vitest-environment jsdom
//
// Runtime-arg trigger-card suite. Opts into jsdom via the top-of-file docblock
// (the convention every `*.test.tsx` in this phase copies); the global vitest env
// stays `node` for the engine/handler suites. @testing-library/react's cleanup is
// registered explicitly because this repo runs without `globals: true`.
//
// The card is the "Trigger with runtime args" surface: it renders only for an
// admin viewing a live (non-terminal) cronoton that declares runtime-arg keys,
// exposes one text input per key, and fires `useTrigger().run(id, args)` behind
// the native confirm — surfacing the fire's requestKey (or its error) inline and
// signalling the Detail to refetch its fire history. The suite mounts a real
// provider over a fake adapter so the hook + confirm-gate wiring is exercised end
// to end, and pins: the per-key inputs, the args passed to `trigger`, the ok
// result line, the status-gated disable + title, and the two hidden tiers
// (no keys / non-admin).

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

import { KhronotonProvider } from "../provider/KhronotonProvider.js";
import type { KhronotonAdapter } from "../provider/adapter.js";
import { RuntimeArgTriggerCard } from "./RuntimeArgTriggerCard.js";
import type { Access } from "./access.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A complete 16-method fake adapter whose `trigger` is overridable. The rest are
 *  inert mocks so `assertAdapter` passes at mount and calls stay observable. */
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

const ADMIN: Access = { tier: "admin", email: "ancient@holdings.test" };

function mount(adapter: KhronotonAdapter, props: Partial<Parameters<typeof RuntimeArgTriggerCard>[0]> = {}) {
  return render(
    <KhronotonProvider adapter={adapter}>
      <RuntimeArgTriggerCard
        id="cr_1"
        name="Daily payout"
        status="active"
        runtimeArgKeys={["amount", "recipient"]}
        access={ADMIN}
        terminal={false}
        {...props}
      />
    </KhronotonProvider>,
  );
}

describe("RuntimeArgTriggerCard — rendering", () => {
  it("renders the header and one text input per declared key with the 'value for {key}' placeholder", () => {
    mount(makeAdapter());

    expect(screen.getByText("Trigger with runtime args")).toBeTruthy();
    // Each declared key gets its own labelled input keyed by the argument name.
    const amount = screen.getByPlaceholderText("value for amount") as HTMLInputElement;
    const recipient = screen.getByPlaceholderText("value for recipient") as HTMLInputElement;
    expect(amount.tagName).toBe("INPUT");
    expect(recipient.tagName).toBe("INPUT");
    // The key itself is shown as the field label so the operator knows what to fill.
    expect(screen.getByText("amount")).toBeTruthy();
    expect(screen.getByText("recipient")).toBeTruthy();
  });
});

describe("RuntimeArgTriggerCard — firing", () => {
  it("passes the per-key input values to trigger.run(id, args) and shows the ok result line with the requestKey", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const trigger = vi.fn(async (_id: string, _args: Record<string, string>) => ({
      ok: true as const,
      fireId: "fire_1",
      requestKey: "rk_abcdef",
    }));
    const onFired = vi.fn();
    const adapter = makeAdapter({ trigger: trigger as unknown as KhronotonAdapter["trigger"] });
    mount(adapter, { onFired });

    fireEvent.change(screen.getByPlaceholderText("value for amount"), { target: { value: "42" } });
    fireEvent.change(screen.getByPlaceholderText("value for recipient"), { target: { value: "k:alice" } });
    fireEvent.click(screen.getByRole("button", { name: "Trigger" }));

    await waitFor(() => expect(trigger).toHaveBeenCalledTimes(1));
    // The exact typed values ride through to the adapter as the runtime-args map.
    expect(trigger.mock.calls[0][0]).toBe("cr_1");
    expect(trigger.mock.calls[0][1]).toEqual({ amount: "42", recipient: "k:alice" });

    // On a successful fire the card shows the requestKey and asks the Detail to refetch.
    await waitFor(() => expect(screen.getByText(/Fired · requestKey rk_abcdef/)).toBeTruthy());
    expect(onFired).toHaveBeenCalledTimes(1);
  });

  it("shows the fire's error (not a green line, no refetch) when the recorded fire failed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const trigger = vi.fn(async () => ({ ok: false as const, error: "insufficient balance" }));
    const onFired = vi.fn();
    const adapter = makeAdapter({ trigger: trigger as unknown as KhronotonAdapter["trigger"] });
    mount(adapter, { onFired });

    fireEvent.change(screen.getByPlaceholderText("value for amount"), { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Trigger" }));

    await waitFor(() => expect(screen.getByText(/insufficient balance/)).toBeTruthy());
    expect(screen.queryByText(/Fired ·/)).toBeNull();
    // A recorded failure did not fire — no history refetch is requested.
    expect(onFired).not.toHaveBeenCalled();
  });

  it("does not call trigger when the operator declines the native confirm", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const trigger = vi.fn(async () => ({ ok: true as const, requestKey: "rk_x" }));
    const adapter = makeAdapter({ trigger: trigger as unknown as KhronotonAdapter["trigger"] });
    mount(adapter);

    fireEvent.click(screen.getByRole("button", { name: "Trigger" }));
    await Promise.resolve();
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe("RuntimeArgTriggerCard — disable rules", () => {
  it("disables the Trigger button and titles it with the resume hint when the cronoton is not active", () => {
    mount(makeAdapter(), { status: "paused" });

    const button = screen.getByRole("button", { name: "Trigger" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Resume before triggering (status: paused)");
  });
});

describe("RuntimeArgTriggerCard — hidden tiers", () => {
  it("renders nothing when the cronoton declares no runtime-arg keys", () => {
    const { container } = mount(makeAdapter(), { runtimeArgKeys: [] });
    expect(container.textContent).toBe("");
  });

  it("renders nothing for a non-admin viewer (the card is an admin-only control)", () => {
    const { container } = mount(makeAdapter(), { access: { tier: "non-admin" } });
    expect(container.textContent).toBe("");
  });

  it("renders nothing for a terminal cronoton (a spent one-time job cannot be triggered)", () => {
    const { container } = mount(makeAdapter(), { terminal: true, status: "completed" });
    expect(container.textContent).toBe("");
  });
});
