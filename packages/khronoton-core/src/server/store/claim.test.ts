/**
 * claim — the atomic claim-before-fire, exercised against a REAL in-memory
 * better-sqlite3 DB (not a SQL-string mock).
 *
 * The conditional UPDATE is the load-bearing exactly-once guard: two racing
 * claimers of the same due row must see exactly one win, so the real
 * round-trip (seed via raw INSERT after `installSchema`, then re-SELECT) is the
 * only thing that actually proves the double-fire window is closed. A mock that
 * always reports `changes: 1` cannot.
 *
 * Schedule branches are driven by REAL data — a genuine recurring config that
 * `computeNextFire` advances, a genuine garbage `schedule_config_json` that
 * makes `JSON.parse`/`computeNextFire` throw — never by spying on the schedule
 * module.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  advanceRecurring,
  applyTerminalIntent,
  claimDueCodexCronoton,
  fetchDueCodexCronotons,
} from "./claim.js";
import { installSchema } from "../schema.js";
import type { CodexCronotonRow } from "../types.js";
import { computeNextFire, type ScheduleConfig } from "../../schedule.js";

let db: Database.Database;

const EVERY_HOUR: ScheduleConfig = {
  mode: "every-n-minutes",
  startDate: "2026-01-01T00:00:00.000Z",
  intervalMinutes: 60,
};

interface SeedOverrides {
  id?: string;
  schedule_mode?: CodexCronotonRow["schedule_mode"];
  schedule_config_json?: string;
  status?: CodexCronotonRow["status"];
  next_fire_at?: string | null;
  last_fire_at?: string | null;
  runtime_arg_keys?: string | null;
}

function seedCronoton(overrides: SeedOverrides = {}): void {
  const row = {
    id: "cc-1",
    schedule_mode: "every-n-minutes" as CodexCronotonRow["schedule_mode"],
    schedule_config_json: JSON.stringify(EVERY_HOUR),
    status: "active" as CodexCronotonRow["status"],
    next_fire_at: "2026-06-08T11:00:00.000Z",
    last_fire_at: null as string | null,
    runtime_arg_keys: null as string | null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO codex_cronotons
       (id, name, pact_code, config_json, gas_payer_json, signers_json,
        schedule_mode, schedule_config_json, status, next_fire_at, last_fire_at,
        created_at, modified_at, created_by, runtime_arg_keys)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    "n",
    "(code)",
    "{}",
    "{}",
    "[]",
    row.schedule_mode,
    row.schedule_config_json,
    row.status,
    row.next_fire_at,
    row.last_fire_at,
    "t0",
    "t0",
    "op",
    row.runtime_arg_keys,
  );
}

function getRow(id: string): CodexCronotonRow {
  return db
    .prepare(`SELECT * FROM codex_cronotons WHERE id = ?`)
    .get(id) as CodexCronotonRow;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  installSchema(db);
});

afterEach(() => {
  db.close();
});

describe("claimDueCodexCronoton — atomic claim branch selection", () => {
  it("RECURRING advances next_fire_at to computeNextFire evaluated at claim-time now, not the stale stored value", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    seedCronoton({
      id: "r1",
      schedule_mode: "every-n-minutes",
      schedule_config_json: JSON.stringify(EVERY_HOUR),
      next_fire_at: "2026-06-08T11:00:00.000Z",
    });

    const won = claimDueCodexCronoton(getRow("r1"), now, { db });

    const expected = computeNextFire("every-n-minutes", EVERY_HOUR, now)!.toISOString();
    const after = getRow("r1");
    expect(won).toBe(true);
    // The advanced value is computed at the FRESH now, not carried from the row.
    expect(after.next_fire_at).toBe(expected);
    expect(after.next_fire_at).not.toBe("2026-06-08T11:00:00.000Z");
    expect(after.last_fire_at).toBe(now.toISOString());
  });

  it("ONE-TIME clears next_fire_at to NULL so the spent row is un-re-selectable", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    seedCronoton({
      id: "o1",
      schedule_mode: "one-time",
      schedule_config_json: JSON.stringify({
        mode: "one-time",
        fireAt: "2026-06-08T11:00:00.000Z",
      }),
      next_fire_at: "2026-06-08T11:00:00.000Z",
    });

    const won = claimDueCodexCronoton(getRow("o1"), now, { db });

    expect(won).toBe(true);
    expect(getRow("o1").next_fire_at).toBeNull();
  });

  it("RECURRING with corrupt schedule_config_json clears next_fire_at to NULL (JSON.parse throws, caught inside the try — F-003)", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    seedCronoton({
      id: "corrupt1",
      schedule_mode: "every-n-minutes",
      schedule_config_json: "not-json{{{",
      next_fire_at: "2026-06-08T11:00:00.000Z",
    });

    // If JSON.parse sat ABOVE the try, this throws uncaught → the row is never
    // claimed → it re-selects every tick (fire-storm). It must instead be caught
    // and routed to the NULL branch.
    const won = claimDueCodexCronoton(getRow("corrupt1"), now, { db });

    expect(won).toBe(true);
    expect(getRow("corrupt1").next_fire_at).toBeNull();
  });

  it("returns false when the row is no longer due (the conditional WHERE matches 0 rows)", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    seedCronoton({
      id: "future1",
      schedule_mode: "every-n-minutes",
      next_fire_at: "2026-06-08T13:00:00.000Z",
    });

    const won = claimDueCodexCronoton(getRow("future1"), now, { db });

    expect(won).toBe(false);
    // A lost claim writes nothing.
    expect(getRow("future1").next_fire_at).toBe("2026-06-08T13:00:00.000Z");
  });
});

describe("claimDueCodexCronoton — once-only race (the double-fire guard)", () => {
  it("claiming the same due recurring row twice at the same now wins exactly once", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    seedCronoton({
      id: "race1",
      schedule_mode: "every-n-minutes",
      schedule_config_json: JSON.stringify(EVERY_HOUR),
      next_fire_at: "2026-06-08T11:00:00.000Z",
    });
    const row = getRow("race1");

    const first = claimDueCodexCronoton(row, now, { db });
    const second = claimDueCodexCronoton(row, now, { db });

    expect(first).toBe(true);
    // After the first advance next_fire_at sits in the future, so the second
    // claimer's `next_fire_at <= now` predicate no longer matches — no fire.
    expect(second).toBe(false);
  });
});

describe("applyTerminalIntent", () => {
  it("writes status='completed' and clears next_fire_at for a non-null intent", () => {
    seedCronoton({ id: "t1", status: "active", next_fire_at: "2026-06-08T11:00:00.000Z" });

    applyTerminalIntent("t1", { status: "completed", clearNextFire: true }, { db });

    const after = getRow("t1");
    expect(after.status).toBe("completed");
    expect(after.next_fire_at).toBeNull();
  });

  it("writes status='error' for an error terminal intent", () => {
    seedCronoton({ id: "t2", status: "active", next_fire_at: "2026-06-08T11:00:00.000Z" });

    applyTerminalIntent("t2", { status: "error", clearNextFire: true }, { db });

    expect(getRow("t2").status).toBe("error");
  });

  it("is a no-op for a null intent (recurring rows keep their status and next fire)", () => {
    seedCronoton({ id: "t3", status: "active", next_fire_at: "2026-06-08T11:00:00.000Z" });

    applyTerminalIntent("t3", null, { db });

    const after = getRow("t3");
    expect(after.status).toBe("active");
    expect(after.next_fire_at).toBe("2026-06-08T11:00:00.000Z");
  });
});

describe("advanceRecurring", () => {
  it("sets next_fire_at to the given date and last_fire_at to firedAt", () => {
    seedCronoton({ id: "a1", next_fire_at: "2026-06-08T11:00:00.000Z" });
    const nextDate = new Date("2026-06-08T13:00:00.000Z");
    const firedAt = new Date("2026-06-08T12:00:00.000Z");

    advanceRecurring("a1", nextDate, firedAt, { db });

    const after = getRow("a1");
    expect(after.next_fire_at).toBe(nextDate.toISOString());
    expect(after.last_fire_at).toBe(firedAt.toISOString());
  });
});

describe("fetchDueCodexCronotons — due selection", () => {
  it("returns due active fixed rows and excludes runtime-arg, paused, and not-yet-due rows", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    seedCronoton({ id: "due-active", status: "active", next_fire_at: "2026-06-08T11:00:00.000Z" });
    seedCronoton({
      id: "runtime-arg",
      status: "active",
      next_fire_at: "2026-06-08T11:00:00.000Z",
      runtime_arg_keys: '["standard-apollo"]',
    });
    seedCronoton({ id: "paused", status: "paused", next_fire_at: "2026-06-08T11:00:00.000Z" });
    seedCronoton({ id: "not-due", status: "active", next_fire_at: "2026-06-08T13:00:00.000Z" });

    const rows = fetchDueCodexCronotons(now, 100, { db });

    expect(rows.map((r) => r.id)).toEqual(["due-active"]);
  });
});
