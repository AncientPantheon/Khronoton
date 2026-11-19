# Review — Phase 4.1: ouronet.aqp-unstall + ouronet.aqp-inject + generation-scoped re-plan + split-plan port

**Scope** (resolved from plan.md's ticked tasks, T1-T6):
`packages/khronoton-core/src/server/store/runs.ts` (new `bumpRunAttempt`/
`touchRunDeadline` + `insertRunLeg`'s `attempt` param), `store/runs.test.ts`,
`store/index.ts`, `pure/split-plan.ts` (new), `pure/split-plan.test.ts` (new),
`planners/inject.ts` (new), `planners/inject.test.ts` (new),
`planners/unstall.ts` (new), `planners/unstall.test.ts` (new),
`server/index.ts`, `runs-driver.ts` (the generation-scoping fix to
`handleReplanStep` + `driveRunOnce`'s `stepLegs` filter), `runs-driver.test.ts`.

**Lens set:** correctness, conventions, tests, security (4-lens tier — this
is a funds-moving automaton porting real transaction-construction logic
across a workspace boundary, same tier as Phase 4).

## Round 1 (pre-existing findings carried into this continuation)

### [LOW] `inject.ts` validated `amount` was a string but never validated it was a well-formed, non-negative decimal
- **Verdict:** CONFIRMED (downgraded from an initial MEDIUM framing — format
  errors are already gated by the downstream `simulate` call; the gap is
  real but defensible). **Resolution:** fixed — added
  `/^\d+\.\d+$/.test(amount)` validation rejecting sign characters,
  exponents, and non-decimal shapes before `amount` ever reaches a signed
  transaction's payload. 7-case `it.each` test added
  (`-5.0`, `abc`, `5`, `5.`, `.5`, `5.0e3`, `""`).

### [MEDIUM] `split-plan.test.ts` never exercised the growth loop's actual probe-call success path
- **Verdict:** CONFIRMED. The growth loop (`planFromSizing`'s
  `for (let growth = 0; growth < MAX_GROWTHS; growth++)` block) existed with
  zero coverage of `run(planned.largest)` actually succeeding and `best`
  being reassigned, or of the refusal-during-growth branch.
  **Resolution:** fixed — added two new `describe` blocks: one where a
  growth probe succeeds and replaces `best` with fewer, larger batches
  (3→2); one where a growth probe is refused and the previously-confirmed
  plan is left standing.

### [LOW] Five other failure branches in `split-plan.ts` were untested
- **Verdict:** CONFIRMED (one-item-probe-refused, sample-probe-refused,
  `capacity<1` in both `measureSize` and `planFromSizing`, confirmation-loop-
  exhausts-without-confirming). **Resolution:** fixed — five dedicated
  tests added, two of them (`capacity<1` in `planFromSizing`, confirmation-
  exhaustion) constructing a `SplitSizing` object by hand and calling
  `planFromSizing` directly, since `measureSize` itself can never produce a
  sizing that would reach those two branches.

## Round 2 (narrow re-review of Round 1's fixes)

Security lens on `inject.ts`'s new regex: **clean.** Tests lens on
`split-plan.test.ts`/`inject.test.ts`'s new tests found 2 more:

### [MEDIUM] Confirmation-loop-exhaustion test's shrink sequence was asserted only by count, not value
- **Verdict:** CONFIRMED. The test's own comment claimed capacities
  "92 → 69 → 51", but the actual batch lengths handed to `probe` are
  `[67, 67, 50]` (capacity is converted to a batch COUNT via `Math.ceil`
  before `evenSplit`, so two different capacities can round to the same
  batch shape) — the test asserted only `calls.toHaveLength(3)`, silently
  tolerating this discrepancy. **Resolution:** fixed — `expect(calls).toEqual([67, 67, 50])`,
  with the comment corrected to explain the capacity→count→batch-length
  distinction.

### [LOW] The growth loop's second-successful-iteration path was never exercised
- **Verdict:** CONFIRMED. `MAX_GROWTHS = 2`, but neither of the growth
  tests added in Round 1 let the loop's SECOND iteration actually call
  `run()` again (one breaks on "no fewer batches," the other is refused on
  its first growth attempt). **Resolution:** fixed — added a third
  growth-family test (n=300, deliberately engineered margins) proving both
  growth iterations each call `run()` and each successfully replace `best`,
  dropping batch count 4→3→2.

## Round 3 (terminal pass, attempt 1 — full scope, full lens set)

### [HIGH→REFUTED] "`planFromSizing`'s confirmation probe can collapse to probing the entire unbounded selection in one call"
- **Verdict:** REFUTED. The correctness lens traced a real-looking scenario
  (`capacity > n` when per-item cost is cheap relative to `ceiling`) and
  claimed this violated the module's "never probe the full selection"
  guarantee. Adversarial validation found an EXISTING test
  (`split-plan.test.ts`'s "a confirmation probe that refuses once, then
  succeeds after shrinking", 100 items) already exercises exactly this
  scenario and proves the shrink-and-retry loop (bounded by
  `MAX_CONFIRMATIONS=3`, shrink factor 0.75) handles it gracefully — it
  never silently accepts an oversized batch, and the module's own doc
  comment's "never probe the full selection" promise is scoped to the SIZE
  phase's two bounded probes, not the CONFIRM phase (whose entire job is to
  verify a candidate batch, including the whole-selection candidate, via a
  real probe). **No fix needed.**

### [MEDIUM] `PlannerNotRegisteredError`'s message/doc comment were stale, still framing the registry as "Phase 4, not yet built"
- **Verdict:** CONFIRMED. The registry and three real planners
  (`ouronet.aqp-evict`/`-inject`/`-unstall`) are fully built and registered;
  the error text would mislead an operator debugging a genuine planner-name
  typo into thinking the whole mechanism doesn't exist. **Resolution:**
  fixed — message changed to `` `planner '${plannerName}' is not registered
  in the StepPlanner registry` ``; doc comment updated to match.

### [LOW→STYLISTIC] `store/runs.ts` imports `randomUUID` via `import { randomUUID } from "node:crypto"` instead of the majority `import crypto from "node:crypto"` form
- **Verdict:** downgraded to STYLISTIC. `store/fires.ts` already uses the
  same destructured-import form, so this is a pre-existing, precedented
  alternate convention in this directory (2 files vs. 4), not a novel
  inconsistency introduced by this change — functionally identical either
  way. **Resolution: left as a user-choice item, not fixed** (see Outcome).

### [MEDIUM] `unstall.test.ts`'s fan-out test asserted `legs.length >= 2` instead of the deterministic exact shape
- **Verdict:** CONFIRMED. With the mocked gas values, `splitPlan` produces
  exactly 3 batches `[34, 33, 33]` after one shrink — a regression that
  silently accepted the refused 50/50 split would still pass the test's
  loose `>= 2` + disjoint-coverage checks. **Resolution:** fixed — tightened
  to exact `toHaveLength(3)` + `[34, 33, 33]` + `dirtyRead` called exactly 5
  times.

### [LOW] `runs-driver.test.ts`'s replan-exhaustion test asserted `>= 2` planner calls instead of the policy-determined exact value
- **Verdict:** CONFIRMED. With `maxReplanAttempts: 1`, `replanOrFail`'s
  guard permits exactly one replan — exactly 2 planner calls is the only
  correct value; an off-by-one guard bug would still pass `>= 2`.
  **Resolution:** fixed — tightened to exact `toBe(2)` + asserted
  `run!.attempt === 1`.

## Round 4 (terminal pass, attempt 2 — full scope, full lens set)

Correctness, conventions, security: **clean.** Tests lens found 2 more:

### [MEDIUM] `deadline_at` asserted only `not.toBeNull()` where the exact value is fully computable
- **Verdict:** CONFIRMED. `NOW`, the default `RUN_STEP_DEADLINE_MS`, and
  `computeStepDeadline`'s arithmetic are all fixed/known in this test — a
  wrong offset or wrong `now` reference would still pass a bare non-null
  check. **Resolution:** fixed — `expect(run!.deadline_at).toBe(new
  Date(NOW.getTime() + RUN_STEP_DEADLINE_MS).toISOString())`.

### [MEDIUM] "200 items, sample doesn't cover" test left the exact batch shape unpinned
- **Verdict:** CONFIRMED. The deterministic linear model produces exactly
  `[100, 100]` with `worstBatchGas: 1_000_000`; the test only checked
  length/balance/sum. **Resolution:** fixed — exact `toEqual`/`toBe`
  assertions added, matching every sibling test in the file.

## Round 5 (terminal pass, attempt 3 — full scope, full lens set)

Correctness, conventions, security: **clean.** Tests lens found 4 more
(the smallest, most granular findings yet — a sign of genuine convergence):

### [LOW] (downgraded from MEDIUM) `estimatedTransactions` asserted `toBeGreaterThan(1)` where the exact value (2) is derivable
- **Verdict:** CONFIRMED, downgraded — the same test's later exact
  assertions on `batches`/`worstBatchGas`/`calls` already guard the
  underlying regression this loose check nominally permits, so independent
  risk is low. **Resolution:** fixed — `toBe(2)`.

### [MEDIUM] `inject.test.ts`'s `CC_Inject` fallback test used `toContain`/`not.toContain` instead of an exact string, and never asserted `payload`
- **Verdict:** CONFIRMED — a substring check doesn't catch argument-order
  bugs or a payload-shape regression specific to the fallback leg.
  **Resolution:** fixed — exact pact-code string + `payload` equality
  check added, matching the sibling finalize-success test's rigor.

### [MEDIUM] `measureSize`'s `n===0` synthetic branch had no dedicated test
- **Verdict:** CONFIRMED — a distinct, exported, synthetic-return-shape
  branch with zero coverage (mitigated only by today's single caller,
  `unstallPlanner`, special-casing the empty list before ever calling
  `splitPlan`). **Resolution:** fixed — `splitPlan([], probe, CEILING)`
  test added, asserting the exact synthetic shape and that `probe` is
  never called.

### [LOW] `measureSize`'s ">1-item sample-covers-whole-and-fits" branch had no dedicated unit test
- **Verdict:** CONFIRMED — only indirectly exercised via `unstall.test.ts`'s
  end-to-end mock, which never inspects `measureSize`'s own return shape.
  **Resolution:** fixed — dedicated 10-item `measureSize` test added,
  asserting the exact `fitsInOne:true` sizing object.

## Round 6 (terminal pass, attempt 4 — tests lens alone, then a combined correctness/conventions/security recheck)

Tests lens, third pass over this scope: **clean** (explicitly declined to
manufacture a borderline finding after three prior rounds closed the
obvious gaps). Combined correctness/conventions/security recheck found one
more:

### [MEDIUM] `handleReplanStep`'s docstring contradicted its own Phase-4.1 implementation
- **Verdict:** CONFIRMED. The docstring still claimed "`canReplan` is
  always `false` for every step mode Phase 3 actually drives, so this
  action is only ever reached via... a step's very first entry" — true in
  Phase 3, false since this same phase's `driveRunOnce` sets
  `canReplan: step.mode === "planner"`, making the genuine-re-plan path a
  few lines below the comment routinely reachable. A maintainer trusting
  the stale comment could "simplify" the function back toward the Phase-3
  assumption, silently reintroducing the `RunLegAlreadyExistsError`/stuck-
  barrier bug this phase was built to fix. **Resolution:** fixed — doc
  comment rewritten to describe both reachable cases (first entry vs.
  genuine re-plan), cross-referencing design.md §A and `store/runs.ts`'s
  `touchRunDeadline` doc.

## Round 7 (terminal pass, attempt 5 — full scope, full lens set)

All four lenses dispatched together, scoped to every file touched across
all six tasks. **Zero findings across all four lenses.** This is the clean
terminal pass.

## Final verification (quoted, after the last applied edit)

```
> @ancientpantheon/khronoton-core@0.12.0 typecheck
> tsc --noEmit
(no errors)

 Test Files  86 passed (86)
      Tests  1190 passed (1190)

> @ancientpantheon/khronoton-core@0.12.0 build
> tsc -p tsconfig.build.json && tsup && node scripts/bundle-css.mjs
ESM ⚡️ Build success in 823ms
DTS ⚡️ Build success in 3370ms
```

## Behavioral verification (against the real built artifact, `dist/server/index.js`, not mocks)

Confirmed `getStepPlanner("ouronet.aqp-evict"/"ouronet.aqp-inject"/"ouronet.aqp-unstall")`
all resolve through the public built barrel, and `new
PlannerNotRegisteredError("bogus.name").message` reads exactly `"planner
'bogus.name' is not registered in the StepPlanner registry"` — confirming
the Round 3 message fix landed in the actual compiled output, not just the
source.

Drove a real 100-user stale-list through the REAL `ouronet.aqp-unstall`
planner off `dist/`, with a mocked chain reporting a 50-item confirm probe
refused over the gas ceiling:

```
legs count: 3
batch sizes: [ 34, 33, 33 ]
first leg pactCode: (ouronet-ns.AQP-FVT.CCp_FvtFixSlice (read-string "patron")
  (read-string "fvt-id") (read-string "reward-dptf-id") (read-msg "users"))
total dirtyRead calls: 5
```

This is an EXACT match with the hand-derived arithmetic in
`unstall.test.ts`'s fan-out test (Round 3's fix target) — the real compiled
shrink-and-retry loop produces the identical 3-batch, 34/33/33 split, and
the Pact code is namespaced (`ouronet-ns.AQP-FVT`, not bare `AQP-FVT`) with
every dynamic value read back via `read-string`/`read-msg` placeholders,
never string-concatenated.

Drove the real `ouronet.aqp-inject` planner off `dist/` with two scenarios:
a negative amount (`"-5.0"`) was rejected before any chain call, with the
exact message `` `ouronet.aqp-inject: amount must be a non-negative decimal
string (e.g. "5.0"), got "-5.0"` `` (confirming Round 1's regex fix is live
in the compiled output); and a scenario where both `CC_InjectFinalize` and
`CC_Inject` fail on-chain correctly rethrows the genuine failure
(`"stale stakers remain"`) rather than silently swallowing it or fanning
out.

## Outcome

**7 rounds. 18 findings raised across the whole phase, 16 CONFIRMED (15
fixed + 1 left as a pending user choice), 1 REFUTED, 1 downgraded to
STYLISTIC (the `randomUUID` import-style item, folded into the same count).**
Terminal full-scope, full-lens-set pass (Round 7) is clean across all four
lenses. Full suite green (1190/1190, up from 1173 at the start of this
review cycle — 17 new/tightened tests), typecheck clean, build clean, and
the exact generated Pact code/payload shape plus the generation-scoped
re-plan fix's behavior independently re-confirmed against the real compiled
`dist/server/index.js` artifact, not just mocks.

The one HIGH finding raised against the ported `split-plan.ts` algorithm
(a feared "probe the full unbounded selection" collapse) was rigorously
investigated and REFUTED — the shrink-and-retry loop already handles that
exact scenario gracefully, proven by a pre-existing test.

### Pending user choice (not fixed, not blocking)

- **`store/runs.ts`'s `randomUUID` import style** (`import { randomUUID }
  from "node:crypto"` vs. the majority `import crypto from "node:crypto"`
  form used in `steps.ts`/`cronoton.ts`/`manual-batch.ts`/`public.ts`).
  Downgraded to STYLISTIC because `store/fires.ts` already uses the same
  destructured form — real but genuinely a preference with precedent on
  both sides. Left as-is pending the user's choice at the end-of-work
  review; purely cosmetic, zero behavioral difference either way.
