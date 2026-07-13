// @vitest-environment jsdom
//
// Manual-batch card suite. Opts into jsdom via the top-of-file docblock (the
// convention every `*.test.tsx` in this phase copies); the global vitest env
// stays `node` for the engine/handler suites. @testing-library/react's cleanup
// is registered explicitly because this repo runs without `globals: true`.
//
// The card is the observe-screen "Execute multiple times" surface: idle it
// starts a 2–60 once-per-minute batch (whole-number validation + the verbatim
// start confirm), active it shows progress + the next-fire ETA + a confirm-free
// (native-confirm-only) cancel. It is suppressed entirely for a non-admin or a
// terminal cronoton. These tests pin the validation message, the exact confirm
// strings, the adapter wiring, and the idle↔active rendering.

import { describe, it, expect, afterEach, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

import { KhronotonProvider } from "../provider/KhronotonProvider.js";
import type { KhronotonAdapter } from "../provider/adapter.js";
import type { ManualBatchView } from "../server/index.js";
import { ManualBatchCard, parseBatchCount, BATCH_COUNT_ALERT } from "./ManualBatchCard.js";
import type { Access } from "./access.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ADMIN: Access = { tier: "admin", email: "ancient@ancientholdings.eu" };

function activeBatch(overrides: Partial<ManualBatchView> = {}): ManualBatchView {
  return {
    id: "batch_1",
    codexCronotonId: "cron_a1",
    total: 10,
    completed: 3,
    remaining: 7,
    intervalSeconds: 60,
    status: "active",
    nextAt: new Date(Date.now() + 44 * 1000).toISOString(),
    createdBy: "ancient@ancientholdings.eu",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * A complete 16-method fake adapter whose batch methods are overridable. The
 * read/lifecycle methods are inert mocks (never exercised here) so `assertAdapter`
 * passes at mount; the caller replaces just the batch method under test. `getBatch`
 * defaults to the idle projection (`batch:null`) so the card starts in idle mode.
 */
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
    getBatch: vi.fn(async () => ({ ok: true, batch: null })),
    cancelBatch: inert(),
    recover: inert(),
    ...overrides,
  } as unknown as KhronotonAdapter;
}

function mount(adapter: KhronotonAdapter, props: Partial<Parameters<typeof ManualBatchCard>[0]> = {}) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <KhronotonProvider adapter={adapter} onNeedConfirm={async () => true}>
        {children}
      </KhronotonProvider>
    );
  }
  return render(
    <ManualBatchCard id="cron_a1" name="Daily" access={ADMIN} terminal={false} {...props} />,
    { wrapper: Wrapper },
  );
}

describe("parseBatchCount — whole 2–60 gate", () => {
  it("accepts the inclusive bounds and rejects out-of-range / non-whole / junk", () => {
    // Drives the validation from the input: only a whole integer in [2,60] passes,
    // so a batch never starts with 1 fire, 61 fires, a fraction, or garbage.
    expect(parseBatchCount("2")).toBe(2);
    expect(parseBatchCount("60")).toBe(60);
    expect(parseBatchCount("10")).toBe(10);
    expect(parseBatchCount("1")).toBeNull();
    expect(parseBatchCount("61")).toBeNull();
    expect(parseBatchCount("2.5")).toBeNull();
    expect(parseBatchCount("-3")).toBeNull();
    expect(parseBatchCount("")).toBeNull();
    expect(parseBatchCount("abc")).toBeNull();
  });
});

describe("ManualBatchCard — visibility gate", () => {
  it("renders nothing for a non-admin viewer (mutation surface is admin-only)", () => {
    const adapter = makeAdapter();
    const { container } = mount(adapter, { access: { tier: "non-admin" } });
    expect(container.textContent).not.toContain("Execute multiple times");
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders nothing for a terminal cronoton (a spent job cannot be batch-fired)", () => {
    const adapter = makeAdapter();
    const { container } = mount(adapter, { terminal: true });
    expect(container.textContent).not.toContain("Execute multiple times");
  });
});

describe("ManualBatchCard — idle → start", () => {
  it("renders the idle copy: Fire + number input (min2 max60 default10) + Execute ×10", () => {
    const adapter = makeAdapter();
    mount(adapter);
    expect(screen.getByText("Execute multiple times")).toBeTruthy();
    expect(screen.getByText(/times, once per minute \(2–60\)\./)).toBeTruthy();
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("10");
    expect(input.min).toBe("2");
    expect(input.max).toBe("60");
    expect(screen.getByRole("button", { name: /Execute ×10/ })).toBeTruthy();
  });

  it("alerts the verbatim 2–60 message and does NOT start when the count is out of range", () => {
    const startBatch = vi.fn(async () => ({ ok: true as const, batch: activeBatch() }));
    const adapter = makeAdapter({ startBatch });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mount(adapter);

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /Execute ×/ }));

    expect(alertSpy).toHaveBeenCalledWith(BATCH_COUNT_ALERT);
    expect(alertSpy).toHaveBeenCalledWith("Enter a whole number between 2 and 60.");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(startBatch).not.toHaveBeenCalled();
  });

  it("confirms with the verbatim batch-start string and starts the batch for a valid count", async () => {
    const startBatch = vi.fn(async () => ({ ok: true as const, batch: activeBatch({ total: 5 }) }));
    const adapter = makeAdapter({ startBatch });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mount(adapter);

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /Execute ×5/ }));

    expect(confirmSpy).toHaveBeenCalledWith(
      'Confirm to execute "Daily" 5 times, once per minute (server-side, signed by the hub codex).',
    );
    await waitFor(() => expect(startBatch).toHaveBeenCalledWith("cron_a1", 5, expect.anything()));
  });

  it("does not start when the confirm is declined", async () => {
    const startBatch = vi.fn(async () => ({ ok: true as const, batch: activeBatch() }));
    const adapter = makeAdapter({ startBatch });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    mount(adapter);

    fireEvent.click(screen.getByRole("button", { name: /Execute ×/ }));
    await Promise.resolve();
    expect(startBatch).not.toHaveBeenCalled();
  });
});

describe("ManualBatchCard — active state + cancel", () => {
  it("shows progress, the next-fire ETA, the safe-to-close note, and a Cancel batch control", async () => {
    const adapter = makeAdapter({
      getBatch: vi.fn(async () => ({ ok: true as const, batch: activeBatch({ completed: 3, total: 10 }) })),
    });
    mount(adapter);

    await waitFor(() => expect(screen.getByText(/Batch running: 3\/10 fired/)).toBeTruthy());
    expect(screen.getByText(/next/)).toBeTruthy();
    expect(
      screen.getByText(
        /One fire per minute · Execute Now is blocked until the batch finishes\. Runs server-side — safe to close this tab\./,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Cancel batch/ })).toBeTruthy();
  });

  it("cancels via the native confirm with the verbatim cancel string, then re-reads the batch", async () => {
    const cancelBatch = vi.fn(async () => ({ ok: true as const, cancelled: true }));
    const getBatch = vi.fn(async () => ({ ok: true as const, batch: activeBatch() }));
    const adapter = makeAdapter({ getBatch, cancelBatch });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mount(adapter);

    await waitFor(() => screen.getByRole("button", { name: /Cancel batch/ }));
    fireEvent.click(screen.getByRole("button", { name: /Cancel batch/ }));

    expect(confirmSpy).toHaveBeenCalledWith(
      "Cancel the running batch? Fires already done remain; no further fires happen.",
    );
    await waitFor(() => expect(cancelBatch).toHaveBeenCalledWith("cron_a1"));
  });

  it("reports the active state through onExecuteBlockedChange so the Detail can block Execute Now", async () => {
    const onExecuteBlockedChange = vi.fn();
    const adapter = makeAdapter({
      getBatch: vi.fn(async () => ({ ok: true as const, batch: activeBatch() })),
    });
    mount(adapter, { onExecuteBlockedChange });

    await waitFor(() =>
      expect(onExecuteBlockedChange.mock.calls.some(([active]) => active === true)).toBe(true),
    );
  });
});
