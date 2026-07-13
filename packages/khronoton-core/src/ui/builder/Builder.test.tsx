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
