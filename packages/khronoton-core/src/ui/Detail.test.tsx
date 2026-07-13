// @vitest-environment jsdom
//
// `<Detail>` observe-screen suite. Opts into jsdom via the top-of-file docblock
// (the phase convention; the global vitest env stays `node`). Detail ASSEMBLES the
// already-built self-contained pieces — FireHistory, ManualBatchCard,
// RuntimeArgTriggerCard, the badges/pills — over `useCronoton(id)` and the shared
// action hooks + confirm-flows + access predicates. Each test mounts the REAL
// `<KhronotonProvider>` over a fake 16-method adapter whose `get` serves a seeded
// row, so the hook + confirm-gate + card wiring is exercised end to end. The
// pieces' own behaviour is covered by their own suites; here we pin the assembly:
// header/pills/metadata, the per-tier header actions + disable rules, the batch-
// active → Execute-Now block, the confirm→mutate→refresh/navigate flows, the
// mounted cards, and the error state.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

import { KhronotonProvider } from "../provider/KhronotonProvider.js";
import type { KhronotonAdapter } from "../provider/adapter.js";
import type { CodexCronotonRow } from "../server/types.js";
import type { ManualBatchView } from "../server/types.js";
import { KhronotonUiRoot } from "./KhronotonUiRoot.js";
import { Detail } from "./Detail.js";
import type { Access } from "./access.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ADMIN: Access = { tier: "admin", email: "ancient@ancientholdings.eu" };
const PUBLIC: Access = { tier: "logged-out" };

/** A full detail row with sensible defaults; overrides pin the field under test. */
function makeRow(over: Partial<CodexCronotonRow> = {}): CodexCronotonRow {
  return {
    id: "c1",
    name: "Daily treasury sweep",
    description: "Move idle STOA hot to cold nightly",
    pact_code: '(coin.transfer "hot" "cold" 1.0)',
    config_json: "{}",
    payload_json: null,
    gas_payer_json: "{}",
    signers_json: "[]",
    schedule_mode: "daily-at-utc",
    schedule_config_json: JSON.stringify({ mode: "daily-at-utc", hours: [12], minute: 0 }),
    server_resolver: null,
    external_fireable: 0,
    runtime_arg_keys: null,
    status: "active",
    next_fire_at: "2099-01-01T06:00:00.000Z",
    last_fire_at: "2026-07-12T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    modified_at: "2026-01-01T00:00:00.000Z",
    created_by: "ancient@ancientholdings.eu",
    ...over,
  } as CodexCronotonRow;
}

const IDLE_BATCH = { ok: true as const, batch: null };

function activeBatch(): { ok: true; batch: ManualBatchView } {
  return {
    ok: true,
    batch: {
      id: "b1",
      codexCronotonId: "c1",
      total: 10,
      completed: 3,
      remaining: 7,
      intervalSeconds: 60,
      status: "active",
      nextAt: "2099-01-01T06:01:00.000Z",
      createdBy: "ancient@ancientholdings.eu",
      createdAt: "2026-07-12T00:00:00.000Z",
    },
  };
}

/** A fake adapter whose `get` serves the seeded row; mutating methods are spies.
 *  `getBatch`/`fires` default to idle/empty so the mounted cards render quietly. */
function makeAdapter(
  row: CodexCronotonRow,
  over: Partial<Record<string, unknown>> = {},
): KhronotonAdapter {
  const ok = async () => ({ ok: true });
  const base: Record<string, unknown> = {
    list: vi.fn(ok),
    get: vi.fn(async () => ({ ok: true, codexCronoton: row })),
    fires: vi.fn(async () => ({ ok: true, fires: [], total: 0, limit: 50, offset: 0 })),
    signers: vi.fn(ok),
    commit: vi.fn(ok),
    edit: vi.fn(ok),
    pause: vi.fn(async () => ({ ok: true, status: "paused", nextFireAt: null })),
    resume: vi.fn(async () => ({ ok: true, status: "active", nextFireAt: null })),
    delete: vi.fn(async () => ({ ok: true })),
    simulate: vi.fn(ok),
    executeNow: vi.fn(async () => ({ ok: true, fireId: "f1", requestKey: "rk1" })),
    trigger: vi.fn(ok),
    startBatch: vi.fn(ok),
    getBatch: vi.fn(async () => IDLE_BATCH),
    cancelBatch: vi.fn(async () => ({ ok: true, cancelled: true })),
    recover: vi.fn(ok),
  };
  return { ...base, ...over } as unknown as KhronotonAdapter;
}

function spy(adapter: KhronotonAdapter, name: keyof KhronotonAdapter): ReturnType<typeof vi.fn> {
  return adapter[name] as unknown as ReturnType<typeof vi.fn>;
}

function mount(adapter: KhronotonAdapter, access: Access, props: Record<string, unknown> = {}) {
  return render(
    <KhronotonProvider adapter={adapter}>
      <KhronotonUiRoot>
        <Detail id="c1" access={access} {...props} />
      </KhronotonUiRoot>
    </KhronotonProvider>,
  );
}

describe("Detail — header + metadata", () => {
  it("renders the eyebrow, name, both pills, description, schedule summary, status, and created metadata", async () => {
    const adapter = makeAdapter(
      makeRow({ server_resolver: "stoicism-mint", external_fireable: 1 }),
    );
    const { container } = mount(adapter, ADMIN);

    // The pinned header copy frames the observe screen.
    expect(await screen.findByText("Codex cronoton detail")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Daily treasury sweep" })).toBeTruthy();
    expect(screen.getByText("Move idle STOA hot to cold nightly")).toBeTruthy();

    // Both provenance pills render off the row flags (resolver lock + external fire).
    expect(screen.getByText("⟳ Updates server state on success")).toBeTruthy();
    expect(screen.getByText("⚡ externally fireable")).toBeTruthy();

    // Schedule uses the shipped summariser (never re-implemented); status via the badge.
    expect(screen.getByText("Daily at 12:00 UTC")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();

    // Next fire is the self-refreshing <time> pinned to the ISO instant.
    expect(container.querySelector('time[datetime="2099-01-01T06:00:00.000Z"]')).toBeTruthy();
    // Created-by + created-at surface the provenance the Hub showed.
    expect(screen.getByText("2026-01-01T00:00:00.000Z")).toBeTruthy();
  });

  it("shows 'Trigger-only — no schedule' for a runtime-arg (trigger-only) cronoton", async () => {
    const adapter = makeAdapter(
      makeRow({ runtime_arg_keys: JSON.stringify(["amount", "recipient"]) }),
    );
    mount(adapter, ADMIN);

    await screen.findByText("Codex cronoton detail");
    // A trigger-only cronoton never auto-fires ⇒ the schedule cell says so, not a summary.
    expect(screen.getByText("Trigger-only — no schedule")).toBeTruthy();
    expect(screen.queryByText("Daily at 12:00 UTC")).toBeNull();
  });

  it("renders the em-dash placeholder when there is no next/last fire", async () => {
    const adapter = makeAdapter(
      makeRow({ next_fire_at: null, last_fire_at: null, status: "completed" }),
    );
    const { container } = mount(adapter, ADMIN);

    await screen.findByText("Codex cronoton detail");
    // Both the absent next-fire and absent last-fire render the placeholder, not a blank/time.
    const dashes = Array.from(container.querySelectorAll("*")).filter(
      (el) => el.children.length === 0 && el.textContent === "—",
    );
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Detail — back link", () => {
  it("the back link fires onBack", async () => {
    const onBack = vi.fn();
    const adapter = makeAdapter(makeRow());
    mount(adapter, ADMIN, { onBack });

    const back = await screen.findByText("← Codex Cronotons");
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("Detail — header actions per tier", () => {
  it("admin on a live, non-resolver row: Edit links to onEdit(id); Pause/Execute Now/Delete are enabled", async () => {
    const onEdit = vi.fn();
    const adapter = makeAdapter(makeRow());
    mount(adapter, ADMIN, { onEdit });

    await screen.findByText("Codex cronoton detail");
    fireEvent.click(screen.getByText("Edit"));
    expect(onEdit).toHaveBeenCalledWith("c1");

    expect((screen.getByText("Pause") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText("Execute Now") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText("Delete") as HTMLButtonElement).disabled).toBe(false);
  });

  it("logged-out: no action buttons — the header shows 'view only'", async () => {
    const adapter = makeAdapter(makeRow());
    mount(adapter, PUBLIC);

    await screen.findByText("Codex cronoton detail");
    expect(screen.queryByText("Delete")).toBeNull();
    expect(screen.queryByText("Execute Now")).toBeNull();
    expect(screen.getByText("view only")).toBeTruthy();
  });

  it("admin + server-resolver row: Delete is locked with the system-cronoton title", async () => {
    const adapter = makeAdapter(makeRow({ server_resolver: "stoicism-mint" }));
    mount(adapter, ADMIN);

    await screen.findByText("Codex cronoton detail");
    const del = screen.getByText("Delete") as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(del.getAttribute("title")).toBe(
      "System cronoton — cannot be deleted. Pause it to disable instead.",
    );
  });
});

describe("Detail — mounted cards", () => {
  it("admin on a live trigger-only cronoton mounts all three cards", async () => {
    const adapter = makeAdapter(
      makeRow({ runtime_arg_keys: JSON.stringify(["amount"]) }),
    );
    mount(adapter, ADMIN);

    await screen.findByText("Codex cronoton detail");
    // The batch card + the runtime-arg trigger card + the fire history are all present.
    expect(screen.getByText("Execute multiple times")).toBeTruthy();
    expect(screen.getByText("Trigger with runtime args")).toBeTruthy();
    expect(await screen.findByText("Fire history (0)")).toBeTruthy();
  });

  it("logged-out: the admin-only batch + trigger cards are absent, but the fire history still renders", async () => {
    const adapter = makeAdapter(
      makeRow({ runtime_arg_keys: JSON.stringify(["amount"]) }),
    );
    mount(adapter, PUBLIC);

    await screen.findByText("Codex cronoton detail");
    expect(screen.queryByText("Execute multiple times")).toBeNull();
    expect(screen.queryByText("Trigger with runtime args")).toBeNull();
    expect(await screen.findByText("Fire history (0)")).toBeTruthy();
  });
});

describe("Detail — Execute Now blocked by a running batch", () => {
  it("an active batch reports through onExecuteBlockedChange → Execute Now disables with the batch-active title", async () => {
    const adapter = makeAdapter(makeRow(), { getBatch: vi.fn(async () => activeBatch()) });
    mount(adapter, ADMIN);

    await screen.findByText("Codex cronoton detail");
    // The batch card's active state flows up and blocks the header Execute Now.
    await waitFor(() => {
      const ex = screen.getByText("Execute Now") as HTMLButtonElement;
      expect(ex.disabled).toBe(true);
    });
    expect((screen.getByText("Execute Now") as HTMLButtonElement).getAttribute("title")).toBe(
      "A batch is running — wait for it to finish or cancel it",
    );
  });
});

describe("Detail — confirm → mutate → refresh/navigate", () => {
  it("delete: double native-confirm → the gated delete → onNavigateToList (never a self-refetch 404)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onNavigateToList = vi.fn();
    const adapter = makeAdapter(makeRow());
    mount(adapter, ADMIN, { onNavigateToList });

    await screen.findByText("Codex cronoton detail");
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(spy(adapter, "delete")).toHaveBeenCalledWith("c1", { confirmed: true }));
    // Both native confirms fired with the verbatim strings, in order.
    expect(confirmSpy).toHaveBeenCalledWith(
      'Delete codex cronoton "Daily treasury sweep"? Fire history is removed too.',
    );
    expect(confirmSpy).toHaveBeenCalledWith(
      'Confirm to delete codex cronoton "Daily treasury sweep".',
    );
    // A successful delete navigates back to the list rather than re-reading the dead row.
    await waitFor(() => expect(onNavigateToList).toHaveBeenCalledTimes(1));
  });

  it("execute now: confirms with the detail-execute wording, then fires the gated executeNow", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const adapter = makeAdapter(makeRow());
    mount(adapter, ADMIN);

    await screen.findByText("Codex cronoton detail");
    fireEvent.click(screen.getByText("Execute Now"));

    await waitFor(() =>
      expect(spy(adapter, "executeNow")).toHaveBeenCalledWith("c1", { confirmed: true }),
    );
    expect(confirmSpy).toHaveBeenCalledWith(
      'Confirm to fire "Daily treasury sweep" now, outside its schedule.',
    );
  });

  it("execute now is disabled with the terminal title on a spent (completed) cronoton", async () => {
    const adapter = makeAdapter(makeRow({ status: "completed" }));
    mount(adapter, ADMIN);

    await screen.findByText("Codex cronoton detail");
    const btn = screen.getByText("Execute Now").closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("title")).toBe("Terminal cronotons cannot be executed");
  });

  it("delete failure surfaces exactly one alert — the nested confirms must not double-alert the same failure", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const del = vi.fn(async () => {
      throw new Error("delete blocked");
    });
    const adapter = makeAdapter(makeRow(), { delete: del });
    mount(adapter, ADMIN);

    await screen.findByText("Codex cronoton detail");
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    expect(alertSpy).toHaveBeenCalledWith("delete blocked");
  });

  it("execute now failure surfaces the error inline and does NOT refetch (the fire tier never throws to the confirm layer)", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    // A transport throw: the hook swallows it into `.error` and resolves undefined.
    const executeNow = vi.fn(async () => {
      throw new Error("network down");
    });
    const adapter = makeAdapter(makeRow(), { executeNow });
    mount(adapter, ADMIN);

    await screen.findByText("Codex cronoton detail");
    const getsBefore = spy(adapter, "get").mock.calls.length;
    fireEvent.click(screen.getByText("Execute Now"));

    // The failure is surfaced inline (not silent) …
    await waitFor(() =>
      expect(screen.getByTestId("execute-status").textContent).toContain("network down"),
    );
    // … and no spurious refetch fired, since nothing was recorded on-chain.
    expect(spy(adapter, "get").mock.calls.length).toBe(getsBefore);
  });

  it("pause: confirms then routes through the pause action and re-reads the row", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const adapter = makeAdapter(makeRow({ status: "active" }));
    mount(adapter, ADMIN);

    await screen.findByText("Codex cronoton detail");
    fireEvent.click(screen.getByText("Pause"));

    await waitFor(() => expect(spy(adapter, "pause")).toHaveBeenCalledWith("c1", { confirmed: true }));
    // The SSR-style refresh re-reads the row after the mutation (initial load + refetch).
    await waitFor(() => expect(spy(adapter, "get").mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

describe("Detail — error state", () => {
  it("renders the error message when the row cannot be read", async () => {
    const adapter = makeAdapter(makeRow(), {
      get: vi.fn(async () => {
        throw new Error("codex cronoton not found");
      }),
    });
    mount(adapter, ADMIN);

    expect(await screen.findByText(/codex cronoton not found/)).toBeTruthy();
  });
});
