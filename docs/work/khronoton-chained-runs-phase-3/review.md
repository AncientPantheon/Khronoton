# Review — Phase 3: the non-blocking driver

**Scope** (resolved from plan.md's ticked tasks, T1-T6):
`store/runs.ts`, `store/runs.test.ts`, `store/errors.ts`, `store/mappers.ts`,
`store/mappers.test.ts`, `seams.ts`, `store/index.ts`, `runs-driver.ts` (new),
`runs-driver.test.ts` (new), `server/index.ts`, `tick.ts`, `tick.test.ts`,
`loop.ts`, `loop.test.ts`.

**Lens set:** correctness, conventions, tests, security (4-lens tier for
14 files, upgraded with security given this is a funds-moving automaton and
`runs-driver.ts` deserializes stored JSON back into transaction definitions).

**Mid-build correction:** the approved design had `RunPolicy.canReplan`
backwards (`mode:'single'` ⇒ true instead of `mode:'planner'` ⇒ true).
Caught and fixed in `design.md` before planning off it — this simplified
Phase 3 considerably: no attempt-bump/retry machinery is needed, since a
`mode:'single'` step's only route to `replan-step` is its very first entry;
any later failure or missed deadline goes straight to `fail-run`.

**Build-time deviation, surfaced for review:** `driveRunOnce` was built as a
loop-until-no-progress (re-invoking `advanceRun` after every mutating
action) rather than the plan's literal single-pass description — necessary
to satisfy both design.md §B ("step 0 planned-and-submitted within one tick
pass") and the plan's own multi-action-in-one-call test requirement. The
correctness lens actively tried to find a counterexample (infinite loop,
double-act, stale-data read) across 2 rounds and found none; the loop is
bounded by strictly monotonic state progression (leg status is one-way,
`step_index` only increases, run status only moves toward terminal).

## Round 1

### [MEDIUM, was CRITICAL] `handleSubmitLeg` submits before any DB-level claim on the leg
- **Verdict:** CONFIRMED, downgraded CRITICAL→MEDIUM. The ordering is real
  (`markLegSubmitted`'s guard runs after the chain submission, not before
  it, unlike `claim.ts`'s claim-before-fire idiom its doc comment claimed
  parity with) and the doc comment overstated the guarantee. No current
  caller can actually race it — every layer (`loop.ts`'s re-entrancy guard,
  `codexCronotonTickOnce`'s due-row loop, `driveRunOnce`'s own action loop)
  is provably sequential by construction, not just empirically unraced.
  **Resolution:** fixed — corrected the misleading doc comments in
  `store/runs.ts` and `runs-driver.ts` to state the real guarantee (safe
  against sequential retry, NOT safe against a future concurrent caller) and
  what a real fix would require (an interim leg status), deferred as a
  schema change out of this phase's scope.

### [MEDIUM] Stored leg definitions are JSON.parsed and blindly cast with no shape validation
- **Verdict:** CONFIRMED. **Resolution:** fixed — added `parseLegDefinition`,
  a shallow shape gate (non-empty `pactCode`, array `signers`, object
  `gasPayer`/`config`) called before any parsed definition reaches the
  signer, with a JSON.parse-failure and shape-failure both routed to a new
  `codex_cronoton_run_leg.invalid_definition` audit event, leaving the leg
  `pending` (never submitted) rather than crashing or signing garbage.

### [MEDIUM] A freshly created run is driven twice in the same loop pass (double-poll)
- **Verdict:** CONFIRMED — real, happens on the common chained-run-creation
  path, breaks the documented "one request per chain per tick" contract,
  non-data-corrupting (conditional-UPDATE guards prevent a double-confirm)
  but wasteful and untested. **Resolution:** fixed — `advanceInFlightRunsOnce`
  gained an `excludeRunIds` parameter and a named `AdvanceRunsResult` type;
  `CodexTickResult` gained `drivenRunIds`; `loop.ts` now threads the tick's
  driven-run-ids into the sweep's exclude set.

### [MEDIUM, was HIGH] New seam-default constants (`RUN_STEP_DEADLINE_MS`, `DEFAULT_MAX_REPLAN_ATTEMPTS`) missing from the public barrel
- **Verdict:** CONFIRMED, downgraded HIGH→MEDIUM (a public-API completeness
  gap, not a silent behavior bug — nothing internal breaks, since
  `runs-driver.ts` imports the constants directly). **Resolution:** fixed —
  added both to `server/index.ts`'s seam-defaults re-export block.

### [LOW] `advanceInFlightRunsOnce`'s result shape was an unnamed inline type
- **Verdict:** CONFIRMED. **Resolution:** fixed as part of the double-poll
  fix — named, exported `AdvanceRunsResult { drivenIds, erroredIds }`.

### [LOW] `loop.test.ts`'s module doc was stale (said "ONE tick pass... then...", omitting the third pass)
- **Verdict:** CONFIRMED. **Resolution:** fixed.

### [LOW] `driveRunOnce`'s "run vanished"/"step missing" defensive branches were untested
- **Verdict:** CONFIRMED. **Resolution:** fixed — two new tests added.

### Discarded as REFUTED-as-out-of-scope (pre-existing, not introduced by this diff)
- `isUniqueConstraintError` duplicated between `store/runs.ts`/`store/steps.ts` — both predate Phase 3.
- `loop.ts`'s `DEFAULT_TICK_INTERVAL_MS` duplicating `seams.ts`'s `TICK_INTERVAL_MS` — predates Phase 3's edits to `loop.ts`.

## Round 2

### [MEDIUM] The double-poll fix's own plumbing was untested end-to-end (type-only assertion)
- **Verdict:** CONFIRMED (adjusted HIGH→MEDIUM: current behavior is
  correct, this is a regression-detection gap, not a live bug).
  **Resolution:** fixed — `loop.test.ts` now asserts actual `Set` contents;
  `runs-driver.test.ts` gained a real-DB test proving `excludeRunIds`
  actually skips the named run and still drives the other.

### [MEDIUM] `parseLegDefinition`'s reject path had zero test coverage (flagged independently by both the tests AND security lenses)
- **Verdict:** CONFIRMED. **Resolution:** fixed — two new tests (missing
  `pactCode`, non-array `signers`).

### [LOW] `handleSubmitLeg`'s "leg not found" defensive branch was untested
- **Verdict:** CONFIRMED. **Resolution:** fixed — one new test, forcing the
  branch via a `vi.spyOn` on `pure/run-advance.js`'s `advanceRun`.

### [MEDIUM] Chained-run success path could land a row in both `firedIds` and `skippedIds` on an audit-sink throw
- **Verdict:** CONFIRMED — `firedIds.push` happened before the `onAudit`
  await in the chained branch, unlike the plain-fire path below it which
  does the reverse. **Resolution:** fixed — reordered to audit-then-push.

### Discarded
- `isUniqueConstraintError` duplication re-raised — already settled, discarded without re-validating.
- `errors.ts`'s tuning constants claimed all-dead — **REFUTED**: three of the four (`MANUAL_BATCH_MIN`/`MAX`/`INTERVAL_SECONDS`) are actually imported and used by `manual-batch.ts`; the finding's own evidence was factually wrong.

## Round 3

### [LOW, was MEDIUM] `ChainClient.pollRequestKeys` absence silently stalls chained runs, contradicting `seams.ts`'s "falls back to listen" doc promise
- **Verdict:** CONFIRMED, downgraded MEDIUM→LOW. `handlePoll` never
  implements the documented one-key-at-a-time `listen` fallback. Zero
  current production impact: the only shipped adapter
  (`blockchain/stoachain.ts`) always implements `pollRequestKeys`; the
  stall is also bounded (the step's deadline eventually fails the run,
  rather than hanging forever). **Resolution:** fixed via documentation —
  corrected `seams.ts`'s doc comment to state the method is effectively
  required for a `ChainClient` meant to back chained runs, not a pure
  performance optimization, rather than building the literal fallback.

### [STYLISTIC] `parseLegDefinition`'s shallow shape-check doesn't validate `signers` elements or `gasPayer.type`
- **Verdict:** REFUTED. The function's own doc comment already accurately
  discloses it's "a shallow check (not a full schema validator)" and states
  exactly why (today's only writer is type-checked; this exists for Phase
  4's future planner-registry writer). No current writer could introduce
  the malformed shape this finding describes. No action taken.

### Discarded
- `loop.ts`'s `DEFAULT_TICK_INTERVAL_MS` duplication re-raised a third time — already settled twice, discarded without re-validating.

## Round 4 — terminal pass

All four lenses (correctness, conventions, tests, security) ran full-scope
against the final on-disk state. **Zero findings across all four.**

## Final verification (quoted, after the last applied edit)

```
> @ancientpantheon/khronoton-core@0.12.0 typecheck
> tsc --noEmit
(no errors)

 Test Files  81 passed (81)
      Tests  1132 passed (1132)

ESM ⚡️ Build success in 784ms
DTS ⚡️ Build success in 3414ms
```

## Behavioral verification (against the real built artifact, not mocks)

A full chained-run lifecycle driven through `dist/server/index.js`'s real
`codexCronotonTickOnce`/`advanceInFlightRunsOnce` against a real in-memory
better-sqlite3 DB, with a minimal mock `ChainRuntime`/`KeyResolver` standing
in for the network:

```
tick 1 result: {"firedIds":["<cronoton>"],"skippedIds":[],"drivenRunIds":["<run>"]}
legs after tick 1: [{"status":"submitted","request_key":"RK-SMOKE"}]
next_fire_at advanced? true

# second due tick while the run is still in-flight:
tick 2 result (self-block expected): {"firedIds":[],"skippedIds":["<cronoton>"],"drivenRunIds":[]}
still exactly one run? true
schedule advanced again despite self-block? true

advance pass 1: {"drivenIds":["<run>"],"erroredIds":[]}
run status after advance 1: succeeded
advance pass 2: {"drivenIds":[],"erroredIds":[]}
run status after advance 2: succeeded
```

Matches design.md's acceptance criteria exactly:
- **§B** — step 0's leg was built AND submitted within the SAME tick pass
  that created the run (not merely by the next loop interval).
- **§C** — the schedule's `next_fire_at` kept advancing on tick 2 even
  though the self-block correctly prevented a second run from being
  created — the two mechanisms are genuinely independent, as designed.
- **Self-block** — exactly one `codex_cronoton_runs` row exists throughout.
- **`advanceInFlightRunsOnce`** — correctly polls (nothing landed on the
  first poll, which happened inline during tick 1), then confirms and
  advances the barrier to `succeeded` on the next sweep, once the mocked
  chain reports the transaction landed — all without ever re-submitting
  the already-`submitted` leg.

## Outcome

**4 rounds. 13 findings raised across all rounds, 10 CONFIRMED (9 fixed, 1
fixed via documentation only), 1 REFUTED on its stated evidence, 1 REFUTED
as a correctly-scoped-already non-defect, 2 discarded as already-settled
re-raises of pre-existing-and-out-of-scope findings.** Terminal full-scope,
full-lens-set pass is clean. Full suite green (1132/1132), typecheck clean,
build clean, behavior verified end-to-end against the real built artifact
across the full create → submit → self-block → poll → confirm → succeed
lifecycle.
