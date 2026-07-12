/**
 * cronoton — the commit/read/find/list/edit/pause/resume/delete lifecycle,
 * exercised against a REAL in-memory better-sqlite3 DB (not a SQL-string mock).
 *
 * The schedule-branch selection is driven by REAL data — a genuine past
 * one-time fireAt (no future fire), a genuine malformed every-n-minutes config
 * (InvalidScheduleConfigError), a real trigger-only flag that must SKIP the
 * schedule engine entirely — never by spying on the schedule module.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  commitCodexCronoton,
  deleteCodexCronoton,
  editCodexCronoton,
  findCodexCronotonIdByServerResolver,
  getCodexCronoton,
  listCodexCronotons,
  pauseCodexCronoton,
  resumeCodexCronoton,
  type CommitCodexCronotonInput,
} from "./cronoton.js";
import {
  AutoGasGateError,
  CodexCronotonValidationError,
  TerminalCronotonError,
} from "./errors.js";
import { installSchema } from "../schema.js";
import type { CodexCronotonRow } from "../types.js";
import { computeNextFire, type ScheduleConfig } from "../../schedule.js";

let db: Database.Database;

const EVERY_HOUR: ScheduleConfig = {
  mode: "every-n-minutes",
  startDate: "2026-01-01T00:00:00.000Z",
  intervalMinutes: 60,
};

const FUTURE_ONE_TIME: ScheduleConfig = {
  mode: "one-time",
  fireAt: "2099-01-01T00:00:00.000Z",
};

function validInput(
  overrides: Partial<CommitCodexCronotonInput> = {},
): CommitCodexCronotonInput {
  return {
    name: "My cronoton",
    description: null,
    pactCode: '(coin.transfer "a" "b" 1.0)',
    config: { chainId: "0", gasPrice: 1, gasLimit: 1500, autoGasLimit: false, ttl: 600 },
    payload: {},
    gasPayer: { type: "gas-station" },
    signers: [],
    scheduleMode: "one-time",
    scheduleConfig: FUTURE_ONE_TIME,
    createdBy: "admin@x",
    ...overrides,
  };
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

describe("commitCodexCronoton — validation reject paths", () => {
  it("rejects an empty name BEFORE the schedule engine (name message, not a schedule message)", () => {
    // The scheduleConfig here is ALSO malformed. If the schedule engine ran
    // first the thrown message would be about startDate — asserting it is the
    // name message proves the entry-point name check fires before scheduling.
    let caught: unknown;
    try {
      commitCodexCronoton(
        validInput({
          name: "   ",
          scheduleMode: "every-n-minutes",
          scheduleConfig: {
            mode: "every-n-minutes",
            startDate: "not-a-date",
            intervalMinutes: 60,
          },
        }),
        { now: new Date(), db },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CodexCronotonValidationError);
    expect((caught as Error).message).toMatch(/name/);
    expect((caught as Error).message).not.toMatch(/startDate/);
  });

  it("rejects an AUTO-gas row with no concrete gasLimit (AutoGasGateError)", () => {
    expect(() =>
      commitCodexCronoton(
        validInput({
          config: { chainId: "0", gasPrice: 1, gasLimit: 0, autoGasLimit: true, ttl: 600 },
        }),
        { now: new Date(), db },
      ),
    ).toThrow(AutoGasGateError);
  });

  it("rejects (no-future-fire) for a real PAST one-time fireAt", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    expect(() =>
      commitCodexCronoton(
        validInput({
          scheduleMode: "one-time",
          scheduleConfig: { mode: "one-time", fireAt: "2020-01-01T00:00:00.000Z" },
        }),
        { now, db },
      ),
    ).toThrow(/no future fires/);
  });

  it("rejects (invalid-config) for a genuinely malformed schedule the engine throws on", () => {
    expect(() =>
      commitCodexCronoton(
        validInput({
          scheduleMode: "every-n-minutes",
          scheduleConfig: {
            mode: "every-n-minutes",
            startDate: "not-a-date",
            intervalMinutes: 60,
          },
        }),
        { now: new Date(), db },
      ),
    ).toThrow(CodexCronotonValidationError);
  });

  it("rejects runtimeArgKeys that collide with a fixed payload key", () => {
    expect(() =>
      commitCodexCronoton(
        validInput({ payload: { amount: "1.0" }, runtimeArgKeys: ["amount"] }),
        { now: new Date(), db },
      ),
    ).toThrow(/disjoint/);
  });

  it("rejects a server-resolver row that also declares runtime args", () => {
    expect(() =>
      commitCodexCronoton(
        validInput({ serverResolver: "pool-payout", runtimeArgKeys: ["amount"] }),
        { now: new Date(), db },
      ),
    ).toThrow(/server-resolver/);
  });
});

describe("commitCodexCronoton — trigger-only skips the schedule engine", () => {
  it("externally fireable → next_fire_at NULL, row still inserted", () => {
    const result = commitCodexCronoton(validInput({ externalFireable: true }), {
      now: new Date(),
      db,
    });
    expect(result.nextFireAt).toBeNull();
    const row = getRow(result.id);
    expect(row.next_fire_at).toBeNull();
    expect(row.status).toBe("active");
  });

  it("declares runtime args → next_fire_at NULL (scheduler never picks it up)", () => {
    const result = commitCodexCronoton(
      validInput({ runtimeArgKeys: ["standard-apollo", "smart-apollo"] }),
      { now: new Date(), db },
    );
    expect(result.nextFireAt).toBeNull();
    expect(getRow(result.id).runtime_arg_keys).toBe(
      JSON.stringify(["standard-apollo", "smart-apollo"]),
    );
  });
});

describe("commitCodexCronoton — success", () => {
  it("INSERTs an active row and returns the computed nextFireAt from the real engine", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    const result = commitCodexCronoton(
      validInput({ scheduleMode: "every-n-minutes", scheduleConfig: EVERY_HOUR }),
      { now, db },
    );
    const expected = computeNextFire("every-n-minutes", EVERY_HOUR, now)!.toISOString();
    expect(result.nextFireAt).toBe(expected);
    const row = getRow(result.id);
    expect(row.status).toBe("active");
    expect(row.next_fire_at).toBe(expected);
    expect(row.name).toBe("My cronoton");
  });
});

describe("getCodexCronoton / findCodexCronotonIdByServerResolver", () => {
  it("returns the row for a known id and null for an unknown id", () => {
    const { id } = commitCodexCronoton(validInput(), { now: new Date(), db });
    expect(getCodexCronoton(id, { db })!.id).toBe(id);
    expect(getCodexCronoton("nope", { db })).toBeNull();
  });

  it("finds the cronoton id bound to a server_resolver name (null when unbound)", () => {
    const { id } = commitCodexCronoton(validInput({ serverResolver: "pool-payout" }), {
      now: new Date(),
      db,
    });
    expect(findCodexCronotonIdByServerResolver("pool-payout", { db })).toBe(id);
    expect(findCodexCronotonIdByServerResolver("absent", { db })).toBeNull();
  });
});

describe("listCodexCronotons", () => {
  it("returns rows newest-first, honors a status filter, and clamps the limit floor to 1", () => {
    const a = commitCodexCronoton(validInput({ name: "older" }), {
      now: new Date("2026-01-01T00:00:00.000Z"),
      db,
    });
    const b = commitCodexCronoton(validInput({ name: "newer" }), {
      now: new Date("2026-02-01T00:00:00.000Z"),
      db,
    });
    // Newest created_at first.
    expect(listCodexCronotons({}, { db }).map((r) => r.id)).toEqual([b.id, a.id]);
    // A limit of 0 clamps up to 1 → only the newest row.
    expect(listCodexCronotons({ limit: 0 }, { db }).map((r) => r.id)).toEqual([b.id]);
    // Status filter narrows the result set.
    pauseCodexCronoton(a.id, { db });
    expect(listCodexCronotons({ status: "paused" }, { db }).map((r) => r.id)).toEqual([a.id]);
  });
});

describe("editCodexCronoton", () => {
  it("re-gates AUTO-gas on a config patch (AutoGasGateError)", () => {
    const { id } = commitCodexCronoton(validInput(), { now: new Date(), db });
    expect(() =>
      editCodexCronoton(
        id,
        { config: { chainId: "0", gasPrice: 1, gasLimit: 0, autoGasLimit: true, ttl: 600 } },
        { db },
      ),
    ).toThrow(AutoGasGateError);
  });

  it("NEVER touches status — editing a paused row leaves it paused", () => {
    const { id } = commitCodexCronoton(validInput(), { now: new Date(), db });
    pauseCodexCronoton(id, { db });
    const res = editCodexCronoton(id, { name: "renamed" }, { db });
    expect(res.changedFields).toContain("name");
    expect(getRow(id).status).toBe("paused");
    expect(getRow(id).name).toBe("renamed");
  });

  it("recomputes next_fire_at on a schedule change", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    const { id } = commitCodexCronoton(
      validInput({
        scheduleMode: "every-n-minutes",
        scheduleConfig: {
          mode: "every-n-minutes",
          startDate: "2026-01-01T00:00:00.000Z",
          intervalMinutes: 30,
        },
      }),
      { now, db },
    );
    const res = editCodexCronoton(
      id,
      { scheduleMode: "every-n-minutes", scheduleConfig: EVERY_HOUR },
      { now, db },
    );
    const expected = computeNextFire("every-n-minutes", EVERY_HOUR, now)!.toISOString();
    expect(res.changedFields).toContain("schedule");
    expect(res.nextFireAt).toBe(expected);
    expect(getRow(id).next_fire_at).toBe(expected);
  });

  it("re-asserts runtime-arg disjointness on a payload change", () => {
    const { id } = commitCodexCronoton(
      validInput({ payload: {}, runtimeArgKeys: ["amount"] }),
      { now: new Date(), db },
    );
    expect(() =>
      editCodexCronoton(id, { payload: { amount: "1.0" } }, { db }),
    ).toThrow(/disjoint/);
  });
});

describe("pause / resume", () => {
  it("pause sets status='paused' only, leaving next_fire_at intact", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    const { id, nextFireAt } = commitCodexCronoton(
      validInput({ scheduleMode: "every-n-minutes", scheduleConfig: EVERY_HOUR }),
      { now, db },
    );
    const res = pauseCodexCronoton(id, { db });
    expect(res.status).toBe("paused");
    expect(getRow(id).status).toBe("paused");
    expect(getRow(id).next_fire_at).toBe(nextFireAt);
  });

  it("resume recomputes next_fire_at from NOW (a stale paused row never fire-storms)", () => {
    const commitNow = new Date("2026-06-08T12:00:00.000Z");
    const { id } = commitCodexCronoton(
      validInput({ scheduleMode: "every-n-minutes", scheduleConfig: EVERY_HOUR }),
      { now: commitNow, db },
    );
    pauseCodexCronoton(id, { db });
    const resumeNow = new Date("2026-06-09T09:30:00.000Z");
    const res = resumeCodexCronoton(id, { now: resumeNow, db });
    const expected = computeNextFire("every-n-minutes", EVERY_HOUR, resumeNow)!.toISOString();
    expect(res.status).toBe("active");
    expect(res.nextFireAt).toBe(expected);
    expect(getRow(id).next_fire_at).toBe(expected);
  });

  it("resume of a trigger-only row keeps next_fire_at NULL", () => {
    const { id } = commitCodexCronoton(validInput({ externalFireable: true }), {
      now: new Date(),
      db,
    });
    pauseCodexCronoton(id, { db });
    const res = resumeCodexCronoton(id, { now: new Date(), db });
    expect(res.nextFireAt).toBeNull();
    expect(getRow(id).next_fire_at).toBeNull();
  });

  it("pause and resume both refuse a terminal (completed/error) row", () => {
    const { id } = commitCodexCronoton(validInput(), { now: new Date(), db });
    db.prepare(`UPDATE codex_cronotons SET status = 'completed' WHERE id = ?`).run(id);
    expect(() => pauseCodexCronoton(id, { db })).toThrow(TerminalCronotonError);
    expect(() => resumeCodexCronoton(id, { db })).toThrow(TerminalCronotonError);
  });
});

describe("deleteCodexCronoton", () => {
  it("returns the fire count and cascades the child fire rows", () => {
    const { id } = commitCodexCronoton(validInput(), { now: new Date(), db });
    db.prepare(
      `INSERT INTO codex_cronoton_fires (id, codex_cronoton_id, fired_at, status)
         VALUES (?, ?, ?, ?)`,
    ).run("fire-1", id, new Date().toISOString(), "success");

    const res = deleteCodexCronoton(id, { db });

    expect(res.fireCountAtDelete).toBe(1);
    expect(getCodexCronoton(id, { db })).toBeNull();
    const fire = db
      .prepare(`SELECT id FROM codex_cronoton_fires WHERE id = ?`)
      .get("fire-1");
    expect(fire).toBeUndefined();
  });
});
