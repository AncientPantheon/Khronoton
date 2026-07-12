/**
 * DEFINITION-OF-DONE gate 2 — codex-signs-a-scheduled-tx, the plug-and-play
 * proof (REQ-34).
 *
 * The whole point of the package: a host injects a chain runtime + a key
 * resolver, and a scheduled cronoton is autonomously BUILT, SIGNED, and
 * SUBMITTED at fire time with no human in the loop. This drives the REAL tick →
 * REAL fireByServerResolver → REAL executeCodexTransaction against a REAL
 * in-memory better-sqlite3, mocking only the two host seams.
 *
 * A ONE-TIME cronoton due now is fired once. The assertions pin the full
 * build→sign→submit wiring: `universalSignTransaction` is consulted (build→sign),
 * `submit` receives the SIGNED command the runtime produced, the resolver is
 * asked for the signer's keypair, the fire is recorded `success`, the executor
 * never throws (the row lands in `firedIds`), and the one-time terminal
 * transition is applied (`status='completed'`, `next_fire_at` cleared).
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

/** The exact object the mock runtime signs into — asserted to reach `submit`. */
const SIGNED = {
  cmd: JSON.stringify({ networkId: "stoa" }),
  hash: "DERIVED-RK",
  sigs: [{ sig: "x" }],
};

let db: Database.Database;
let submit: ReturnType<typeof vi.fn>;
let universalSignTransaction: ReturnType<typeof vi.fn>;
let isSignedTransaction: ReturnType<typeof vi.fn>;
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
  universalSignTransaction = vi.fn().mockResolvedValue(SIGNED);
  isSignedTransaction = vi.fn(() => true);

  const runtime: ChainRuntime = {
    Pact: fakePactBuilder,
    createClient: vi.fn((_url: string) => ({ dirtyRead, submit, listen })) as unknown as ChainRuntime["createClient"],
    isSignedTransaction: isSignedTransaction as ChainRuntime["isSignedTransaction"],
    universalSignTransaction:
      universalSignTransaction as ChainRuntime["universalSignTransaction"],
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

/** Seed one due ONE-TIME cronoton whose next_fire_at is the tick instant. */
function seedDueOneTime(): string {
  // Commit at 11:00 (before fireAt 12:00) so next_fire_at = fireAt = 12:00;
  // the tick then runs at 12:00 with the row due for its single fire.
  const { id } = commitCodexCronoton(
    {
      name: "codex-signs gate",
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
      scheduleMode: "one-time",
      scheduleConfig: { mode: "one-time", fireAt: "2026-06-08T12:00:00.000Z" },
      createdBy: "ancient",
    },
    { db: db as unknown as TickCtx["db"], now: new Date("2026-06-08T11:00:00.000Z") },
  );
  return id;
}

function successFireRows(id: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM codex_cronoton_fires WHERE codex_cronoton_id = ? AND status = 'success'",
    )
    .get(id) as { c: number };
  return row.c;
}

const NOW = new Date("2026-06-08T12:00:00.000Z");

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  installSchema(db);
  ctx = buildCtx();
});

afterEach(() => {
  db.close();
});

describe("DoD gate — codex signs a scheduled tx (REQ-34)", () => {
  it("fires the due one-time row without throwing (row lands in firedIds)", async () => {
    const id = seedDueOneTime();

    const result = await codexCronotonTickOnce(NOW, ctx);

    expect(result.firedIds).toEqual([id]);
    expect(result.failedIds).toEqual([]);
    expect(result.skippedIds).toEqual([]);
  });

  it("records EXACTLY ONE fire row with status='success'", async () => {
    const id = seedDueOneTime();

    await codexCronotonTickOnce(NOW, ctx);

    expect(successFireRows(id)).toBe(1);
  });

  it("BUILDS+SIGNS the tx and SUBMITS the signed command the runtime produced", async () => {
    seedDueOneTime();

    await codexCronotonTickOnce(NOW, ctx);

    // build→sign happened
    expect(universalSignTransaction).toHaveBeenCalledTimes(1);
    // the object handed to submit is the SIGNED command, not the unsigned build
    expect(submit).toHaveBeenCalledTimes(1);
    const submitted = submit.mock.calls[0][0] as { hash?: string };
    expect(submitted).toBe(SIGNED);
    expect(submitted.hash).toBe("DERIVED-RK");
    expect(ctx.runtime.isSignedTransaction(submitted)).toBe(true);
  });

  it("consults the resolver for the signer's keypair", async () => {
    seedDueOneTime();

    await codexCronotonTickOnce(NOW, ctx);

    const resolvedPubs = getKeyPairByPublicKey.mock.calls.map((c) => c[0]);
    expect(resolvedPubs).toContain(PUB_A);
  });

  it("applies the one-time terminal transition — status='completed', next_fire_at cleared", async () => {
    const id = seedDueOneTime();

    await codexCronotonTickOnce(NOW, ctx);

    const cronoton = getCodexCronoton(id, { db: db as unknown as TickCtx["db"] })!;
    expect(cronoton.status).toBe("completed");
    expect(cronoton.next_fire_at).toBeNull();
  });

  it("invokes onAudit once with codex_cronoton.fire for the fired row", async () => {
    const id = seedDueOneTime();

    await codexCronotonTickOnce(NOW, ctx);

    expect(onAudit).toHaveBeenCalledTimes(1);
    const event = onAudit.mock.calls[0][0];
    expect(event.action).toBe("codex_cronoton.fire");
    expect(event.result).toBe("success");
    expect(event.targetId).toBe(id);
  });
});
