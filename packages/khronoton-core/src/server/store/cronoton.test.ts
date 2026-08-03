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
import { fetchDueCodexCronotons } from "./claim.js";
import {
  AutoGasGateError,
  CodexCronotonValidationError,
  TerminalCronotonError,
} from "./errors.js";
import { registerServerResolver } from "../resolvers.js";
import { installSchema } from "../schema.js";
import type { CodexCronotonRow } from "../types.js";
import { computeNextFire, type ScheduleConfig } from "../../schedule.js";

let db: Database.Database;

// A registry-registered EVENTED single-tx resolver — the store reads its `evented`
// flag via getServerResolver to force a bound cronoton scheduleless
// (next_fire_at NULL + external_fireable = 1) regardless of the schedule sent.
// The registry is a module-level singleton that persists across tests, so this
// name is unique and registered once at module eval.
const EVENTED_RESOLVER = "khronoton-evented-store-test-resolver";
registerServerResolver(EVENTED_RESOLVER, {
  kind: "single-tx",
  evented: true,
  resolve: () => ({ plan: [], payload: {} }),
  settle: () => {},
});

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

  // Regression (0.6.1): the list projection must return the FULL row fields that
  // CronotonList renders — `pact_code` (its preview), `schedule_config_json`/
  // `schedule_mode` (schedule line), `description`, `server_resolver`,
  // `runtime_arg_keys`, `next_fire_at`/`last_fire_at`. The old 9-field camelCase
  // projection returned NONE of these under the snake_case names the UI reads,
  // white-screening the admin page on the unguarded `pactPreview(row.pact_code)`.
  it("returns full snake_case rows carrying the fields CronotonList renders (not a camelCase projection)", () => {
    const { id } = commitCodexCronoton(
      validInput({
        name: "n",
        description: "the description",
        pactCode: '(coin.transfer "hot" "cold" 1.0)',
        serverResolver: "r",
        scheduleMode: "every-n-minutes",
        scheduleConfig: EVERY_HOUR,
      }),
      { now: new Date("2026-06-08T12:00:00.000Z"), db },
    );
    const row = listCodexCronotons({}, { db }).find((r) => r.id === id)!;
    // The exact field the crash was on — present and a string, not undefined.
    expect(typeof row.pact_code).toBe("string");
    expect(row.pact_code).toBe('(coin.transfer "hot" "cold" 1.0)');
    // The other snake_case fields the list renders are present too.
    expect(row.description).toBe("the description");
    expect(row.server_resolver).toBe("r");
    expect(row.schedule_mode).toBe("every-n-minutes");
    expect(typeof row.schedule_config_json).toBe("string");
    expect(row).toHaveProperty("next_fire_at");
    expect(row).toHaveProperty("last_fire_at");
    // And NOT the old camelCase projection keys.
    expect(row).not.toHaveProperty("scheduleMode");
    expect(row).not.toHaveProperty("nextFireAt");
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

describe("event-driven server resolvers (scheduler-off via eventDriven)", () => {
  // (a) An event-driven server-resolver create must persist scheduler-off
  // (next_fire_at NULL) so the tick loop's due-query never auto-fires it — even
  // when `now` is past the schedule the Builder still sends. Without threading
  // eventDriven into triggerOnly, a real next_fire_at would be computed and the
  // row would fire on a timer instead of on the host's event.
  it("event-driven create persists next_fire_at NULL and is excluded from fetchDueCodexCronotons", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    const { id, nextFireAt } = commitCodexCronoton(
      validInput({
        serverResolver: "r",
        eventDriven: true,
        scheduleMode: "every-n-minutes",
        scheduleConfig: EVERY_HOUR,
      }),
      { now, db },
    );
    expect(nextFireAt).toBeNull();
    expect(getRow(id).next_fire_at).toBeNull();
    // Positive control: a genuinely-scheduled row committed at the same `now`
    // with a due next_fire_at MUST be returned by the same query — so the
    // event-driven exclusion below is the scheduler-off NULL, not a vacuous
    // "fetchDue returned nothing" pass.
    const { id: scheduledId } = commitCodexCronoton(
      validInput({ scheduleMode: "every-n-minutes", scheduleConfig: EVERY_HOUR }),
      { now, db },
    );
    const due = fetchDueCodexCronotons(new Date("2026-06-08T13:30:00.000Z"), 100, { db });
    const dueIds = due.map((r) => r.id);
    expect(dueIds).toContain(scheduledId);
    expect(dueIds).not.toContain(id);
  });

  // (b) server_resolver + eventDriven must stay ALLOWED (the whole feature), while
  // server_resolver + runtime_arg_keys stays FORBIDDEN — the mutual-exclusion throw
  // must not be broadened to reject event-driven.
  it("server-resolver + eventDriven is allowed; server-resolver + runtimeArgKeys still throws", () => {
    expect(() =>
      commitCodexCronoton(validInput({ serverResolver: "r", eventDriven: true }), {
        now: new Date(),
        db,
      }),
    ).not.toThrow();
    expect(() =>
      commitCodexCronoton(validInput({ serverResolver: "r", runtimeArgKeys: ["x"] }), {
        now: new Date(),
        db,
      }),
    ).toThrow(/server-resolver/);
  });

  // (c) Steady state: editing an already event-driven row (the Builder always resends
  // a schedule block, so scheduleChanged is true) must NOT resurrect a next_fire_at.
  it("editing an event-driven row (eventDriven + schedule patch) keeps next_fire_at NULL", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    const { id } = commitCodexCronoton(
      validInput({ serverResolver: "r", eventDriven: true }),
      { now, db },
    );
    editCodexCronoton(
      id,
      { eventDriven: true, scheduleMode: "every-n-minutes", scheduleConfig: EVERY_HOUR },
      { now, db },
    );
    expect(getRow(id).next_fire_at).toBeNull();
  });

  // (d) Conversion scheduled→event-driven: the row starts with a real next_fire_at;
  // the edit must CLEAR it to NULL so the tick loop stops firing it.
  it("converting a scheduled row to eventDriven (+ schedule patch) clears next_fire_at to NULL", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    const { id, nextFireAt } = commitCodexCronoton(
      validInput({ scheduleMode: "every-n-minutes", scheduleConfig: EVERY_HOUR }),
      { now, db },
    );
    expect(nextFireAt).not.toBeNull();
    editCodexCronoton(
      id,
      {
        serverResolver: "r",
        eventDriven: true,
        scheduleMode: "every-n-minutes",
        scheduleConfig: EVERY_HOUR,
      },
      { now, db },
    );
    expect(getRow(id).next_fire_at).toBeNull();
  });

  // (e) Conversion event-driven→scheduled: the edit patch omits eventDriven (the new
  // resolver is time-based), so the existing scheduleChanged recompute must run and
  // restore a real next_fire_at.
  it("converting an event-driven row to a scheduled resolver (no eventDriven) recomputes a real next_fire_at", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    const { id } = commitCodexCronoton(
      validInput({ serverResolver: "r", eventDriven: true }),
      { now, db },
    );
    expect(getRow(id).next_fire_at).toBeNull();
    const res = editCodexCronoton(
      id,
      { serverResolver: "r2", scheduleMode: "every-n-minutes", scheduleConfig: EVERY_HOUR },
      { now, db },
    );
    const expected = computeNextFire("every-n-minutes", EVERY_HOUR, now)!.toISOString();
    expect(res.nextFireAt).toBe(expected);
    expect(getRow(id).next_fire_at).toBe(expected);
  });

  // (f) Pause→resume of an event-driven cronoton must NOT resurrect a schedule.
  // Pause-to-disable is the sanctioned way to disable a server-resolver cronoton
  // (delete is refused for them), so this is a normal operation. Event-driven
  // persists no distinguishing column — resume must read the row's own
  // next_fire_at NULL as "scheduler-off" and keep it NULL, or the tick loop would
  // silently start auto-firing a host-fired cronoton on a timer it never had.
  it("resume of an event-driven row keeps next_fire_at NULL (does not re-arm the scheduler)", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    const { id } = commitCodexCronoton(
      validInput({
        serverResolver: "r",
        eventDriven: true,
        scheduleMode: "every-n-minutes",
        scheduleConfig: EVERY_HOUR,
      }),
      { now, db },
    );
    expect(getRow(id).next_fire_at).toBeNull();
    pauseCodexCronoton(id, { db });
    const res = resumeCodexCronoton(id, { now: new Date("2026-06-09T09:30:00.000Z"), db });
    expect(res.nextFireAt).toBeNull();
    expect(getRow(id).next_fire_at).toBeNull();
    // And it stays excluded from the due-query after the resume.
    const due = fetchDueCodexCronotons(new Date("2026-06-10T00:00:00.000Z"), 100, { db });
    expect(due.map((r) => r.id)).not.toContain(id);
  });
});

describe("evented server resolvers — store forces scheduleless (server-authoritative)", () => {
  // (a) The registry's `evented` flag — NOT any client-sent eventDriven flag — must
  // make the store commit the row scheduler-off even when the caller sends a real
  // schedule. Without the store reading getServerResolver(...).evented, a real
  // next_fire_at would be computed and the tick loop would auto-fire a host-fired
  // cronoton on a timer it should never have.
  it("(a) commit on an evented resolver with a real schedule → next_fire_at NULL, external_fireable=1, excluded from fetchDue", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    const { id, nextFireAt } = commitCodexCronoton(
      validInput({
        serverResolver: EVENTED_RESOLVER,
        scheduleMode: "every-n-minutes",
        scheduleConfig: EVERY_HOUR,
      }),
      { now, db },
    );
    expect(nextFireAt).toBeNull();
    expect(getRow(id).next_fire_at).toBeNull();
    expect(getRow(id).external_fireable).toBe(1);
    // Positive control: a genuinely-scheduled row committed at the same `now` IS
    // returned by the same query — so the evented exclusion below is the
    // scheduler-off NULL, not a vacuous "fetchDue returned nothing".
    const { id: scheduledId } = commitCodexCronoton(
      validInput({ scheduleMode: "every-n-minutes", scheduleConfig: EVERY_HOUR }),
      { now, db },
    );
    const due = fetchDueCodexCronotons(new Date("2026-06-08T13:30:00.000Z"), 100, { db });
    const dueIds = due.map((r) => r.id);
    expect(dueIds).toContain(scheduledId);
    expect(dueIds).not.toContain(id);
  });

  // (b) The forcing is CONDITIONAL on the resolver being evented — a non-evented
  // resolver (or none) with the same schedule must still compute a real next_fire_at
  // and leave external_fireable at 0, proving (a) is the evented flag at work and not
  // a blanket "server-resolver rows are scheduleless" behavior.
  it("(b) commit on a NON-evented resolver with the same schedule → non-null next_fire_at, external_fireable=0", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    const { id, nextFireAt } = commitCodexCronoton(
      validInput({
        serverResolver: "not-registered-non-evented",
        scheduleMode: "every-n-minutes",
        scheduleConfig: EVERY_HOUR,
      }),
      { now, db },
    );
    const expected = computeNextFire("every-n-minutes", EVERY_HOUR, now)!.toISOString();
    expect(nextFireAt).toBe(expected);
    expect(getRow(id).next_fire_at).toBe(expected);
    expect(getRow(id).external_fireable).toBe(0);
  });

  // (c) One-resolver-one-cronoton: a second commit reusing an already-bound
  // serverResolver must be rejected (the finder returns the newest, so a silent
  // duplicate would shadow the first and fire the wrong template). The message must
  // name the existing cronoton so the operator can delete it. A DIFFERENT resolver
  // is unaffected.
  it("(c) a second commit reusing the same serverResolver throws naming the existing id; a different resolver succeeds", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    const first = commitCodexCronoton(
      validInput({ serverResolver: EVENTED_RESOLVER }),
      { now, db },
    );
    let caught: unknown;
    try {
      commitCodexCronoton(validInput({ serverResolver: EVENTED_RESOLVER }), { now, db });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CodexCronotonValidationError);
    expect((caught as Error).message).toContain(first.id);
    // A different resolver name is unbound → its first commit still succeeds.
    expect(() =>
      commitCodexCronoton(validInput({ serverResolver: "a-different-resolver" }), {
        now,
        db,
      }),
    ).not.toThrow();
  });

  // (d) Editing a normally-scheduled cronoton ONTO the evented resolver (no client
  // eventDriven flag in the patch) must force the row scheduler-off — the store
  // derives evented from the patched serverResolver and clears next_fire_at + sets
  // external_fireable=1, mirroring create.
  it("(d) editing a scheduled row onto the evented resolver (no eventDriven) → next_fire_at NULL, external_fireable=1", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    const { id, nextFireAt } = commitCodexCronoton(
      validInput({ scheduleMode: "every-n-minutes", scheduleConfig: EVERY_HOUR }),
      { now, db },
    );
    expect(nextFireAt).not.toBeNull();
    editCodexCronoton(
      id,
      {
        serverResolver: EVENTED_RESOLVER,
        scheduleMode: "every-n-minutes",
        scheduleConfig: EVERY_HOUR,
      },
      { now, db },
    );
    expect(getRow(id).next_fire_at).toBeNull();
    expect(getRow(id).external_fireable).toBe(1);
  });

  // (e) An evented row is committed scheduler-off; pause→resume must keep it that way.
  // resume reads the row's own next_fire_at NULL as "scheduler-off" and must not
  // re-arm a schedule for a host-fired cronoton.
  it("(e) resume of an evented row keeps next_fire_at NULL", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    const { id } = commitCodexCronoton(
      validInput({
        serverResolver: EVENTED_RESOLVER,
        scheduleMode: "every-n-minutes",
        scheduleConfig: EVERY_HOUR,
      }),
      { now, db },
    );
    expect(getRow(id).next_fire_at).toBeNull();
    pauseCodexCronoton(id, { db });
    const res = resumeCodexCronoton(id, { now: new Date("2026-06-09T09:30:00.000Z"), db });
    expect(res.nextFireAt).toBeNull();
    expect(getRow(id).next_fire_at).toBeNull();
  });

  // (f) A GENUINELY external-fireable row (user-set, NOT via an evented resolver)
  // must keep its external_fireable=1 across an unrelated edit (name change). The
  // edit path now writes external_fireable on every UPDATE, so it must NOT clobber
  // a real HMAC-fire flag — it preserves it because the row's resolver isn't evented.
  it("(f) a non-evented edit of a genuinely external-fireable row preserves external_fireable=1 (and stays scheduler-off)", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    const { id } = commitCodexCronoton(validInput({ externalFireable: true }), { now, db });
    expect(getRow(id).external_fireable).toBe(1);
    expect(getRow(id).next_fire_at).toBeNull();
    editCodexCronoton(id, { name: "renamed, no resolver change" }, { now, db });
    expect(getRow(id).external_fireable).toBe(1);
    expect(getRow(id).next_fire_at).toBeNull();
  });

  // (g) Repointing an evented row ONTO a non-evented scheduled resolver (with a
  // schedule patch) must SHED the evented-forced scheduler-off state: clear
  // external_fireable to 0 AND recompute a real next_fire_at — else the row would
  // sit external_fireable=1 / next_fire_at=NULL forever, never firing on the schedule
  // the caller just set.
  it("(g) editing an evented row onto a non-evented resolver (with schedule) recomputes next_fire_at and clears external_fireable", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    const { id } = commitCodexCronoton(
      validInput({
        serverResolver: EVENTED_RESOLVER,
        scheduleMode: "every-n-minutes",
        scheduleConfig: EVERY_HOUR,
      }),
      { now, db },
    );
    expect(getRow(id).next_fire_at).toBeNull();
    expect(getRow(id).external_fireable).toBe(1);
    editCodexCronoton(
      id,
      {
        serverResolver: "not-registered-non-evented",
        scheduleMode: "every-n-minutes",
        scheduleConfig: EVERY_HOUR,
      },
      { now, db },
    );
    const expected = computeNextFire("every-n-minutes", EVERY_HOUR, now)!.toISOString();
    expect(getRow(id).next_fire_at).toBe(expected);
    expect(getRow(id).external_fireable).toBe(0);
  });

  // (h) The same repoint WITHOUT an explicit schedule patch must still re-arm from
  // the row's stored schedule (else external_fireable=0 + next_fire_at=NULL = a dead
  // row that never fires).
  it("(h) editing an evented row onto a non-evented resolver (no schedule patch) still re-arms from the stored schedule", () => {
    const now = new Date("2026-06-08T12:00:00.000Z");
    const { id } = commitCodexCronoton(
      validInput({
        serverResolver: EVENTED_RESOLVER,
        scheduleMode: "every-n-minutes",
        scheduleConfig: EVERY_HOUR,
      }),
      { now, db },
    );
    expect(getRow(id).next_fire_at).toBeNull();
    editCodexCronoton(id, { serverResolver: "not-registered-non-evented" }, { now, db });
    const expected = computeNextFire("every-n-minutes", EVERY_HOUR, now)!.toISOString();
    expect(getRow(id).next_fire_at).toBe(expected);
    expect(getRow(id).external_fireable).toBe(0);
  });
});
