/**
 * DEFINITION-OF-DONE gate — "never advance past an unconfirmed leg"
 * (Phase 2 design, `docs/work/khronoton-chained-runs-phase-2/design.md`'s
 * "Decision algorithm" step 3).
 *
 * Mirrors `tests/double-fire.test.ts`'s role as a cross-cutting gate that
 * pins ONE invariant at a higher, mutation-resistant level than the
 * branch-by-branch suite already covers it at (`src/server/pure/
 * run-advance.test.ts`). Where double-fire.test.ts raises claim.test.ts's
 * store-layer atomic-claim proof to the full tick layer, this file raises
 * run-advance.test.ts's per-branch `advance-step` assertions to a single
 * property checked across every representative non-barrier-met fixture at
 * once: `advanceRun` is PURE (no DB, no driver — the invariant lives
 * entirely inside this one function), so the gate is a direct property test
 * of `advanceRun` itself rather than anything observed through I/O.
 *
 * The property: unless every leg of the current step is `confirmed`,
 * `advanceRun` must never emit `{ kind: "advance-step" }` — regardless of
 * run status, deadline, step mode, failure count, or re-plan budget. A
 * mutation that weakens the barrier check (`legs.every(...)` ->
 * `legs.some(...)`) would let a run advance to its next step while a sibling
 * leg is still `pending`/`submitted`/`failed`, silently corrupting a chained
 * run's execution order — exactly the class of bug branch tests alone can
 * miss if a future edit adds a new branch upstream of the barrier check
 * without a dedicated test of its own.
 */
import { describe, expect, it } from "vitest";

import { advanceRun } from "../src/server/pure/run-advance.js";
import type { RunState, LegState, RunPolicy } from "../src/server/pure/run-advance.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const PAST = "2020-01-01T00:00:00.000Z";

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

interface Fixture {
  readonly name: string;
  readonly run: RunState;
  readonly legs: readonly LegState[];
  readonly now: Date;
  readonly policy: RunPolicy;
}

/**
 * Representative fixtures spanning every category of the Decision algorithm
 * EXCEPT the one case that is legitimately allowed to advance (step 3, all
 * legs confirmed) — paralleling run-advance.test.ts's own fixtures for
 * terminal runs, no-legs, deadline-exceeded, serial mid-sequence failure,
 * and parallel failure mid-flight, plus the remaining normal submit/poll
 * and resolved-failure branches so the gate covers the full decision
 * surface, not just a hand-picked subset.
 */
const FIXTURES: readonly Fixture[] = [
  // Terminal runs — legs deliberately left unresolved; a terminal run must
  // never advance regardless of what its legs look like.
  {
    name: "terminal: succeeded, one pending leg",
    run: run({ status: "succeeded" }),
    legs: [leg(0, "pending")],
    now: NOW,
    policy: policy(),
  },
  {
    name: "terminal: failed, one submitted leg",
    run: run({ status: "failed" }),
    legs: [leg(0, "submitted")],
    now: NOW,
    policy: policy(),
  },
  {
    name: "terminal: abandoned, one failed leg",
    run: run({ status: "abandoned" }),
    legs: [leg(0, "failed")],
    now: NOW,
    policy: policy(),
  },
  // No legs yet for the current step.
  {
    name: "no legs yet",
    run: run({ status: "planning", stepIndex: 2 }),
    legs: [],
    now: NOW,
    policy: policy(),
  },
  // Deadline exceeded, barrier not met — both step modes, both replan/fail
  // sides of the attempt budget.
  {
    name: "deadline exceeded, serial, replan attempts remain",
    run: run({ deadlineAt: PAST, attempt: 0 }),
    legs: [leg(0, "submitted"), leg(1, "pending")],
    now: NOW,
    policy: policy({ stepMode: "serial", maxReplanAttempts: 3 }),
  },
  {
    name: "deadline exceeded, serial, replan attempts exhausted",
    run: run({ deadlineAt: PAST, attempt: 3 }),
    legs: [leg(0, "submitted"), leg(1, "pending")],
    now: NOW,
    policy: policy({ stepMode: "serial", maxReplanAttempts: 3 }),
  },
  {
    name: "deadline exceeded, parallel, replan attempts remain",
    run: run({ deadlineAt: PAST, attempt: 0 }),
    legs: [leg(0, "submitted"), leg(1, "pending")],
    now: NOW,
    policy: policy({ stepMode: "parallel", maxReplanAttempts: 3 }),
  },
  {
    name: "deadline exceeded, parallel, replan attempts exhausted",
    run: run({ deadlineAt: PAST, attempt: 3 }),
    legs: [leg(0, "submitted"), leg(1, "pending")],
    now: NOW,
    policy: policy({ stepMode: "parallel", maxReplanAttempts: 3 }),
  },
  // Serial mid-sequence failure — later legs still pending, never attempted.
  {
    name: "serial mid-sequence failure, replan attempts remain",
    run: run({ attempt: 0 }),
    legs: [leg(0, "failed"), leg(1, "pending"), leg(2, "pending")],
    now: NOW,
    policy: policy({ stepMode: "serial", maxReplanAttempts: 3 }),
  },
  {
    name: "serial mid-sequence failure, replan attempts exhausted",
    run: run({ attempt: 3 }),
    legs: [leg(0, "failed"), leg(1, "pending"), leg(2, "pending")],
    now: NOW,
    policy: policy({ stepMode: "serial", maxReplanAttempts: 3 }),
  },
  // Parallel failure with siblings still in flight — falls through to
  // submit/poll rather than replanning yet, but must still never advance.
  {
    name: "parallel failure mid-flight, one submitted sibling remains",
    run: run(),
    legs: [leg(0, "failed"), leg(1, "submitted"), leg(2, "confirmed")],
    now: NOW,
    policy: policy({ stepMode: "parallel" }),
  },
  {
    name: "parallel failure mid-flight, one pending sibling remains",
    run: run(),
    legs: [leg(0, "failed"), leg(1, "pending"), leg(2, "confirmed")],
    now: NOW,
    policy: policy({ stepMode: "parallel" }),
  },
  // Parallel failure once every leg is resolved (the failure itself keeps
  // the barrier unmet, so advance-step must still never appear).
  {
    name: "parallel failure fully resolved, replan attempts remain",
    run: run({ attempt: 0 }),
    legs: [leg(0, "confirmed"), leg(1, "confirmed"), leg(2, "confirmed"), leg(3, "failed")],
    now: NOW,
    policy: policy({ stepMode: "parallel", maxReplanAttempts: 2 }),
  },
  {
    name: "parallel failure fully resolved, replan attempts exhausted",
    run: run({ attempt: 2 }),
    legs: [leg(0, "confirmed"), leg(1, "confirmed"), leg(2, "confirmed"), leg(3, "failed")],
    now: NOW,
    policy: policy({ stepMode: "parallel", maxReplanAttempts: 2 }),
  },
  // Normal submit/poll — no failure, no deadline, barrier simply not met yet.
  {
    name: "parallel submit, all legs pending",
    run: run(),
    legs: [leg(0, "pending"), leg(1, "pending"), leg(2, "pending")],
    now: NOW,
    policy: policy({ stepMode: "parallel" }),
  },
  {
    name: "parallel poll, zero pending, one submitted",
    run: run(),
    legs: [leg(0, "submitted"), leg(1, "confirmed")],
    now: NOW,
    policy: policy({ stepMode: "parallel" }),
  },
  {
    name: "serial poll, one submitted leg blocks further submission",
    run: run(),
    legs: [leg(0, "confirmed"), leg(1, "submitted"), leg(2, "pending")],
    now: NOW,
    policy: policy({ stepMode: "serial" }),
  },
  {
    name: "serial submit, lowest-index pending leg chosen",
    run: run(),
    legs: [leg(2, "pending"), leg(1, "confirmed"), leg(0, "pending")],
    now: NOW,
    policy: policy({ stepMode: "serial" }),
  },
  // canReplan: false (single-mode step) — fails immediately on a failed leg.
  {
    name: "canReplan false, serial, failed leg",
    run: run({ attempt: 0 }),
    legs: [leg(0, "failed"), leg(1, "pending")],
    now: NOW,
    policy: policy({ stepMode: "serial", canReplan: false, maxReplanAttempts: 5 }),
  },
  // deadlineAt: null, far-future now — deadline branch never triggers.
  {
    name: "deadlineAt null, far future now, barrier not met",
    run: run({ deadlineAt: null }),
    legs: [leg(0, "pending")],
    now: new Date("2099-01-01T00:00:00.000Z"),
    policy: policy({ stepMode: "serial" }),
  },
];

describe("advanceRun — invariant gate: never advance past an unconfirmed leg", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name} -> never emits advance-step`, () => {
      // Sanity: every fixture must actually have an unmet barrier — either
      // no legs yet, or at least one leg that is not confirmed — or it
      // would trivially (and vacuously) pass this gate.
      const barrierMet = fixture.legs.length > 0 && fixture.legs.every((l) => l.status === "confirmed");
      expect(barrierMet).toBe(false);

      const actions = advanceRun(fixture.run, fixture.legs, fixture.now, fixture.policy);

      expect(actions.some((a) => a.kind === "advance-step")).toBe(false);
    });
  }

  it("covers at least one fixture per non-barrier decision category (terminal, no-legs, deadline, serial-failure, parallel-failure)", () => {
    // Load-bearing guard against this file silently losing coverage of a
    // category if a future edit trims FIXTURES down to a lazy subset.
    const names = FIXTURES.map((f) => f.name);
    expect(names.some((n) => n.startsWith("terminal:"))).toBe(true);
    expect(names).toContain("no legs yet");
    expect(names.some((n) => n.startsWith("deadline exceeded"))).toBe(true);
    expect(names.some((n) => n.startsWith("serial mid-sequence failure"))).toBe(true);
    expect(names.some((n) => n.startsWith("parallel failure mid-flight"))).toBe(true);
  });
});
