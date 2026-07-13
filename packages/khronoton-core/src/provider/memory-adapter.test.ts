/**
 * The in-process MemoryAdapter — drives the SAME sixteen `/handlers` functions
 * the fetch adapter targets over HTTP, but with NO network: an internal
 * {@link HandlerContext} over a real in-memory `better-sqlite3` DB.
 *
 * These tests pin the round-trip that proves the adapter drives the REAL
 * handlers (not a mock): a `commit` lands a row the store's own `list`/`get`
 * read back, `fires` echoes the handler's 50-default page window, and the
 * manual-batch start/observe/stop trio flows through `createManualBatch`. The
 * gate test proves the confirm signal threads exactly like the fetch adapter —
 * a mutating call WITHOUT `{ confirmed:true }` surfaces the handler's 401
 * `admin_confirm_required` as a thrown {@link NeedsConfirmError} via the shared
 * `parseHandlerResult`.
 */
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertAdapter, NeedsConfirmError, type KhronotonAdapter } from "./adapter.js";
import { createMemoryAdapter } from "./memory-adapter.js";
import type { CommitBody } from "../handlers/index.js";
import type { Database } from "../server/index.js";

/** A future one-time cronoton — parks with a next fire but no manual batch. */
function oneTimeBody(name = "Memory cronoton"): CommitBody {
  return {
    name,
    description: null,
    envelope: {
      pactCode: '(coin.transfer "a" "b" 1.0)',
      config: { chainId: "0", gasPrice: 1, gasLimit: 1500, autoGasLimit: false, ttl: 600 },
      payload: {},
      gasPayer: { type: "gas-station" },
      signers: [],
    },
    schedule: { mode: "one-time", config: { mode: "one-time", fireAt: "2099-01-01T00:00:00.000Z" } },
  };
}

/** A recurring cronoton — an ACTIVE, non-one-time row a manual batch can attach to. */
function recurringBody(name = "Recurring cronoton"): CommitBody {
  return {
    name,
    description: null,
    envelope: {
      pactCode: '(coin.transfer "a" "b" 1.0)',
      config: { chainId: "0", gasPrice: 1, gasLimit: 1500, autoGasLimit: false, ttl: 600 },
      payload: {},
      gasPayer: { type: "gas-station" },
      signers: [],
    },
    schedule: {
      mode: "every-n-minutes",
      config: { mode: "every-n-minutes", startDate: "2026-01-01T00:00:00.000Z", intervalMinutes: 60 },
    },
  };
}

let db: Database;
let adapter: KhronotonAdapter;

beforeEach(() => {
  // A FRESH, un-migrated db — the adapter installs the schema itself, proving it
  // owns the in-process store setup (a demo/SSR seed needs only a db handle).
  db = new BetterSqlite3(":memory:") as unknown as Database;
  adapter = createMemoryAdapter({ db });
});

afterEach(() => {
  (db as unknown as BetterSqlite3.Database).close();
});

describe("createMemoryAdapter — adapter contract", () => {
  it("satisfies assertAdapter (all sixteen methods present)", () => {
    expect(() => assertAdapter(adapter)).not.toThrow();
  });

  it("serves the read tier with no chain runtime injected (SSR/demo default resolver)", async () => {
    const signers = await adapter.signers();
    expect(signers).toEqual({ ok: true, signers: [] });
  });
});

describe("createMemoryAdapter — commit round-trip through the real handlers", () => {
  it("commits a cronoton the store's own list + get read back", async () => {
    const committed = await adapter.commit(oneTimeBody("Round-trip one"), { confirmed: true });
    expect(typeof committed.codexCronotonId).toBe("string");

    const listed = await adapter.list();
    expect(listed.codexCronotons).toHaveLength(1);
    expect(listed.codexCronotons[0].id).toBe(committed.codexCronotonId);
    expect(listed.codexCronotons[0].name).toBe("Round-trip one");

    const got = await adapter.get(committed.codexCronotonId);
    expect(got.codexCronoton.id).toBe(committed.codexCronotonId);
    expect(got.codexCronoton.name).toBe("Round-trip one");
  });

  it("returns an empty fires page echoing the handler's 50-default window", async () => {
    const committed = await adapter.commit(oneTimeBody(), { confirmed: true });
    const page = await adapter.fires({ id: committed.codexCronotonId });
    expect(page.fires).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.limit).toBe(50);
    expect(page.offset).toBe(0);
  });
});

describe("createMemoryAdapter — manual-batch start/observe/stop", () => {
  it("starts, observes, then cancels a batch on an active recurring cronoton", async () => {
    const { codexCronotonId } = await adapter.commit(recurringBody(), { confirmed: true });

    const started = await adapter.startBatch(codexCronotonId, 5, { confirmed: true });
    expect(started.batch.total).toBe(5);

    const observed = await adapter.getBatch(codexCronotonId);
    expect(observed.batch).not.toBeNull();
    expect(observed.batch?.total).toBe(5);

    const cancelled = await adapter.cancelBatch(codexCronotonId);
    expect(cancelled.cancelled).toBe(true);

    const afterCancel = await adapter.getBatch(codexCronotonId);
    expect(afterCancel.batch).toBeNull();
  });
});

describe("createMemoryAdapter — confirm gate threads through the seam", () => {
  it("throws NeedsConfirmError when a mutating commit omits the fresh confirm", async () => {
    await expect(adapter.commit(oneTimeBody())).rejects.toBeInstanceOf(NeedsConfirmError);
  });

  it("throws NeedsConfirmError for a mutating pause without confirm, but read pause-target is reachable", async () => {
    const { codexCronotonId } = await adapter.commit(recurringBody(), { confirmed: true });
    await expect(adapter.pause(codexCronotonId)).rejects.toBeInstanceOf(NeedsConfirmError);
    // With the confirm threaded, the SAME call passes the gate and settles state.
    const paused = await adapter.pause(codexCronotonId, { confirmed: true });
    expect(paused.status).toBe("paused");
  });
});
