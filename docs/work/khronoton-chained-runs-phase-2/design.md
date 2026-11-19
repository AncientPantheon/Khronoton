# Khronoton chained runs — Phase 2 — Design

Parent design: `docs/work/khronoton-chained-runs/design.md` (Phase 0+1, shipped).
Source handoff: `HANDOFF-khronoton-chained-runs.md` §3 "Phase 2" (the sketch) and
§5 (the settled failure/resume/concurrency rules this phase has to encode).

Phase 2 is the pure decision core: given a run's current state and its current
step's legs, decide what happens next. No DB, no chain client, no I/O —
everything the handoff calls "decidable with no I/O" lives here, as one
function with a table of branches, each independently unit-tested.

## Problem

Phase 1 built storage with **zero decision logic by design** (`store/runs.ts`'s
own doc comment says so explicitly). Nothing today can look at a run's legs and
say "submit this one," "keep polling," "the step is done, advance," "ask the
planner again," or "give up." The handoff's own sketch:

```ts
export function advanceRun(
  run: RunState, legs: LegState[], now: Date, policy: RunPolicy
): RunAction[]    // 'submit-leg' | 'poll' | 'advance-step' | 'replan-step' | 'fail-run' | 'wait'
```

is a signature, not a design — it names the six action kinds but not the
branch order, not how serial and parallel steps actually differ, and not how
§5.5's "re-plan asks the chain who is still owed" interacts with §5.7's
"poll once more, then fail." Those interactions are where a chained-run bug
would actually hide, so this document pins them down before any code is
written.

## Approach

### Types (`src/server/pure/run-advance.ts`)

Following `runtime-args.ts`/`capability.ts`'s convention: types local to the
pure module, not added to `server/types.ts` (they describe this function's
input/output shape, not a cross-cutting domain type).

```ts
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

export function advanceRun(
  run: RunState,
  legs: readonly LegState[],
  now: Date,
  policy: RunPolicy,
): RunAction[];
```

### Decision algorithm

In this exact order (each branch's test is named after its row below):

1. **Terminal run** (`status` is `succeeded`/`failed`/`abandoned`) → `[{kind:
   "wait"}]`. A pure no-op; defends against a driver that calls `advanceRun`
   on a run it should have already stopped touching, without throwing.
2. **No legs yet for the current step** (`legs.length === 0`) → `[{kind:
   "replan-step", reason: "step N has no legs yet"}]`. Covers `status:
   'planning'`'s very first pass — building a step's legs for the first time
   and re-planning after a failure are the same call, so this reuses
   `replan-step` rather than inventing a `plan-step` kind.
3. **Barrier met** (`legs.every(l => l.status === "confirmed")`) → `[{kind:
   "advance-step"}]`. Checked BEFORE the deadline test — once every leg is
   confirmed, a deadline that already passed is moot; the invariant this
   phase exists to protect is "never advance past an UNCONFIRMED leg," not
   "never advance past a deadline."
4. **Deadline exceeded and the barrier is not met**
   (`deadlineAt != null && now > deadlineAt`, and step 3 did not match) →
   the re-plan-or-fail decision (below), regardless of step mode or how many
   legs are still pending/submitted. This is deliberately the "poll once
   more, then decide" moment from handoff §5.7 — see "On the deadline grace
   poll" below for why no extra hidden state is needed to implement
   "once more."
5. **A failed leg exists, and the step's legs are not independent of each
   other** — i.e. `stepMode === "serial"` and `legs.some(l => l.status ===
   "failed")` → re-plan-or-fail immediately, even if later legs in the
   sequence are still `pending` and never attempted. A serial step is
   cursor-paged (handoff: "SERIAL cursor-paged for inject"); a failure
   partway through makes every later leg's cursor suspect, so the engine
   must stop and ask the planner for fresh state rather than keep submitting
   a sequence built on a now-doubtful cursor.
6. **A failed leg exists, but the step's legs are independent**
   (`stepMode === "parallel"`) → wait for every leg to reach a terminal
   status first (`legs.every(l => l.status === "confirmed" || l.status ===
   "failed")`); only once ALL legs are resolved does a failure trigger
   re-plan-or-fail. Until then, fall through to step 7 — parallel fed-slices
   don't depend on each other (handoff: "PARALLEL fed-slices for evict"), so
   one slice failing is not a reason to stop submitting or polling its
   siblings. This is the handoff §5.5 worked example precisely: "3 of 4
   evict legs confirm and one fails on gas" re-plans only once that picture
   is complete, not the instant the first failure appears.
7. **Otherwise — normal submit/poll**, branching on `stepMode`:
   - `parallel`: any `pending` legs → one `{kind: "submit-leg", legIndex}`
     action PER pending leg (submit the whole remaining fan at once — this is
     "submit all" from the handoff's own phrasing). No pending legs (only
     `submitted`/`confirmed` remain, barrier not yet met) → `[{kind:
     "poll"}]`.
   - `serial`: any leg currently `submitted` → `[{kind: "poll"}]` (don't
     submit the next leg while one is in flight — "submit one, wait"). No
     leg `submitted` and at least one `pending` → `[{kind: "submit-leg",
     legIndex}]` for the LOWEST-indexed pending leg only (never more than
     one at a time). Neither case — defensively — → `[{kind: "wait"}]`
     (should not arise given the CHECK-constrained leg statuses and the
     branches above; documented rather than silently falling through).

### Re-plan-or-fail (shared by steps 4, 5, 6)

```ts
function replanOrFail(run: RunState, trigger: string, policy: RunPolicy): RunAction[] {
  if (policy.canReplan && run.attempt < policy.maxReplanAttempts) {
    return [{ kind: "replan-step", reason:
      `step ${run.stepIndex}: ${trigger}; re-planning (attempt ${run.attempt + 1}/${policy.maxReplanAttempts})` }];
  }
  const why = policy.canReplan
    ? `replan attempts exhausted (${run.attempt}/${policy.maxReplanAttempts})`
    : "no re-plan available for a single-mode step";
  return [{ kind: "fail-run", reason: `step ${run.stepIndex}: ${trigger}; ${why}` }];
}
```

`trigger` is one of `"a leg failed"` (steps 5/6) or `"barrier deadline
exceeded"` (step 4) — concrete enough to satisfy §5.1's "have proper logs to
tell us where it failed" without this function knowing anything about *why*
a leg failed (it only sees `LegState.status`, not the error text — that's
Phase 5's per-leg observability, not this phase's job).

### On the deadline grace poll (why no hidden state is needed)

Handoff §5.7: "poll once more, then either re-plan or fail." `advanceRun` is
pure and stateless across calls — it cannot remember "did I already grant the
grace poll" from one invocation to the next. It doesn't need to: Phase 3's
driver polls the chain for every outstanding request key **before** calling
`advanceRun` each tick (that ordering is Phase 3's contract, stated here so
Phase 3's design inherits it as a requirement, not an afterthought). So the
first tick where `now > deadlineAt` is already, by construction, a tick where
a poll against live chain state just happened moments earlier in the same
tick. That poll **is** "the one more poll" — `advanceRun` deciding
immediately on stale-vs-fresh leg state the instant it sees `deadlinePassed
&& !barrierMet` is correct, not premature, because the freshness guarantee
comes from call order, not from a second hidden check inside this function.
Phase 3's plan.md must include a task-level acceptance criterion asserting
this call order (poll, then advance) — flagged here so it isn't lost between
documents.

### Action-array shape

`advanceRun` always returns a non-empty array. Most branches return exactly
one action; only step 7's parallel-submit branch returns more than one (one
`submit-leg` per pending leg in the fan). The driver never needs to special-
case an empty array — `wait` is always an explicit element when there is
genuinely nothing to do, matching the handoff's own six-kind vocabulary
(treating `wait` as a real action, not "no actions").

## Tests

Per `HANDOFF-khronoton-chained-runs.md` §6's stated destinations:

- `src/server/pure/run-advance.test.ts` (co-located, vitest, explicit
  imports) — one `it` per branch above, specifically:
  - terminal run (each of succeeded/failed/abandoned) → `wait`.
  - no legs → `replan-step`.
  - all confirmed → `advance-step`, independent of a passed deadline (proves
    step 3 really is checked before step 4).
  - deadline exceeded, barrier not met → `replan-step` when `attempt <
    maxReplanAttempts`, `fail-run` when exhausted, for BOTH step modes.
  - serial step, one failed leg, remaining legs still pending →
    `replan-step`/`fail-run` immediately (proves step 5 does not wait for
    the pending legs to resolve).
  - parallel step, one failed + some still submitted/pending → falls through
    to step 7 (submit remaining pending / poll), NOT re-plan-or-fail yet.
  - parallel step, one failed + the rest now confirmed (fully resolved) →
    `replan-step`/`fail-run` (the handoff's "3 of 4 confirm, one fails"
    case, exactly).
  - parallel submit: N pending legs → N `submit-leg` actions, one per leg,
    legIndex-matched.
  - parallel poll: zero pending, some submitted, barrier not met → single
    `poll`.
  - serial submit: zero submitted, lowest-index pending leg chosen over a
    higher-index one when both are pending (proves "lowest index," not "any
    pending").
  - serial poll: one leg submitted → `poll`, no submit-leg emitted even
    though other legs are still pending.
  - `canReplan: false` (single-mode step) with a failed leg → `fail-run`
    immediately regardless of `attempt`/`maxReplanAttempts`.
  - `deadlineAt: null` → deadline branch never triggers no matter how far in
    the future `now` is.
- `tests/chained-run-invariants.test.ts` (new cross-cutting gate, mirroring
  `tests/double-fire.test.ts`'s existing pattern) — property-style coverage
  over `advanceRun` directly (no DB, no driver needed, since the invariant is
  entirely a property of this pure function): for every `RunState`/
  `LegState[]`/`policy` combination exercised by the branch tests above,
  `advance-step` is NEVER among the returned actions unless
  `legs.every(l => l.status === "confirmed")`. This is the pure-logic half of
  the handoff's stated invariant ("a run never advances while any leg of the
  current step is unconfirmed"); the other half — the driver actually
  obeying what `advanceRun` returns — is Phase 3's `tick.test.ts` coverage,
  out of scope here.

## Acceptance criteria

- [ ] `advanceRun` is exported from `src/server/pure/run-advance.ts` and
      re-exported from `src/server/index.ts`'s pure-helpers block, alongside
      `parseRuntimeArgKeys`/`parseCapabilityLine`.
- [ ] Every branch in the Decision algorithm section above has at least one
      passing test asserting its exact `RunAction[]` output (kind, and
      `legIndex`/`reason` where applicable).
- [ ] A parallel step with one failed leg and others still in flight does
      NOT return `replan-step`/`fail-run` — proven by a test, not just
      asserted in prose (the handoff §5.5 worked example).
- [ ] A serial step with a mid-sequence failure returns `replan-step`/
      `fail-run` even while later legs are still `pending` — proven by a
      test (the cursor-invalidation rule this design adds beyond the
      handoff's literal text).
- [ ] `tests/chained-run-invariants.test.ts` exists and fails if `advanceRun`
      is mutated to return `advance-step` with any non-confirmed leg present
      (verified during review by a mutation sanity-check, not just by the
      test passing once).
- [ ] `advanceRun` never throws for any input matching the declared types —
      every branch, including the two defensive `wait` fallbacks, is reached
      by a test rather than left as dead/unverified code.

## Out of scope

- Phase 3 (the driver that calls `advanceRun`, executes its actions against
  the store + chain client, and owns the poll-before-decide call order this
  design assumes).
- Any change to `store/runs.ts`, `schema.ts`, or `executor.ts` — this phase
  adds exactly one new pure module plus its tests.
- The `StepPlanner` registry (Phase 4) and the built-ins (Phase 4b) —
  `replan-step`'s "ask the planner" is a Phase 3/4 concern; this phase only
  emits the instruction.
