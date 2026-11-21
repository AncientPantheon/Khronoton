/**
 * `fire-and-record` tests — `recordAndFinalizeFire`/`fireAndRecord`, exercised
 * against a REAL in-memory better-sqlite3 DB (never a SQL-string mock).
 *
 * A review finding caught this module — the shared record+finalize+audit
 * sequence both `handlers/execute.ts` and `single-tx.ts` delegate to — having
 * zero direct test coverage of its own, with its branches (one-time terminal
 * transition, custom `auditAction`/`auditDetailExtra` merging) only exercised
 * as a side effect of its callers' own scenarios. These tests target
 * `recordAndFinalizeFire` directly with hand-built `FireResult`s (no need to
 * drive a real chain client for those branches), plus one end-to-end
 * `fireAndRecord` test that does drive a real fake `ChainRuntime`/`KeyResolver`
 * (modeled on `single-tx.test.ts`'s own fixtures) to prove the fire-then-record
 * composition itself works.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installSchema } from "./schema.js";
import { listFires } from "./store/fires.js";
import * as executorModule from "./executor.js";
import { fireAndRecord, recordAndFinalizeFire } from "./fire-and-record.js";
import type { ChainClient, ChainRuntime, KeyResolver } from "./seams.js";
import type { CodexCronotonRow, CodexTxDefinition, FireResult } from "./types.js";

let db: Database.Database;

const PUB_A = "aa".repeat(32);

/** Raw-SQL-inserted `codex_cronotons` parent row, mirroring `single-tx.test.ts`'s own `seedCronoton` convention. */
function seedCronoton(id = "cc-1"): CodexCronotonRow {
  db.prepare(
    `INSERT INTO codex_cronotons
       (id, name, pact_code, config_json, gas_payer_json, signers_json,
        schedule_mode, schedule_config_json, status, next_fire_at, last_fire_at,
        created_at, modified_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "n",
    "(+ 1 1)",
    JSON.stringify({ chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 }),
    JSON.stringify({ type: "gas-station", gasStationSignerKey: PUB_A }),
    JSON.stringify([{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }]),
    "every-n-minutes",
    JSON.stringify({ mode: "every-n-minutes", startDate: "2026-01-01T00:00:00.000Z", intervalMinutes: 60 }),
    "active",
    "2026-01-01T00:00:00.000Z",
    null,
    "t0",
    "t0",
    "op",
  );
  return db.prepare(`SELECT * FROM codex_cronotons WHERE id = ?`).get(id) as CodexCronotonRow;
}

function makeDefinition(overrides: Partial<CodexTxDefinition> = {}): CodexTxDefinition {
  return {
    pactCode: "(+ 1 1)",
    config: { chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 },
    payload: {},
    gasPayer: { type: "gas-station", gasStationSignerKey: PUB_A },
    signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
    ...overrides,
  };
}

function makeSuccessResult(overrides: Partial<FireResult> = {}): FireResult {
  return {
    ok: true,
    mode: "fire",
    requestKey: "RK-1",
    chainId: "0",
    terminalIntent: null,
    ...overrides,
  };
}

function makeFailureResult(overrides: Partial<FireResult> = {}): FireResult {
  return {
    ok: false,
    mode: "fire",
    error: "reverted on-chain",
    terminalIntent: null,
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  installSchema(db);
});

afterEach(() => {
  db.close();
});

describe("recordAndFinalizeFire — recurring definition", () => {
  it("records exactly one success fire row and leaves status/next_fire_at untouched (terminalIntent null -> no-op)", async () => {
    const row = seedCronoton();
    const definition = makeDefinition();
    const result = makeSuccessResult();

    const { fireId } = await recordAndFinalizeFire(result, { db, runtime: makeRuntime(), resolver: makeResolver() }, row, definition);

    const { fires } = listFires(row.id, {}, { db });
    expect(fires).toHaveLength(1);
    expect(fires[0].id).toBe(fireId);
    expect(fires[0].status).toBe("success");

    const after = db.prepare(`SELECT status, next_fire_at FROM codex_cronotons WHERE id = ?`).get(row.id) as {
      status: string;
      next_fire_at: string | null;
    };
    expect(after.status).toBe("active");
    expect(after.next_fire_at).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("recordAndFinalizeFire — one-time definition", () => {
  it("applies the computed terminal transition (status + clears next_fire_at) on a successful fire", async () => {
    const row = seedCronoton();
    const definition = makeDefinition({ scheduleKind: "one-time" });
    const result = makeSuccessResult({
      terminalIntent: { status: "completed", clearNextFire: true },
    });

    await recordAndFinalizeFire(result, { db, runtime: makeRuntime(), resolver: makeResolver() }, row, definition);

    const after = db.prepare(`SELECT status, next_fire_at FROM codex_cronotons WHERE id = ?`).get(row.id) as {
      status: string;
      next_fire_at: string | null;
    };
    expect(after.status).toBe("completed");
    expect(after.next_fire_at).toBeNull();
  });

  it("applies the computed terminal transition to 'error' on a genuine on-chain failure, and records a failure fire row", async () => {
    const row = seedCronoton();
    const definition = makeDefinition({ scheduleKind: "one-time" });
    const result = makeFailureResult({
      terminalIntent: { status: "error", clearNextFire: true },
    });

    const { fireId } = await recordAndFinalizeFire(result, { db, runtime: makeRuntime(), resolver: makeResolver() }, row, definition);

    const { fires } = listFires(row.id, {}, { db });
    expect(fires.find((f) => f.id === fireId)?.status).toBe("failure");

    const after = db.prepare(`SELECT status, next_fire_at FROM codex_cronotons WHERE id = ?`).get(row.id) as {
      status: string;
      next_fire_at: string | null;
    };
    expect(after.status).toBe("error");
    expect(after.next_fire_at).toBeNull();
  });
});

describe("recordAndFinalizeFire — audit action + detail", () => {
  it("defaults to the ordinary one-shot audit action names and the plain detail fields", async () => {
    const row = seedCronoton();
    const definition = makeDefinition();
    const result = makeSuccessResult();
    const onAudit = vi.fn();

    const { fireId } = await recordAndFinalizeFire(result, { db, runtime: makeRuntime(), resolver: makeResolver(), onAudit }, row, definition);

    expect(onAudit).toHaveBeenCalledTimes(1);
    const event = onAudit.mock.calls[0][0];
    expect(event.action).toBe("codex_cronoton.fire");
    expect(event.result).toBe("success");
    expect(event.targetKind).toBe("codex_cronoton");
    expect(event.targetId).toBe(row.id);
    expect(event.detail).toMatchObject({
      codexCronotonId: row.id,
      fireId,
      requestKey: "RK-1",
      chainId: "0",
    });
  });

  it("uses a custom auditAction pair and merges auditDetailExtra into the detail payload", async () => {
    const row = seedCronoton();
    const definition = makeDefinition();
    const result = makeFailureResult();
    const onAudit = vi.fn();

    await recordAndFinalizeFire(result, { db, runtime: makeRuntime(), resolver: makeResolver(), onAudit }, row, definition, {
      auditAction: { success: "codex_cronoton.single_tx.fire", failure: "codex_cronoton.single_tx.fire_failed" },
      auditDetailExtra: { actor: "ancient" },
    });

    expect(onAudit).toHaveBeenCalledTimes(1);
    const event = onAudit.mock.calls[0][0];
    expect(event.action).toBe("codex_cronoton.single_tx.fire_failed");
    expect(event.result).toBe("failure");
    expect(event.detail).toMatchObject({ actor: "ancient", errorMessage: "reverted on-chain" });
  });

  it("never calls onAudit when none is supplied", async () => {
    const row = seedCronoton();
    const definition = makeDefinition();
    const result = makeSuccessResult();

    await expect(recordAndFinalizeFire(result, { db, runtime: makeRuntime(), resolver: makeResolver() }, row, definition)).resolves.toMatchObject({
      result,
    });
  });
});

// ── fireAndRecord end-to-end: fire via a real fake ChainRuntime, then record ──

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

describe("fireAndRecord — fires via the real dispatcher, then records + finalizes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executorModule.__clearCeilingCacheForTests();
    currentClient = { dirtyRead, submit, listen };
    universalSignTransaction.mockResolvedValue({ cmd: "{}", hash: "SIGNED-HASH", sigs: [{ sig: "x" }] });
    isSignedTransaction.mockReturnValue(true);
    getKeyPairByPublicKey.mockResolvedValue({ publicKey: PUB_A, privateKey: "deadbeef", seedType: "koala" });
    dirtyRead.mockResolvedValue({ result: { status: "success", data: "OK" }, gas: 100 });
    submit.mockResolvedValue({ requestKey: "RK-LIVE" });
    listen.mockResolvedValue({ result: { status: "success" }, reqKey: "RK-LIVE" });
  });

  it("fires a plain (no serverResolver) definition through the real executor and records exactly one success fire row", async () => {
    const row = seedCronoton();
    const definition = makeDefinition();

    const { result, fireId } = await fireAndRecord(
      { db, runtime: makeRuntime(), resolver: makeResolver() },
      row,
      definition,
    );

    expect(result.ok).toBe(true);
    expect(result.requestKey).toBe("RK-LIVE");

    const { fires } = listFires(row.id, {}, { db });
    expect(fires).toHaveLength(1);
    expect(fires[0].id).toBe(fireId);
    expect(fires[0].status).toBe("success");
  });
});
