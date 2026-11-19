# Khronoton chained runs — Phase 3 (the non-blocking driver) — Design

Scope per `docs/work/khronoton-chained-runs/design.md`'s "Topics" item 2: the
non-blocking driver (`advanceInFlightRunsOnce`, wired into
`startKhronotonLoop`), the tick's create-run-and-submit-step-0 path, and the
self-blocking-vs-schedule-advances-anyway interaction.

Note on sourcing: the original handoff's exact §5.6 prose isn't recoverable
in this session (no file on disk carries it — it was pasted inline in an
earlier, now-compacted conversation). This design reconstructs the
self-blocking-vs-schedule-advances-anyway interaction from first principles
against the actual committed code (`store/claim.ts`'s unconditional
`next_fire_at` advance, `schema.ts`'s partial unique self-block index) rather
than from the missing prose. Flagging this so the approval step can catch it
if the reconstruction drifts from what was originally specified.

## Problem

Phases 0–2 built every piece a chained run needs *except the thing that
drives it*: Phase 0 made `submit` non-blocking, Phase 1 gave it a place to
persist state, Phase 2 decided what should happen next — but nothing yet
calls `advanceRun`, nothing executes its `RunAction`s against the chain, and
`tick.ts` still only knows how to one-shot fire a plain cronoton. A cronoton
with `codex_cronoton_steps` rows today would be created successfully and
then never fire anything, because the tick has no branch that recognizes it.

## Approach

### A. Distinguishing a chained cronoton from a plain one

**Chosen:** a cronoton is "chained" iff `listStepsForCronoton(row.id, dep)`
returns at least one row. No new column.

- *Alternative — an explicit `codex_cronotons.kind`/`is_chained` column:*
  rejected. It would duplicate information the steps table already encodes
  unambiguously, creating a second source of truth that can drift (a row
  with steps but `is_chained=0`, or vice versa) for zero behavioral gain —
  the steps table's own existence is the simplest possible truth source.

### B. The create-run-and-submit-step-0 path (inside `codexCronotonTickOnce`)

For each claimed due row, branch on (A):
- **Plain** (no steps) → today's unchanged `fireByServerResolver` path.
- **Chained** (≥1 step) → call `createRun({ codexCronotonId: row.id,
  stepCount: steps.length })`. On success, immediately call the new shared
  `driveRunOnce(runId, ctx)` (§D) once, synchronously, in the SAME tick pass
  — so a freshly created run's step 0 gets planned-and-submitted without
  waiting a full `tickIntervalMs` for the next loop pass to notice it. On
  `RunAlreadyInFlightError` (§C), skip silently (not an orchestration
  error) — the existing non-terminal run for this cronoton is already being
  driven by `advanceInFlightRunsOnce` every pass regardless of this tick's
  own due-ness.

  No separate "submit step 0" code path is written — `driveRunOnce` handles
  a brand-new `status:'planning'`, zero-legs run exactly the same way
  `advanceRun`'s own step 2 (`legs.length === 0 → replan-step`) already
  describes it. Reusing one function for "just created" and "N-th pass of
  an existing run" avoids a second, divergence-prone decision path.

  This tick pass does **not** `recordFire`/apply `applyTerminalIntent` for
  a chained row the way it does for a plain one — a chained run's
  lifecycle is recorded via its own `codex_cronoton_runs`/`..._run_legs`
  rows, not the one-shot `codex_cronoton_fires` table. (`CreateRunInput`
  already carries an optional `fireId`-shaped link — out of scope to wire
  up in Phase 3; left `null`.)

### C. Self-blocking vs. schedule-advances-anyway

**Chosen:** leave `claimDueCodexCronoton` completely unchanged — it keeps
unconditionally advancing (recurring) or clearing (one-time) `next_fire_at`
at claim time, with zero awareness of run state. The chained-start branch
in (B) treats a `RunAlreadyInFlightError` from `createRun` as a normal,
logged skip.

- *Alternative — check for an in-flight run BEFORE claiming, and skip the
  claim (leaving `next_fire_at` due) if one exists:* rejected. This
  reintroduces a check-then-act race between "no in-flight run" and the
  claim itself, undermining the claim's own exactly-once guarantee, and
  produces a busy-tick (the row stays perpetually due) that contradicts
  the "schedule advances anyway" framing the topic name itself states —
  the schedule's cadence and a run's lifecycle are explicitly two
  independent clocks, not one gated by the other.

Net effect: a chained cronoton whose run regularly outlives its own
schedule interval will see every intervening tick's claim succeed (advance
`next_fire_at` again), then skip the `createRun` attempt (self-blocked).
This is intentional, not a bug — once the long-lived run finally reaches a
terminal status, the very next due tick starts a fresh one.

### D. `advanceInFlightRunsOnce` + the shared `driveRunOnce`

New file `src/server/runs-driver.ts` (sibling to `tick.ts`, `loop.ts`):

- `listInFlightRuns(dep)` — new `store/runs.ts` read, `SELECT * FROM
  codex_cronoton_runs WHERE status IN ('planning','awaiting','advancing')
  ORDER BY modified_at ASC`, using the existing (Phase-1-provisioned,
  previously-unused) `idx_codex_cronoton_runs_due` index.
- `driveRunOnce(runId, ctx): Promise<void>` — the one-run, one-pass core:
  1. `getRun` + `listRunLegs`, filter legs to the run's current `stepIndex`.
  2. `listStepsForCronoton` → the current step row → derive `RunPolicy`
     (`stepMode`: the step's `mode === 'single'` maps to `'serial'`,
     `mode === 'planner'` to `'parallel'`, per `run-advance.ts`'s own doc
     comment; `canReplan`: **`mode === 'planner'` only** — correcting an
     error in an earlier draft of this design, which had this backwards.
     `run-advance.ts`'s own doc comment on `RunPolicy.canReplan` is explicit:
     "False for a `mode: 'single'` step: there is no registered planner to
     consult, so a failed leg has no 'ask the chain who is still owed'
     escape hatch and the run must fail immediately." Since Phase 4's
     planner registry doesn't exist yet, `canReplan` is therefore **always
     false** in Phase 3's real, exercised behavior — a `mode:'single'`
     step's only route to `replan-step` is `advanceRun`'s step 2 ("no legs
     yet," unconditional, independent of `canReplan`) — i.e. the *first*
     time the step is entered. Any later deadline-exceeded or leg-failure
     on that same step hits `replanOrFail` with `canReplan:false` and goes
     straight to `fail-run`. This means a single-mode step is NEVER
     re-planned after its one leg already exists — there is no "retry a
     failed single-tx leg" mechanism in Phase 3, and none is needed: a
     deterministic one-shot `pactCode` that failed once has no reason to
     behave differently on a second, identical attempt, and the import of
     the existing codex_cronoton_run_legs.attempt column staying at 0
     throughout Phase 3 is the correct, inert reflection of that;
     `maxReplanAttempts`: `ctx.config?.maxReplanAttempts ??
     DEFAULT_MAX_REPLAN_ATTEMPTS` (irrelevant in practice until Phase 4,
     since `canReplan:false` short-circuits `replanOrFail` before this
     bound is ever consulted).
  3. Build `RunState`/`LegState[]`, call the Phase 2 `advanceRun(...)`.
  4. Execute each returned `RunAction` (§F).
- `advanceInFlightRunsOnce(now, ctx): Promise<{ driven: string[]; errored:
  string[] }>` — `listInFlightRuns`, call `driveRunOnce` for each,
  try/catch per run (one run's error never blocks the others — same
  isolation posture `codexCronotonTickOnce` already applies per-row).

Wired into `loop.ts`'s `startKhronotonLoop` as a third pass, after
`runTick`/`runManualBatch`, same catch-and-keep-ticking discipline, same
`opts`-injectable-for-tests seam as the existing two.

### E. Planner-mode steps — out of scope, guarded

The `StepPlanner` registry is Phase 4. `driveRunOnce` builds
`RunPolicy.canReplan: true` only for a `mode:'planner'` step (§D) — but
since no planner is registered yet, reaching `replan-step` for one (which
can only happen via `advanceRun`'s step 2, "no legs yet," since that
branch is unconditional) is where the guard actually fires: the
`replan-step` handler (§F) throws a new typed
`PlannerNotRegisteredError("planner mode is Phase 4 — not yet supported")`
for any step whose `mode === 'planner'`, rather than attempting to build a
leg from a step row that has no `pact_code` at all. No cronoton reachable
through today's committed API can combine a planner step with a live run
in any way that bypasses this guard, so it's defensively unreachable in
practice, not untested dead code papering over a real gap.

### F. Executing each `RunAction`

- **`submit-leg` { legIndex }`:** for a brand-new leg (no row yet — the
  very first submission of a freshly (re)planned step), build it first
  (see "replan-step" below handles the *build*; `submit-leg` only ever
  targets a leg that already has a `pending` row). Read the leg's
  `definition_json`, `JSON.parse` it back into a `CodexTxDefinition`, call
  `executeCodexTransaction(definition, "submit", ctx)`.
  - `ok: true` → `markLegSubmitted(legId, { requestKey, chainId })`.
  - `ok: false` → the leg never reached the chain (still `pending`, no
    `requestKey` was ever persisted) — log via `ctx.onAudit` and leave the
    row `pending`. The *next* `driveRunOnce` pass naturally re-selects the
    same still-`pending` leg (that's exactly what `advanceRun`'s own
    serial/parallel submit branches do), so no separate retry-counting
    mechanism is needed in Phase 3. Capping retries is deferred (§Out of
    scope) — nothing here risks a double-submit, since a `pending` leg by
    definition never got a `requestKey`.
- **`poll` {}`:** collect every `submitted` leg's `(requestKey, chainId)`
  for the current step, group by `chainId`, call
  `runtime.createClient(runtime.getPactUrl(chainId)).pollRequestKeys(keys,
  chainId)` once per distinct chain (Phase 0's own "one request per chain
  per tick, not one request per leg" contract). For each key present in the
  response: `result.status === 'success'` → `markLegConfirmed(legId)`;
  otherwise → `markLegFailed(legId, { errorMessage: ... })`. Absent keys
  are untouched (still landing).
- **`advance-step` {}`:** if `run.stepIndex + 1 === run.stepCount` →
  `markRunTerminal(runId, "succeeded")`; else → `advanceRunStep(runId, {
  fromStepIndex: run.stepIndex, toStepIndex: run.stepIndex + 1, deadlineAt:
  computeStepDeadline(ctx) })` (resets `attempt` to 0 — new store write,
  §G).
- **`replan-step` { reason }`:** per §D's correction, `canReplan` is always
  `false` for the only step mode Phase 3 actually drives (`mode:'single'`),
  so this action is ONLY ever reached via `advanceRun`'s step 2 ("no legs
  yet") — i.e. the step's very first entry, never a retry after a failure
  or a missed deadline (both of those go straight to `fail-run` instead,
  per §D). The handler: if `step.mode === 'planner'`, throw
  `PlannerNotRegisteredError` (§E) and stop. Otherwise (`mode:'single'`)
  build the step's one fixed leg from the step row (new mapper
  `stepRowToDefinition`, mirroring `rowToDefinition`), `insertRunLeg({
  runId, stepIndex: run.stepIndex, legIndex: 0, definitionJson:
  JSON.stringify(definition) })`, then `advanceRunStep(runId, {
  fromStepIndex: run.stepIndex, toStepIndex: run.stepIndex, deadlineAt:
  computeStepDeadline(ctx) })` — same function as the real step-advance
  case, called with `toStepIndex === fromStepIndex` to stamp this step's
  first deadline without changing `step_index`. No `bumpRunAttempt`/retry
  machinery exists in Phase 3 — see §G.
- **`fail-run` { reason }`:** `markRunTerminal(runId, "failed")` — the
  reason is logged via `ctx.onAudit`, not persisted on the run row itself
  (no `codex_cronoton_runs.error_message`-shaped column exists; adding one
  is a schema change left to whichever phase needs to surface it in the
  UI, per Phase 5's "observability" scope).
- **`wait` {}`:** no-op (the terminal-run defensive case; `driveRunOnce`
  should never actually reach a terminal run via `listInFlightRuns`, which
  only selects non-terminal statuses — this is `advanceRun`'s own built-in
  defense-in-depth, not something Phase 3 needs to additionally guard).

### G. New store-layer writes (added here, not deferred again)

`store/runs.ts` gains two small, conditional-UPDATE-guarded writes,
matching the file's existing idiom (`markLegSubmitted`'s `WHERE status =
'pending'` pattern) rather than a raw unconditional UPDATE, and `getRun`'s
sibling `listInFlightRuns` read:

- `listInFlightRuns(dep)` — see §D.
- `advanceRunStep(runId, { fromStepIndex, toStepIndex, deadlineAt }, dep)`
  — `UPDATE codex_cronoton_runs SET step_index = ?, attempt = 0,
  deadline_at = ?, modified_at = ? WHERE id = ? AND step_index = ?` (the
  trailing `step_index = ?` binds `fromStepIndex`, an optimistic-
  concurrency guard — if another process already changed this run's step,
  this call's precondition is stale and should fail loudly rather than
  overwrite). Doubles as both "really advance to the next step" (§F
  `advance-step`, `toStepIndex = fromStepIndex + 1`) and "stamp this
  step's first deadline without moving it" (§F `replan-step`'s first-plan
  case, `toStepIndex = fromStepIndex`) — one function, two callers, same
  guard. Throws a new `RunStepMismatchError` on zero rows changed.
- `markRunTerminal(runId, status, dep)` — `UPDATE codex_cronoton_runs SET
  status = ?, modified_at = ? WHERE id = ? AND status NOT IN ('succeeded',
  'failed', 'abandoned')` (guards against double-terminalizing an
  already-finished run). Throws a new `RunAlreadyTerminalError` on zero
  rows changed.

No `bumpRunAttempt`/attempt-incrementing write is added in Phase 3: per
§D's correction, `canReplan:false` for every step mode Phase 3 actually
drives means `replanOrFail`'s attempt-counting branches (`advanceRun`'s
steps 4/5/6) always resolve to `fail-run`, never `replan-step`, so no
Phase-3-reachable code path ever needs to increment a run's `attempt`
column. Adding the write now would be untested, unreachable plumbing;
Phase 4 adds it once a registered planner makes `canReplan:true` — and
therefore a real retry — possible.

`src/server/store/mappers.ts` (or `store/steps.ts`) gains
`stepRowToDefinition(step: CodexCronotonStepRow): CodexTxDefinition`,
structurally identical to the existing `rowToDefinition` for
`CodexCronotonRow` minus `scheduleKind`/`serverResolver` (steps have
neither).

A new `Config.runStepDeadlineMs?: number` (default 10 minutes,
`RUN_STEP_DEADLINE_MS = 600_000` in `seams.ts`) and
`Config.maxReplanAttempts?: number` (default 3, matching Phase 2's own test
default) back `computeStepDeadline`/`driveRunOnce`'s policy construction.
Without a configured deadline, `advanceRun`'s step 4 ("deadline exceeded")
would be permanently dead code in Phase 3 — every chained run needs *some*
per-step deadline to make the barrier-grace-poll behavior real.

## Acceptance criteria

- [ ] A newly committed cronoton with ≥1 `codex_cronoton_steps` row, once
      due, gets a `codex_cronoton_runs` row created AND its step 0 leg
      submitted (a `submitted` leg row with a non-null `request_key`)
      within the SAME tick pass that created the run — not merely at the
      next loop interval.
- [ ] A due chained cronoton with an existing non-terminal run does NOT
      get a second run created (`RunAlreadyInFlightError` caught, not
      surfaced as a tick failure/skippedId), while its `next_fire_at` is
      still advanced exactly as it would be for a plain cronoton (proving
      §C's "schedule advances anyway, self-block is independent").
- [ ] `advanceInFlightRunsOnce` run against a fixture run whose current
      step has one `submitted` leg with a landed success result (mocked
      `pollRequestKeys`) flips that leg to `confirmed` and, once the
      step's barrier is met, advances `step_index` (or marks the run
      `succeeded` if it was the last step) — WITHOUT re-submitting the
      leg (`client.submit` never called for an already-`submitted` leg).
- [ ] A step whose single leg's submit returns `ok:false` leaves the leg
      row `pending` (not `failed`, no `request_key`), and the leg is
      re-submitted on the next `driveRunOnce` pass for the same run.
- [ ] A `mode:'single'` step's leg that reaches `failed` (confirmed via a
      polled non-success result), or whose barrier deadline passes before
      it resolves, flips the run straight to `status: 'failed'` — no
      second leg-0 row is ever inserted for the same `stepIndex`, proving
      `canReplan:false` (§D) actually gates the no-retry behavior rather
      than it being an accidental side effect of no caller ever hitting
      that path.
- [ ] A `mode:'planner'` step reaching `replan-step` (its first entry, no
      legs yet) throws `PlannerNotRegisteredError` rather than attempting
      to build a leg from a step row with no `pact_code` — proven against
      a step row inserted directly via `insertStep({ mode: 'planner',
      plannerName: '...' })`, since no live registry exists to construct
      one any other way.
- [ ] `startKhronotonLoop`'s existing re-entrancy guard (REQ-32) still
      allows at most one of {tick, manual-batch, run-advance} pass stacked
      at a time — the new third pass does not reintroduce an overlapping
      inline-fire window.
- [ ] Every existing `tick.test.ts`/`loop.test.ts` test for the plain
      (non-chained) path passes unmodified — proving the branch in (B) is
      genuinely additive.

## Out of scope

- The `StepPlanner` registry itself and any `mode:'planner'` step's real
  `replan-step` execution (Phase 4) — guarded, not implemented (§E).
- Capping/limiting repeated submit-failure retries on a `pending` leg
  (§F) — deferred; nothing about an uncapped retry is unsafe (no
  `requestKey` ever existed), only potentially wasteful, and bounding it
  needs the kind of operator-facing config Phase 5 (observability) is
  positioned to add meaningfully.
- Persisting a run's fail/abandon `reason` on the run row itself (no
  schema column exists) — audit-logged only; Phase 5's job if a persisted,
  queryable reason is needed.
- `codex_cronoton_runs.fire_id` wiring (linking a run back to a
  `codex_cronoton_fires` row) — the column exists per Phase 1's schema but
  nothing in this phase populates it; chained runs are visible via their
  own tables, not the fires table, until a later phase decides they need
  both.
- Any change to the one-shot (`fireByServerResolver`) path itself, or to
  `fetchDueCodexCronotons`/`claimDueCodexCronoton`'s own logic (§C
  explicitly keeps the claim unchanged).
- Phase 4 (planner registry), 4b (built-ins), 5 (observability/standalone
  fire), 6 (merge optimiser) — unchanged from the parent design's own
  phase list.
