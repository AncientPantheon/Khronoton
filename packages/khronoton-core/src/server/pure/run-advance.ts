/**
 * Phase 2's pure decision core for chained runs (handoff
 * `HANDOFF-khronoton-chained-runs.md` §3/§5; full spec in
 * `docs/work/khronoton-chained-runs-phase-2/design.md`'s "Decision algorithm").
 *
 * Given a run's current state and its current step's legs, `advanceRun`
 * decides what happens next — "submit this leg," "keep polling," "the step
 * is done, advance," "ask the planner again," or "give up." No DB, no chain
 * client, no I/O: pure and dependency-free, following `runtime-args.ts` /
 * `capability.ts`'s convention of keeping types local to the module that
 * owns the function's input/output shape rather than in `server/types.ts`.
 */

/** The two fan shapes a step's legs can be submitted in (handoff §3: "is this
 *  step serial (submit one, wait) or parallel (submit all)"). A `mode:
 *  'single'` step from `codex_cronoton_steps` has exactly one leg and is
 *  represented to `advanceRun` as `stepMode: 'serial'` — with N=1, "submit
 *  one, wait" and "submit all" are the same thing, so a third enum value
 *  would be a pure alias. The caller (Phase 3's driver) makes this call, not
 *  this function — it already knows the step's `mode` column and, for a
 *  planner step, the registered planner's own fan declaration. */
export type StepMode = "serial" | "parallel";

export interface RunState {
  readonly status: "planning" | "awaiting" | "advancing" | "succeeded" | "failed" | "abandoned";
  readonly stepIndex: number;
  readonly stepCount: number;
  /** ISO timestamp, or `null` for "no deadline configured" (unbounded wait). */
  readonly deadlineAt: string | null;
  /** Re-plan attempts already spent on the CURRENT step (resets to 0 when the
   *  driver advances to a new step — Phase 3's job, not this function's). */
  readonly attempt: number;
}

export interface LegState {
  readonly legIndex: number;
  readonly status: "pending" | "submitted" | "confirmed" | "failed";
}

export interface RunPolicy {
  readonly stepMode: StepMode;
  /** False for a `mode: 'single'` step: there is no registered planner to
   *  consult, so a failed leg has no "ask the chain who is still owed"
   *  escape hatch and the run must fail immediately (handoff §5.5 only
   *  describes re-planning in terms of a planner's `plan()` reading live
   *  state — a fixed single-tx step has no such thing). */
  readonly canReplan: boolean;
  /** Ignored when `canReplan` is false. Bounds §5.5's "small attempt count
   *  per step"; exhausting it fails the run per §5.1. */
  readonly maxReplanAttempts: number;
}

export type RunAction =
  | { readonly kind: "submit-leg"; readonly legIndex: number }
  | { readonly kind: "poll" }
  /** Barrier met for the current step. The driver (Phase 3), not this
   *  function, decides whether that means "move to stepIndex + 1" or "the
   *  run is done" — by comparing stepIndex + 1 to stepCount. advanceRun
   *  itself has no opinion on what happens after the barrier clears. */
  | { readonly kind: "advance-step" }
  /** Ask the registered planner (or, for a step's very first pass, build its
   *  one fixed leg) to (re)produce this step's legs. Mechanically the same
   *  operation whether it's step 0's first plan or a post-failure re-plan —
   *  the handoff's own framing treats "no legs yet" and "re-plan after a
   *  failure" as the same call into `plan()`, so one action kind covers
   *  both rather than inventing a seventh. */
  | { readonly kind: "replan-step"; readonly reason: string }
  | { readonly kind: "fail-run"; readonly reason: string }
  | { readonly kind: "wait" };

/** Shared by decision steps 4 (deadline exceeded), 5 (serial failure), and 6
 *  (parallel failure, fully resolved): spend a re-plan attempt if the policy
 *  and budget allow it, otherwise fail the run outright. */
function replanOrFail(run: RunState, trigger: string, policy: RunPolicy): RunAction[] {
  if (policy.canReplan && run.attempt < policy.maxReplanAttempts) {
    return [
      {
        kind: "replan-step",
        reason: `step ${run.stepIndex}: ${trigger}; re-planning (attempt ${run.attempt + 1}/${policy.maxReplanAttempts})`,
      },
    ];
  }
  const why = policy.canReplan
    ? `replan attempts exhausted (${run.attempt}/${policy.maxReplanAttempts})`
    : "no re-plan available for a single-mode step";
  return [{ kind: "fail-run", reason: `step ${run.stepIndex}: ${trigger}; ${why}` }];
}

export function advanceRun(
  run: RunState,
  legs: readonly LegState[],
  now: Date,
  policy: RunPolicy,
): RunAction[] {
  // 1. Terminal run — pure no-op, defends against a driver that calls
  //    advanceRun on a run it should have already stopped touching.
  if (run.status === "succeeded" || run.status === "failed" || run.status === "abandoned") {
    return [{ kind: "wait" }];
  }

  // 2. No legs yet for the current step — building a step's legs for the
  //    first time and re-planning after a failure are the same call, so
  //    this reuses replan-step rather than inventing a plan-step kind.
  if (legs.length === 0) {
    return [{ kind: "replan-step", reason: `step ${run.stepIndex} has no legs yet` }];
  }

  // 3. Barrier met — checked BEFORE the deadline test: once every leg is
  //    confirmed, a deadline that already passed is moot.
  if (legs.every((l) => l.status === "confirmed")) {
    return [{ kind: "advance-step" }];
  }

  // 4. Deadline exceeded and the barrier is not met — the "poll once more,
  //    then decide" moment from handoff §5.7, regardless of step mode or how
  //    many legs are still pending/submitted.
  const deadlinePassed = run.deadlineAt != null && now.getTime() > new Date(run.deadlineAt).getTime();
  if (deadlinePassed) {
    return replanOrFail(run, "barrier deadline exceeded", policy);
  }

  // 5. A failed leg exists and the step's legs are NOT independent of each
  //    other (serial, cursor-paged) — re-plan-or-fail immediately, even if
  //    later legs are still pending and never attempted.
  if (policy.stepMode === "serial" && legs.some((l) => l.status === "failed")) {
    return replanOrFail(run, "a leg failed", policy);
  }

  // 6. A failed leg exists but the step's legs ARE independent (parallel,
  //    fed-slices) — only once every leg has reached a terminal status
  //    (confirmed or failed) does the failure trigger re-plan-or-fail.
  //    Until then, fall through: a sibling failing is not a reason to stop
  //    submitting or polling the others.
  if (policy.stepMode === "parallel" && legs.some((l) => l.status === "failed")) {
    const allResolved = legs.every((l) => l.status === "confirmed" || l.status === "failed");
    if (allResolved) {
      return replanOrFail(run, "a leg failed", policy);
    }
    // fall through to step 7
  }

  // 7. Otherwise — normal submit/poll, branching on step mode.
  if (policy.stepMode === "parallel") {
    const pending = legs.filter((l) => l.status === "pending");
    if (pending.length > 0) {
      return pending.map((l) => ({ kind: "submit-leg" as const, legIndex: l.legIndex }));
    }
    return [{ kind: "poll" }];
  }

  // serial
  if (legs.some((l) => l.status === "submitted")) {
    return [{ kind: "poll" }];
  }
  const pendingLegs = legs.filter((l) => l.status === "pending");
  if (pendingLegs.length > 0) {
    const lowest = pendingLegs.reduce((a, b) => (b.legIndex < a.legIndex ? b : a));
    return [{ kind: "submit-leg", legIndex: lowest.legIndex }];
  }
  // Defensive fallback: should not arise given the CHECK-constrained leg
  // statuses and the branches above (any failed leg is caught by step 5;
  // all-confirmed is caught by step 3) — documented rather than silently
  // falling through, and must not throw.
  return [{ kind: "wait" }];
}
