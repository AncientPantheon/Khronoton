/**
 * fires — record / running / append / finalize / list / recover + the fire-mode seam.
 *
 * Exercised against a REAL in-memory `better-sqlite3` handle (`installSchema` +
 * a raw parent-cronoton seed) so the mode read, the INSERT, and the read-modify-
 * write round-trip through the actual columns — not a recorded-SQL mock. The
 * fire-mode source is the INJECTED `ResolveFireMode` seam (the Hub's
 * `system_state.scoring_live_locked` read is gone), gated FIRST by the parent's
 * `fire_mode_override = 'live'` column.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FireTxKey } from "../types.js";
import { installSchema } from "../schema.js";
import {
  appendFireTxKeys,
  createRunningFire,
  listFires,
  recordFire,
  recoverFire,
} from "./fires.js";

let db: Database.Database;

function seedParent(id = "cc-1"): void {
  db.prepare(
    `INSERT INTO codex_cronotons
       (id, name, pact_code, config_json, gas_payer_json, signers_json,
        schedule_mode, schedule_config_json, status, created_at, modified_at, created_by)
     VALUES (?, 'Stoicism Minter', '(mint)', '{"chainId":"0"}', '{"type":"gas-station"}',
             '[]', 'daily-at-utc', '{}', 'active', '2026-06-11T00:00:00.000Z',
             '2026-06-11T00:00:00.000Z', 'ancient@x')`,
  ).run(id);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  installSchema(db);
  seedParent();
});

afterEach(() => {
  db.close();
});

describe("readFireMode via the injected ResolveFireMode seam", () => {
  it("badges a fire with the seam result when no override is set (seam → 'test')", () => {
    recordFire(fireInput(), { db, resolveFireMode: () => "test" });
    expect(listFires("cc-1", {}, { db }).fires[0]!.mode).toBe("test");
  });

  it("badges a fire LIVE when the seam resolves to 'live'", () => {
    recordFire(fireInput(), { db, resolveFireMode: () => "live" });
    expect(listFires("cc-1", {}, { db }).fires[0]!.mode).toBe("live");
  });

  it("lets the parent fire_mode_override='live' win over a 'test' seam (override is the FIRST gate)", () => {
    db.prepare(`UPDATE codex_cronotons SET fire_mode_override = 'live' WHERE id = 'cc-1'`).run();
    recordFire(fireInput(), { db, resolveFireMode: () => "test" });
    expect(listFires("cc-1", {}, { db }).fires[0]!.mode).toBe("live");
  });

  it("falls through an unrecognised override value ('banana') to the seam ('test')", () => {
    db.prepare(`UPDATE codex_cronotons SET fire_mode_override = 'banana' WHERE id = 'cc-1'`).run();
    recordFire(fireInput(), { db, resolveFireMode: () => "test" });
    expect(listFires("cc-1", {}, { db }).fires[0]!.mode).toBe("test");
  });

  it("backfills a pre-existing fire row (no explicit mode) to 'test' via the schema column default", () => {
    db.prepare(
      `INSERT INTO codex_cronoton_fires
         (id, codex_cronoton_id, fired_at, status, definition_fingerprint)
       VALUES ('old-fire', 'cc-1', '2026-01-01T00:00:00.000Z', 'success', ?)`,
    ).run("a".repeat(64));
    const old = listFires("cc-1", {}, { db }).fires.find((f) => f.id === "old-fire");
    expect(old?.mode).toBe("test");
  });
});

describe("recordFire", () => {
  it("inserts exactly one fire row carrying the passed-in definitionFingerprint", () => {
    const fireId = recordFire(
      { ...fireInput(), definitionFingerprint: "f".repeat(64) },
      { db },
    );
    expect(fireId).toMatch(/.+/);
    const { fires, total } = listFires("cc-1", {}, { db });
    expect(total).toBe(1);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.definitionFingerprint).toBe("f".repeat(64));
  });

  it("bumps the parent's last_fire_at to the fired_at of the recorded fire", () => {
    recordFire({ ...fireInput(), firedAt: "2026-06-08T12:00:00.000Z" }, { db });
    const parent = db
      .prepare(`SELECT last_fire_at FROM codex_cronotons WHERE id = 'cc-1'`)
      .get() as { last_fire_at: string | null };
    expect(parent.last_fire_at).toBe("2026-06-08T12:00:00.000Z");
  });
});

describe("recoverFire", () => {
  it("flips a failure row to success, stamps recovered_at, clears error_message, returns true", () => {
    const fireId = seedFailureFire("stale nginx 504");
    const ok = recoverFire(fireId, "confirmed-rk", { db });
    expect(ok).toBe(true);
    const row = db
      .prepare(
        `SELECT status, request_key, recovered_at, error_message
           FROM codex_cronoton_fires WHERE id = ?`,
      )
      .get(fireId) as {
      status: string;
      request_key: string | null;
      recovered_at: string | null;
      error_message: string | null;
    };
    expect(row.status).toBe("success");
    expect(row.request_key).toBe("confirmed-rk");
    expect(row.recovered_at).not.toBeNull();
    expect(row.error_message).toBeNull();
  });

  it("is idempotent — a second recover on the now-success row is a no-op returning false", () => {
    const fireId = seedFailureFire("boom");
    expect(recoverFire(fireId, "rk-1", { db })).toBe(true);
    expect(recoverFire(fireId, "rk-2", { db })).toBe(false);
    const row = db
      .prepare(`SELECT request_key FROM codex_cronoton_fires WHERE id = ?`)
      .get(fireId) as { request_key: string };
    expect(row.request_key).toBe("rk-1");
  });

  it("returns false when the fire is absent", () => {
    expect(recoverFire("no-such-fire", "rk", { db })).toBe(false);
  });

  it("surfaces recoveredAt through listFires so a recovered fire is distinguishable from a native success", () => {
    const fireId = seedFailureFire("stale nginx 504");
    recoverFire(fireId, "confirmed-rk", { db });
    const recovered = listFires("cc-1", {}, { db }).fires.find((f) => f.id === fireId);
    expect(recovered).toBeDefined();
    expect(recovered!.status).toBe("success");
    expect(recovered!.recoveredAt).not.toBeNull();
  });
});

describe("appendFireTxKeys", () => {
  it("dedups by requestKey so a retried leg upserts (latest ok wins)", () => {
    const fireId = createRunningFire(
      { codexCronotonId: "cc-1", jobId: null, firedAt: iso(), definitionFingerprint: "f".repeat(64) },
      { db },
    );
    const key: FireTxKey = { kind: "burn", chainId: "1", requestKey: "rk-burn" };
    appendFireTxKeys(fireId, [{ ...key, ok: false }], { db });
    appendFireTxKeys(fireId, [{ ...key, ok: true }], { db });

    const txKeys = listFires("cc-1", {}, { db }).fires[0]!.txKeys;
    expect(txKeys).toHaveLength(1);
    expect(txKeys[0]!.requestKey).toBe("rk-burn");
    expect(txKeys[0]!.ok).toBe(true);
  });

  it("no-ops (never throws) when the fire is missing", () => {
    expect(() =>
      appendFireTxKeys("no-such-fire", [{ kind: "bulk", chainId: "0", requestKey: "x" }], { db }),
    ).not.toThrow();
  });
});

function iso(): string {
  return new Date().toISOString();
}

function fireInput() {
  return {
    codexCronotonId: "cc-1",
    jobId: null,
    firedAt: iso(),
    status: "success" as const,
    requestKey: "rk",
    chainId: "0",
    definitionFingerprint: "f".repeat(64),
  };
}

function seedFailureFire(errorMessage: string, id = "fire-fail"): string {
  db.prepare(
    `INSERT INTO codex_cronoton_fires
       (id, codex_cronoton_id, fired_at, status, error_message, definition_fingerprint, mode)
     VALUES (?, 'cc-1', ?, 'failure', ?, ?, 'live')`,
  ).run(id, iso(), errorMessage, "f".repeat(64));
  return id;
}
