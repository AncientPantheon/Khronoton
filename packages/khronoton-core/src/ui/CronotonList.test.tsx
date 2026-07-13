// @vitest-environment jsdom
//
// `<CronotonList>` screen suite. Opts into jsdom via the top-of-file docblock (the
// convention every `*.test.tsx` in this phase copies). The screen reads the REAL
// provider context + data/action hooks, so each test mounts it under the real
// `<KhronotonProvider>` with a fake 16-method adapter whose `list` returns seeded
// full `CodexCronotonRow`s — giving precise control over the resolver lock, the
// runtime-arg (trigger-only) flag, statuses, and the last-fire status the built-in
// store projection does not carry. Native `window.confirm`/`alert` are spied.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

import { KhronotonProvider } from "../provider/KhronotonProvider.js";
import type { KhronotonAdapter } from "../provider/adapter.js";
import type { CodexCronotonRow } from "../server/types.js";
import type { FireStatus } from "./badges.js";
import { KhronotonUiRoot } from "./KhronotonUiRoot.js";
import { CronotonList } from "./CronotonList.js";
import type { Access } from "./access.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ADMIN: Access = { tier: "admin", email: "ancient@ancientholdings.eu" };
const NON_ADMIN: Access = { tier: "non-admin", email: "member@ancientholdings.eu" };
const PUBLIC: Access = { tier: "logged-out" };

/** A full list row with sensible defaults; overrides pin the field under test. */
function makeRow(
  over: Partial<CodexCronotonRow> & { last_fire_status?: FireStatus | null } = {},
): CodexCronotonRow {
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
    last_fire_status: "success",
    ...over,
  } as CodexCronotonRow;
}

/** A fake adapter whose `list` serves the seeded rows; mutating methods are spies. */
function makeAdapter(rows: CodexCronotonRow[], over: Partial<Record<string, unknown>> = {}): KhronotonAdapter {
  const ok = async () => ({ ok: true });
  const base: Record<string, unknown> = {
    list: vi.fn(async () => ({ ok: true, codexCronotons: rows })),
    get: vi.fn(ok),
    fires: vi.fn(ok),
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
    getBatch: vi.fn(ok),
    cancelBatch: vi.fn(ok),
    recover: vi.fn(ok),
  };
  return { ...base, ...over } as unknown as KhronotonAdapter;
}

function mountList(adapter: KhronotonAdapter, access: Access, props: Record<string, unknown> = {}) {
  return render(
    <KhronotonProvider adapter={adapter}>
      <KhronotonUiRoot>
        <CronotonList access={access} {...props} />
      </KhronotonUiRoot>
    </KhronotonProvider>,
  );
}

/** The spied mutating method, typed for `.mock` access. */
function spy(adapter: KhronotonAdapter, name: keyof KhronotonAdapter): ReturnType<typeof vi.fn> {
  return adapter[name] as unknown as ReturnType<typeof vi.fn>;
}

describe("CronotonList — columns", () => {
  it("renders the header + every column for a seeded row (name/desc/resolver pill/schedule/last-fire badge/status)", async () => {
    const adapter = makeAdapter([makeRow({ server_resolver: "stoicism-mint" })]);
    const { container } = mountList(adapter, ADMIN);

    // The pinned header copy (eyebrow + H1) frames the list.
    expect(screen.getByText("Codex-signed scheduled transactions")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Codex Cronotons" })).toBeTruthy();

    // Name + description + the server-resolver pill (row has a resolver set).
    await screen.findByText("Daily treasury sweep");
    expect(screen.getByText("Move idle STOA hot to cold nightly")).toBeTruthy();
    expect(screen.getByText("⟳ Updates server state on success")).toBeTruthy();

    // Operation = pact preview; Schedule = the shipped summariser (not re-implemented).
    expect(screen.getByText('(coin.transfer "hot" "cold" 1.0)')).toBeTruthy();
    expect(screen.getByText("Daily at 12:00 UTC")).toBeTruthy();

    // Next fire renders a self-refreshing <time> pinned to the ISO instant.
    expect(container.querySelector('time[datetime="2099-01-01T06:00:00.000Z"]')).toBeTruthy();

    // Last fire = the ok/fail fire badge; Status = the cronoton status badge.
    expect(screen.getByText("success")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
  });

  it("shows 'External trigger' for a trigger-only row and '(empty)' for empty pact code", async () => {
    const adapter = makeAdapter([
      makeRow({ pact_code: "   ", runtime_arg_keys: JSON.stringify(["amount", "recipient"]) }),
    ]);
    mountList(adapter, ADMIN);

    await screen.findByText("Daily treasury sweep");
    // runtime_arg_keys non-empty ⇒ the scheduler never auto-fires ⇒ "External trigger".
    expect(screen.getByText("External trigger")).toBeTruthy();
    // Whitespace-only pact code collapses to the "(empty)" placeholder, not a blank cell.
    expect(screen.getByText("(empty)")).toBeTruthy();
  });

  it("renders '—' for a row with no next fire and no last-fire status", async () => {
    const adapter = makeAdapter([
      makeRow({ next_fire_at: null, last_fire_at: null, last_fire_status: null, status: "completed" }),
    ]);
    const { container } = mountList(adapter, ADMIN);

    await screen.findByText("Daily treasury sweep");
    // Two em-dash placeholders: the absent next-fire and the absent last-fire badge.
    const dashes = Array.from(container.querySelectorAll("td")).filter((td) => td.textContent === "—");
    expect(dashes.length).toBe(2);
  });
});

describe("CronotonList — three access tiers", () => {
  it("admin: '+ New' is an enabled link (fires onNew) and the row actions are enabled", async () => {
    const onNew = vi.fn();
    const adapter = makeAdapter([makeRow()]);
    mountList(adapter, ADMIN, { onNew });

    await screen.findByText("Daily treasury sweep");
    const add = screen.getByText("+ New Codex Cronoton");
    expect(add.tagName).toBe("A");
    fireEvent.click(add);
    expect(onNew).toHaveBeenCalledTimes(1);

    // An active, non-resolver row: every mutating control is enabled for an admin.
    expect((screen.getByText("Pause") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText("Execute Now") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText("Delete") as HTMLButtonElement).disabled).toBe(false);
  });

  it("non-admin: '+ New' and every row action are disabled with the 'Ancient admins only' title", async () => {
    const adapter = makeAdapter([makeRow()]);
    mountList(adapter, NON_ADMIN);

    await screen.findByText("Daily treasury sweep");
    const add = screen.getByText("+ New Codex Cronoton") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.getAttribute("title")).toBe("Ancient admins only");

    for (const label of ["Edit", "Pause", "Execute Now", "Delete"]) {
      const btn = screen.getByText(label) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute("title")).toBe("Ancient admins only");
    }
  });

  it("logged-out: no '+ New', actions read 'view only', and the public footer shows", async () => {
    const adapter = makeAdapter([makeRow()]);
    mountList(adapter, PUBLIC);

    await screen.findByText("Daily treasury sweep");
    expect(screen.queryByText("+ New Codex Cronoton")).toBeNull();
    expect(screen.queryByText("Delete")).toBeNull();
    expect(screen.getByText("view only")).toBeTruthy();
    expect(
      screen.getByText("Public view — read only. Sign in as an Ancient admin to manage."),
    ).toBeTruthy();
  });
});

describe("CronotonList — delete-lock precedence", () => {
  it("admin + server-resolver row: Delete is disabled with the system-cronoton title (announces before the tier)", async () => {
    const adapter = makeAdapter([makeRow({ server_resolver: "stoicism-mint" })]);
    mountList(adapter, ADMIN);

    await screen.findByText("Daily treasury sweep");
    const del = screen.getByText("Delete") as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(del.getAttribute("title")).toBe(
      "System cronoton — cannot be deleted. Pause it to disable instead.",
    );
  });
});

describe("CronotonList — confirm flows + refetch", () => {
  it("delete: double native-confirm then the gated action, then an SSR-style refetch", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const adapter = makeAdapter([makeRow({ name: "Daily treasury sweep" })]);
    mountList(adapter, ADMIN);

    await screen.findByText("Daily treasury sweep");
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(spy(adapter, "delete")).toHaveBeenCalled());
    // Both native confirms fired, in order, with the verbatim strings.
    expect(confirmSpy).toHaveBeenCalledWith(
      'Delete codex cronoton "Daily treasury sweep"? Fire history is removed too.',
    );
    expect(confirmSpy).toHaveBeenCalledWith(
      'Confirm to delete codex cronoton "Daily treasury sweep".',
    );
    // The gated delete carried the fresh-confirm signal to the adapter.
    expect(spy(adapter, "delete")).toHaveBeenCalledWith("c1", { confirmed: true });
    // Success triggers the SSR-style refetch: the list is re-read (initial load + refetch).
    await waitFor(() => expect(spy(adapter, "list").mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("delete: declining the first native confirm skips the action entirely", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const adapter = makeAdapter([makeRow()]);
    mountList(adapter, ADMIN);

    await screen.findByText("Daily treasury sweep");
    fireEvent.click(screen.getByText("Delete"));

    await Promise.resolve();
    expect(spy(adapter, "delete")).not.toHaveBeenCalled();
  });

  it("pause: confirms then routes through the action hook and refetches", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const adapter = makeAdapter([makeRow({ status: "active" })]);
    mountList(adapter, ADMIN);

    await screen.findByText("Daily treasury sweep");
    fireEvent.click(screen.getByText("Pause"));

    await waitFor(() => expect(spy(adapter, "pause")).toHaveBeenCalledWith("c1", { confirmed: true }));
    expect(confirmSpy).toHaveBeenCalledWith("Confirm to pause this codex cronoton.");
    await waitFor(() => expect(spy(adapter, "list").mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("resume: a paused row offers Resume, confirming with the resume verb", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const adapter = makeAdapter([makeRow({ status: "paused" })]);
    mountList(adapter, ADMIN);

    await screen.findByText("Daily treasury sweep");
    fireEvent.click(screen.getByText("Resume"));

    await waitFor(() => expect(spy(adapter, "resume")).toHaveBeenCalledWith("c1", { confirmed: true }));
  });
});

describe("CronotonList — empty + footer", () => {
  it("renders the empty state when there are no cronotons", async () => {
    const adapter = makeAdapter([]);
    mountList(adapter, ADMIN);

    await waitFor(() => expect(screen.getByText(/No codex cronotons yet/)).toBeTruthy());
  });

  it("signed-in footer shows the viewer email", async () => {
    const adapter = makeAdapter([makeRow()]);
    mountList(adapter, ADMIN);

    await screen.findByText("Daily treasury sweep");
    expect(screen.getByText("ancient@ancientholdings.eu")).toBeTruthy();
    expect(screen.getByText(/Signed in as/)).toBeTruthy();
  });
});
