// @vitest-environment jsdom
//
// Builder assembly suite. Opts into jsdom via the top-of-file docblock (the
// global vitest env stays `node` for the engine/handler suites). The assembly is
// the single state owner that hosts the already-built controlled tabs: it wires
// each tab's `onChange` back into one `BuilderState`, fetches the signer
// descriptors once, and routes the commit through the create/edit action hooks.
// The suite mounts a real provider over a fake 16-method adapter (the pattern the
// sibling ExecuteTab/RuntimeArgTriggerCard suites use) so the hook + confirm-gate
// wiring is exercised end to end.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

import { KhronotonProvider } from "../../provider/KhronotonProvider.js";
import type { KhronotonAdapter } from "../../provider/adapter.js";
import { KhronotonUiRoot } from "../KhronotonUiRoot.js";
import { Builder } from "./Builder.js";
import {
  builderToCommit,
  detailToBuilderState,
  makeEmptyBuilderState,
} from "../builder-state.js";
import type { Access } from "../access.js";
import type { CodexCronotonRow } from "../../server/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ADMIN: Access = { tier: "admin", email: "ancient@holdings.test" };

const DESCRIPTORS = [
  { publicKey: "k:alice", display: "derived" as const },
  { publicKey: "k:bob", display: "foreign" as const },
];

/** A complete 16-method fake adapter; `signers`/`get`/`commit`/`edit` overridable,
 *  the rest inert so `assertAdapter` passes at mount and calls stay observable. */
function makeAdapter(overrides: Partial<KhronotonAdapter> = {}): KhronotonAdapter {
  const inert = () => vi.fn(async () => ({ ok: true }));
  return {
    list: inert(),
    get: inert(),
    fires: inert(),
    signers: vi.fn(async () => ({ ok: true, signers: DESCRIPTORS })),
    // OPTIONAL adapter method (0.7.0). Default: an empty registry, so every
    // existing test computes eventDrivenResolver from serverResolverOptions alone
    // (unchanged). Only the server-authoritative test below overrides it.
    resolvers: vi.fn(async () => ({ ok: true, resolvers: [] })),
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

function mount(adapter: KhronotonAdapter, props: Partial<Parameters<typeof Builder>[0]> = {}) {
  return render(
    <KhronotonProvider adapter={adapter}>
      <KhronotonUiRoot>
        <Builder access={ADMIN} {...props} />
      </KhronotonUiRoot>
    </KhronotonProvider>,
  );
}

/** A seeded persisted row for the edit-rehydration test. */
function seedRow(): CodexCronotonRow {
  return {
    id: "cr_7",
    name: "Weekly settle",
    description: "Settles the pool",
    pact_code: "(settle)",
    config_json: JSON.stringify({
      chainId: "0",
      gasPrice: 10000,
      gasLimit: 2500,
      autoGasLimit: false,
      ttl: 600,
    }),
    payload_json: JSON.stringify({ amount: 1 }),
    gas_payer_json: JSON.stringify({ type: "gas-station", gasStationSignerKey: "k:payer" }),
    signers_json: JSON.stringify([{ publicKey: "k:alice", capabilityMode: "pure", capabilities: "" }]),
    schedule_mode: "daily-at-utc",
    schedule_config_json: JSON.stringify({ mode: "daily-at-utc", hours: [9], minute: 30 }),
    server_resolver: null,
    status: "active",
    next_fire_at: null,
    last_fire_at: null,
    created_at: "2026-07-01T00:00:00.000Z",
    modified_at: "2026-07-01T00:00:00.000Z",
    created_by: "ancient@holdings.test",
  };
}

describe("Builder — create round-trip", () => {
  it("commits builderToCommit(state) built from the edited name + chosen gas-station key, then calls onDone with the new id", async () => {
    const commit = vi.fn(async (_body: unknown) => ({
      ok: true as const,
      codexCronotonId: "cr_new",
      nextFireAt: null,
    }));
    const onDone = vi.fn();
    const adapter = makeAdapter({ commit: commit as unknown as KhronotonAdapter["commit"] });
    mount(adapter, { onDone });

    // Wait for the once-fetched descriptors so the gas-station key picker is populated.
    await screen.findByRole("option", { name: "k:alice" }).catch(() => null);

    // Edit the name in the always-visible header.
    fireEvent.change(screen.getByPlaceholderText("Daily payout"), { target: { value: "Nightly" } });

    // Pick the gas-station signing key on the Gas Payer tab — this both configures
    // the payer AND supplies the effective signer that clears the commit gate.
    fireEvent.click(screen.getByRole("tab", { name: "Gas Payer" }));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "k:alice" })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Signing Key (DALOS.GAS_PAYER capability)"), {
      target: { value: "k:alice" },
    });

    // Cross to Execute and fire the (now-open) commit gate.
    fireEvent.click(screen.getByRole("tab", { name: "Execute" }));
    fireEvent.click(screen.getByRole("button", { name: "Commit Codex Cronoton" }));

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));

    // The wire body is exactly what the pure serializer produces from the edited state.
    const expected = builderToCommit({
      ...makeEmptyBuilderState(),
      name: "Nightly",
      gasPayer: { type: "gas-station", signingKey: "k:alice" },
    });
    expect(commit.mock.calls[0][0]).toEqual(expected);

    // Success routes the new id back to the host.
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("cr_new"));
  });
});

describe("Builder — event-driven resolver seam (options → derivation → commit + UI swap)", () => {
  it("selecting an event-driven resolver commits envelope.eventDriven=true AND swaps the schedule editor for the event-driven notice", async () => {
    const commit = vi.fn(async (_body: unknown) => ({
      ok: true as const,
      codexCronotonId: "cr_ev",
      nextFireAt: null,
    }));
    const adapter = makeAdapter({ commit: commit as unknown as KhronotonAdapter["commit"] });
    // The provider carries an event-driven resolver option — the SAME source
    // BuilderHeader's dropdown and Builder's derivation both read (config
    // serverResolverOptions), so this exercises the real options→eventDrivenResolver
    // →{ExecuteTab prop, builderToCommit opts} seam, not either half in isolation.
    render(
      <KhronotonProvider
        adapter={adapter}
        serverResolverOptions={[
          { value: "dual-link-activate", label: "Dual-Link Activate", eventDriven: true },
        ]}
      >
        <KhronotonUiRoot>
          <Builder access={ADMIN} />
        </KhronotonUiRoot>
      </KhronotonProvider>,
    );

    await screen.findByRole("option", { name: "k:alice" }).catch(() => null);

    // Name + gas-station signing key clear the commit gate (as in the create test).
    fireEvent.change(screen.getByPlaceholderText("Daily payout"), { target: { value: "Ev" } });
    // Select the event-driven resolver in the header dropdown.
    fireEvent.change(screen.getByLabelText("Server resolver"), {
      target: { value: "dual-link-activate" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Gas Payer" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "k:alice" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Signing Key (DALOS.GAS_PAYER capability)"), {
      target: { value: "k:alice" },
    });

    // Execute tab: the ScheduleStep is swapped for the event-driven notice, and the
    // schedule summary reflects host-fired — proving the UI half of the seam.
    fireEvent.click(screen.getByRole("tab", { name: "Execute" }));
    expect(screen.getByText(/Event-driven — the host application fires this/i)).toBeTruthy();
    expect(screen.queryByLabelText("Mode")).toBeNull(); // ScheduleStep absent
    expect(screen.getByTestId("summary-schedule").textContent).toContain("Event-driven (host-fired)");

    // Commit: the wire body carries envelope.eventDriven === true — proving the
    // commit half of the seam (derivation → builderToCommit opts), the exact bridge
    // that would silently regress to a real next_fire_at if it were dropped.
    fireEvent.click(screen.getByRole("button", { name: "Commit Codex Cronoton" }));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    const body = commit.mock.calls[0][0] as { envelope: { eventDriven?: boolean; serverResolver?: string } };
    expect(body.envelope.eventDriven).toBe(true);
    expect(body.envelope.serverResolver).toBe("dual-link-activate");
  });
});

describe("Builder — server-authoritative evented resolver (/resolvers → schedule-off + external-fireable auto-set)", () => {
  it("marks a resolver the SERVER reports evented as event-driven (hides ScheduleStep, shows the notice) even when the client option omits eventDriven, and auto-sets externalFireable + eventDriven on commit", async () => {
    const commit = vi.fn(async (_body: unknown) => ({
      ok: true as const,
      codexCronotonId: "cr_evt",
      nextFireAt: null,
    }));
    const adapter = makeAdapter({
      commit: commit as unknown as KhronotonAdapter["commit"],
      // The SERVER registry (/resolvers) marks evt-resolver evented. The client
      // serverResolverOptions below deliberately does NOT set eventDriven, so this
      // exercises the NEW server-authoritative path — not the 0.6.0 client flag.
      resolvers: vi.fn(async () => ({
        ok: true as const,
        resolvers: [{ name: "evt-resolver", kind: "single-tx", evented: true }],
      })) as unknown as KhronotonAdapter["resolvers"],
    });
    render(
      <KhronotonProvider
        adapter={adapter}
        serverResolverOptions={[{ value: "evt-resolver", label: "Evt Resolver" }]}
      >
        <KhronotonUiRoot>
          <Builder access={ADMIN} />
        </KhronotonUiRoot>
      </KhronotonProvider>,
    );

    await screen.findByRole("option", { name: "k:alice" }).catch(() => null);

    // Name + gas-station signing key clear the commit gate (as in the create test).
    fireEvent.change(screen.getByPlaceholderText("Daily payout"), { target: { value: "Evt" } });
    fireEvent.change(screen.getByLabelText("Server resolver"), {
      target: { value: "evt-resolver" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Gas Payer" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "k:alice" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Signing Key (DALOS.GAS_PAYER capability)"), {
      target: { value: "k:alice" },
    });

    // Execute tab: the /resolvers fetch made evt-resolver event-driven, so the
    // ScheduleStep is swapped for the event-driven notice (server-authoritative).
    fireEvent.click(screen.getByRole("tab", { name: "Execute" }));
    await waitFor(() =>
      expect(screen.getByText(/Event-driven — the host application fires this/i)).toBeTruthy(),
    );
    expect(screen.queryByLabelText("Mode")).toBeNull(); // ScheduleStep absent

    // Commit: the auto-set flipped externalFireable on (matching the store's forced
    // external_fireable = 1), and the derivation carried eventDriven through.
    fireEvent.click(screen.getByRole("button", { name: "Commit Codex Cronoton" }));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    const body = commit.mock.calls[0][0] as {
      envelope: { externalFireable?: boolean; eventDriven?: boolean; serverResolver?: string };
    };
    expect(body.envelope.externalFireable).toBe(true);
    expect(body.envelope.eventDriven).toBe(true);
    expect(body.envelope.serverResolver).toBe("evt-resolver");
  });

  it("does NOT leave externalFireable stuck true after previewing an evented resolver then switching to a non-evented one (commit-time derivation, not sticky state)", async () => {
    const commit = vi.fn(async (_body: unknown) => ({
      ok: true as const,
      codexCronotonId: "cr_plain",
      nextFireAt: "2026-09-01T00:00:00.000Z",
    }));
    const adapter = makeAdapter({
      commit: commit as unknown as KhronotonAdapter["commit"],
      // Registry marks ONLY evt-resolver evented; plain-resolver is a normal
      // scheduled server resolver.
      resolvers: vi.fn(async () => ({
        ok: true as const,
        resolvers: [{ name: "evt-resolver", kind: "single-tx", evented: true }],
      })) as unknown as KhronotonAdapter["resolvers"],
    });
    render(
      <KhronotonProvider
        adapter={adapter}
        serverResolverOptions={[
          { value: "evt-resolver", label: "Evt Resolver" },
          { value: "plain-resolver", label: "Plain Resolver" },
        ]}
      >
        <KhronotonUiRoot>
          <Builder access={ADMIN} />
        </KhronotonUiRoot>
      </KhronotonProvider>,
    );

    await screen.findByRole("option", { name: "k:alice" }).catch(() => null);

    fireEvent.change(screen.getByPlaceholderText("Daily payout"), { target: { value: "Switch" } });
    // Preview the evented resolver first (the old sticky useEffect would flip
    // state.externalFireable true here and never reset it).
    fireEvent.change(screen.getByLabelText("Server resolver"), {
      target: { value: "evt-resolver" },
    });
    // Then switch to the non-evented resolver before committing.
    fireEvent.change(screen.getByLabelText("Server resolver"), {
      target: { value: "plain-resolver" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Gas Payer" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "k:alice" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Signing Key (DALOS.GAS_PAYER capability)"), {
      target: { value: "k:alice" },
    });

    // Execute tab: with the non-evented resolver the ScheduleStep is restored
    // (not the event-driven notice) — proving the switch-away reverted the UI too.
    fireEvent.click(screen.getByRole("tab", { name: "Execute" }));
    expect(screen.queryByText(/Event-driven — the host application fires this/i)).toBeNull();
    expect(screen.getByLabelText("Mode")).toBeTruthy(); // ScheduleStep restored

    fireEvent.click(screen.getByRole("button", { name: "Commit Codex Cronoton" }));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    const body = commit.mock.calls[0][0] as {
      envelope: { externalFireable?: boolean; eventDriven?: boolean; serverResolver?: string };
    };
    // The committed body reflects the CURRENT (non-evented) resolver: no forced
    // external-fireable, no event-driven flag — proving the flag is derived at
    // commit time, not left stuck by an earlier evented preview.
    expect(body.envelope.serverResolver).toBe("plain-resolver");
    expect(body.envelope.externalFireable).not.toBe(true);
    expect(body.envelope.eventDriven).not.toBe(true);
  });
});

describe("Builder — edit rehydration + patch", () => {
  it("rehydrates the seeded row (payload forced raw, Row C hidden, schedule preserved) and PATCHes on save", async () => {
    const row = seedRow();
    const get = vi.fn(async () => ({ ok: true as const, codexCronoton: row }));
    const edit = vi.fn(async (_id: string, _patch: unknown) => ({ ok: true as const, nextFireAt: null }));
    const commit = vi.fn(async () => ({ ok: true as const, codexCronotonId: "x", nextFireAt: null }));
    const onDone = vi.fn();
    const adapter = makeAdapter({
      get: get as unknown as KhronotonAdapter["get"],
      edit: edit as unknown as KhronotonAdapter["edit"],
      commit: commit as unknown as KhronotonAdapter["commit"],
    });
    mount(adapter, { editId: "cr_7", onDone });

    // State rehydrates once the row loads: the name field mirrors the stored name.
    await waitFor(() =>
      expect((screen.getByPlaceholderText("Daily payout") as HTMLInputElement).value).toBe(
        "Weekly settle",
      ),
    );

    // Row C (external-fire + runtime args) is CREATE-ONLY: hidden in edit mode.
    expect(
      screen.queryByPlaceholderText("comma or newline separated, e.g. amount, recipient"),
    ).toBeNull();

    // Payload opened in FORCED raw mode — the raw editor shows the "Switch to typed" toggle.
    fireEvent.click(screen.getByRole("tab", { name: "Payload" }));
    expect(screen.getByText("Switch to typed")).toBeTruthy();

    // Schedule preserved: the Execute summary reads the rehydrated schedule verbatim.
    fireEvent.click(screen.getByRole("tab", { name: "Execute" }));
    expect(screen.getByTestId("summary-schedule").textContent).toContain("09:30");

    // Saving issues a PATCH (edit) to the bound id — NOT a create POST.
    fireEvent.click(screen.getByRole("button", { name: "Commit Codex Cronoton" }));
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
    expect(edit.mock.calls[0][0]).toBe("cr_7");
    expect(edit.mock.calls[0][1]).toEqual(builderToCommit(detailToBuilderState(row)));
    expect(commit).not.toHaveBeenCalled();
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("cr_7"));
  });
});

describe("Builder — tab switching keeps hosted state", () => {
  it("preserves a Config edit across a Payload round-trip (state lives in the assembly, not the tab)", async () => {
    mount(makeAdapter());

    const chain = () => screen.getByLabelText("Chain ID") as HTMLInputElement;
    fireEvent.change(chain(), { target: { value: "5" } });
    expect(chain().value).toBe("5");

    fireEvent.click(screen.getByRole("tab", { name: "Payload" }));
    fireEvent.click(screen.getByRole("tab", { name: "Config" }));

    // The edited chain id survived the tab switch because the assembly owns it.
    expect(chain().value).toBe("5");
  });
});

describe("Builder — signer descriptors", () => {
  it("fetches the descriptors exactly once and passes them to Gas Payer and Signatures", async () => {
    const adapter = makeAdapter();
    mount(adapter);

    await waitFor(() => expect((adapter.signers as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1));

    // Gas Payer receives them — the signing-key picker lists the fetched key.
    fireEvent.click(screen.getByRole("tab", { name: "Gas Payer" }));
    expect(screen.getByRole("option", { name: "k:bob" })).toBeTruthy();

    // Signatures receives them — the add-signer list offers the same key.
    fireEvent.click(screen.getByRole("tab", { name: "Signatures" }));
    expect(screen.getByLabelText("Add signer k:bob")).toBeTruthy();

    // No second fetch was triggered by the tab switches.
    expect((adapter.signers as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

describe("Builder — switching editId on a mounted instance", () => {
  it("re-fetches the new row and rebinds the PATCH to it (no stale-body overwrite of the wrong id)", async () => {
    const row7 = seedRow();
    const row9: CodexCronotonRow = {
      ...seedRow(),
      id: "cr_9",
      name: "Monthly drain",
      schedule_config_json: JSON.stringify({ mode: "daily-at-utc", hours: [3], minute: 0 }),
    };
    // The persisted store serves each row by its own id.
    const get = vi.fn(async (id: string) => ({
      ok: true as const,
      codexCronoton: id === "cr_9" ? row9 : row7,
    }));
    const edit = vi.fn(async (_id: string, _patch: unknown) => ({ ok: true as const, nextFireAt: null }));
    const onDone = vi.fn();
    const adapter = makeAdapter({
      get: get as unknown as KhronotonAdapter["get"],
      edit: edit as unknown as KhronotonAdapter["edit"],
    });

    const view = render(
      <KhronotonProvider adapter={adapter}>
        <KhronotonUiRoot>
          <Builder access={ADMIN} editId="cr_7" onDone={onDone} />
        </KhronotonUiRoot>
      </KhronotonProvider>,
    );

    await waitFor(() =>
      expect((screen.getByPlaceholderText("Daily payout") as HTMLInputElement).value).toBe(
        "Weekly settle",
      ),
    );

    // Switch the target id on the SAME mounted Builder (no remount).
    view.rerender(
      <KhronotonProvider adapter={adapter}>
        <KhronotonUiRoot>
          <Builder access={ADMIN} editId="cr_9" onDone={onDone} />
        </KhronotonUiRoot>
      </KhronotonProvider>,
    );

    // The form now mirrors cr_9 — not the stale cr_7 body.
    await waitFor(() =>
      expect((screen.getByPlaceholderText("Daily payout") as HTMLInputElement).value).toBe(
        "Monthly drain",
      ),
    );

    // Saving PATCHes cr_9 with cr_9's rehydrated body — never cr_7's.
    fireEvent.click(screen.getByRole("tab", { name: "Execute" }));
    fireEvent.click(screen.getByRole("button", { name: "Commit Codex Cronoton" }));
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
    expect(edit.mock.calls[0][0]).toBe("cr_9");
    expect(edit.mock.calls[0][1]).toEqual(builderToCommit(detailToBuilderState(row9)));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("cr_9"));
  });
});

describe("Builder — top/bottom layout", () => {
  it("renders the Pact editor header before the tab bar in DOM order (top, not side-by-side)", () => {
    mount(makeAdapter());

    const editorHeader = screen.getByText("PACT Code Editor");
    const tablist = screen.getByRole("tablist");

    // DOCUMENT_POSITION_FOLLOWING (4) on the tablist means editorHeader precedes it.
    // eslint-disable-next-line no-bitwise
    expect(editorHeader.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("stacks the editor and the header+tabs pane in a single flex column, not a 2-column grid", () => {
    mount(makeAdapter());

    const tablist = screen.getByRole("tablist");
    // tablist -> "Bottom" pane div -> PANE_WRAP wrapper.
    const paneWrap = tablist.parentElement?.parentElement;

    expect(paneWrap?.style.flexDirection).toBe("column");
    expect(paneWrap?.style.display).not.toBe("grid");
  });
});

describe("Builder — shared Simulate result feeds the top meter", () => {
  it("shows Run Simulate before any simulate call, then reflects the SAME simulate result the Execute tab used", async () => {
    const simulate = vi.fn(async () => ({ ok: true as const, gasUsed: 900 }));
    const adapter = makeAdapter({
      simulate: simulate as unknown as KhronotonAdapter["simulate"],
    });
    mount(adapter);

    // Before any simulate call, the Gas meter row (above the tab bar) shows the
    // "no result yet" state. `makeEmptyBuilderState()`'s default gas limit is 1500.
    expect(screen.getByText("Run Simulate")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Execute" }));
    fireEvent.click(screen.getByRole("button", { name: "Simulate" }));

    await waitFor(() => expect(simulate).toHaveBeenCalledTimes(1));

    // The top meter (still mounted — it lives above the tab bar, not inside it)
    // updates from the SAME sim result ExecuteTab's own summary used: one shared
    // `useSimulate()` call, not two independent instances.
    await waitFor(() => expect(screen.getByText("900 / 1,500")).toBeTruthy());
    expect(simulate).toHaveBeenCalledTimes(1);
  });
});
