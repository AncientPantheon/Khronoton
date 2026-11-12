/**
 * public — the public-observability store surface: token toggle, by-token
 * read, whole-history fire counts, the pure health rule, and the sanitizing
 * projector.
 *
 * Exercised against a REAL in-memory `better-sqlite3` handle (mirroring
 * `schema.test.ts`/`fires.test.ts`'s own `beforeEach`/`installSchema` setup),
 * not a mock — the token round-trip through the unique-indexed column and the
 * aggregate SQL for fire counts both need a real DB to mean anything.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installSchema } from "../schema.js";
import type { CodexCronotonFireRow, CodexCronotonRow } from "../types.js";
import { CodexCronotonValidationError } from "./errors.js";
import {
  deriveCronotonHealth,
  getCodexCronotonByPublicToken,
  getCronotonFireCounts,
  setPublicObservable,
  toPublicCronotonView,
} from "./public.js";

let db: Database.Database;

function seedCronoton(id: string, overrides: Partial<{ status: string }> = {}): void {
  db.prepare(
    `INSERT INTO codex_cronotons
       (id, name, pact_code, config_json, gas_payer_json, signers_json,
        schedule_mode, schedule_config_json, status, created_at, modified_at, created_by)
     VALUES (?, 'Stoicism Minter', '(mint)', '{"chainId":"0"}', '{"type":"gas-station"}',
             '[]', 'daily-at-utc', '{}', ?, '2026-06-11T00:00:00.000Z',
             '2026-06-11T00:00:00.000Z', 'ancient@x')`,
  ).run(id, overrides.status ?? "active");
}

function rawCronotonRow(id: string): { public_token: string | null; public_observable: number } {
  return db
    .prepare(`SELECT public_token, public_observable FROM codex_cronotons WHERE id = ?`)
    .get(id) as { public_token: string | null; public_observable: number };
}

function insertFire(cronotonId: string, firedAt: string, status: string, suffix: string): void {
  db.prepare(
    `INSERT INTO codex_cronoton_fires (id, codex_cronoton_id, fired_at, status)
       VALUES (?, ?, ?, ?)`,
  ).run(`fire-${cronotonId}-${suffix}`, cronotonId, firedAt, status);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  installSchema(db);
});

afterEach(() => {
  db.close();
});

describe("setPublicObservable", () => {
  it("generates a new non-empty token and sets public_observable = 1 on first enable", () => {
    seedCronoton("cc-1");
    setPublicObservable("cc-1", { observable: true }, { db });

    const row = rawCronotonRow("cc-1");
    expect(row.public_observable).toBe(1);
    expect(typeof row.public_token).toBe("string");
    expect(row.public_token).not.toBeNull();
    expect((row.public_token as string).length).toBeGreaterThan(0);
  });

  it("keeps the same public_token across a disable/re-enable toggle (no silent rotation)", () => {
    seedCronoton("cc-2");
    const first = setPublicObservable("cc-2", { observable: true }, { db });

    setPublicObservable("cc-2", { observable: false }, { db });
    const second = setPublicObservable("cc-2", { observable: true }, { db });

    expect(second.publicToken).toBe(first.publicToken);
  });

  it("mints a different token when regenerate: true is passed", () => {
    seedCronoton("cc-3");
    const first = setPublicObservable("cc-3", { observable: true }, { db });

    const second = setPublicObservable(
      "cc-3",
      { observable: true, regenerate: true },
      { db },
    );

    expect(second.publicToken).not.toBe(first.publicToken);
  });

  it("throws CodexCronotonValidationError('not found') for an unknown id", () => {
    expect(() => setPublicObservable("no-such-id", { observable: true }, { db })).toThrow(
      CodexCronotonValidationError,
    );
    expect(() => setPublicObservable("no-such-id", { observable: true }, { db })).toThrow(
      "not found",
    );
  });
});

describe("getCodexCronotonByPublicToken", () => {
  it("returns null for an unknown token", () => {
    expect(getCodexCronotonByPublicToken("unknown-token", { db })).toBeNull();
  });

  it("returns null when the token belongs to a row whose public_observable is currently 0", () => {
    seedCronoton("cc-4");
    const { publicToken } = setPublicObservable("cc-4", { observable: true }, { db });
    setPublicObservable("cc-4", { observable: false }, { db });

    expect(getCodexCronotonByPublicToken(publicToken as string, { db })).toBeNull();
  });

  it("returns the full row when the token belongs to an observable row", () => {
    seedCronoton("cc-5");
    const { publicToken } = setPublicObservable("cc-5", { observable: true }, { db });

    const row = getCodexCronotonByPublicToken(publicToken as string, { db });
    expect(row).not.toBeNull();
    expect(row?.id).toBe("cc-5");
    expect(row?.public_observable).toBe(1);
  });
});

describe("getCronotonFireCounts", () => {
  it("reports fired/succeeded/failed/lastSuccessAt/lastFailureAt and a trailing-only currentFailStreak", () => {
    seedCronoton("cc-6");
    // 5 successes then 2 trailing failures, strictly ascending fired_at.
    insertFire("cc-6", "2026-01-01T00:00:01.000Z", "success", "1");
    insertFire("cc-6", "2026-01-01T00:00:02.000Z", "success", "2");
    insertFire("cc-6", "2026-01-01T00:00:03.000Z", "success", "3");
    insertFire("cc-6", "2026-01-01T00:00:04.000Z", "success", "4");
    insertFire("cc-6", "2026-01-01T00:00:05.000Z", "success", "5");
    insertFire("cc-6", "2026-01-01T00:00:06.000Z", "failure", "6");
    insertFire("cc-6", "2026-01-01T00:00:07.000Z", "failure", "7");

    const counts = getCronotonFireCounts("cc-6", { db });

    expect(counts.fired).toBe(7);
    expect(counts.succeeded).toBe(5);
    expect(counts.failed).toBe(2);
    expect(counts.lastSuccessAt).toBe("2026-01-01T00:00:05.000Z");
    expect(counts.lastFailureAt).toBe("2026-01-01T00:00:07.000Z");
    expect(counts.currentFailStreak).toBe(2);
  });

  it("resets the streak at the most recent non-failure, not a raw history-wide failure tally", () => {
    seedCronoton("cc-7");
    // failure, failure, success, failure — ascending fired_at, so the most
    // recent fire is the trailing failure; only it counts toward the streak.
    insertFire("cc-7", "2026-01-01T00:00:01.000Z", "failure", "1");
    insertFire("cc-7", "2026-01-01T00:00:02.000Z", "failure", "2");
    insertFire("cc-7", "2026-01-01T00:00:03.000Z", "success", "3");
    insertFire("cc-7", "2026-01-01T00:00:04.000Z", "failure", "4");

    const counts = getCronotonFireCounts("cc-7", { db });

    expect(counts.currentFailStreak).toBe(1);
  });

  it("breaks a fired_at tie by INSERTION ORDER (rowid), not by the id column's lexical order", () => {
    seedCronoton("cc-8");
    // Two fires sharing the IDENTICAL fired_at (plausible for a rapid
    // externally-triggered/event-driven cronoton, or any clock coarser than
    // fire frequency). `id` is deliberately chosen so lexical id order
    // DIVERGES from insertion order ("z" > "a" alphabetically, but "z" is
    // inserted FIRST here) — this is the realistic shape of production rows,
    // whose ids are `crypto.randomUUID()` with no correlation to insertion
    // order at all. If the tiebreak wrongly used `id DESC` (lexical), the
    // success row ("z") would sort as "most recent" and the streak would
    // read 0; the correct `rowid DESC` tiebreak instead recovers true
    // insertion order, so the failure (inserted SECOND, higher rowid) is
    // "most recent" and the streak reads 1.
    insertFire("cc-8", "2026-01-01T00:00:01.000Z", "success", "z");
    insertFire("cc-8", "2026-01-01T00:00:01.000Z", "failure", "a");

    const counts = getCronotonFireCounts("cc-8", { db });

    expect(counts.currentFailStreak).toBe(1);
  });

  it("caps currentFailStreak at 1000 rather than scanning/counting beyond it", () => {
    seedCronoton("cc-9");
    // 1001 strictly-ascending-fired_at failures — one past the documented cap.
    for (let i = 0; i < 1001; i += 1) {
      insertFire("cc-9", new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 1000).toISOString(), "failure", String(i));
    }

    const counts = getCronotonFireCounts("cc-9", { db });

    expect(counts.currentFailStreak).toBe(1000);
  });
});

describe("deriveCronotonHealth", () => {
  it.each([
    [{ currentFailStreak: 0, isOverdue: false }, "healthy"],
    [{ currentFailStreak: 1, isOverdue: false }, "degraded"],
    [{ currentFailStreak: 2, isOverdue: false }, "degraded"],
    [{ currentFailStreak: 0, isOverdue: true }, "degraded"],
    [{ currentFailStreak: 3, isOverdue: false }, "down"],
    [{ currentFailStreak: 10, isOverdue: true }, "down"],
  ] as const)("derives %j -> %s", (input, expected) => {
    expect(deriveCronotonHealth(input)).toBe(expected);
  });
});

describe("toPublicCronotonView", () => {
  function secretRow(overrides: Partial<CodexCronotonRow> = {}): CodexCronotonRow {
    return {
      id: "internal-uuid-should-never-appear",
      name: "Public Cronoton",
      description: null,
      pact_code: "SECRET_PACT_CODE",
      config_json: "SECRET_CONFIG_JSON",
      payload_json: "SECRET_PAYLOAD_JSON",
      gas_payer_json: "SECRET_GAS_PAYER_JSON",
      signers_json: "SECRET_SIGNERS_JSON",
      schedule_mode: "daily-at-utc",
      schedule_config_json: JSON.stringify({ mode: "daily-at-utc", hours: [12], minute: 0 }),
      server_resolver: "SECRET_SERVER_RESOLVER",
      external_fireable: 0,
      runtime_arg_keys: null,
      public_token: "pub-token-abc",
      public_observable: 1,
      status: "active",
      next_fire_at: null,
      last_fire_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      modified_at: "2026-01-01T00:00:00.000Z",
      created_by: "SECRET_CREATED_BY",
      ...overrides,
    };
  }

  const zeroCounts = {
    fired: 0,
    succeeded: 0,
    failed: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    currentFailStreak: 0,
  };

  it("never leaks pact_code/payload_json/signers_json/gas_payer_json/server_resolver/created_by/config_json, raw fire error text, or the internal id", () => {
    const secretFire: CodexCronotonFireRow = {
      id: "fire-1",
      firedAt: "2026-01-02T00:00:00.000Z",
      status: "failure",
      requestKey: "req-1",
      chainId: "0",
      errorMessage: "SECRET_ERROR_TEXT",
      chainResponse: { leak: "SECRET_CHAIN_RESPONSE" },
      definitionFingerprint: "fp-1",
      mode: "test",
      recoveredAt: null,
      txKeys: [],
    };
    const firesPage = { fires: [secretFire], total: 1, limit: 20, offset: 0 };

    const view = toPublicCronotonView(
      secretRow(),
      { ...zeroCounts, fired: 1, failed: 1, lastFailureAt: secretFire.firedAt, currentFailStreak: 1 },
      firesPage,
      new Date("2026-01-03T00:00:00.000Z"),
    );

    expect(JSON.stringify(view).includes("SECRET_")).toBe(false);
    expect(view).not.toHaveProperty("id");
    // Value-based, not just name-based: catches the internal id leaking under
    // ANY renamed key (e.g. a future `cronotonId` field), not only a literal
    // top-level `id` property.
    expect(JSON.stringify(view)).not.toContain("internal-uuid-should-never-appear");
  });

  it("sets schedule.humanText via summariseSchedule and omits cron for a daily-at-utc row", async () => {
    const { summariseSchedule } = await import("../../schedule.js");
    const row = secretRow({
      schedule_mode: "daily-at-utc",
      schedule_config_json: JSON.stringify({ mode: "daily-at-utc", hours: [12], minute: 30 }),
    });

    const view = toPublicCronotonView(row, zeroCounts, { fires: [], total: 0, limit: 20, offset: 0 });

    expect(view.schedule.humanText).toBe(
      summariseSchedule("daily-at-utc", { mode: "daily-at-utc", hours: [12], minute: 30 }),
    );
    expect(view.schedule.cron).toBeUndefined();
  });

  it("includes schedule.cron equal to the stored expression for a cron-expression row", async () => {
    const { summariseSchedule } = await import("../../schedule.js");
    const row = secretRow({
      schedule_mode: "cron-expression",
      schedule_config_json: JSON.stringify({ mode: "cron-expression", expression: "0 0 * * *" }),
    });

    const view = toPublicCronotonView(row, zeroCounts, { fires: [], total: 0, limit: 20, offset: 0 });

    expect(view.schedule.cron).toBe("0 0 * * *");
    expect(view.schedule.humanText).toBe(
      summariseSchedule("cron-expression", { mode: "cron-expression", expression: "0 0 * * *" }),
    );
  });

  it("sets triggerOnly: true when external_fireable is 1", () => {
    const row = secretRow({ external_fireable: 1 });
    const view = toPublicCronotonView(row, zeroCounts, { fires: [], total: 0, limit: 20, offset: 0 });
    expect(view.triggerOnly).toBe(true);
  });

  it("sets triggerOnly: true when runtime_arg_keys is non-empty, even with external_fireable: 0", () => {
    const row = secretRow({ external_fireable: 0, runtime_arg_keys: JSON.stringify(["amount"]) });
    const view = toPublicCronotonView(row, zeroCounts, { fires: [], total: 0, limit: 20, offset: 0 });
    expect(view.triggerOnly).toBe(true);
  });

  it("sets triggerOnly: true for a plain eventDriven row (next_fire_at null, no external_fireable/runtime_arg_keys, not terminal)", () => {
    const row = secretRow({
      external_fireable: 0,
      runtime_arg_keys: null,
      status: "active",
      next_fire_at: null,
    });
    const view = toPublicCronotonView(row, zeroCounts, { fires: [], total: 0, limit: 20, offset: 0 });
    expect(view.triggerOnly).toBe(true);
  });

  it("sets triggerOnly: false for a spent terminal one-time row (next_fire_at null but status completed)", () => {
    const row = secretRow({
      external_fireable: 0,
      runtime_arg_keys: null,
      status: "completed",
      next_fire_at: null,
    });
    const view = toPublicCronotonView(row, zeroCounts, { fires: [], total: 0, limit: 20, offset: 0 });
    expect(view.triggerOnly).toBe(false);
  });

  it("sets triggerOnly: false for a terminal one-time row that ended in error (next_fire_at null but status error)", () => {
    const row = secretRow({
      external_fireable: 0,
      runtime_arg_keys: null,
      status: "error",
      next_fire_at: null,
    });
    const view = toPublicCronotonView(row, zeroCounts, { fires: [], total: 0, limit: 20, offset: 0 });
    expect(view.triggerOnly).toBe(false);
  });

  it("sets triggerOnly: false for an ordinary scheduled row (non-null next_fire_at)", () => {
    const row = secretRow({
      external_fireable: 0,
      runtime_arg_keys: null,
      status: "active",
      next_fire_at: "2026-03-01T00:00:00.000Z",
    });
    const view = toPublicCronotonView(row, zeroCounts, { fires: [], total: 0, limit: 20, offset: 0 });
    expect(view.triggerOnly).toBe(false);
  });

  it("wires counts.currentFailStreak + isOverdue into view.health via deriveCronotonHealth (not just testing the pure function in isolation)", () => {
    // 3 trailing failures + overdue -> "down" (deriveCronotonHealth's own
    // table already pins the pure rule; this proves the PROJECTOR actually
    // calls it with the row's real derived isOverdue and the passed-in
    // counts, not e.g. a swapped/dropped argument).
    const row = secretRow({ status: "active", next_fire_at: "2026-01-01T00:00:00.000Z" });
    const view = toPublicCronotonView(
      row,
      { ...zeroCounts, fired: 3, failed: 3, currentFailStreak: 3 },
      { fires: [], total: 0, limit: 20, offset: 0 },
      new Date("2026-02-01T00:00:00.000Z"),
    );
    expect(view.isOverdue).toBe(true);
    expect(view.health).toBe("down");
  });

  it("sets isOverdue: true for an active row whose next_fire_at is before now", () => {
    const row = secretRow({ status: "active", next_fire_at: "2026-01-01T00:00:00.000Z" });
    const view = toPublicCronotonView(
      row,
      zeroCounts,
      { fires: [], total: 0, limit: 20, offset: 0 },
      new Date("2026-02-01T00:00:00.000Z"),
    );
    expect(view.isOverdue).toBe(true);
  });

  it("sets isOverdue: false for a paused row with an equally-past next_fire_at", () => {
    const row = secretRow({ status: "paused", next_fire_at: "2026-01-01T00:00:00.000Z" });
    const view = toPublicCronotonView(
      row,
      zeroCounts,
      { fires: [], total: 0, limit: 20, offset: 0 },
      new Date("2026-02-01T00:00:00.000Z"),
    );
    expect(view.isOverdue).toBe(false);
  });

  it("maps fires.page entries to firedAt/status/chainId/requestKey/txKeys/recoveredAt/mode and passes total/limit/offset through unchanged", () => {
    const fireA: CodexCronotonFireRow = {
      id: "fire-a",
      firedAt: "2026-01-02T00:00:00.000Z",
      status: "success",
      requestKey: "req-a",
      chainId: "0",
      errorMessage: null,
      chainResponse: null,
      definitionFingerprint: "fp-a",
      mode: "live",
      recoveredAt: "2026-01-02T00:01:00.000Z",
      txKeys: [{ kind: "bulk", chainId: "0", requestKey: "req-a" }],
    };
    const firesPage = { fires: [fireA], total: 150, limit: 50, offset: 100 };

    const view = toPublicCronotonView(secretRow(), zeroCounts, firesPage);

    expect(view.fires.page).toEqual([
      {
        firedAt: fireA.firedAt,
        status: fireA.status,
        chainId: fireA.chainId,
        requestKey: fireA.requestKey,
        txKeys: fireA.txKeys,
        recoveredAt: fireA.recoveredAt,
        mode: fireA.mode,
      },
    ]);
    expect(view.fires.total).toBe(150);
    expect(view.fires.limit).toBe(50);
    expect(view.fires.offset).toBe(100);
  });

  it("sets counts.successRatePercent to null when fired is 0", () => {
    const view = toPublicCronotonView(secretRow(), zeroCounts, { fires: [], total: 0, limit: 20, offset: 0 });
    expect(view.counts.successRatePercent).toBeNull();
  });

  it("sets counts.successRatePercent to the rounded succeeded/fired percentage for a non-trivial ratio", () => {
    const view = toPublicCronotonView(
      secretRow(),
      { ...zeroCounts, fired: 3, succeeded: 2, failed: 1 },
      { fires: [], total: 0, limit: 20, offset: 0 },
    );
    // 2/3 = 0.666... -> rounds to 67, not truncates to 66.
    expect(view.counts.successRatePercent).toBe(67);
  });
});
