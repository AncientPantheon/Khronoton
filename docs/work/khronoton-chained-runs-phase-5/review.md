# Review — Phase 5: handlers/observability (executeNow, adaptMultiTxSummary, per-step standalone fire, per-leg visibility)

**Scope** (resolved from plan.md's ticked tasks, T1-T6):
`handlers/execute.ts`, `handlers/execute.test.ts`, `server/resolvers.ts`,
`server/resolvers.test.ts`, `server/store/runs.ts`, `server/store/runs.test.ts`,
`server/store/index.ts`, `handlers/steps.ts` (new), `handlers/steps.test.ts`
(new), `handlers/read.ts`, `handlers/read.test.ts`, `handlers/index.ts`.
Extended mid-review into `server/schema.ts`, `server/runs-driver.ts`, and
`server/planners/registry.ts` — the already-shipped Phase 3 core driver —
when one finding required a real architectural fix there, not a handler-
layer patch.

**Lens set:** correctness, conventions, tests, security (4-lens tier,
consistent with every other phase of this feature — this round's scope is
the HTTP-facing layer of a funds-moving automaton, including a route that
can fire real Pact code on demand).

## Round 1 — full scope, full lens set

Correctness and security each surfaced a HIGH finding; tests and
conventions each surfaced findings of their own.

### [HIGH] `fireStep` could fire a paused or terminal cronoton's real Pact code, bypassing the guard `executeNow`/`triggerCronoton` already enforce
- **Verdict:** CONFIRMED, severity HIGH unchanged. `findStep` (the shared
  step-lookup helper in the new `handlers/steps.ts`) only checked the
  cronoton existed — never its `status`. Validation traced every other
  fire-capable route in this codebase and confirmed `executeNow`/
  `triggerCronoton` both explicitly reject a `paused`/terminal row before
  firing; `fireStep` had no equivalent check anywhere, despite the design
  doc's own words that "firing real money-moving Pact code standalone is
  exactly as sensitive as firing a committed row." `simulateStep` was
  correctly left unguarded (it never submits to chain).
  **Resolution:** fixed — `findStep` now also returns the parent cronoton
  row; `fireStep` rejects with the identical 400 message `executeNow` uses
  for a paused or terminal row, checked before any leg is resolved or
  fired. 3 new tests (paused rejection, terminal rejection, confirming
  `simulateStep` stays correctly unguarded).

### [HIGH] `executeNow`'s new chained-row branch called `driveRunOnce` outside `loop.ts`'s re-entrancy guard, enabling a genuine double-submission race
- **Verdict:** CONFIRMED, severity HIGH unchanged — the most
  architecturally significant finding of this entire phase. Before this
  phase, `driveRunOnce`/`advanceInFlightRunsOnce` were ONLY ever invoked
  from inside `startKhronotonLoop`'s single-process `running` boolean
  guard; `executeNow`'s new chained-row branch is the first caller that
  invokes `driveRunOnce` directly from an HTTP handler, entirely outside
  that guard. If the background loop's tick fires while `executeNow`'s own
  `driveRunOnce` call is still awaiting a chain round-trip, the background
  sweep could pick up the SAME newly-created run (visible via
  `listInFlightRuns()` the instant `createRun` returns, with no "due"/
  claim gating) and call `driveRunOnce` on it concurrently — both callers
  could read the same `pending` leg and both submit it to chain before
  either write landed. `runs-driver.ts`'s own pre-existing doc comment
  (quoted verbatim during validation) had explicitly anticipated and
  deferred exactly this: *"It is NOT safe against a future concurrent
  caller... without adding a real claim-before-submit step... Deferred
  rather than built here: no such caller exists yet."* Phase 5's
  `executeNow` fix made that caller real.
  **Resolution:** fixed with a genuine claim-before-submit step, not a
  workaround:
  - A new nullable `claimed_at TEXT` column on `codex_cronoton_run_legs`
    (additive via the established `ensureColumn` idempotent-migration
    pattern — no change to the existing status-enum `CHECK` constraint,
    consistent with the ORIGINAL author's own stated reason for deferring
    this: "adding [a claim] changes the leg status enum, which is schema
    scope beyond this phase").
  - `claimLegForSubmit`/`releaseLegClaim` (new, `store/runs.ts`): a
    conditional `UPDATE ... WHERE status='pending' AND claimed_at IS NULL`,
    mirroring `claim.ts`'s `claimDueCodexCronoton` idiom one level down —
    two concurrent callers racing the same leg can never both win.
  - `handleSubmitLeg` (`runs-driver.ts`) now claims immediately before the
    real network submit; a lost claim backs off silently (same as "wait");
    a submit that doesn't land releases the claim so a later pass can
    still retry, preserving the existing no-retry-cap posture unchanged.
  - Proven by a new end-to-end test in `runs-driver.test.ts`: two
    concurrent `driveRunOnce` calls on the SAME run, asserting `submit`
    was called exactly once (not twice) and the leg ends up `submitted`
    with exactly one request key — plus a companion test proving the
    losing caller's promise still resolves cleanly (no thrown error).
    3 new store-level unit tests for `claimLegForSubmit`/`releaseLegClaim`
    directly.

### [MEDIUM] `adaptMultiTxSummary` silently dropped a batch's non-boolean `ok` value back to the "no ok field" (success) default
- **Verdict:** CONFIRMED. `okFields = batches.filter(b => typeof b.ok ===
  "boolean")` excluded a batch reporting failure via a non-strict-boolean
  value (the string `"false"`, `0`) — identical treatment to "didn't
  report at all," which could defeat the whole fix if every batch happened
  to report failure this way. **Resolution:** fixed — a new `toReportedOk`
  helper recognizes real booleans, case-insensitive `"true"`/`"false"`
  strings, and numbers (`0` is false, else true), explicitly NOT using a
  naive `Boolean(value)` coercion (which would wrongly read the string
  `"false"` as truthy). 3 new tests: the string-`"false"` regression case,
  a non-boolean-success case (`"TRUE"`, `1`), and an unrecognized-value
  (object) case correctly falling back to "does not report."

### [MEDIUM] `runLegsHandler`'s cross-cronoton "no leak" test had dead assertions that could never independently fail
- **Verdict:** CONFIRMED. The handler returns a static `err(404, "not
  found")` body BEFORE `listRunLegs` is ever called — the `toContain`
  checks on leg content were redundant with the status-code assertion
  directly above them; a broken ownership check would still produce the
  same unreachable-leg-content 404 body and pass the test regardless.
  **Resolution:** fixed — replaced with a structural
  `expect(res.body).not.toHaveProperty("legs")` check, which actually
  constrains the response shape rather than string-searching a body that
  can never contain the data by construction.

### [MEDIUM] `resolveStepLegs` (new, `handlers/steps.ts`) hand-copied `handleReplanStep`'s planner-resolution logic instead of sharing it
- **Verdict:** CONFIRMED. Both functions independently built the same
  `PlannerCtx` shape and called `getStepPlanner` directly, with no shared
  helper — the doc comment's "never a parallel reimplementation" claim was
  false on its face; a future edit to one (e.g. a `PlannerCtx` field
  addition) could silently drift from the other with no compiler signal.
  **Resolution:** fixed — extracted a single shared `resolvePlannerFor
  (step, seams)` helper into `planners/registry.ts`, consumed identically
  by both `runs-driver.ts`'s `handleReplanStep` and `handlers/steps.ts`'s
  `resolveStepLegs`.

### [LOW] `resolveStepLegs`'s bare-string sentinel (`"unregistered"`) was inconsistent with `findStep`'s `{ok,...}` discriminated-union idiom in the same file
- **Verdict:** CONFIRMED. **Resolution:** fixed as part of the same edit
  that closed the finding above — `resolveStepLegs` now returns
  `{ok:true,legs}|{ok:false}`, matching `findStep`'s own convention.

## Round 2 — terminal pass, full scope, full lens set (first run, over the extended scope)

All four lenses dispatched together over the COMPLETE touched scope,
including the Phase-3 core-driver files the concurrency fix extended into.
Conventions, tests, security: clean. Correctness surfaced one more,
narrower finding specifically about the new claim mechanism's own edge
case.

### [MEDIUM] A claim left between `claimLegForSubmit` and its release/settle is never reclaimed if the process crashes mid-submit
- **Verdict:** CONFIRMED on adversarial validation, with a clear
  recommendation on how to resolve it. The new claim is a TWO-PHASE lease
  (unlike `claimDueCodexCronoton`'s one-shot, irreversible claim this fix
  was documented as "mirroring") — something must later call
  `markLegSubmitted` or `releaseLegClaim` to make the leg claimable again.
  A process crash (OOM-kill, hard restart) strictly between a won claim
  and either of those calls leaves the leg permanently `pending` with
  `claimed_at` set; no later pass, even after a restart, can reclaim it.
  Validation traced the actual consequence precisely: the run still
  recovers (the existing deadline-exceeded branch in `pure/run-advance.ts`
  eventually re-plans, bumping `attempt` past the orphaned leg, or fails
  the run outright), just bounded by the full `RUN_STEP_DEADLINE_MS`
  (10 minutes by default) instead of the very next pass — not a
  permanently-stuck run, a slower recovery path reusing machinery that
  already exists. Validation also assessed both candidate code fixes and
  found neither proportionate: a `try`/`finally` around the submit call
  would be genuinely dead code (`executeCodexTransaction`'s own documented
  and enforced contract guarantees `mode:"submit"` never throws — confirmed
  by reading its real `try`/`catch` wrapper in `executor.ts`), and a
  periodic lease-expiry reconciliation sweep is legitimate new recovery
  machinery deserving its own scoped design, not a drive-by addition here.
  **Resolution: documented as an accepted, bounded limitation**, matching
  this codebase's own established pattern (the pre-existing "no retry-cap
  mechanism... an operator noticing is the backstop today" posture, now
  joined by this one) — `claimLegForSubmit`'s and `releaseLegClaim`'s doc
  comments in `store/runs.ts` were extended with the full tradeoff
  explanation, and `design.md`'s "Out of scope" section gained a matching
  entry naming the deferred reconciliation sweep as a legitimate future
  follow-up, not something rushed into this change.

## Round 3 — terminal pass, full scope, full lens set (final)

All four lenses dispatched together over the final, complete scope after
the doc-only resolution above. **Zero findings across all four lenses.**
This is the clean terminal pass.

## Final verification (quoted, after the last applied edit)

```
> @ancientpantheon/khronoton-core@0.12.0 typecheck
> tsc --noEmit
(no errors)

 Test Files  89 passed (89)
      Tests  1255 passed (1255)

> @ancientpantheon/khronoton-core@0.12.0 build
ESM ⚡️ Build success in 827ms
DTS ⚡️ Build success in 3531ms
```

## Behavioral verification (against the real built artifact, `dist/`, not mocks)

Confirmed all five new/fixed handler exports resolve through the public
`dist/handlers/index.js` barrel (`executeNow`, `simulateStep`, `fireStep`,
`fetchRuns`, `fetchRunLegs`).

Drove a complete, real end-to-end scenario off `dist/`: seeded a chained
cronoton (one `mode:'single'` step) via the real `insertStep`, called the
real `executeNow` —

```
AUDIT: codex_cronoton.run_started
executeNow status: 200
executeNow body: {"ok":true,"runId":"0665a544-...","status":"planning"}
```

— then confirmed the real run and leg through the real new read handlers:

```
fetchRuns:    {"ok":true,"runs":[{...,"status":"planning",...}],"total":1,...}
fetchRunLegs: {"ok":true,"legs":[{...,"status":"submitted","request_key":"RK-SMOKE",
                "claimed_at":"2026-11-19T19:51:01.709Z",...}]}
```

— confirming the claim mechanism is genuinely live in the compiled output
(`claimed_at` is stamped on the real submitted leg). A second `executeNow`
call against the SAME still-in-flight cronoton correctly returned:

```
executeNow (second call) status: 409 {"error":"a run is already in flight for this cronoton"}
```

Separately confirmed the Round 1 `fireStep` guard fix against the real
artifact: a `paused` cronoton's `fireStep` call returned `400 {"error":
"cannot execute a paused cronoton"}`, while the identical cronoton's
`simulateStep` call correctly still returned `200` (unguarded, as designed,
since it never submits).

## Outcome

**3 rounds. 7 findings raised, 7 CONFIRMED (6 fixed in code/tests + 1
resolved via documentation as an accepted, bounded limitation), 0 REFUTED,
0 STYLISTIC.** Terminal full-scope, full-lens-set pass (Round 3) is clean.
Full suite green (1255/1255, up from 1244 at the start of this phase's
review cycle — 11 new/tightened tests), typecheck clean, build clean, and
five independent behavioral checks against the real compiled artifact
confirm every fix (including the cross-cutting concurrency fix that
touched the already-shipped Phase 3 core driver) landed correctly in the
actual shipped output, not just the source.

The two HIGH findings (`fireStep`'s paused/terminal bypass, and the
concurrent `driveRunOnce` double-submission race) were both genuinely
serious for a funds-moving automaton and both received full nectar rigor
rather than a quick patch: the double-submission fix in particular
required reopening and extending the already-shipped, already-reviewed
Phase 3 core driver, which then went through its own dedicated adversarial
validation and a full additional terminal review round before this topic
could close — exactly the discipline a change of that weight warrants.
