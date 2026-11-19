/**
 * run-advance — Phase 2's pure decision core. One `it` per branch of
 * `docs/work/khronoton-chained-runs-phase-2/design.md`'s "Decision algorithm"
 * section, named after the row it pins.
 */
import { describe, it, expect } from "vitest";

import { advanceRun } from "./run-advance.js";
import type { RunState, LegState, RunPolicy } from "./run-advance.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function run(overrides: Partial<RunState> = {}): RunState {
  return {
    status: "advancing",
    stepIndex: 0,
    stepCount: 3,
    deadlineAt: null,
    attempt: 0,
    ...overrides,
  };
}

function leg(legIndex: number, status: LegState["status"]): LegState {
  return { legIndex, status };
}

function policy(overrides: Partial<RunPolicy> = {}): RunPolicy {
  return {
    stepMode: "serial",
    canReplan: true,
    maxReplanAttempts: 3,
    ...overrides,
  };
}

describe("advanceRun — terminal run (step 1)", () => {
  for (const status of ["succeeded", "failed", "abandoned"] as const) {
    it(`status "${status}" → [wait], regardless of legs/deadline`, () => {
      const r = advanceRun(run({ status }), [leg(0, "pending")], NOW, policy());
      expect(r).toEqual([{ kind: "wait" }]);
    });
  }
});

describe("advanceRun — no legs yet (step 2)", () => {
  it("legs: [] with status 'planning' → replan-step with the exact reason string", () => {
    const r = advanceRun(run({ status: "planning", stepIndex: 2 }), [], NOW, policy());
    expect(r).toEqual([{ kind: "replan-step", reason: "step 2 has no legs yet" }]);
  });
});

describe("advanceRun — barrier met beats a passed deadline (step 3)", () => {
  it("every leg confirmed, even with deadlineAt already in the past → advance-step", () => {
    const r = advanceRun(
      run({ deadlineAt: "2020-01-01T00:00:00.000Z" }),
      [leg(0, "confirmed"), leg(1, "confirmed")],
      NOW,
      policy(),
    );
    expect(r).toEqual([{ kind: "advance-step" }]);
  });
});

describe("advanceRun — deadline exceeded, barrier not met (step 4)", () => {
  const PAST = "2020-01-01T00:00:00.000Z";

  for (const stepMode of ["serial", "parallel"] as const) {
    it(`${stepMode}: attempt < maxReplanAttempts → replan-step mentioning "barrier deadline exceeded"`, () => {
      const r = advanceRun(
        run({ deadlineAt: PAST, attempt: 0 }),
        [leg(0, "submitted"), leg(1, "pending")],
        NOW,
        policy({ stepMode, maxReplanAttempts: 3 }),
      );
      expect(r).toEqual([
        {
          kind: "replan-step",
          reason: "step 0: barrier deadline exceeded; re-planning (attempt 1/3)",
        },
      ]);
    });

    it(`${stepMode}: attempt >= maxReplanAttempts → fail-run`, () => {
      const r = advanceRun(
        run({ deadlineAt: PAST, attempt: 3 }),
        [leg(0, "submitted"), leg(1, "pending")],
        NOW,
        policy({ stepMode, maxReplanAttempts: 3 }),
      );
      expect(r).toEqual([
        {
          kind: "fail-run",
          reason: "step 0: barrier deadline exceeded; replan attempts exhausted (3/3)",
        },
      ]);
    });
  }

  it("deadlineAt exactly equal to now → NOT exceeded (strict >, not >=); falls through to normal poll", () => {
    const r = advanceRun(
      run({ deadlineAt: NOW.toISOString(), attempt: 0 }),
      [leg(0, "submitted"), leg(1, "pending")],
      NOW,
      policy({ stepMode: "serial", maxReplanAttempts: 3 }),
    );
    expect(r).toEqual([{ kind: "poll" }]);
  });
});

describe("advanceRun — serial mid-sequence failure (step 5)", () => {
  it("one failed leg, other legs still pending (never submitted) → replan-step immediately (attempt < max)", () => {
    const r = advanceRun(
      run({ attempt: 0 }),
      [leg(0, "failed"), leg(1, "pending"), leg(2, "pending")],
      NOW,
      policy({ stepMode: "serial", maxReplanAttempts: 3 }),
    );
    expect(r).toEqual([
      {
        kind: "replan-step",
        reason: "step 0: a leg failed; re-planning (attempt 1/3)",
      },
    ]);
  });

  it("one failed leg, other legs still pending → fail-run once replan attempts are exhausted", () => {
    const r = advanceRun(
      run({ attempt: 3 }),
      [leg(0, "failed"), leg(1, "pending"), leg(2, "pending")],
      NOW,
      policy({ stepMode: "serial", maxReplanAttempts: 3 }),
    );
    expect(r).toEqual([
      {
        kind: "fail-run",
        reason: "step 0: a leg failed; replan attempts exhausted (3/3)",
      },
    ]);
  });
});

describe("advanceRun — parallel failure while siblings still in flight (step 6, fall-through)", () => {
  it("one failed + one still submitted → NOT replan/fail; polls (no pending remain)", () => {
    const r = advanceRun(
      run(),
      [leg(0, "failed"), leg(1, "submitted"), leg(2, "confirmed")],
      NOW,
      policy({ stepMode: "parallel" }),
    );
    expect(r).toEqual([{ kind: "poll" }]);
  });

  it("one failed + one still pending → NOT replan/fail; submits the pending leg", () => {
    const r = advanceRun(
      run(),
      [leg(0, "failed"), leg(1, "pending"), leg(2, "confirmed")],
      NOW,
      policy({ stepMode: "parallel" }),
    );
    expect(r).toEqual([{ kind: "submit-leg", legIndex: 1 }]);
  });
});

describe("advanceRun — parallel failure once all legs are resolved (step 6, handoff's 3-of-4 case)", () => {
  it("one failed, the rest confirmed (fully resolved mix) → replan-step", () => {
    const r = advanceRun(
      run({ attempt: 0 }),
      [leg(0, "confirmed"), leg(1, "confirmed"), leg(2, "confirmed"), leg(3, "failed")],
      NOW,
      policy({ stepMode: "parallel", maxReplanAttempts: 2 }),
    );
    expect(r).toEqual([
      {
        kind: "replan-step",
        reason: "step 0: a leg failed; re-planning (attempt 1/2)",
      },
    ]);
  });

  it("one failed, the rest confirmed, replan exhausted → fail-run", () => {
    const r = advanceRun(
      run({ attempt: 2 }),
      [leg(0, "confirmed"), leg(1, "confirmed"), leg(2, "confirmed"), leg(3, "failed")],
      NOW,
      policy({ stepMode: "parallel", maxReplanAttempts: 2 }),
    );
    expect(r).toEqual([
      {
        kind: "fail-run",
        reason: "step 0: a leg failed; replan attempts exhausted (2/2)",
      },
    ]);
  });
});

describe("advanceRun — parallel submit (step 7, parallel branch)", () => {
  it("N pending legs, none submitted/confirmed/failed → one submit-leg action per pending leg", () => {
    // Deliberately out of legIndex order (mirrors the serial "lowest legIndex,
    // not array position" test below) — proves this targets legIndex, not
    // array position, and isn't a vacuous pass from an already-sorted fixture.
    const r = advanceRun(
      run(),
      [leg(2, "pending"), leg(0, "pending"), leg(1, "pending")],
      NOW,
      policy({ stepMode: "parallel" }),
    );
    expect(r).toEqual([
      { kind: "submit-leg", legIndex: 2 },
      { kind: "submit-leg", legIndex: 0 },
      { kind: "submit-leg", legIndex: 1 },
    ]);
  });
});

describe("advanceRun — parallel poll (step 7, parallel branch)", () => {
  it("zero pending, some submitted, barrier not met → single poll", () => {
    const r = advanceRun(
      run(),
      [leg(0, "submitted"), leg(1, "confirmed")],
      NOW,
      policy({ stepMode: "parallel" }),
    );
    expect(r).toEqual([{ kind: "poll" }]);
  });
});

describe("advanceRun — serial poll blocks further submission (step 7, serial branch)", () => {
  it("one leg submitted, others pending → single poll, no submit-leg emitted", () => {
    const r = advanceRun(
      run(),
      [leg(0, "confirmed"), leg(1, "submitted"), leg(2, "pending")],
      NOW,
      policy({ stepMode: "serial" }),
    );
    expect(r).toEqual([{ kind: "poll" }]);
  });
});

describe("advanceRun — serial picks the lowest-index pending leg (step 7, serial branch)", () => {
  it("no leg submitted; legs 0 and 2 pending, leg 1 confirmed → targets legIndex 0, not array position", () => {
    const r = advanceRun(
      run(),
      [leg(2, "pending"), leg(1, "confirmed"), leg(0, "pending")],
      NOW,
      policy({ stepMode: "serial" }),
    );
    expect(r).toEqual([{ kind: "submit-leg", legIndex: 0 }]);
  });
});

describe("advanceRun — serial defensive wait fallback (step 7, serial branch)", () => {
  it("neither 'submitted' nor 'pending' present (unreachable via the four CHECK-constrained statuses alone — forced here to prove the fallback doesn't throw) → wait", () => {
    // By design, a serial step with no failed/pending/submitted leg has every leg
    // confirmed, which step 3 (barrier met) already intercepts before step 7 runs — so
    // this branch is dead code under the four real statuses, documented as defensive.
    // We force it here with an out-of-union status to actually execute, not just read,
    // the fallback line and assert it returns `wait` rather than throwing.
    const weirdLeg = { legIndex: 0, status: "unknown" } as unknown as LegState;
    const r = advanceRun(run(), [weirdLeg], NOW, policy({ stepMode: "serial" }));
    expect(r).toEqual([{ kind: "wait" }]);
  });
});

describe("advanceRun — canReplan: false fails immediately regardless of attempt (shared re-plan-or-fail)", () => {
  it("serial, failed leg, canReplan false, attempt 0 → fail-run immediately", () => {
    const r = advanceRun(
      run({ attempt: 0 }),
      [leg(0, "failed"), leg(1, "pending")],
      NOW,
      policy({ stepMode: "serial", canReplan: false, maxReplanAttempts: 5 }),
    );
    expect(r).toEqual([
      {
        kind: "fail-run",
        reason: "step 0: a leg failed; no re-plan available for a single-mode step",
      },
    ]);
  });

  it("parallel, failed leg, all resolved, canReplan false, attempt 0 → fail-run immediately", () => {
    const r = advanceRun(
      run({ attempt: 0 }),
      [leg(0, "failed"), leg(1, "confirmed")],
      NOW,
      policy({ stepMode: "parallel", canReplan: false, maxReplanAttempts: 5 }),
    );
    expect(r).toEqual([
      {
        kind: "fail-run",
        reason: "step 0: a leg failed; no re-plan available for a single-mode step",
      },
    ]);
  });
});

describe("advanceRun — deadlineAt: null never triggers the deadline branch", () => {
  it("deadlineAt null, now far in the future, barrier not met, no failures → normal submit/poll logic runs", () => {
    const farFuture = new Date("2099-01-01T00:00:00.000Z");
    const r = advanceRun(
      run({ deadlineAt: null }),
      [leg(0, "pending")],
      farFuture,
      policy({ stepMode: "serial" }),
    );
    expect(r).toEqual([{ kind: "submit-leg", legIndex: 0 }]);
  });
});
