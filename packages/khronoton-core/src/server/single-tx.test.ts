/**
 * `single-tx` tests — `attemptSingleTxFirst`, exercised against a REAL
 * in-memory better-sqlite3 DB (never a SQL-string mock) and a hand-built
 * `ChainRuntime`/`KeyResolver` fake modeled on `runs-driver.test.ts`'s own
 * fixtures, so a "fits" case drives through the REAL `executeCodexTransaction`
 * + `fireByServerResolver` + `recordFire`, not a replaced one.
 *
 * Six behaviors, per docs/work/khronoton-single-tx-custom/plan.md's T2:
 *   1. off -> no-op, chain client never touched
 *   2. fits -> fires + no run row ever created, one new `codex_cronoton_fires` row
 *   3. gas-refused -> no fire record written, caller falls through
 *   4. non-gas simulate failure -> throws, never treated as "doesn't fit"
 *   5. fires but reverts -> recorded as a failed fire, still `fired: true`
 *   6. both gas-payer types (`codex`/`gas-station`) work through the identical path
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installSchema } from "./schema.js";
import { listFires } from "./store/fires.js";
import * as executorModule from "./executor.js";
import type { ChainClient, ChainRuntime, KeyResolver } from "./seams.js";
import type { CodexGasPayer, CodexSigner } from "./types.js";

import { registerServerResolver } from "./resolvers.js";
import { attemptSingleTxFirst } from "./single-tx.js";

let db: Database.Database;

const PUB_A = "aa".repeat(32);

/**
 * Raw-SQL-inserted `codex_cronotons` parent row, mirroring
 * `runs-driver.test.ts`'s own `seedCronoton` convention. `try_single_tx_first`
 * is included explicitly in the INSERT's column list (the column already
 * exists post-`installSchema`, via T1's `ensureColumn`), so a test can flip it
 * on without a separate UPDATE.
 */
function seedCronoton(opts: {
  id?: string;
  trySingleTxFirst?: boolean;
  gasPayer?: CodexGasPayer;
  signers?: CodexSigner[];
  serverResolver?: string;
} = {}): string {
  const id = opts.id ?? "cc-1";
  const gasPayer: CodexGasPayer = opts.gasPayer ?? {
    type: "gas-station",
    gasStationSignerKey: PUB_A,
  };
  const signers: CodexSigner[] = opts.signers ?? [
    { publicKey: PUB_A, capabilityMode: "pure", capabilities: "" },
  ];
  db.prepare(
    `INSERT INTO codex_cronotons
       (id, name, pact_code, config_json, gas_payer_json, signers_json,
        schedule_mode, schedule_config_json, status, next_fire_at, last_fire_at,
        created_at, modified_at, created_by, try_single_tx_first, single_tx_mode,
        server_resolver)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "n",
    "(+ 1 1)",
    JSON.stringify({ chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 }),
    JSON.stringify(gasPayer),
    JSON.stringify(signers),
    "every-n-minutes",
    JSON.stringify({ mode: "every-n-minutes", startDate: "2026-01-01T00:00:00.000Z", intervalMinutes: 60 }),
    "active",
    null,
    null,
    "t0",
    "t0",
    "op",
    opts.trySingleTxFirst ? 1 : 0,
    opts.trySingleTxFirst ? "custom" : null,
    opts.serverResolver ?? null,
  );
  return id;
}

// ── mock ChainRuntime (modeled on runs-driver.test.ts's own fixtures) ──────
const dirtyRead = vi.fn();
const submit = vi.fn();
const listen = vi.fn();
let currentClient: ChainClient;
const createClient = vi.fn((..._a: unknown[]) => currentClient);
const universalSignTransaction = vi.fn();
const isSignedTransaction = vi.fn(() => true);
const getPactUrl = vi.fn((c: string) => `https://node/${c}`);
const calculateAutoGasLimit = vi.fn((g: number) => g * 2);
const anuToStoa = vi.fn((a: number) => a / 1e12);
const gasMeta = vi.fn(() => ({ creationTime: 1000, gasPrice: 0.001 }));

function makeFakeBuilder() {
  const builder: Record<string, unknown> = {};
  builder.setMeta = () => builder;
  builder.setNetworkId = () => builder;
  builder.addData = () => builder;
  builder.addSigner = () => builder;
  builder.createTransaction = () => ({ cmd: "{}", hash: "SIGNED-HASH", sigs: [] });
  return builder;
}
const fakePactBuilder = {
  get builder() {
    return { execution: () => makeFakeBuilder() };
  },
};

function makeRuntime(): ChainRuntime {
  return {
    Pact: fakePactBuilder,
    createClient,
    isSignedTransaction,
    universalSignTransaction,
    calculateAutoGasLimit,
    anuToStoa,
    gasMeta,
    getPactUrl,
    networkId: "stoa",
    namespace: "ouronet-ns",
    gasStationAccount: "c:GASSTATION",
  };
}

const getKeyPairByPublicKey = vi.fn();
const listCodexPubs = vi.fn(async () => new Set<string>());
function makeResolver(): KeyResolver {
  return { getKeyPairByPublicKey, listCodexPubs };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  installSchema(db);

  vi.clearAllMocks();
  executorModule.__clearCeilingCacheForTests();
  currentClient = { dirtyRead, submit, listen };
  universalSignTransaction.mockResolvedValue({ cmd: "{}", hash: "SIGNED-HASH", sigs: [{ sig: "x" }] });
  isSignedTransaction.mockReturnValue(true);
  getKeyPairByPublicKey.mockResolvedValue({ publicKey: PUB_A, privateKey: "deadbeef", seedType: "koala" });
  // Default: simulate/preflight both succeed comfortably under the 2,000,000
  // AUTO_GAS_CEILING default — "fits" by default, individual tests override.
  dirtyRead.mockResolvedValue({ result: { status: "success", data: "OK" }, gas: 100 });
  submit.mockResolvedValue({ requestKey: "RK-1" });
  listen.mockResolvedValue({ result: { status: "success" }, reqKey: "RK-1" });
});

afterEach(() => {
  db.close();
});

describe("attemptSingleTxFirst — try_single_tx_first off", () => {
  it("returns { fired: false } immediately, never touching the chain client", async () => {
    const id = seedCronoton({ trySingleTxFirst: false });
    const row = db.prepare(`SELECT * FROM codex_cronotons WHERE id = ?`).get(id) as never;

    const attempt = await attemptSingleTxFirst(row, { db, runtime: makeRuntime(), resolver: makeResolver() });

    expect(attempt).toEqual({ fired: false });
    expect(dirtyRead).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("attemptSingleTxFirst — fits under the gas ceiling", () => {
  it("fires the single-tx variant via the plain one-shot path, recording exactly one success fire and zero runs", async () => {
    const id = seedCronoton({ trySingleTxFirst: true });
    const row = db.prepare(`SELECT * FROM codex_cronotons WHERE id = ?`).get(id) as never;

    const attempt = await attemptSingleTxFirst(row, { db, runtime: makeRuntime(), resolver: makeResolver() });

    expect(attempt.fired).toBe(true);
    expect(attempt.result?.ok).toBe(true);
    expect(attempt.fireId).toBeTruthy();

    const { fires } = listFires(id, {}, { db });
    expect(fires).toHaveLength(1);
    expect(fires[0].status).toBe("success");

    const runRows = db.prepare(`SELECT COUNT(*) AS c FROM codex_cronoton_runs`).get() as { c: number };
    expect(runRows.c).toBe(0);
  });
});

describe("attemptSingleTxFirst — refused specifically for exceeding the gas ceiling", () => {
  it("returns { fired: false } with NO fire record written, leaving the decision to the caller", async () => {
    const id = seedCronoton({ trySingleTxFirst: true });
    const row = db.prepare(`SELECT * FROM codex_cronotons WHERE id = ?`).get(id) as never;

    // Over AUTO_GAS_CEILING (2,000,000) — the executor's own refuse-unmineable
    // signal: `{ ok: false }` with a numeric `gasUsed`.
    dirtyRead.mockResolvedValue({ result: { status: "success", data: "OK" }, gas: 3_000_000 });

    const attempt = await attemptSingleTxFirst(row, { db, runtime: makeRuntime(), resolver: makeResolver() });

    expect(attempt).toEqual({ fired: false });
    expect(submit).not.toHaveBeenCalled();

    const { fires } = listFires(id, {}, { db });
    expect(fires).toHaveLength(0);
  });
});

describe("attemptSingleTxFirst — a server-resolver postpone is never recorded as a failure (regression)", () => {
  it("returns { fired: false } with NO fire record when fireByServerResolver's own safety-guard simulate postpones, never treating it as a genuine on-chain failure", async () => {
    registerServerResolver("single-tx-test-postpone", {
      kind: "single-tx",
      resolve: () => ({ plan: [], payload: {} }),
      settle: () => {},
    });
    const id = seedCronoton({ trySingleTxFirst: true, serverResolver: "single-tx-test-postpone" });
    const row = db.prepare(`SELECT * FROM codex_cronotons WHERE id = ?`).get(id) as never;

    // Call 1: attemptSingleTxFirst's OWN pre-check simulate — succeeds, so it
    // proceeds to fire. Call 2: fireWithServerResolver's OWN internal
    // safety-guard simulate (a different, merged payload) — fails with no
    // numeric gasUsed, which resolvers.ts's own code postpones rather than
    // treating as a submitted-and-reverted fire.
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: "OK" }, gas: 100 })
      .mockResolvedValueOnce({ result: { status: "failure", error: { message: "resolver-side guard failed" } } });

    const attempt = await attemptSingleTxFirst(row, { db, runtime: makeRuntime(), resolver: makeResolver() });

    // Before the fix: this returned { fired: true, result: { ok: false } }
    // and wrote a "failure" fire row — permanently orphaning a one-time row
    // (claim already cleared next_fire_at; applyTerminalIntent(id, null, ...)
    // is a no-op) since the tx was never actually submitted to chain at all.
    expect(attempt).toEqual({ fired: false });
    expect(submit).not.toHaveBeenCalled();

    const { fires } = listFires(id, {}, { db });
    expect(fires).toHaveLength(0);
  });
});

describe("attemptSingleTxFirst — a multi-tx server resolver is never dispatched inline (regression)", () => {
  it("returns { fired: false } BEFORE simulating or firing, never awaiting the multi-tx orchestrator inline", async () => {
    const run = vi.fn(async () => ({ batches: [{ requestKey: "RK-MULTI", ok: true }] }));
    registerServerResolver("single-tx-test-multi-tx", { kind: "multi-tx", run });
    const id = seedCronoton({ trySingleTxFirst: true, serverResolver: "single-tx-test-multi-tx" });
    const row = db.prepare(`SELECT * FROM codex_cronotons WHERE id = ?`).get(id) as never;

    // Before the fix: this simulated the row's own top-level definition (which
    // has nothing to do with the multi-tx resolver's real work), then awaited
    // `run` inline on the scheduler/manual-trigger thread — exactly what
    // `handlers/execute.ts`'s own plain-fire branch refuses to do for every
    // other multi-tx-bound row (REQ-H06: queued 202, never fired inline).
    const attempt = await attemptSingleTxFirst(row, { db, runtime: makeRuntime(), resolver: makeResolver() });

    expect(attempt).toEqual({ fired: false });
    expect(dirtyRead).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();

    const { fires } = listFires(id, {}, { db });
    expect(fires).toHaveLength(0);
  });
});

describe("attemptSingleTxFirst — genuine non-gas simulate failure", () => {
  it("rejects rather than returning { fired: false } — never silently treated as 'doesn't fit'", async () => {
    const id = seedCronoton({ trySingleTxFirst: true });
    const row = db.prepare(`SELECT * FROM codex_cronotons WHERE id = ?`).get(id) as never;

    dirtyRead.mockRejectedValueOnce(new Error("node unreachable"));

    await expect(
      attemptSingleTxFirst(row, { db, runtime: makeRuntime(), resolver: makeResolver() }),
    ).rejects.toThrow("node unreachable");

    const { fires } = listFires(id, {}, { db });
    expect(fires).toHaveLength(0);
  });
});

describe("attemptSingleTxFirst — fits simulation but genuinely fails at real fire time", () => {
  it("returns { fired: true, result } with result.ok === false, recorded as a failed fire (no fallback to the chain)", async () => {
    const id = seedCronoton({ trySingleTxFirst: true });
    const row = db.prepare(`SELECT * FROM codex_cronotons WHERE id = ?`).get(id) as never;

    // Simulate succeeds (default dirtyRead mock), but the SAME dirtyRead is
    // reused by `submitTransaction`'s own preflight read — a second call
    // returning a real on-chain revert (no numeric gasUsed) fails the fire,
    // not the simulate.
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: "OK" }, gas: 100 })
      .mockResolvedValueOnce({ result: { status: "failure", error: { message: "reverted on-chain" } } });

    const attempt = await attemptSingleTxFirst(row, { db, runtime: makeRuntime(), resolver: makeResolver() });

    expect(attempt.fired).toBe(true);
    expect(attempt.result?.ok).toBe(false);
    expect(submit).not.toHaveBeenCalled();

    const { fires } = listFires(id, {}, { db });
    expect(fires).toHaveLength(1);
    expect(fires[0].status).toBe("failure");
  });
});

describe("attemptSingleTxFirst — actor attribution (regression)", () => {
  it("merges the caller-supplied auditDetailExtra (e.g. actor) into the single-tx audit event's detail", async () => {
    const id = seedCronoton({ trySingleTxFirst: true });
    const row = db.prepare(`SELECT * FROM codex_cronotons WHERE id = ?`).get(id) as never;
    const onAudit = vi.fn();

    await attemptSingleTxFirst(
      row,
      { db, runtime: makeRuntime(), resolver: makeResolver(), onAudit },
      { auditDetailExtra: { actor: "scheduler" } },
    );

    expect(onAudit).toHaveBeenCalledTimes(1);
    const event = onAudit.mock.calls[0][0];
    expect(event.action).toBe("codex_cronoton.single_tx.fire");
    expect(event.detail.actor).toBe("scheduler");
  });

  it("omits actor entirely when the caller supplies no auditDetailExtra (no crash, no stray undefined field)", async () => {
    const id = seedCronoton({ trySingleTxFirst: true });
    const row = db.prepare(`SELECT * FROM codex_cronotons WHERE id = ?`).get(id) as never;
    const onAudit = vi.fn();

    await attemptSingleTxFirst(row, { db, runtime: makeRuntime(), resolver: makeResolver(), onAudit });

    expect(onAudit).toHaveBeenCalledTimes(1);
    expect(onAudit.mock.calls[0][0].detail.actor).toBeUndefined();
  });
});

describe("attemptSingleTxFirst — both gas-payer types reach the identical path", () => {
  it("fires successfully with a 'codex' (self-paid) gas payer, same as the default gas-station payer", async () => {
    const id = seedCronoton({
      trySingleTxFirst: true,
      gasPayer: { type: "codex", address: `k:${PUB_A}` },
      signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
    });
    const row = db.prepare(`SELECT * FROM codex_cronotons WHERE id = ?`).get(id) as never;

    const attempt = await attemptSingleTxFirst(row, { db, runtime: makeRuntime(), resolver: makeResolver() });

    expect(attempt.fired).toBe(true);
    expect(attempt.result?.ok).toBe(true);

    const { fires } = listFires(id, {}, { db });
    expect(fires).toHaveLength(1);
    expect(fires[0].status).toBe("success");
  });
});
