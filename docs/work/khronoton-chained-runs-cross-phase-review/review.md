# Cross-phase review — chained multi-step cronoton runs (all phases, post-Phase 5)

**Trigger:** after Phases 0–5 of the chained-runs feature were individually
shaped/planned/built/reviewed and all green (89 test files, 1255 tests,
typecheck clean, build clean), the user asked for one more pass across the
whole feature — "lets do a review of whats been built, maybe we find more
bugs" — specifically looking for cross-phase integration seams that each
phase's own single-phase review could not see (a planner wired in Phase 4
driven for the first time through Phase 5's `executeNow`/standalone-fire
routes; the Phase 3 core driver reopened by Phase 5's concurrency fix; etc.).

This review was never written to disk at the time it ran. This document
reconstructs it in full from the session transcript so the feature's
`docs/work/` history is complete before publish, per this workspace's
convention that reviews live under `docs/work/<topic>/`.

## Scope

All files touched across Phases 0–5: `handlers/execute.ts`,
`handlers/steps.ts`, `handlers/read.ts`, `handlers/index.ts`,
`server/resolvers.ts`, `server/runs-driver.ts`, `server/loop.ts`,
`server/tick.ts`, `server/executor.ts`, `server/schema.ts`,
`server/seams.ts`, `server/store/runs.ts`, `server/store/steps.ts`,
`server/store/errors.ts`, `server/store/index.ts`,
`server/pure/run-advance.ts`, `server/pure/split-plan.ts`,
`server/planners/{evict,inject,unstall,stoa-wrap,stoa-unwrap,registry}.ts`,
`blockchain/stoachain.ts`, and their test files.

## Round 1 — 5 lenses in parallel, cross-phase integration focus

Lenses: tests, conventions, security, performance, correctness. Each
targeted specifically at cross-phase seams rather than re-litigating any
single phase's already-reviewed internals.

### Tests lens — 3 findings

- **[HIGH]** No test drives a multi-step cronoton through two DIFFERENT
  real planners end-to-end. Every multi-planner test in
  `runs-driver.test.ts` used a trivial test-only planner for one step and
  a `mode:'single'` step for the other; no test chained e.g.
  `ouronet.aqp-unstall` → `ouronet.aqp-inject`, the actual shape the
  feature exists for.
- **[HIGH]** `handlers/steps.ts`'s standalone fire/simulate route was
  never tested against any of the five real shipped planners — only
  hand-rolled trivial test planners (`steps-test-fanout-2/3`).
- **[MEDIUM]** `executeNow`'s chained-row branch was only tested with
  `mode:'single'` steps, never `mode:'planner'`.

All three CONFIRMED on adversarial validation, severities as claimed.

### Conventions lens — 2 findings

- **[MEDIUM]** `isUniqueConstraintError` duplicated verbatim between
  `store/runs.ts` and `store/steps.ts`, with `steps.ts`'s own doc comment
  admitting it "mirrors `runs.ts`'s identical helper" — duplication kept
  despite being noticed, with no shared home in `store/errors.ts` (which
  both files already import from for error classes).
- **[MEDIUM]** Stale "(used as the executor)" error text copy-pasted into
  `planners/unstall.ts`'s signer-empty check, even though — unlike the
  other four planners — `unstall.ts` never computes an `executor`
  variable (`CCp_FvtFixSlice`'s signature has no credited-caller
  argument), per the file's own doc comment.

Both CONFIRMED on adversarial validation.

### Security lens — 1 finding

- **[HIGH]** Per-leg computed transaction details (real transfer amounts,
  patron/beneficiary account identifiers, literal Pact capability lines)
  leaked through `runLegsHandler` behind only the weak `withRead` gate —
  a full unredacted `SELECT *`/`JSON.stringify` round-trip of
  `definition_json`, in direct contrast to every sibling read surface in
  this same feature (`listFires`'s explicit column allowlist,
  `toPublicCronotonView`'s explicit ban list, `steps.ts`'s own
  confirm-gated standalone-fire response deliberately omitting
  `signers`). CONFIRMED on adversarial validation, severity HIGH as
  claimed — real account identifiers and computed amounts exposed, not
  private key material (`CodexSigner` only ever carries `publicKey`).

### Performance lens — 2 findings

- **[HIGH]** `resolveCeiling`'s live `getBlockGasLimit()` fetch
  (`executor.ts`) has no caching and is re-issued on every leg submit and
  every planner probe within a single `driveRunOnce`/planning pass — up
  to ~7 probes for `ouronet.aqp-unstall`'s `splitPlan` alone, all
  serialized behind the loop's single `running` guard, so one fanned-out
  run's redundant network chatter delays every other scheduled fire and
  run in the same tick. CONFIRMED, severity HIGH as claimed (real
  uncached HTTP round-trips, not a local DB cost).
- **[MEDIUM, downgraded to LOW on validation]** `handleReplanStep`
  re-queries the full `listRunLegs` result the caller (`driveRunOnce`)
  already fetched, doubling the read cost of that table on every
  first-plan/re-plan. Validator downgraded MEDIUM → LOW: the underlying
  query is a cheap, local, indexed embedded-SQLite read, not a network
  call, and `handleReplanStep` runs far less often than the per-leg/
  per-probe hot path of the HIGH finding above — a real but low-stakes
  duplicate-query nit, not a maintainability trap.

### Correctness lens — 1 finding

- **[CRITICAL]** A planner throw on a step's first `replan-step` pass
  (the universal first action for any brand-new run, since `createRun`
  leaves `deadline_at = NULL` and `advanceRun`'s "no legs yet" branch is
  evaluated unconditionally, before the deadline-exceeded branch is ever
  reachable) left the run stuck non-terminal forever: `handleReplanStep`
  called into the step's planner with no surrounding try/catch, a throw
  there propagated straight out of `driveRunOnce`'s loop, and
  `advanceInFlightRunsOnce`'s per-run catch only logged to `erroredIds` —
  it never called `markRunTerminal`. Because `deadline_at` was never
  stamped, the deadline-based `replanOrFail`/`maxReplanAttempts` recovery
  path could never engage either (gated on `deadlineAt != null`). The
  partial unique self-block index then permanently blocked any future
  run for that cronoton, with no exposed handler anywhere in `src/handlers`
  able to terminalize a stuck run — the only recovery was direct DB
  surgery. Realistically reachable: every real planner's first action is
  a live chain simulate read (malformed `planner_params_json`, a genuine
  non-gas Pact failure, or a transient chain outage all throw from this
  exact unprotected statement). CONFIRMED CRITICAL on dedicated adversarial
  validation — the existing "planner throw doesn't block a second run"
  test was shown to corroborate rather than refute the claim: it asserts
  the healthy second run proceeds, but never checks whether the first
  (thrown) run ever recovers, which it does not.

**Round 1 outcome: 9 findings raised, 9 CONFIRMED on adversarial
validation, 0 REFUTED.** (4 HIGH, 3 MEDIUM — one downgraded to LOW — and
1 CRITICAL.)

## Fixes applied (severity order)

1. **CRITICAL — stuck run.** `handleReplanStep` wrapped so a throw during
   the planner-resolution-and-call region calls `handleFailRun` (marking
   the run terminally `failed`, with an audit event) instead of
   propagating unhandled. Proven by new regression tests: a genuine
   planner throw, and the pre-existing `PlannerNotRegisteredError` case,
   both now terminalize the run instead of leaving it stuck.
2. **HIGH — security leak.** `handlers/read.ts` gained a `redactLegRow`
   projector (mirroring `toPublicCronotonView`'s field-by-field,
   never-spread convention) applied in `runLegsHandler`, stripping
   `signers`/capabilities from the returned `definition_json` so a
   read-tier caller can no longer see account identifiers, computed
   amounts, or capability lines. New regression test added.
3. **HIGH — uncached gas-ceiling fetch.** `resolveCeiling` gained a
   short-TTL (30s) in-memory cache keyed by chain id in `executor.ts`,
   threaded through the three call sites (`runSimulate`/`runFire`/
   `runSubmit`) that now pass `chainId`. Both `executor.test.ts` and
   `runs-driver.test.ts` (which exercises the real executor) needed the
   cache cleared in `beforeEach` to avoid cross-test leakage — found and
   fixed. New regression test proves repeated calls within the TTL hit
   the cache.
4. **HIGH/MEDIUM — the 3 test-coverage gaps.** Added: a genuine two-real-
   planner (`ouronet.aqp-unstall` → `ouronet.aqp-inject`-shaped) chained
   `runs-driver.test.ts` case reaching `succeeded`; a real-built-in-planner
   case in `steps.test.ts` for the standalone fire/simulate route; a
   `mode:'planner'` case for `executeNow`'s chained-row branch in
   `execute.test.ts`.
5. **MEDIUM — `isUniqueConstraintError` duplication.** Moved into
   `store/errors.ts` as a shared export; both `store/runs.ts` and
   `store/steps.ts` now import it instead of each declaring their own copy.
6. **MEDIUM — stale `unstall.ts` error text.** Reworded to match what the
   file's own doc comment already explains (no `executor` argument exists
   for `CCp_FvtFixSlice`).
7. **LOW — redundant `listRunLegs` query.** `driveRunOnce` now fetches the
   full run-legs list once per outer iteration and threads it down to both
   its own `stepLegs` filter and `handleReplanStep`, instead of each
   independently re-querying the store.

All 9 fixes applied; full suite run after: **1263/1263 tests passing**,
typecheck clean.

## Round 2 — terminal re-review of the fix set

Dispatched a full-scope, full-lens terminal pass specifically to
re-scrutinize the fixes above (a substantial amount of production code —
including the core driver's `handleReplanStep` — had just been touched a
second time). Caught a genuine regression in fix #1:

- **[CRITICAL]** `handleReplanStep`'s new blanket catch converted a
  benign, already-documented concurrency race (two concurrent
  `driveRunOnce` calls racing on `insertRunLeg`, the loser throwing
  `RunLegAlreadyExistsError`) into a permanent, incorrect run failure —
  strictly worse than the pre-fix behavior, where the loser's throw was
  simply isolated by `advanceInFlightRunsOnce`'s per-run try/catch while
  the winner's run continued progressing normally.
- **[HIGH]** The same catch was broader than its own documented
  justification: it wrapped every `handleReplanStep` call, including a
  genuine re-plan (`isReplan === true`), so a single transient planner
  error (e.g. a flaky chain read during a legitimate retry) now
  permanently failed the run instead of letting `maxReplanAttempts`'s
  existing retry budget apply.

Both CONFIRMED on dedicated adversarial validation.

## Fix round 2

`handleReplanStep`'s catch logic was narrowed to only terminalize
unconditionally for the genuinely-unrecoverable first-entry case (no
legs yet for the step, i.e. `deadline_at` was never stamped) and to let
a genuine re-plan's throw propagate to `advanceInFlightRunsOnce`'s
existing per-run isolation as before, preserving the `maxReplanAttempts`
retry budget. Two new regression tests added proving: (a) a benign
concurrent-insert race no longer fails a run that is otherwise
succeeding, and (b) a transient throw during a genuine re-plan is
retried on the next pass rather than immediately terminalizing the run.

Full suite after this fix: **1265/1265 tests passing**, typecheck clean,
build clean (verified directly, not just reported).

## Round 3 — final terminal pass

A further full-scope terminal review pass was dispatched specifically to
re-scrutinize the Round 2 fix (the narrowed catch logic). That pass's own
result was not recovered before this document was finalized (background
task output is not retrievable without its task id, which fell out of
context). In its place, a fresh independent verification was run directly
at publish time: full typecheck (clean), full build (clean), and the full
test suite (1265/1265 passing) against the working tree exactly as it
stands — covering the Round 2 fix along with everything else in this
cycle. This is a weaker guarantee than a fourth reviewer's eyes on the
narrowed catch logic specifically, so that logic (`handleReplanStep` in
`server/runs-driver.ts`) is worth a closer look in the next review cycle
if anything related surfaces in production.

## Outcome

**3 rounds total across this cross-phase cycle. 11 findings raised, 11
CONFIRMED, 0 REFUTED, 0 STYLISTIC** (1 CRITICAL + 1 HIGH found during
Round 2 specifically because Round 1's own CRITICAL fix was applied and
then re-reviewed, exactly the discipline a fix of that weight warrants).
Final state: 1265/1265 tests passing, typecheck clean, build clean.

Standout findings, for changelog purposes: the CRITICAL stuck-run bug
(a planner throw on a run's first pass could permanently brick a
cronoton's ability to ever run again) and the HIGH `runLegsHandler`
transaction-detail leak are both genuinely new findings from this
cross-phase round — distinct from Phase 5's own two HIGH findings
(`fireStep`'s paused-guard bypass and the `driveRunOnce` concurrency
race), which were already fixed and documented in
`docs/work/khronoton-chained-runs-phase-5/review.md` before this round
began.
