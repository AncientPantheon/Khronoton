/**
 * manual-batch — the create / due-fetch / claim / cancel lifecycle for
 * `codex_cronoton_manual_batches`, exercised against a REAL in-memory
 * better-sqlite3 DB (not a SQL-string mock).
 *
 * The atomic slot claim (`claimManualBatchFire`) is a single conditional UPDATE
 * whose once-only guarantee can only be proven against a real DB: two claims on
 * the same due slot see exactly one win. The last-slot completion (status flips
 * to 'completed' + next_at NULL in the SAME statement) is likewise a real-round-
 * trip assertion.
 */
import crypto from "node:crypto";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cancelManualBatch,
  claimManualBatchFire,
  createManualBatch,
  fetchDueManualBatches,
  getActiveManualBatchForCronoton,
  getManualBatch,
} from "./manual-batch.js";
import { CodexCronotonValidationError, ManualBatchActiveError } from "./errors.js";
import { installSchema } from "../schema.js";
import type { CodexManualBatchRow } from "../types.js";

let db: Database.Database;

function seedParent(
  overrides: { status?: string; scheduleMode?: string } = {},
): string {
  const id = crypto.randomUUID();
  const status = overrides.status ?? "active";
  const scheduleMode = overrides.scheduleMode ?? "every-n-minutes";
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO codex_cronotons
       (id, name, pact_code, config_json, gas_payer_json, signers_json,
        schedule_mode, schedule_config_json, status, created_at, modified_at, created_by)
       VALUES (?, ?, ?, '{}', '{}', '[]', ?, '{}', ?, ?, ?, 'admin@x')`,
  ).run(id, "parent", "(coin.details)", scheduleMode, status, nowIso, nowIso);
  return id;
}

/** Seed a batch row directly (bypassing createManualBatch's guards). */
function seedBatch(
  cronotonId: string,
  fields: {
    total: number;
    completed: number;
    status?: string;
    nextAt?: string | null;
    intervalSeconds?: number;
  },
): CodexManualBatchRow {
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO codex_cronoton_manual_batches
       (id, codex_cronoton_id, total, completed, interval_seconds, status,
        next_at, created_at, modified_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin@x')`,
  ).run(
    id,
    cronotonId,
    fields.total,
    fields.completed,
    fields.intervalSeconds ?? 60,
    fields.status ?? "active",
    fields.nextAt === undefined ? nowIso : fields.nextAt,
    nowIso,
    nowIso,
  );
  return getManualBatch(id, { db })!;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  installSchema(db);
});

afterEach(() => {
  db.close();
});

describe("createManualBatch — validation", () => {
  it("rejects a count below the minimum with the between-bounds message", () => {
    const cronotonId = seedParent();
    let caught: unknown;
    try {
      createManualBatch({ cronotonId, total: 1, createdBy: "admin@x" }, { db });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CodexCronotonValidationError);
    expect((caught as Error).message).toMatch(/between 2 and 60/);
  });

  it("rejects a count above the maximum with the between-bounds message", () => {
    const cronotonId = seedParent();
    expect(() =>
      createManualBatch({ cronotonId, total: 61, createdBy: "admin@x" }, { db }),
    ).toThrow(/between 2 and 60/);
  });

  it("rejects a non-integer count (Math.trunc floors below the minimum)", () => {
    const cronotonId = seedParent();
    expect(() =>
      createManualBatch({ cronotonId, total: 1.9, createdBy: "admin@x" }, { db }),
    ).toThrow(/between 2 and 60/);
  });

  it("rejects a one-time parent (a single fire spends it)", () => {
    const cronotonId = seedParent({ scheduleMode: "one-time" });
    expect(() =>
      createManualBatch({ cronotonId, total: 5, createdBy: "admin@x" }, { db }),
    ).toThrow(/one-time/);
  });

  it("rejects a non-active parent, naming the offending status", () => {
    const cronotonId = seedParent({ status: "paused" });
    expect(() =>
      createManualBatch({ cronotonId, total: 5, createdBy: "admin@x" }, { db }),
    ).toThrow(/status 'paused'/);
  });

  it("rejects a second batch while one is already active (ManualBatchActiveError)", () => {
    const cronotonId = seedParent();
    createManualBatch({ cronotonId, total: 5, createdBy: "admin@x" }, { db });
    expect(() =>
      createManualBatch({ cronotonId, total: 3, createdBy: "admin@x" }, { db }),
    ).toThrow(ManualBatchActiveError);
  });
});

describe("createManualBatch — happy path", () => {
  it("INSERTs an active batch with next_at=now (fire ASAP) and the default 60s cadence", () => {
    const cronotonId = seedParent();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const batch = createManualBatch(
      { cronotonId, total: 4, createdBy: "admin@x" },
      { db, now },
    );
    expect(batch.total).toBe(4);
    expect(batch.completed).toBe(0);
    expect(batch.interval_seconds).toBe(60);
    expect(batch.status).toBe("active");
    expect(batch.next_at).toBe(now.toISOString());
    // The row is discoverable as the cronoton's one active batch.
    expect(getActiveManualBatchForCronoton(cronotonId, { db })!.id).toBe(batch.id);
  });

  it("honors an injected config.manualBatch — new bounds and cadence take effect", () => {
    const cronotonId = seedParent();
    const config = { manualBatch: { min: 5, max: 10, intervalSeconds: 30 } };
    // 3 is valid under the defaults (2..60) but rejected under the injected 5..10.
    expect(() =>
      createManualBatch(
        { cronotonId, total: 3, createdBy: "admin@x" },
        { db, config },
      ),
    ).toThrow(/between 5 and 10/);
    // A count inside the injected window seeds the injected 30s cadence.
    const batch = createManualBatch(
      { cronotonId, total: 5, createdBy: "admin@x" },
      { db, config },
    );
    expect(batch.interval_seconds).toBe(30);
  });
});

describe("getManualBatch", () => {
  it("returns null for an unknown id", () => {
    expect(getManualBatch("nope", { db })).toBeNull();
  });
});

describe("fetchDueManualBatches", () => {
  it("returns active batches with a due slot oldest-first and skips future/inactive ones", () => {
    const cronotonId = seedParent();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const due = seedBatch(cronotonId, {
      total: 5,
      completed: 0,
      nextAt: "2026-06-08T11:00:00.000Z",
    });
    // Not due yet (next_at in the future).
    seedBatch(cronotonId, {
      total: 5,
      completed: 0,
      nextAt: "2026-06-08T13:00:00.000Z",
    });
    // Cancelled — never selected.
    seedBatch(cronotonId, {
      total: 5,
      completed: 0,
      status: "cancelled",
      nextAt: "2026-06-08T10:00:00.000Z",
    });
    const rows = fetchDueManualBatches(now, 100, { db });
    expect(rows.map((r) => r.id)).toEqual([due.id]);
  });
});

describe("claimManualBatchFire — the atomic slot claim", () => {
  it("wins a due slot: increments completed and advances next_at by one interval", () => {
    const cronotonId = seedParent();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const batch = seedBatch(cronotonId, {
      total: 5,
      completed: 0,
      nextAt: now.toISOString(),
      intervalSeconds: 60,
    });

    expect(claimManualBatchFire(batch, now, { db })).toBe(true);

    const after = getManualBatch(batch.id, { db })!;
    expect(after.completed).toBe(1);
    expect(after.status).toBe("active");
    expect(after.next_at).toBe(
      new Date(now.getTime() + 60 * 1000).toISOString(),
    );
  });

  it("loses when the slot is not yet due (now before next_at)", () => {
    const cronotonId = seedParent();
    const dueAt = new Date("2026-06-08T12:00:00.000Z");
    const batch = seedBatch(cronotonId, {
      total: 5,
      completed: 0,
      nextAt: dueAt.toISOString(),
    });
    const tooEarly = new Date(dueAt.getTime() - 1000);
    expect(claimManualBatchFire(batch, tooEarly, { db })).toBe(false);
    expect(getManualBatch(batch.id, { db })!.completed).toBe(0);
  });

  it("loses when completed already equals total", () => {
    const cronotonId = seedParent();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const batch = seedBatch(cronotonId, {
      total: 2,
      completed: 2,
      nextAt: now.toISOString(),
    });
    expect(claimManualBatchFire(batch, now, { db })).toBe(false);
  });

  it("flips status to 'completed' and next_at to NULL on the LAST slot, in the same claim", () => {
    const cronotonId = seedParent();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const batch = seedBatch(cronotonId, {
      total: 2,
      completed: 1,
      nextAt: now.toISOString(),
    });

    expect(claimManualBatchFire(batch, now, { db })).toBe(true);

    const after = getManualBatch(batch.id, { db })!;
    expect(after.completed).toBe(2);
    expect(after.status).toBe("completed");
    expect(after.next_at).toBeNull();
  });

  it("guards the once-only slot: two claims on the same due slot yield one win", () => {
    const cronotonId = seedParent();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const batch = seedBatch(cronotonId, {
      total: 5,
      completed: 0,
      nextAt: now.toISOString(),
    });

    // Same stale row object, same now — the WHERE predicate re-reads DB state.
    expect(claimManualBatchFire(batch, now, { db })).toBe(true);
    expect(claimManualBatchFire(batch, now, { db })).toBe(false);
    expect(getManualBatch(batch.id, { db })!.completed).toBe(1);
  });
});

describe("cancelManualBatch", () => {
  it("cancels an active batch (ok:true) and clears next_at", () => {
    const cronotonId = seedParent();
    const batch = seedBatch(cronotonId, { total: 5, completed: 0 });
    expect(cancelManualBatch(batch.id, { db })).toEqual({ ok: true });
    const after = getManualBatch(batch.id, { db })!;
    expect(after.status).toBe("cancelled");
    expect(after.next_at).toBeNull();
  });

  it("no-ops a non-active batch (ok:false)", () => {
    const cronotonId = seedParent();
    const batch = seedBatch(cronotonId, {
      total: 5,
      completed: 5,
      status: "completed",
    });
    expect(cancelManualBatch(batch.id, { db })).toEqual({ ok: false });
  });
});
