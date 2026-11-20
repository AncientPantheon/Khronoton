/**
 * yields — the decision-free CRUD layer for `codex_cronoton_run_yields` (the
 * step-to-step yield carry pool, per `docs/work/khronoton-step-yield-carry/
 * design.md`). Exercised against a REAL in-memory better-sqlite3 DB (never a
 * SQL-string mock), mirroring `steps.test.ts`'s own stated rationale: a mock
 * that always reports success cannot prove the `ON CONFLICT(run_id, name)`
 * upsert path is actually hit rather than erroring or duplicating.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getYieldPool, upsertYield } from "./yields.js";
import { installSchema } from "../schema.js";

let db: Database.Database;

/** Raw-SQL-inserted `codex_cronotons` parent row. */
function seedCronoton(id = "cc-1"): void {
  db.prepare(
    `INSERT INTO codex_cronotons
       (id, name, pact_code, config_json, gas_payer_json, signers_json,
        schedule_mode, schedule_config_json, created_at, modified_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, "n", "(code)", "{}", "{}", "[]", "one-time", "{}", "t0", "t0", "op");
}

/** Raw-SQL-inserted `codex_cronoton_runs` row, assuming the cronoton already exists. */
function seedRun(runId = "run-1", cronotonId = "cc-1"): void {
  db.prepare(
    `INSERT INTO codex_cronoton_runs
       (id, codex_cronoton_id, step_count, started_at, modified_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(runId, cronotonId, 3, "t0", "t0");
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  installSchema(db);
  seedCronoton();
  seedRun();
});

afterEach(() => {
  db.close();
});

describe("upsertYield / getYieldPool", () => {
  it("getYieldPool returns {} for a run with zero yields", () => {
    expect(getYieldPool("run-1", { db })).toEqual({});
  });

  it("upsertYield inserts a new (runId, name) row, readable via getYieldPool", () => {
    upsertYield({ runId: "run-1", name: "drainedAmount", value: "123.45", stepIndex: 0 }, { db });

    expect(getYieldPool("run-1", { db })).toEqual({ drainedAmount: "123.45" });
  });

  it("round-trips a string, a number, and a decimal-string value across multiple upserts", () => {
    upsertYield({ runId: "run-1", name: "note", value: "hello", stepIndex: 0 }, { db });
    upsertYield({ runId: "run-1", name: "count", value: 42, stepIndex: 1 }, { db });
    upsertYield({ runId: "run-1", name: "amount", value: "50.0", stepIndex: 2 }, { db });

    expect(getYieldPool("run-1", { db })).toEqual({
      note: "hello",
      count: 42,
      amount: "50.0",
    });
  });

  it("a second upsertYield call with the SAME (runId, name) overwrites value_json/step_index rather than erroring or duplicating", () => {
    upsertYield({ runId: "run-1", name: "drainedAmount", value: "100.0", stepIndex: 0 }, { db });
    upsertYield({ runId: "run-1", name: "drainedAmount", value: "200.0", stepIndex: 1 }, { db });

    expect(getYieldPool("run-1", { db })).toEqual({ drainedAmount: "200.0" });

    const rows = db
      .prepare(`SELECT * FROM codex_cronoton_run_yields WHERE run_id = ? AND name = ?`)
      .all("run-1", "drainedAmount");
    expect(rows).toHaveLength(1);
    expect((rows[0] as { step_index: number }).step_index).toBe(1);
  });

  it("keeps yields scoped per run — a different run's pool is unaffected", () => {
    // A second, distinct cronoton: the self-block partial unique index
    // (schema.ts) permits only one non-terminal run PER cronoton, so a
    // second concurrent run needs its own parent cronoton row.
    seedCronoton("cc-2");
    seedRun("run-2", "cc-2");
    upsertYield({ runId: "run-1", name: "x", value: "a", stepIndex: 0 }, { db });
    upsertYield({ runId: "run-2", name: "x", value: "b", stepIndex: 0 }, { db });

    expect(getYieldPool("run-1", { db })).toEqual({ x: "a" });
    expect(getYieldPool("run-2", { db })).toEqual({ x: "b" });
  });

  it("upsertYield normalizes an undefined value to null instead of crashing JSON.stringify's SQL bind (regression: a confirmed on-chain result with no data field previously threw here, after markLegConfirmed had already committed)", () => {
    expect(() =>
      upsertYield({ runId: "run-1", name: "collected", value: undefined, stepIndex: 0 }, { db }),
    ).not.toThrow();

    expect(getYieldPool("run-1", { db })).toEqual({ collected: null });
  });

  it("a yield legitimately named \"__proto__\" round-trips as an ordinary entry and never pollutes the returned pool's own prototype (regression: getYieldPool builds its map via Object.create(null), not a {} literal)", () => {
    upsertYield({ runId: "run-1", name: "__proto__", value: { polluted: true }, stepIndex: 0 }, { db });

    const pool = getYieldPool("run-1", { db });

    expect(Object.getPrototypeOf(pool)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(pool, "__proto__")).toBe(true);
    expect(pool.__proto__).toEqual({ polluted: true });
    // The global Object.prototype itself must be completely untouched —
    // an ordinary {} elsewhere in the process must never see `polluted`.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
