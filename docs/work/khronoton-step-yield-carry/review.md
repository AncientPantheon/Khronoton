# Review — Khronoton step-to-step yield carry

Scope: 23 files (9 production files touched by T1–T6 plus their test files,
plus 7 incidentally-touched fixture files that needed a mechanical
`yield_as: null` field and, for 5 of them, a `normalizePlannerResult`
unwrap at their direct planner-call sites). Lenses: correctness,
conventions, security, tests, performance (16+ files → full 5-lens set per
round).

## Round 1 — 8 findings, all CONFIRMED, 0 REFUTED

### [HIGH] Confirming a `mode:'single'` step whose on-chain result has no `data` crashes yield capture, permanently stalling the run
- **Where:** `server/store/yields.ts`'s `upsertYield`, consumed from `server/runs-driver.ts`'s `handlePoll`
- **Why it mattered:** `JSON.stringify(undefined)` yields the JS value `undefined`, which better-sqlite3's `.run()` refuses to bind, throwing — but only *after* `markLegConfirmed` had already committed. A genuinely successful on-chain transaction got silently bricked with no recovery path.
- **Resolution: FIXED.** `upsertYield` normalizes `undefined` → `null` before stringifying. Regression test added in `store/yields.test.ts`.

### [HIGH] `$yield` resolution silently resolves reserved/prototype-chain names instead of throwing `YieldNotFoundError`
- **Where:** `server/pure/yields.ts`'s `resolveYieldRefs` (`name in pool`), `server/store/yields.ts`'s `getYieldPool` (plain `{}` pool)
- **Why it mattered:** `in` walks the prototype chain; `{"$yield":"toString"}` against an empty pool would silently resolve to an inherited `Object.prototype` function instead of throwing — defeating this feature's own "never silently guess" invariant, and risking a `__proto__`-named yield reassigning the pool's own prototype.
- **Resolution: FIXED.** `getYieldPool` builds its pool via `Object.create(null)`; `resolveYieldRefs` checks membership via `Object.prototype.hasOwnProperty.call(pool, name)`. Regression tests in both `pure/yields.test.ts` (reserved-name `it.each`) and `store/yields.test.ts` (`__proto__` round-trip).

### [MEDIUM] `handlers/steps.ts` reports "planner is not registered" for a `mode:'single'` step that actually failed on an unresolved `$yield` reference
- **Resolution: FIXED.** `resolveStepLegs` now returns a discriminated `{ok:false, reason: 'planner-not-registered' | 'yield-not-found', ...}` instead of a bare `{ok:false}`; a shared `resolveStepLegsErrorResponse` builds the correct message per reason. Regression tests assert the message names the actual yield, not `planner 'null'`.

### [MEDIUM] `stoaWrapPlanner`'s `amountOverride` path builds a real wrap transaction for a zero amount, unlike the live-probe path's explicit zero short-circuit
- **Resolution: FIXED.** `amountOverride === "0.0"` (numerically zero) now short-circuits to `return []`, mirroring the probed path's `data === 0` check. Regression test added.

### [LOW] Stale table-count comments left out of sync after adding the 7th table
- **Resolution: FIXED.** `schema.ts`/`schema.test.ts` doc comments updated "six" → "seven".

### [MEDIUM→LOW] Single-mode yield-resolution logic duplicated instead of sharing a helper, unlike the planner-mode case in the same change
- **Validator note:** downgraded from MEDIUM — a thin 3-line wrapper around an already-shared pure function, not substantive lookup logic.
- **Resolution: FIXED anyway** (worth closing even at LOW, given this exact drift pattern is this codebase's most-repeated review finding). Extracted `resolveSingleStepPayload` into `pure/yields.ts`; both `runs-driver.ts` and `handlers/steps.ts` now call it instead of each re-deriving the JSON.parse/resolveYieldRefs/JSON.stringify/spread sequence.

### [MEDIUM→LOW] Static step list re-fetched on every inner-loop iteration of `driveRunOnce`
- **Validator note:** downgraded from MEDIUM — a cheap local indexed SQLite read, not a network call; real but low-stakes.
- **Resolution: FIXED.** `listStepsForCronoton` hoisted to once per `driveRunOnce` call (via an initial `getRun` for the cronoton id), not re-fetched every inner-loop pass.

### [LOW] Full step-table scan to resolve one step by index in the standalone fire/simulate handler
- **Resolution: FIXED.** New `getStepByIndex(codexCronotonId, stepIndex, dep)` store function does a direct indexed point lookup; `handlers/steps.ts`'s `findStep` uses it instead of `listStepsForCronoton(...).find(...)`.

## Round 2 (terminal pass after Round 1's fixes) — 3 new findings, all CONFIRMED, 0 REFUTED

### [MEDIUM] A planner returning `{ legs: [], yield }` has its yield silently discarded instead of stored
- **Where:** `runs-driver.ts`'s `handleReplanStepInner` — the `legs.length === 0` early return happened *before* the yield-write check.
- **Resolution: FIXED.** The yield write now also happens in the empty-legs branch, before the `handleAdvanceStep` return. Regression test added.

### [LOW] Yield write and leg insert are not atomically paired, letting a concurrent loser's yield value win even though its legs were rejected
- **Resolution: FIXED** (folded into the same reordering as above). Leg inserts now run *before* the yield write; a losing racer's `insertRunLeg` throws before it ever reaches its own `upsertYield` call.

### [MEDIUM] Step-planner registry lookup is not prototype-pollution-safe, unlike its sibling yield pool
- **Where:** `planners/registry.ts`'s `STEP_PLANNERS` (plain `{}` literal)
- **Resolution: FIXED.** `STEP_PLANNERS` built via `Object.create(null)`, mirroring the yield pool's fix. Regression tests added (`it.each` over reserved names, plus a genuinely-registered-under-a-reserved-name case).

## Round 3 (terminal pass after Round 2's fixes) — 1 new finding, CONFIRMED, 0 REFUTED

### [MEDIUM] Concurrent genuine re-plan racers both bump `run.attempt`, even though only one's legs ever land
- **Where:** `runs-driver.ts`'s `handleReplanStepInner` — `bumpRunAttempt`/`touchRunDeadline` ran *before* the leg-insert loop, same ordering bug class as Round 2's yield-write finding, just not caught the first time since the fix only addressed the yield write specifically.
- **Why it mattered:** Two racers both computing `isReplan=true` from the same stale snapshot would both bump `attempt` before either's `insertRunLeg` resolved the collision — silently burning through `maxReplanAttempts` roughly 2x too fast under concurrency, causing premature `fail-run`.
- **Resolution: FIXED.** `bumpRunAttempt`/`touchRunDeadline` moved to after the leg-insert loop, alongside the yield write — all three "second-order" writes for a replan generation now only happen for whichever caller's legs actually won the race. Regression test added (extends the existing concurrent-race simulation pattern).

## Round 4 (terminal pass after Round 3's fix) — 0 new findings from the lens pass

All 5 lenses clean. The correctness lens specifically re-verified the final `insertRunLeg → bumpRunAttempt/touchRunDeadline → upsertYield` ordering in `handleReplanStepInner` end-to-end (given it had been rewritten twice across rounds) and confirmed it is correct and complete — not just reshuffled — citing the three dedicated regression tests that now pin it.

### One additional gap, caught by behavioral verification (not the lens pass)
`YieldNotFoundError` was not exported from the package's public `server/index.ts` barrel, breaking this codebase's own established convention that every custom typed error is public (`RunAlreadyInFlightError`, `PlannerNotRegisteredError`, etc. all are, so a host can `instanceof`-check them from its own error handling).
- **Resolution: FIXED.** Added `export { YieldNotFoundError } from "./pure/yields.js";` to `server/index.ts`. `resolveYieldRefs`/`resolveSingleStepPayload` deliberately remain internal-only (no external use case — resolution happens transparently before any planner or step-building code runs).

## Outcome

**4 review rounds, 12 findings total, 12 CONFIRMED, 0 REFUTED, 2 validator-adjusted severity downgrades (both honest signals of real adversarial scrutiny, not rubber-stamping). Terminal full-scope, full-lens-set pass (Round 4) is clean.**

Final state:
- `npx tsc --noEmit`: clean.
- `npm test`: **1317/1317 passing** (up from 1295 at the start of this review cycle — 22 new/tightened regression tests across the fix rounds).
- `npm run build`: clean (ESM + DTS + CSS bundle).
- **Behavioral verification** against the real compiled `dist/` artifact (not source, not a mocked DB): seeded a real cronoton with two `mode:'planner'` steps — the REAL registered `ouronet.stoa-wrap` (with `amountOverride: "77.0"`, `yieldAs: "wrappedAmount"`) followed by the REAL registered `ouronet.aqp-inject` (`amount: {"$yield":"wrappedAmount"}`) — drove it via `driveRunOnce` against a real in-memory `better-sqlite3` DB with a fake chain client at the system boundary. Result: run reached `succeeded`; inject's submitted leg's `payload.amount` was exactly `"77.0"`, the literal value wrap actually used, never independently re-probed or statically pre-set — the exact motivating case from `design.md`'s acceptance criteria, proven against the real shipped build.

All 7 of `design.md`'s acceptance criteria are satisfied:
1. ✅ Planner-yield production + consumption via real `driveRunOnce` — proven by `runs-driver.test.ts`'s dedicated test and the behavioral verification above.
2. ✅ Single-mode `yield_as` on-chain capture — proven by `runs-driver.test.ts`'s dedicated test.
3. ✅ Zero source changes to the 4 unmodified built-in planners (`evict`, `inject`, `unstall`, `stoa-unwrap`) for yield CONSUMPTION — confirmed; only `stoa-wrap` changed, for yield *production* (a different, explicitly in-scope axis).
4. ✅ Missing-yield reference fails loudly — `YieldNotFoundError`, now public, propagating through the established `handleReplanStep` catch path.
5. ✅ Replan overwrites stale values — proven by a dedicated test, and the Round 3 fix closes the concurrent double-counting gap in the same mechanism.
6. ✅ Zero regression on every pre-existing chained-run test.
7. ✅ The real drain→wrap→inject→evict chain's wrap→inject handoff carries a genuine, non-static, non-re-probed amount — proven twice (unit-level in `runs-driver.test.ts`, and now behaviorally against the compiled artifact).

Ready to publish as `khronoton-core` 0.14.0.
