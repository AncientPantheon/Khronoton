/**
 * DEFINITION-OF-DONE gate 1 — the once-only double-fire guard, end-to-end
 * (REQ-33).
 *
 * This is the store-layer atomic-claim proof (claim.test.ts's "wins exactly
 * once" race) RAISED to the full tick layer: instead of two raw
 * `claimDueCodexCronoton` calls, TWO overlapping `codexCronotonTickOnce` passes
 * run against ONE due row on a REAL in-memory better-sqlite3. Because the claim
 * advances `next_fire_at` synchronously BEFORE the inline fire's `await`, the
 * second overlapping pass sees the row already spent and never re-fires it.
 *
 * The proof is OBSERVABLE, not introspective: exactly one fire row lands in
 * `codex_cronoton_fires`, the mock chain's `submit` is called exactly once (no
 * double on-chain submission), and `onAudit` fires once. A mock DB that always
 * reported `changes: 1` would double-fire here — the real conditional UPDATE is
 * what closes the window.
 *
 * The full stack is real (tick → resolver dispatch → executor → store → schema);
 * only the two host seams — the chain runtime and the key resolver — are mocked,
 * since a unit test cannot reach a live node or an encrypted key store.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installSchema } from "../src/server/schema.js";
import { codexCronotonTickOnce } from "../src/server/tick.js";
import type { TickCtx } from "../src/server/tick.js";
import { commitCodexCronoton, getCodexCronoton } from "../src/server/store/index.js";
import type { ChainRuntime, Config, KeyResolver } from "../src/server/seams.js";

const PUB_A = "aa".repeat(32);

const CONFIG: Config = {
  tickIntervalMs: 30_000,
  listenTimeoutMs: 300_000,
  autoGasCeiling: 2_000_000,
  singleTxGasGuard: 1_600_000,
  tickBatchLimit: 100,
  manualBatch: { min: 2, max: 60, intervalSeconds: 60 },
};

// ── Fake Pact.builder recorder (mirrors executor.test.ts) ────────────────────
function makeFakeBuilder(): Record<string, unknown> {
  const builder: Record<string, unknown> = {};
  const record =
    () =>
    (..._args: unknown[]) =>
      builder;
  builder.setMeta = record();
  builder.setNetworkId = record();
  builder.addData = record();
  builder.addSigner = (..._args: unknown[]) => builder;
  builder.createTransaction = () => ({ cmd: "UNSIGNED_CMD", hash: "UH", sigs: [] });
  return builder;
}

const fakePactBuilder = {
  get builder() {
    return { execution: (_code: string) => makeFakeBuilder() };
  },
};

let db: Database.Database;
let submit: ReturnType<typeof vi.fn>;
let getKeyPairByPublicKey: ReturnType<typeof vi.fn>;
let onAudit: ReturnType<typeof vi.fn>;
let ctx: TickCtx;

function buildCtx(): TickCtx {
  const dirtyRead = vi.fn().mockResolvedValue({
    result: { status: "success", data: "OK" },
    gas: 700,
  });
  submit = vi.fn().mockResolvedValue({ requestKey: "RK-1" });
  const listen = vi.fn().mockResolvedValue({
    result: { status: "success", data: "DONE" },
    reqKey: "RK-1",
  });

  const runtime: ChainRuntime = {
    Pact: fakePactBuilder,
    createClient: vi.fn((_url: string) => ({ dirtyRead, submit, listen })) as unknown as ChainRuntime["createClient"],
    isSignedTransaction: () => true,
    universalSignTransaction: vi.fn().mockResolvedValue({
      cmd: JSON.stringify({ networkId: "stoa" }),
      hash: "DERIVED-RK",
      sigs: [{ sig: "x" }],
    }),
    calculateAutoGasLimit: (g: number) => g * 2,
    anuToStoa: (a: number) => a / 1e12,
    getPactUrl: (c: string) => `https://node/${c}`,
    networkId: "stoa",
    namespace: "ouronet-ns",
    gasStationAccount: "c:GASSTATION",
  };

  getKeyPairByPublicKey = vi.fn().mockResolvedValue({
    publicKey: PUB_A,
    privateKey: "deadbeef",
    seedType: "koala",
  });
  const resolver: KeyResolver = {
    getKeyPairByPublicKey: getKeyPairByPublicKey as KeyResolver["getKeyPairByPublicKey"],
    listCodexPubs: vi.fn(async () => new Set<string>()),
  };

  onAudit = vi.fn();

  return {
    db: db as unknown as TickCtx["db"],
    resolver,
    runtime,
    onAudit: onAudit as unknown as TickCtx["onAudit"],
    resolveFireMode: () => "live",
    config: CONFIG,
  };
}

/** Seed one due RECURRING cronoton whose next_fire_at lands exactly on the tick instant. */
function seedDueRecurring(): string {
  // Commit at 11:30 so the every-hour schedule computes next_fire_at = 12:00;
  // the tick then runs at 12:00 with the row due.
  const { id } = commitCodexCronoton(
    {
      name: "double-fire gate",
      description: null,
      pactCode: '(coin.transfer "a" "b" 1.0)',
      config: {
        chainId: "0",
        gasPrice: 10000,
        gasLimit: 1500,
        autoGasLimit: false,
        ttl: 28800,
      },
      payload: {},
      gasPayer: { type: "gas-station", gasStationSignerKey: PUB_A },
      signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
      scheduleMode: "every-n-minutes",
      scheduleConfig: {
        mode: "every-n-minutes",
        startDate: "2026-01-01T00:00:00.000Z",
        intervalMinutes: 60,
      },
      createdBy: "ancient",
    },
    { db: db as unknown as TickCtx["db"], now: new Date("2026-06-08T11:30:00.000Z") },
  );
  return id;
}

function fireRowCount(id: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM codex_cronoton_fires WHERE codex_cronoton_id = ?")
    .get(id) as { c: number };
  return row.c;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  installSchema(db);
  ctx = buildCtx();
});

afterEach(() => {
  db.close();
});

describe("DoD gate — double-fire once-only guard (REQ-33)", () => {
  it("two overlapping tick passes on one due row fire it EXACTLY ONCE", async () => {
    const id = seedDueRecurring();
    const now = new Date("2026-06-08T12:00:00.000Z");

    const [passA, passB] = await Promise.all([
      codexCronotonTickOnce(now, ctx),
      codexCronotonTickOnce(now, ctx),
    ]);

    // The atomic claim lets exactly one of the two overlapping passes fire.
    const fired = [...passA.firedIds, ...passB.firedIds];
    expect(fired).toEqual([id]);
  });

  it("records EXACTLY ONE fire row for the cronoton (the real conditional UPDATE closes the window)", async () => {
    const id = seedDueRecurring();
    const now = new Date("2026-06-08T12:00:00.000Z");

    await Promise.all([
      codexCronotonTickOnce(now, ctx),
      codexCronotonTickOnce(now, ctx),
    ]);

    expect(fireRowCount(id)).toBe(1);
  });

  it("submits to the chain EXACTLY ONCE — no double on-chain submission", async () => {
    seedDueRecurring();
    const now = new Date("2026-06-08T12:00:00.000Z");

    await Promise.all([
      codexCronotonTickOnce(now, ctx),
      codexCronotonTickOnce(now, ctx),
    ]);

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("invokes onAudit once with codex_cronoton.fire for the fired row", async () => {
    const id = seedDueRecurring();
    const now = new Date("2026-06-08T12:00:00.000Z");

    await Promise.all([
      codexCronotonTickOnce(now, ctx),
      codexCronotonTickOnce(now, ctx),
    ]);

    expect(onAudit).toHaveBeenCalledTimes(1);
    const event = onAudit.mock.calls[0][0];
    expect(event.action).toBe("codex_cronoton.fire");
    expect(event.targetId).toBe(id);
  });

  it("the single fire row is a success and the recurring row stays active with its advanced next-fire", async () => {
    const id = seedDueRecurring();
    const now = new Date("2026-06-08T12:00:00.000Z");

    await Promise.all([
      codexCronotonTickOnce(now, ctx),
      codexCronotonTickOnce(now, ctx),
    ]);

    const fireRow = db
      .prepare("SELECT status FROM codex_cronoton_fires WHERE codex_cronoton_id = ?")
      .get(id) as { status: string };
    expect(fireRow.status).toBe("success");

    // A recurring fire is NOT terminal: the claim advanced next_fire_at to the
    // next hour boundary and left the row active (no auto-pause, no terminal).
    const cronoton = getCodexCronoton(id, { db: db as unknown as TickCtx["db"] })!;
    expect(cronoton.status).toBe("active");
    expect(cronoton.next_fire_at).toBe("2026-06-08T13:00:00.000Z");
  });
});
