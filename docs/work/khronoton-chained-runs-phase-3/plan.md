## Wave 1
- [x] T1: Add the two run-level transition writes + their typed errors to
  `store/runs.ts` — done when: `packages/khronoton-core/src/server/store/runs.ts`
  exports two new functions and `packages/khronoton-core/src/server/store/errors.ts`
  exports two new error classes:
  - `listInFlightRuns(dep: DbDep): CodexCronotonRunRow[]` — `SELECT * FROM
    codex_cronoton_runs WHERE status IN ('planning','awaiting','advancing')
    ORDER BY modified_at ASC` (uses the existing `idx_codex_cronoton_runs_due`
    index from `schema.ts`, previously unused by any store function).
  - `advanceRunStep(runId: string, input: { fromStepIndex: number;
    toStepIndex: number; deadlineAt: string | null }, dep: DbDep): void` —
    `UPDATE codex_cronoton_runs SET step_index = ?, attempt = 0, deadline_at
    = ?, modified_at = ? WHERE id = ? AND step_index = ?` binding
    `toStepIndex, deadlineAt, <now ISO>, runId, fromStepIndex` in that
    order; if `result.changes !== 1`, throw `new RunStepMismatchError(runId,
    input.fromStepIndex)`. Works identically whether `toStepIndex ===
    fromStepIndex` (stamping a fresh deadline on the CURRENT step, no
    actual advance) or `toStepIndex === fromStepIndex + 1` (a real
    advance) — both are the same write, mirroring `markLegSubmitted`'s
    conditional-UPDATE-as-guard idiom one level up.
  - `markRunTerminal(runId: string, status: "succeeded" | "failed" |
    "abandoned", dep: DbDep): void` — `UPDATE codex_cronoton_runs SET
    status = ?, modified_at = ? WHERE id = ? AND status NOT IN
    ('succeeded','failed','abandoned')`; if `result.changes !== 1`, throw
    `new RunAlreadyTerminalError(runId)`.
  - `errors.ts` gains `RunStepMismatchError` (constructor `(runId: string,
    expectedStepIndex: number)`, message mentioning both, `this.name =
    'RunStepMismatchError'`) and `RunAlreadyTerminalError` (constructor
    `(runId: string)`, `this.name = 'RunAlreadyTerminalError'`), matching
    the existing class shape in that file exactly (plain `extends Error`,
    no custom fields).
  - Deliberately NOT added in this task: any attempt-incrementing write
    (e.g. `bumpRunAttempt`). Per `docs/work/khronoton-chained-runs-phase-3/design.md`
    §D/§G, `canReplan` is always `false` for every step mode Phase 3
    actually drives (`mode:'single'` has no planner to consult; a future
    `mode:'planner'` step throws before reaching any attempt accounting —
    see T4), so `advanceRun`'s attempt-counting `replanOrFail` branches
    (steps 4/5/6) always resolve to `fail-run`, never `replan-step`, in
    every path Phase 3 exercises — an attempt-bump write would be
    untested, unreachable code. Do not add it.
  - Tests in `store/runs.test.ts` (reusing the existing `seedCronoton`
    helper and real in-memory `better-sqlite3` pattern already in that
    file — no SQL-string mocking): (a) `listInFlightRuns` returns a
    `planning` and an `advancing` run but excludes a `succeeded` one, all
    for different cronotons, ordered by `modified_at` ascending (verified
    by seeding them out of that order); (b) `advanceRunStep` with
    `toStepIndex = fromStepIndex + 1` updates `step_index`, resets
    `attempt` to 0 (seed a run with `attempt` already bumped — wait, since
    T1 adds no bump write, seed via direct raw SQL `UPDATE` in the test
    itself to set a nonzero `attempt` before calling `advanceRunStep`, to
    prove the reset), and sets the new `deadline_at`; (c) `advanceRunStep`
    with `toStepIndex === fromStepIndex` leaves `step_index` unchanged but
    still updates `deadline_at`/`modified_at`; (d) `advanceRunStep` called
    with a stale `fromStepIndex` (not matching the run's current
    `step_index`) throws `RunStepMismatchError` and leaves the row
    untouched (verified by re-reading via `getRun` after the throw); (e)
    `markRunTerminal` flips a `planning`/`advancing`/`awaiting` run (one
    `it.each` case per status) to `succeeded`; (f) a second
    `markRunTerminal` call on an already-`failed` run throws
    `RunAlreadyTerminalError` and leaves `status` unchanged.
  `npx vitest run store/runs.test.ts` (from
  `packages/khronoton-core`) and `npm run typecheck` both pass, with every
  pre-existing test in that file (createRun/getRun/listRunLegs/
  insertRunLeg/markLegSubmitted/markLegConfirmed/markLegFailed describe
  blocks) passing unmodified.
  - files: `packages/khronoton-core/src/server/store/runs.ts`,
    `packages/khronoton-core/src/server/store/runs.test.ts`,
    `packages/khronoton-core/src/server/store/errors.ts`

- [x] T2: Add `stepRowToDefinition` to `store/mappers.ts` + the two new
  `Config` knobs to `seams.ts` — done when:
  `packages/khronoton-core/src/server/store/mappers.ts` exports
  `stepRowToDefinition(step: CodexCronotonStepRow): CodexTxDefinition`,
  importing `CodexCronotonStepRow` as a type from `./steps.js`, structured
  identically to the existing `rowToDefinition` in the same file (same
  `parseJson` helper, same field mapping) but reading `step.pact_code`
  (falling back to `""` when `null` — only ever non-null for a `mode:
  'single'` step, which is the only mode any Phase-3 caller passes to this
  function; see T4's guard), `step.config_json`, `step.payload_json`,
  `step.gas_payer_json`, `step.signers_json`, and omitting
  `scheduleKind`/`serverResolver` entirely (steps have neither column).
  `packages/khronoton-core/src/server/seams.ts`'s `Config` interface gains
  `runStepDeadlineMs: number` and `maxReplanAttempts: number`, with two
  new module-level constants `RUN_STEP_DEADLINE_MS = 600_000` (10 minutes)
  and `DEFAULT_MAX_REPLAN_ATTEMPTS = 3`, each with a one-line doc comment
  matching the existing constants' style (`/** Default ... — {@link
  Config.<field>}. */`).
  Tests in `store/mappers.test.ts` (reusing that file's existing `baseRow`-
  style fixture-builder convention — read the file first to match it
  exactly): a `mode:'single'` step row with all five JSON columns
  populated maps to a `CodexTxDefinition` with the matching parsed
  `pactCode`/`config`/`payload`/`gasPayer`/`signers`, and neither
  `scheduleKind` nor `serverResolver` keys are present on the returned
  object (`"scheduleKind" in def` is `false`); a step row with
  `payload_json: null`/`signers_json: null` falls back to `{}`/`[]`
  respectively, mirroring `rowToDefinition`'s own null-handling tests in
  the same file. `npx vitest run store/mappers.test.ts` and `npm run
  typecheck` both pass; every pre-existing `rowToDefinition`/
  `assertAutoGasGate`/`assertGasPriceBufferAnu`/`manualBatchView` test in
  that file passes unmodified.
  - files: `packages/khronoton-core/src/server/store/mappers.ts`,
    `packages/khronoton-core/src/server/store/mappers.test.ts`,
    `packages/khronoton-core/src/server/seams.ts`

## Wave 2 (depends on Wave 1)
- [x] T3: Barrel-wire T1 + T2's new exports into `store/index.ts` — done
  when: `packages/khronoton-core/src/server/store/index.ts`'s existing
  `export { ... } from "./errors.js"` list gains `RunStepMismatchError,
  RunAlreadyTerminalError`; its existing `export { ... } from
  "./mappers.js"` list gains `stepRowToDefinition`; and its existing
  `export { createRun, getRun, listRunLegs, insertRunLeg, markLegSubmitted,
  markLegConfirmed, markLegFailed } from "./runs.js"` line gains
  `listInFlightRuns, advanceRunStep, markRunTerminal`, following the
  file's own `// ── <section comment> ──` grouping convention (add to the
  existing sections, do not invent a new one). `npm run typecheck` passes
  and `npx vitest run` (full suite) passes — this task adds no new test
  file, mirroring Phase 1's own T10 precedent ("pure re-export wiring...
  every new store function already has direct-import test coverage from
  earlier waves").
  - files: `packages/khronoton-core/src/server/store/index.ts`

- [x] T4: New file `runs-driver.ts` — `driveRunOnce` + `advanceInFlightRunsOnce`
  — done when: `packages/khronoton-core/src/server/runs-driver.ts` exists
  and exports exactly:
  - `export interface RunsDriverCtx { db: Database; runtime: ChainRuntime;
    resolver: KeyResolver; onAudit: OnAudit; config?: Partial<Config>; }`
    — importing `Database, ChainRuntime, KeyResolver, OnAudit, Config` as
    TYPES only from `./seams.js`. **Deliberately does NOT import anything
    from `./tick.js` or `./loop.js`** (those two files will import FROM
    this module in Wave 3 — importing `TickCtx` here instead of declaring
    this structurally-compatible local interface would create a circular
    import). A real `TickCtx` (from `tick.ts`) structurally satisfies this
    interface already (same `db`/`runtime`/`resolver`/`onAudit`/`config`
    shape, `TickCtx` just adds `resolveFireMode` on top), so passing one
    in at either of T5/T6's call sites needs no conversion.
  - `export class PlannerNotRegisteredError extends Error` — local to this
    file (not `store/errors.ts`; it's thrown by the driver, not the store
    layer), constructor `(plannerName: string)`, message along the lines
    of `` `planner '${plannerName}' is not registered — the StepPlanner
    registry is Phase 4, not yet built` ``, `this.name =
    'PlannerNotRegisteredError'`.
  - `export async function driveRunOnce(runId: string, now: Date, ctx:
    RunsDriverCtx): Promise<void>` implementing exactly:
    1. `getRun(runId, { db: ctx.db })`; if `null`, return immediately (the
       run vanished between `listInFlightRuns` and this call — defensive,
       no-op).
    2. `listStepsForCronoton(run.codex_cronoton_id, { db: ctx.db })`, find
       the row with `step_index === run.step_index`. If none exists, call
       `markRunTerminal(runId, "failed", { db: ctx.db })`, fire
       `ctx.onAudit({ action: "codex_cronoton_run.step_missing", result:
       "failure", targetKind: "codex_cronoton_run", targetId: runId,
       detail: { codexCronotonId: run.codex_cronoton_id, stepIndex:
       run.step_index } })`, and return (a run/step-definition mismatch —
       e.g. steps deleted out from under a live run — must fail loudly,
       not loop forever).
    3. `listRunLegs(runId, { db: ctx.db })`, filter to `step_index ===
       run.step_index`, map to `{ legIndex: l.leg_index, status: l.status
       }` for `advanceRun`'s `LegState[]` input.
    4. Build `RunPolicy`: `stepMode: step.mode === "single" ? "serial" :
       "parallel"`, `canReplan: step.mode === "planner"`,
       `maxReplanAttempts: ctx.config?.maxReplanAttempts ??
       DEFAULT_MAX_REPLAN_ATTEMPTS` (import from `./seams.js`).
    5. Build `RunState: { status: run.status, stepIndex: run.step_index,
       stepCount: run.step_count, deadlineAt: run.deadline_at, attempt:
       run.attempt }`. Call `advanceRun(runState, legs, now, policy)` (from
       `./pure/run-advance.js`).
    6. For each returned `RunAction`, execute (see the exact per-kind
       behavior below) — loop sequentially (`for...of` with `await`, not
       `Promise.all`; the `submit-leg` case below explains why).
  - Per-`RunAction`-kind behavior inside `driveRunOnce`:
    - `{ kind: "submit-leg", legIndex }`: find the leg row (from the same
      `step_index`-filtered list read in step 3) with `leg_index ===
      legIndex`; if not found, `ctx.onAudit` an error event and continue
      to the next action (defensive — should never happen, since every
      `submit-leg` action targets a `pending` leg `advanceRun` itself
      selected from the very `legs` array this function passed it).
      `JSON.parse(leg.definition_json)` as `CodexTxDefinition`, call
      `await executeCodexTransaction(definition, "submit", { runtime:
      ctx.runtime, resolver: ctx.resolver, config: ctx.config })` (import
      from `./executor.js`). If `result.ok && result.requestKey &&
      result.chainId`: `markLegSubmitted(leg.id, { requestKey:
      result.requestKey, chainId: result.chainId }, { db: ctx.db })`.
      Else: `ctx.onAudit({ action: "codex_cronoton_run_leg.submit_failed",
      result: "failure", targetKind: "codex_cronoton_run_leg", targetId:
      leg.id, detail: { runId, stepIndex: run.step_index, legIndex,
      error: result.error } })` and leave the leg row untouched (still
      `pending` — the next `driveRunOnce` pass re-selects it, per
      design.md §F; no retry-counting write exists or is needed).
    - `{ kind: "poll" }`: collect every `step_index`-filtered leg with
      `status === "submitted"` that has both a non-null `request_key` and
      `chain_id`; if none, no-op. Group by `chain_id`. For each
      `(chainId, legsForChain)` group: `const client =
      ctx.runtime.createClient(ctx.runtime.getPactUrl(chainId));` `const
      polled = (await client.pollRequestKeys?.(legsForChain.map(l =>
      l.request_key!), chainId)) ?? {};` — the `?? {}` covers BOTH "the
      adapter omits `pollRequestKeys`" and "the call returned nothing
      landed yet," treating both identically as "nothing new this pass,"
      never throwing (an adapter without `pollRequestKeys` is out of
      scope for Phase 3's one-request-per-chain path — see design.md's
      Out of scope). For each leg in the group: if
      `polled[leg.request_key!]` is absent, skip (still pending); else if
      its `.result.status === "success"`, `markLegConfirmed(leg.id, { db:
      ctx.db })`; else `markLegFailed(leg.id, { errorMessage:
      polled[leg.request_key!].result.error?.message ?? "transaction
      failed on-chain" }, { db: ctx.db })`.
    - `{ kind: "advance-step" }`: if `run.step_index + 1 >=
      run.step_count`, `markRunTerminal(runId, "succeeded", { db:
      ctx.db })`. Else `advanceRunStep(runId, { fromStepIndex:
      run.step_index, toStepIndex: run.step_index + 1, deadlineAt: new
      Date(now.getTime() + (ctx.config?.runStepDeadlineMs ??
      RUN_STEP_DEADLINE_MS)).toISOString() }, { db: ctx.db })` (import
      `RUN_STEP_DEADLINE_MS` from `./seams.js`).
    - `{ kind: "replan-step", reason }`: if `step.mode === "planner"`,
      `throw new PlannerNotRegisteredError(step.planner_name ??
      "(unnamed)")` — stop processing further actions for this run (let it
      propagate to `advanceInFlightRunsOnce`'s per-run try/catch). Else
      (`mode: "single"`): `const definition =
      stepRowToDefinition(step);` (import from `./store/mappers.js`)
      `insertRunLeg({ runId, stepIndex: run.step_index, legIndex: 0,
      definitionJson: JSON.stringify(definition) }, { db: ctx.db });` then
      `advanceRunStep(runId, { fromStepIndex: run.step_index,
      toStepIndex: run.step_index, deadlineAt: new Date(now.getTime() +
      (ctx.config?.runStepDeadlineMs ?? RUN_STEP_DEADLINE_MS)).toISOString()
      }, { db: ctx.db })` to stamp this step's first deadline.
    - `{ kind: "fail-run", reason }`: `markRunTerminal(runId, "failed", {
      db: ctx.db })`, then `ctx.onAudit({ action:
      "codex_cronoton_run.failed", result: "failure", targetKind:
      "codex_cronoton_run", targetId: runId, detail: { codexCronotonId:
      run.codex_cronoton_id, stepIndex: run.step_index, reason } })`.
    - `{ kind: "wait" }`: no-op.
  - `export async function advanceInFlightRunsOnce(now: Date, ctx:
    RunsDriverCtx): Promise<{ driven: string[]; errored: string[] }>` —
    `listInFlightRuns({ db: ctx.db })` (import from `./store/runs.js`),
    for each run `await driveRunOnce(run.id, now, ctx)` inside a
    per-run `try/catch` (one run's thrown error — including
    `PlannerNotRegisteredError` — is caught, logged via
    `console.error`, and pushes `run.id` to `errored`; success pushes to
    `driven`), continuing to the next run either way — same per-item
    isolation posture `codexCronotonTickOnce` already applies per-row.
  - `packages/khronoton-core/src/server/index.ts` gains one new line,
    placed immediately after the existing `export * from "./loop.js";`
    (and its surrounding comment block, matching that block's style):
    `export * from "./runs-driver.js";`.
  Tests in `packages/khronoton-core/src/server/runs-driver.test.ts` (new
  file, following `tick.test.ts`'s ctx-injection convention — a
  hand-built `RunsDriverCtx` with a real in-memory `better-sqlite3` `db`
  via `installSchema`, `onAudit: vi.fn()`, and a mock `runtime`/`resolver`
  built the way `tick.test.ts`/`executor.test.ts` build theirs — read both
  first): (a) a freshly-created run (`status:'planning'`, `step_index:0`,
  no legs, cronoton has one `mode:'single'` step) drives through
  `replan-step` (build leg 0 + stamp a deadline) then, in the SAME
  `driveRunOnce` call, through `submit-leg` for that leg — asserted via
  `getRun`/`listRunLegs` showing a `submitted` leg with a `request_key`
  after one `driveRunOnce` call, and the mock `runtime`'s
  `universalSignTransaction`/`client.submit` called exactly once; (b) a
  run whose current step has one `submitted` leg, polled via a mock
  `pollRequestKeys` returning a landed success result, flips that leg to
  `confirmed` and — being the step barrier — advances `step_index` (or
  calls `markRunTerminal(..., "succeeded")` if it was the last step); (c)
  the same poll scenario but the landed result is a failure flips the leg
  to `failed`, and since `mode:'single'` has `canReplan:false`, the RUN's
  status becomes `failed` in the same `driveRunOnce` call (not a second
  leg inserted); (d) a step whose `executeCodexTransaction("submit", ...)`
  mock resolves `{ ok: false, mode: "submit", error: "..." }` on a FIRST
  `driveRunOnce` call leaves the leg row `pending` (verified via
  `listRunLegs`) and calls `ctx.onAudit` with an event whose `result` is
  `"failure"`, mock not reset; a SECOND `driveRunOnce` call against the
  same run id re-selects the same still-`pending` leg and calls
  `executeCodexTransaction` a second time (asserted via the mock's call
  count going from 1 to 2 with the same `legIndex`/definition), proving
  the "no retry-counting write, next pass just retries" behavior rather
  than merely asserting the first call's outcome; (e) a run whose current
  step's `deadlineAt` has already passed `now` (seed a run with
  `deadline_at` in the past relative to the `now` passed into
  `driveRunOnce`), with its one leg still `pending`/`submitted` (never
  `failed`) — `driveRunOnce` flips the run straight to `status: 'failed'`
  via `markRunTerminal` (not a second leg-0 insert), proving the
  deadline-exceeded branch also respects `mode:'single'`'s
  `canReplan:false`, independent of the leg-failure case in (c); (f) a
  cronoton with a `mode:'planner'` step (inserted directly via
  `insertStep({ mode: 'planner', plannerName: 'test-planner' })`, since no
  registry exists to create one any other way) throws
  `PlannerNotRegisteredError` from `driveRunOnce` on its first pass (no
  legs yet); (g) `advanceInFlightRunsOnce` against two in-flight runs
  where the first's `driveRunOnce` throws (simulate via (f)'s planner
  scenario) still drives the second to completion, returning `{ driven:
  [secondRunId], errored: [firstRunId] }`.
  `npx vitest run runs-driver.test.ts` and `npm run typecheck` both pass.
  - files: `packages/khronoton-core/src/server/runs-driver.ts`,
    `packages/khronoton-core/src/server/runs-driver.test.ts`,
    `packages/khronoton-core/src/server/index.ts`

## Wave 3 (depends on Wave 2)
- [x] T5: Wire the create-run-and-submit-step-0 path into
  `codexCronotonTickOnce` — done when:
  `packages/khronoton-core/src/server/tick.ts` imports `createRun` and the
  `RunAlreadyInFlightError` class from `./store/runs.js` and
  `./store/errors.js` respectively, `listStepsForCronoton` from
  `./store/steps.js`, and `driveRunOnce` from `./runs-driver.js`. Inside
  the existing per-row `for (const row of due)` loop in
  `codexCronotonTickOnce`, immediately after the existing `claimed =
  claimDueCodexCronoton(...)` / `if (!claimed) { skippedIds.push(row.id);
  continue; }` block and BEFORE the existing `rowToDefinition`/
  `fireByServerResolver` call, insert: `const steps =
  listStepsForCronoton(row.id, { db: ctx.db });` then `if (steps.length >
  0) { ... }` branching to the chained path, with the EXISTING plain-fire
  code below it now reached only in the `else` (implicitly, via the
  chained branch's own `continue`). Inside the chained branch: `try {
  const runId = createRun({ codexCronotonId: row.id, stepCount:
  steps.length }, { db: ctx.db }); await driveRunOnce(runId, now, ctx);
  firedIds.push(row.id); await ctx.onAudit({ action:
  "codex_cronoton.run_started", result: "success", targetKind:
  "codex_cronoton", targetId: row.id, detail: { codexCronotonId: row.id,
  runId, stepCount: steps.length, actor: "scheduler" } }); } catch (err) {
  if (err instanceof RunAlreadyInFlightError) { skippedIds.push(row.id); }
  else { throw err; } }` — rethrowing anything other than
  `RunAlreadyInFlightError` lets it fall through to the per-row `catch`
  block the function ALREADY has (the existing `console.error(...);
  skippedIds.push(row.id);` a few lines below), so no new error-isolation
  logic is written, only reused. `continue;` after the chained branch
  (whether it succeeded or self-blocked) so a chained row never falls
  through into the plain-fire code beneath it. Does NOT call `recordFire`
  or `applyTerminalIntent` for a chained row (per design.md §B — a
  chained run's lifecycle lives in `codex_cronoton_runs`/
  `..._run_legs`, not `codex_cronoton_fires`).
  Tests in `tick.test.ts` (reusing the file's existing `makeCtx`/`makeRow`
  helpers and `vi.spyOn` convention — read the file's existing describe
  blocks first to match style): (a) a due row with one seeded
  `codex_cronoton_steps` row (`mode:'single'`) gets `createRun` called
  (spy), `driveRunOnce` called exactly once with the new run's id (spy on
  the `./runs-driver.js` module), ends up in `firedIds`, and neither
  `recordFire` nor `applyTerminalIntent` is called for that row (spies
  asserting zero calls); (b) the SAME due row, but `createRun` is
  stubbed/spied to throw `RunAlreadyInFlightError` (simulating an
  existing non-terminal run) — the row lands in `skippedIds` (not
  `failedIds`), `driveRunOnce` is NOT called, and `claimDueCodexCronoton`
  (and therefore `next_fire_at`) was still called/advanced before the
  throw (assert via the claim spy's call count, or by re-reading the row
  from a real in-memory DB after the tick — pick whichever matches this
  file's existing due-selection test's own verification style); (c) a due
  row with ZERO `codex_cronoton_steps` rows still takes the existing
  plain-fire path unchanged (reuse/adapt one existing passing test's
  assertions to confirm `listStepsForCronoton` returning `[]` doesn't
  alter behavior); (d) every pre-existing test in `tick.test.ts`
  (recurring/one-time/claim-false/per-row-isolation/multi-tx-resolver/
  manual-batch describe blocks) passes unmodified. `npx vitest run
  tick.test.ts` and `npm run typecheck` both pass.
  - files: `packages/khronoton-core/src/server/tick.ts`,
    `packages/khronoton-core/src/server/tick.test.ts`

- [x] T6: Wire `advanceInFlightRunsOnce` into `startKhronotonLoop` as a
  third pass — done when: `packages/khronoton-core/src/server/loop.ts`
  imports `advanceInFlightRunsOnce` from `./runs-driver.js`;
  `KhronotonLoopOpts` gains `runAdvance?: typeof advanceInFlightRunsOnce;`;
  inside `startKhronotonLoop`, `const runAdvance = opts?.runAdvance ??
  advanceInFlightRunsOnce;` is added alongside the existing `runTick`/
  `runManualBatch` resolution, and the interval handler's body gains
  `await runAdvance(new Date(), ctx);` as a THIRD call, placed after the
  existing `await runManualBatch(new Date(), ctx);` line, still inside the
  same `try` block (so a rejection from any of the three passes is caught
  by the existing single `catch (err) { console.error(...); }` and the
  existing `finally { running = false; }` still runs regardless of which
  pass threw).
  `packages/khronoton-core/src/server/loop.test.ts` is updated: every
  existing `startKhronotonLoop(ctx, { runTick, runManualBatch })` call
  site (all four `it` blocks) gains a third `runAdvance: vi.fn()
  .mockResolvedValue(ADVANCE_RESULT)` in its opts object, where
  `ADVANCE_RESULT: { driven: string[]; errored: string[] } = { driven: [],
  errored: [] }` is a new module-level constant mirroring the existing
  `TICK_RESULT`/`MANUAL_RESULT` constants. The first test ("runs one pass
  per tickIntervalMs") additionally asserts `expect(runAdvance)
  .toHaveBeenCalledTimes(1)` / `(2)` at the same two checkpoints it
  already checks `runTick`/`runManualBatch`, and `expect(runAdvance)
  .toHaveBeenCalledWith(expect.any(Date), ctx)`. The re-entrancy test
  ("suppresses an overlapping pass...") additionally asserts `runAdvance`
  is NOT called while the hung `runTick` promise is still pending (same
  call-count-stays-flat assertion style already used for `runTick`), and
  IS called once the pass settles. One NEW test, `"survives a rejecting
  runAdvance pass — the interval keeps ticking and the guard is cleared"`,
  mirroring the existing `"survives a rejecting pass"` test's structure
  exactly but with `runAdvance` (not `runTick`) stubbed via
  `mockRejectedValueOnce`, asserting `consoleError` was called and the
  NEXT interval still runs a fresh pass. `npx vitest run loop.test.ts` and
  `npm run typecheck` both pass; the three pre-existing tests continue to
  pass (now with the added `runAdvance` assertions, not removed).
  - files: `packages/khronoton-core/src/server/loop.ts`,
    `packages/khronoton-core/src/server/loop.test.ts`
