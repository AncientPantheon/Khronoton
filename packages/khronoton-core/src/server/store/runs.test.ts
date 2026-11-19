/**
 * runs — the `codex_cronoton_runs` + `codex_cronoton_run_legs` CRUD layer,
 * exercised against a REAL in-memory better-sqlite3 DB (never a SQL-string
 * mock), mirroring `claim.test.ts`'s own stated rationale: a mock that always
 * reports `changes: 1` cannot prove the double-fire window — here, the
 * self-block window — is actually closed.
 *
 * NOTE on what the "exactly one row" test below does NOT prove: unlike
 * `claim.test.ts`'s own two-racing-claimers proof (which passes the SAME
 * pre-fetched, now-stale row to two calls to prove the conditional UPDATE
 * re-validates against live DB state rather than a caller's stale view),
 * `createRun` takes no prior-state snapshot at all — there is no "stale view
 * vs. live state" dimension to exercise, and better-sqlite3's synchronous,
 * single-threaded execution means two sequential calls never actually
 * interleave. The test below pins "exactly one row ends up in the table"
 * for two back-to-back calls; it does NOT demonstrate concurrent-execution
 * safety the way `claim.test.ts`'s pattern does, because `createRun`'s
 * shape (a single INSERT relying on the DB's own constraint) has no
 * check-then-write gap for interleaving to even land in.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  advanceRunStep,
  bumpRunAttempt,
  claimLegForSubmit,
  createRun,
  getRun,
  insertRunLeg,
  listInFlightRuns,
  listRunLegs,
  listRunsForCronoton,
  markLegConfirmed,
  markLegFailed,
  markLegSubmitted,
  markRunTerminal,
  releaseLegClaim,
  touchRunDeadline,
} from "./runs.js";
import {
  LegAlreadySubmittedError,
  LegNotSubmittedError,
  RunAlreadyInFlightError,
  RunAlreadyTerminalError,
  RunLegAlreadyExistsError,
  RunStepMismatchError,
} from "./errors.js";
import { installSchema } from "../schema.js";

let db: Database.Database;

/** Raw-SQL-inserted `codex_cronotons` parent row, mirroring `steps.test.ts`'s own `seedCronoton` helper. */
function seedCronoton(id = "cc-1"): void {
  db.prepare(
    `INSERT INTO codex_cronotons
       (id, name, pact_code, config_json, gas_payer_json, signers_json,
        schedule_mode, schedule_config_json, status, next_fire_at, last_fire_at,
        created_at, modified_at, created_by, runtime_arg_keys)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "n",
    "(code)",
    "{}",
    "{}",
    "[]",
    "every-n-minutes",
    JSON.stringify({ mode: "every-n-minutes", startDate: "2026-01-01T00:00:00.000Z", intervalMinutes: 60 }),
    "active",
    null,
    null,
    "t0",
    "t0",
    "op",
    null,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  installSchema(db);
  seedCronoton();
});

afterEach(() => {
  db.close();
});

describe("createRun / getRun", () => {
  it("creates a new run for a cronoton with no existing run, reading back planning/0/stepCount", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });

    const row = getRun(runId, { db });

    expect(row).not.toBeNull();
    expect(row!.id).toBe(runId);
    expect(row!.codex_cronoton_id).toBe("cc-1");
    expect(row!.status).toBe("planning");
    expect(row!.step_index).toBe(0);
    expect(row!.step_count).toBe(3);
  });
});

describe("createRun — self-block while a run is non-terminal", () => {
  it("throws RunAlreadyInFlightError (typed, not a raw SqliteError) and leaves the first run's row completely unchanged", () => {
    const firstId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    const before = getRun(firstId, { db });

    expect(() => createRun({ codexCronotonId: "cc-1", stepCount: 5 }, { db })).toThrow(
      RunAlreadyInFlightError,
    );

    const after = getRun(firstId, { db });
    expect(after).toEqual(before);
  });

  it.each(["succeeded", "failed", "abandoned"] as const)(
    "allows a new createRun once the first run's status is updated to the terminal value '%s'",
    (terminalStatus) => {
      const firstId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
      db.prepare(`UPDATE codex_cronoton_runs SET status = ? WHERE id = ?`).run(
        terminalStatus,
        firstId,
      );

      const secondId = createRun({ codexCronotonId: "cc-1", stepCount: 2 }, { db });

      expect(secondId).not.toBe(firstId);
      expect(getRun(secondId, { db })!.status).toBe("planning");
    },
  );
});

describe("createRun — exactly one row survives two back-to-back calls (sequential, not a concurrency proof — see module doc above)", () => {
  it("exactly one of two back-to-back createRun calls for the same cronoton succeeds, and exactly one row exists afterward", () => {
    // Two SEQUENTIAL calls with no status update between them. This pins
    // "the partial unique index rejects a second non-terminal run no matter
    // how soon after the first," but does NOT exercise any interleaving —
    // better-sqlite3 is synchronous, so there is no window for these two
    // calls to race inside. See the module doc comment for what this
    // deliberately does not claim to prove.
    let firstResult: { ok: true; id: string } | { ok: false; error: unknown };
    let secondResult: { ok: true; id: string } | { ok: false; error: unknown };

    try {
      firstResult = { ok: true, id: createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db }) };
    } catch (error) {
      firstResult = { ok: false, error };
    }
    try {
      secondResult = { ok: true, id: createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db }) };
    } catch (error) {
      secondResult = { ok: false, error };
    }

    const results = [firstResult, secondResult];
    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as { ok: false; error: unknown }).error).toBeInstanceOf(
      RunAlreadyInFlightError,
    );

    const rows = db
      .prepare(`SELECT id FROM codex_cronoton_runs WHERE codex_cronoton_id = ?`)
      .all("cc-1");
    expect(rows).toHaveLength(1);
  });
});

describe("insertRunLeg", () => {
  it("creates a pending leg with a NULL request_key before any request key is known", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });

    const legId = insertRunLeg(
      { runId, stepIndex: 0, legIndex: 0, definitionJson: '{"pactCode":"(+ 1 1)"}' },
      { db },
    );

    const [leg] = listRunLegs(runId, { db });
    expect(leg.id).toBe(legId);
    expect(leg.status).toBe("pending");
    expect(leg.request_key).toBeNull();
    expect(leg.definition_json).toBe('{"pactCode":"(+ 1 1)"}');
  });

  it("throws the typed RunLegAlreadyExistsError (not a raw SqliteError) on a second insert for the same (runId, stepIndex, legIndex) slot", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    insertRunLeg({ runId, stepIndex: 0, legIndex: 0, definitionJson: "{}" }, { db });

    expect(() =>
      insertRunLeg({ runId, stepIndex: 0, legIndex: 0, definitionJson: "{}" }, { db }),
    ).toThrow(RunLegAlreadyExistsError);

    // The first leg is untouched — exactly one leg exists at this slot.
    expect(listRunLegs(runId, { db })).toHaveLength(1);
  });
});

describe("markLegSubmitted — never re-submit, only poll", () => {
  it("flips a pending leg to submitted, stamping request_key/chain_id/submitted_at", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    const legId = insertRunLeg(
      { runId, stepIndex: 0, legIndex: 0, definitionJson: "{}" },
      { db },
    );

    markLegSubmitted(legId, { requestKey: "abc", chainId: "0" }, { db });

    const [leg] = listRunLegs(runId, { db });
    expect(leg.status).toBe("submitted");
    expect(leg.request_key).toBe("abc");
    expect(leg.chain_id).toBe("0");
    expect(leg.submitted_at).not.toBeNull();
  });

  it("throws LegAlreadySubmittedError on a second submit attempt, rather than overwriting the existing request_key", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    const legId = insertRunLeg(
      { runId, stepIndex: 0, legIndex: 0, definitionJson: "{}" },
      { db },
    );
    markLegSubmitted(legId, { requestKey: "abc", chainId: "0" }, { db });

    expect(() =>
      markLegSubmitted(legId, { requestKey: "accidental-resubmit", chainId: "0" }, { db }),
    ).toThrow(LegAlreadySubmittedError);

    const [leg] = listRunLegs(runId, { db });
    expect(leg.request_key).toBe("abc");
  });
});

describe("claimLegForSubmit / releaseLegClaim — the real claim-before-submit step (Phase 5 fix)", () => {
  it("claims a pending, unclaimed leg exactly once — a second concurrent claim attempt on the SAME leg fails", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    const legId = insertRunLeg({ runId, stepIndex: 0, legIndex: 0, definitionJson: "{}" }, { db });

    const firstClaim = claimLegForSubmit(legId, "2026-01-01T00:00:00.000Z", { db });
    const secondClaim = claimLegForSubmit(legId, "2026-01-01T00:00:01.000Z", { db });

    expect(firstClaim).toBe(true);
    expect(secondClaim).toBe(false);
    const [leg] = listRunLegs(runId, { db });
    // The FIRST claimant's timestamp wins; the second claim never touched the row.
    expect(leg.claimed_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("releaseLegClaim clears claimed_at, letting a LATER pass successfully re-claim the still-pending leg", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    const legId = insertRunLeg({ runId, stepIndex: 0, legIndex: 0, definitionJson: "{}" }, { db });
    claimLegForSubmit(legId, "2026-01-01T00:00:00.000Z", { db });

    releaseLegClaim(legId, { db });
    const reclaimed = claimLegForSubmit(legId, "2026-01-01T00:00:05.000Z", { db });

    expect(reclaimed).toBe(true);
    const [leg] = listRunLegs(runId, { db });
    expect(leg.claimed_at).toBe("2026-01-01T00:00:05.000Z");
  });

  it("cannot claim a leg that is no longer pending (already submitted), even with no prior claim", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    const legId = insertRunLeg({ runId, stepIndex: 0, legIndex: 0, definitionJson: "{}" }, { db });
    markLegSubmitted(legId, { requestKey: "abc", chainId: "0" }, { db });

    const claimed = claimLegForSubmit(legId, "2026-01-01T00:00:00.000Z", { db });

    expect(claimed).toBe(false);
  });
});

describe("markLegConfirmed / markLegFailed", () => {
  it("markLegConfirmed flips a submitted leg to confirmed and stamps confirmed_at", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    const legId = insertRunLeg(
      { runId, stepIndex: 0, legIndex: 0, definitionJson: "{}" },
      { db },
    );
    markLegSubmitted(legId, { requestKey: "abc", chainId: "0" }, { db });

    markLegConfirmed(legId, { db });

    const [leg] = listRunLegs(runId, { db });
    expect(leg.status).toBe("confirmed");
    expect(leg.confirmed_at).not.toBeNull();
  });

  it("markLegFailed flips a submitted leg to failed and stamps error_message", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    const legId = insertRunLeg(
      { runId, stepIndex: 0, legIndex: 0, definitionJson: "{}" },
      { db },
    );
    markLegSubmitted(legId, { requestKey: "abc", chainId: "0" }, { db });

    markLegFailed(legId, { errorMessage: "chain rejected" }, { db });

    const [leg] = listRunLegs(runId, { db });
    expect(leg.status).toBe("failed");
    expect(leg.error_message).toBe("chain rejected");
  });

  it("markLegConfirmed throws LegNotSubmittedError on a still-pending leg (never submitted to chain)", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    const legId = insertRunLeg(
      { runId, stepIndex: 0, legIndex: 0, definitionJson: "{}" },
      { db },
    );

    expect(() => markLegConfirmed(legId, { db })).toThrow(LegNotSubmittedError);

    const [leg] = listRunLegs(runId, { db });
    expect(leg.status).toBe("pending");
    expect(leg.confirmed_at).toBeNull();
  });

  it("markLegFailed throws LegNotSubmittedError on an already-confirmed leg (never silently overwrites a terminal success)", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    const legId = insertRunLeg(
      { runId, stepIndex: 0, legIndex: 0, definitionJson: "{}" },
      { db },
    );
    markLegSubmitted(legId, { requestKey: "abc", chainId: "0" }, { db });
    markLegConfirmed(legId, { db });

    expect(() => markLegFailed(legId, { errorMessage: "late rejection" }, { db })).toThrow(
      LegNotSubmittedError,
    );

    const [leg] = listRunLegs(runId, { db });
    expect(leg.status).toBe("confirmed");
    expect(leg.error_message).toBeNull();
  });

  it("markLegConfirmed throws LegNotSubmittedError on an already-failed leg (never resurrects a terminal failure)", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    const legId = insertRunLeg(
      { runId, stepIndex: 0, legIndex: 0, definitionJson: "{}" },
      { db },
    );
    markLegSubmitted(legId, { requestKey: "abc", chainId: "0" }, { db });
    markLegFailed(legId, { errorMessage: "chain rejected" }, { db });

    expect(() => markLegConfirmed(legId, { db })).toThrow(LegNotSubmittedError);

    const [leg] = listRunLegs(runId, { db });
    expect(leg.status).toBe("failed");
    expect(leg.confirmed_at).toBeNull();
  });
});

describe("listRunLegs — ordering", () => {
  it("returns every leg for a run ordered by (step_index, leg_index) ascending regardless of insertion order", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    insertRunLeg({ runId, stepIndex: 1, legIndex: 1, definitionJson: "{}" }, { db });
    insertRunLeg({ runId, stepIndex: 0, legIndex: 1, definitionJson: "{}" }, { db });
    insertRunLeg({ runId, stepIndex: 1, legIndex: 0, definitionJson: "{}" }, { db });
    insertRunLeg({ runId, stepIndex: 0, legIndex: 0, definitionJson: "{}" }, { db });

    const legs = listRunLegs(runId, { db });

    expect(legs.map((l) => [l.step_index, l.leg_index])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
  });
});

describe("listInFlightRuns — the non-terminal-status read backing advanceInFlightRunsOnce", () => {
  it("returns planning and advancing runs (each for a different cronoton) but excludes a succeeded one, ordered by modified_at ascending", () => {
    seedCronoton("cc-2");
    seedCronoton("cc-3");

    // Seed out of modified_at order: the run that ends up LAST in
    // modified_at is created FIRST, proving the ORDER BY isn't just
    // insertion order.
    const succeededId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    db.prepare(`UPDATE codex_cronoton_runs SET status = 'succeeded' WHERE id = ?`).run(
      succeededId,
    );

    const advancingId = createRun({ codexCronotonId: "cc-2", stepCount: 2 }, { db });
    db.prepare(
      `UPDATE codex_cronoton_runs SET status = 'advancing', modified_at = ? WHERE id = ?`,
    ).run("2026-01-01T00:00:02.000Z", advancingId);

    const planningId = createRun({ codexCronotonId: "cc-3", stepCount: 2 }, { db });
    db.prepare(`UPDATE codex_cronoton_runs SET modified_at = ? WHERE id = ?`).run(
      "2026-01-01T00:00:01.000Z",
      planningId,
    );

    const rows = listInFlightRuns({ db });

    expect(rows.map((r) => r.id)).toEqual([planningId, advancingId]);
    expect(rows.map((r) => r.status)).toEqual(["planning", "advancing"]);
  });
});

describe("advanceRunStep — the conditional-UPDATE guard one level up from markLegSubmitted", () => {
  it("advancing to fromStepIndex + 1 updates step_index, resets a nonzero attempt to 0, and sets deadline_at", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    // T1 adds no attempt-bumping write — seed a nonzero attempt directly via
    // raw SQL to prove advanceRunStep resets it.
    db.prepare(`UPDATE codex_cronoton_runs SET attempt = 2 WHERE id = ?`).run(runId);

    advanceRunStep(
      runId,
      { fromStepIndex: 0, toStepIndex: 1, deadlineAt: "2026-02-01T00:00:00.000Z" },
      { db },
    );

    const row = getRun(runId, { db });
    expect(row!.step_index).toBe(1);
    expect(row!.attempt).toBe(0);
    expect(row!.deadline_at).toBe("2026-02-01T00:00:00.000Z");
  });

  it("called with toStepIndex === fromStepIndex leaves step_index unchanged but still updates deadline_at/modified_at (stamping a fresh deadline on the current step)", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    const before = getRun(runId, { db })!;

    advanceRunStep(
      runId,
      { fromStepIndex: 0, toStepIndex: 0, deadlineAt: "2026-03-01T00:00:00.000Z" },
      { db },
    );

    const after = getRun(runId, { db })!;
    expect(after.step_index).toBe(0);
    expect(after.deadline_at).toBe("2026-03-01T00:00:00.000Z");
    expect(after.deadline_at).not.toBe(before.deadline_at);
    expect(after.modified_at >= before.modified_at).toBe(true);
  });

  it("throws RunStepMismatchError on a stale fromStepIndex and leaves the row untouched", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    const before = getRun(runId, { db });

    expect(() =>
      advanceRunStep(
        runId,
        { fromStepIndex: 5, toStepIndex: 6, deadlineAt: "2026-04-01T00:00:00.000Z" },
        { db },
      ),
    ).toThrow(RunStepMismatchError);

    const after = getRun(runId, { db });
    expect(after).toEqual(before);
  });
});

describe("markRunTerminal — the run-level guard mirroring markLegConfirmed/markLegFailed's terminal guard", () => {
  it.each(["planning", "advancing", "awaiting"] as const)(
    "flips a '%s' run to succeeded",
    (status) => {
      const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
      db.prepare(`UPDATE codex_cronoton_runs SET status = ? WHERE id = ?`).run(status, runId);

      markRunTerminal(runId, "succeeded", { db });

      expect(getRun(runId, { db })!.status).toBe("succeeded");
    },
  );

  it("throws RunAlreadyTerminalError on a second call against an already-failed run, leaving status unchanged", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    markRunTerminal(runId, "failed", { db });

    expect(() => markRunTerminal(runId, "succeeded", { db })).toThrow(RunAlreadyTerminalError);

    expect(getRun(runId, { db })!.status).toBe("failed");
  });
});

describe("bumpRunAttempt — the T1 primitive a genuine re-plan uses instead of advanceRunStep's own attempt-reset", () => {
  it("increments a run's attempt from 0 to 1, and a second call increments it to 2 (cumulative, not reset)", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    expect(getRun(runId, { db })!.attempt).toBe(0);

    bumpRunAttempt(runId, { db });
    expect(getRun(runId, { db })!.attempt).toBe(1);

    bumpRunAttempt(runId, { db });
    expect(getRun(runId, { db })!.attempt).toBe(2);
  });
});

describe("touchRunDeadline — narrower than advanceRunStep, never resets attempt or step_index", () => {
  it("updates only deadline_at/modified_at, leaving step_index and an already-bumped attempt unchanged", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });
    bumpRunAttempt(runId, { db });
    const before = getRun(runId, { db })!;
    expect(before.attempt).toBe(1);

    touchRunDeadline(runId, "2026-05-01T00:00:00.000Z", { db });

    const after = getRun(runId, { db })!;
    expect(after.deadline_at).toBe("2026-05-01T00:00:00.000Z");
    expect(after.attempt).toBe(1);
    expect(after.step_index).toBe(before.step_index);
    expect(after.modified_at >= before.modified_at).toBe(true);
  });
});

describe("listRunsForCronoton — paginated run history for one cronoton, newest-first by started_at", () => {
  it("returns runs newest-first by started_at, with total reflecting the full count regardless of the page window", () => {
    const run1 = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    db.prepare(
      `UPDATE codex_cronoton_runs SET status = 'succeeded', started_at = ? WHERE id = ?`,
    ).run("2026-01-01T00:00:01.000Z", run1);

    const run2 = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    db.prepare(
      `UPDATE codex_cronoton_runs SET status = 'succeeded', started_at = ? WHERE id = ?`,
    ).run("2026-01-01T00:00:02.000Z", run2);

    const run3 = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    db.prepare(`UPDATE codex_cronoton_runs SET started_at = ? WHERE id = ?`).run(
      "2026-01-01T00:00:03.000Z",
      run3,
    );

    const { runs, total } = listRunsForCronoton("cc-1", { limit: 2 }, { db });

    expect(runs.map((r) => r.id)).toEqual([run3, run2]);
    expect(total).toBe(3);
  });

  it("returns an empty array (not an error) for a cronoton with zero runs", () => {
    expect(listRunsForCronoton("cc-1", {}, { db })).toEqual({ runs: [], total: 0 });
  });

  it("clamps an out-of-range limit/offset exactly like listFires's own clamp logic ([1,100], offset>=0)", () => {
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    const ids: string[] = [];
    for (let i = 0; i < 105; i++) {
      const id = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
      db.prepare(
        `UPDATE codex_cronoton_runs SET status = 'succeeded', started_at = ? WHERE id = ?`,
      ).run(new Date(base + i * 1000).toISOString(), id);
      ids.push(id);
    }

    // limit: 500 clamps down to the [1,100] ceiling.
    expect(listRunsForCronoton("cc-1", { limit: 500 }, { db }).runs).toHaveLength(100);

    // limit: 0 clamps up to the floor of 1 -> only the single newest row.
    expect(listRunsForCronoton("cc-1", { limit: 0 }, { db }).runs.map((r) => r.id)).toEqual([
      ids[104],
    ]);

    // offset: -5 clamps to 0, identical to not passing an offset at all.
    expect(listRunsForCronoton("cc-1", { offset: -5 }, { db }).runs.map((r) => r.id)).toEqual(
      listRunsForCronoton("cc-1", {}, { db }).runs.map((r) => r.id),
    );
  });

  it("never returns a different cronoton's runs", () => {
    seedCronoton("cc-2");
    const runA = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    const runB = createRun({ codexCronotonId: "cc-2", stepCount: 1 }, { db });

    const { runs, total } = listRunsForCronoton("cc-1", {}, { db });

    expect(runs.map((r) => r.id)).toEqual([runA]);
    expect(runs.map((r) => r.id)).not.toContain(runB);
    expect(total).toBe(1);
  });
});

describe("insertRunLeg — generation-scoping attempt param (T1)", () => {
  it("called with no attempt field inserts a row with attempt: 0 (unchanged default behavior)", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });

    insertRunLeg({ runId, stepIndex: 0, legIndex: 0, definitionJson: "{}" }, { db });

    const [leg] = listRunLegs(runId, { db });
    expect(leg.attempt).toBe(0);
  });

  it("called with attempt: 1 inserts a row with attempt: 1, and a second insert for the SAME (runId, stepIndex, legIndex) slot with attempt: 2 still throws RunLegAlreadyExistsError (the unique index has no attempt dimension)", () => {
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 3 }, { db });

    insertRunLeg(
      { runId, stepIndex: 0, legIndex: 0, definitionJson: "{}", attempt: 1 },
      { db },
    );

    const [leg] = listRunLegs(runId, { db });
    expect(leg.attempt).toBe(1);

    expect(() =>
      insertRunLeg(
        { runId, stepIndex: 0, legIndex: 0, definitionJson: "{}", attempt: 2 },
        { db },
      ),
    ).toThrow(RunLegAlreadyExistsError);

    // The first leg at this slot is untouched — the attempt dimension never
    // disambiguates the slot, matching design's "legIndex must keep
    // incrementing across generations" rationale.
    expect(listRunLegs(runId, { db })).toHaveLength(1);
  });
});
