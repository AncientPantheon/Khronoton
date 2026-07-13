// @vitest-environment jsdom
//
// `<Public>` read-only transparency suite. Opts into jsdom via the top-of-file
// docblock (the phase convention; the global vitest env stays `node`). Public is
// NOT a fork of Detail — it REUSES `<Detail>` with a fixed logged-out access
// tier, so every mutation control self-hides and the ManualBatch/RuntimeArgTrigger
// cards self-suppress to null, while the metadata panel + FireHistory (with
// Explorer verify links) stay visible. Around Detail it adds a public bar and an
// attribution footer. Each test mounts the REAL `<KhronotonProvider>` over a fake
// 16-method adapter whose `get` serves a seeded row and `fires` serves a page with
// one successful fire, so the read-only assembly is exercised end to end.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { KhronotonProvider } from "../provider/KhronotonProvider.js";
import type { KhronotonAdapter } from "../provider/adapter.js";
import type { CodexCronotonRow, CodexCronotonFireRow } from "../server/types.js";
import { KhronotonUiRoot } from "./KhronotonUiRoot.js";
import { Public } from "./Public.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PUBLIC_BAR_TEXT =
  "Public view — read-only transparency into this codex cronoton's schedule and fire history.";
const PUBLIC_FOOTER_TEXT =
  "Public view — read only. Sign in as an Ancient admin to manage.";

/** A full detail row; overrides pin the field under test. Runtime-arg keys are
 *  seeded so BOTH admin-only cards (batch + runtime-arg trigger) would apply —
 *  proving they self-suppress for the logged-out viewer, not merely stay off. */
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
    runtime_arg_keys: JSON.stringify(["amount"]),
    status: "active",
    next_fire_at: "2099-01-01T06:00:00.000Z",
    last_fire_at: "2026-07-12T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    modified_at: "2026-01-01T00:00:00.000Z",
    created_by: "ancient@ancientholdings.eu",
    ...over,
  } as CodexCronotonRow;
}

const SUCCESS_FIRE: CodexCronotonFireRow = {
  id: "f1",
  firedAt: "2026-07-12T00:00:00.000Z",
  status: "success",
  requestKey: "rk-success-1",
  chainId: "2",
  errorMessage: null,
  chainResponse: null,
  definitionFingerprint: "fp1",
  mode: "live",
  recoveredAt: null,
  txKeys: [],
};

/** A fake adapter whose `get` serves the row and `fires` a one-fire page.
 *  Mutating methods are spies; `getBatch` is idle so the card renders quietly. */
function makeAdapter(row: CodexCronotonRow): KhronotonAdapter {
  const ok = async () => ({ ok: true });
  const base: Record<string, unknown> = {
    list: vi.fn(ok),
    get: vi.fn(async () => ({ ok: true, codexCronoton: row })),
    fires: vi.fn(async () => ({ ok: true, fires: [SUCCESS_FIRE], total: 1, limit: 50, offset: 0 })),
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
    getBatch: vi.fn(async () => ({ ok: true, batch: null })),
    cancelBatch: vi.fn(async () => ({ ok: true, cancelled: true })),
    recover: vi.fn(ok),
  };
  return base as unknown as KhronotonAdapter;
}

function mount(adapter: KhronotonAdapter, props: Record<string, unknown> = {}) {
  return render(
    <KhronotonProvider adapter={adapter}>
      <KhronotonUiRoot>
        <Public id="c1" {...props} />
      </KhronotonUiRoot>
    </KhronotonProvider>,
  );
}

describe("Public — no mutation controls for a logged-out viewer", () => {
  it("hides every header action and suppresses the admin-only batch + runtime-arg cards", async () => {
    const adapter = makeAdapter(makeRow());
    mount(adapter);

    // The detail tree loaded (metadata eyebrow present) …
    await screen.findByText("Codex cronoton detail");
    // … but a logged-out viewer gets no mutation affordances.
    expect(screen.queryByText("Edit")).toBeNull();
    expect(screen.queryByText("Pause")).toBeNull();
    expect(screen.queryByText("Execute Now")).toBeNull();
    expect(screen.queryByText("Delete")).toBeNull();
    // The two admin-only cards self-suppress to null even though the row's
    // runtime-arg keys would make both apply for an admin.
    expect(screen.queryByText("Execute multiple times")).toBeNull();
    expect(screen.queryByText("Trigger with runtime args")).toBeNull();
  });
});

describe("Public — public chrome", () => {
  it("renders the public bar and the attribution footer with their verbatim strings", async () => {
    const adapter = makeAdapter(makeRow());
    mount(adapter);

    await screen.findByText("Codex cronoton detail");
    // The read-only bar frames the page; the footer attributes it and points to sign-in.
    expect(screen.getByText(PUBLIC_BAR_TEXT)).toBeTruthy();
    expect(screen.getByText(PUBLIC_FOOTER_TEXT)).toBeTruthy();
  });
});

describe("Public — read-only content stays visible", () => {
  it("renders the metadata panel and the fire history with an Explorer verify link for a successful fire", async () => {
    const adapter = makeAdapter(makeRow());
    mount(adapter);

    // The metadata panel remains: the name heading + the status badge.
    expect(await screen.findByRole("heading", { name: "Daily treasury sweep" })).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();

    // The complete fire history renders read-only, with the Explorer deep link
    // whose href carries the successful fire's (encoded) request key.
    expect(await screen.findByText("Fire history (1)")).toBeTruthy();
    const verify = (await screen.findByText("explorer ↗")) as HTMLAnchorElement;
    expect(verify.getAttribute("href")).toContain("rk-success-1");
  });

  it("threads a custom robots policy through to Detail's single robots meta", async () => {
    const adapter = makeAdapter(makeRow());
    mount(adapter, { robots: "index,follow" });

    await screen.findByText("Codex cronoton detail");
    // React hoists the robots <meta> into <head>; Detail owns it and Public passes
    // the value through, so there is exactly one carrying the custom policy.
    const metas = document.head.querySelectorAll('meta[name="robots"]');
    expect(metas.length).toBe(1);
    expect(metas[0].getAttribute("content")).toBe("index,follow");
  });
});
