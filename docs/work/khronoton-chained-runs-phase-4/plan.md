## Wave 1
- [x] T1: The `StepPlanner` registry — done when: new file
  `packages/khronoton-core/src/server/planners/registry.ts` exports exactly:
  - `export interface PlannerCtx { runtime: ChainRuntime; resolver:
    KeyResolver; config?: Partial<Config>; }` — importing
    `ChainRuntime`/`KeyResolver`/`Config` as types only from `../seams.js`.
    Structurally identical to `executor.ts`'s `ExecutorCtx` (same three
    fields) but declared as its OWN interface here, matching the precedent
    `runs-driver.ts`'s `RunsDriverCtx` already set (a module-local ctx type
    that happens to be satisfied by the same real objects, no import of the
    other module's type name).
  - `export interface PlannedLeg { pactCode: string; config: CodexTxConfig;
    payload: Record<string, unknown>; gasPayer: CodexGasPayer; signers:
    CodexSigner[]; }` — importing `CodexTxConfig`/`CodexGasPayer`/`CodexSigner`
    as types from `../types.js`. (Deliberately the same field set as
    `CodexTxDefinition` minus `scheduleKind`/`serverResolver`, which a leg
    never needs — matching `store/mappers.ts`'s `stepRowToDefinition`'s own
    output shape exactly, so `JSON.stringify`-ing a `PlannedLeg` produces a
    string `handleSubmitLeg`'s existing `parseLegDefinition` (Phase 3,
    unchanged) already accepts without any change there.)
  - `export type StepPlanner = (step: CodexCronotonStepRow, ctx: PlannerCtx)
    => Promise<PlannedLeg[]>;` — importing `CodexCronotonStepRow` as a type
    from `../store/steps.js`.
  - `export function registerStepPlanner(name: string, planner: StepPlanner):
    void` and `export function getStepPlanner(name: string): StepPlanner |
    undefined`, backed by a module-level `const STEP_PLANNERS: Record<string,
    StepPlanner> = {};` — a plain keyed object, NOT a `Map`, mirroring
    `resolvers.ts`'s `registerServerResolver`/`getServerResolver`/
    `SERVER_RESOLVERS` precedent exactly (read `resolvers.ts` lines 89-104
    first to match its doc-comment style and register/get shape verbatim).
  Also: `packages/khronoton-core/src/server/index.ts` gains one new
  re-export block (placed near the existing `export * from "./resolvers.js"`
  line, matching that line's bare `export *` style): `export * from
  "./planners/registry.js";`.
  Tests in `packages/khronoton-core/src/server/planners/registry.test.ts`
  (new file, following `resolvers.test.ts`'s existing style if one exists —
  check first; otherwise a plain `describe`/`it` suite with no DB, no
  chain client, pure in-memory registration): (a) `getStepPlanner` returns
  `undefined` for a name nothing registered; (b) `registerStepPlanner`
  followed by `getStepPlanner` with the same name returns the exact function
  reference registered; (c) registering a second planner under the SAME
  name as an existing one REPLACES it (matches `registerServerResolver`'s
  own "register (or replace)" documented behavior — read that doc comment
  and mirror its semantics, not invent new last-write-wins-vs-throw
  behavior). `npx vitest run planners/registry.test.ts` and `npm run
  typecheck` both pass.
  - files: `packages/khronoton-core/src/server/planners/registry.ts`,
    `packages/khronoton-core/src/server/planners/registry.test.ts`,
    `packages/khronoton-core/src/server/index.ts`

## Wave 2 (depends on Wave 1)
- [x] T2: Wire the real registry into `runs-driver.ts`'s `handleReplanStep`
  — done when: `packages/khronoton-core/src/server/runs-driver.ts` imports
  `getStepPlanner` and the `PlannedLeg`/`PlannerCtx` types from
  `./planners/registry.js`, and `handleReplanStep`'s current body —
  ```ts
  function handleReplanStep(
    run: CodexCronotonRunRow,
    step: CodexCronotonStepRow,
    now: Date,
    ctx: RunsDriverCtx,
  ): boolean {
    if (step.mode === "planner") {
      throw new PlannerNotRegisteredError(step.planner_name ?? "(unnamed)");
    }
    const definition = stepRowToDefinition(step);
    insertRunLeg(
      { runId: run.id, stepIndex: run.step_index, legIndex: 0, definitionJson: JSON.stringify(definition) },
      { db: ctx.db },
    );
    advanceRunStep(
      run.id,
      { fromStepIndex: run.step_index, toStepIndex: run.step_index, deadlineAt: computeStepDeadline(now, ctx) },
      { db: ctx.db },
    );
    return true;
  }
  ```
  — becomes (this function must become `async`, returning
  `Promise<boolean>` instead of `boolean`; its one call site,
  `executeAction`'s `case "replan-step": return handleReplanStep(run, step,
  now, ctx);` at runs-driver.ts:351-352, needs NO edit — `executeAction` is
  already `async`, and `return <a promise>;` inside an `async function`
  already returns a promise the caller correctly awaits, so the call site
  is untouched):
  ```ts
  async function handleReplanStep(
    run: CodexCronotonRunRow,
    step: CodexCronotonStepRow,
    now: Date,
    ctx: RunsDriverCtx,
  ): Promise<boolean> {
    if (step.mode === "planner") {
      const planner = getStepPlanner(step.planner_name ?? "");
      if (!planner) {
        throw new PlannerNotRegisteredError(step.planner_name ?? "(unnamed)");
      }
      const legs = await planner(step, { runtime: ctx.runtime, resolver: ctx.resolver, config: ctx.config });
      if (legs.length === 0) {
        // The planner decided this step needs no work this pass (e.g.
        // nothing owed) — treat exactly like a cleared barrier, matching
        // `handleAdvanceStep`'s own terminal-vs-advance branch verbatim
        // rather than duplicating it.
        return handleAdvanceStep(run, now, ctx);
      }
      legs.forEach((leg, legIndex) => {
        insertRunLeg(
          { runId: run.id, stepIndex: run.step_index, legIndex, definitionJson: JSON.stringify(leg) },
          { db: ctx.db },
        );
      });
      advanceRunStep(
        run.id,
        { fromStepIndex: run.step_index, toStepIndex: run.step_index, deadlineAt: computeStepDeadline(now, ctx) },
        { db: ctx.db },
      );
      return true;
    }
    const definition = stepRowToDefinition(step);
    insertRunLeg(
      { runId: run.id, stepIndex: run.step_index, legIndex: 0, definitionJson: JSON.stringify(definition) },
      { db: ctx.db },
    );
    advanceRunStep(
      run.id,
      { fromStepIndex: run.step_index, toStepIndex: run.step_index, deadlineAt: computeStepDeadline(now, ctx) },
      { db: ctx.db },
    );
    return true;
  }
  ```
  (the `mode:'single'` branch is untouched, copy-pasted verbatim from the
  current function — do not refactor it in this task, only add the
  `mode:'planner'` real-lookup branch above it).
  Tests in `packages/khronoton-core/src/server/runs-driver.test.ts`: reuse
  the file's existing real-in-memory-`better-sqlite3` + `installStep`/
  `createRun` fixture style. Add, inside (or right after) the existing
  `describe("driveRunOnce — a mode:'planner' step's first entry throws,
  guarding the unbuilt Phase 4 registry", ...)` block — **rename that
  describe block's title** to `"driveRunOnce — mode:'planner' routes through
  the real registry"` since Phase 4 registers one now, and **keep its one
  existing test** (`insertStep({ mode: "planner", plannerName:
  "test-planner" })` with NOTHING registered under that exact name still
  throws `PlannerNotRegisteredError` — this is the one pre-existing test in
  that block; confirm it still passes unmodified since nothing in this task
  registers a planner named literally `"test-planner"`), and ADD four new
  tests: (a) `registerStepPlanner("rd-test-returns-n", async () =>
  [{pactCode:"(+ 1 1)", config:{chainId:"0",gasPrice:0,gasLimit:1000,
  autoGasLimit:false,ttl:600}, payload:{}, gasPayer:{type:"gas-station",
  gasStationSignerKey: PUB_A}, signers:[{publicKey:PUB_A,
  capabilityMode:"pure",capabilities:""}]}, /* a second leg, same shape */])`
  (register this in a `beforeEach`/at the top of the test, using this file's
  existing `PUB_A` constant and the same leg-shape fixtures
  `insertSingleStep`'s own definition already uses) — a step with `mode:
  "planner", plannerName: "rd-test-returns-n"` drives through `driveRunOnce`
  and ends with exactly 2 `pending` legs inserted (both at `stepIndex:0`,
  `legIndex` 0 and 1), both eventually submitted (the mock `submit`/
  `universalSignTransaction` from this file's existing `ChainRuntime` mock
  fixtures, called twice); (b) `registerStepPlanner("rd-test-returns-zero",
  async () => [])` — a step using this planner drives through
  `driveRunOnce` and, being the ONLY step (`stepCount: 1`), ends with
  `getRun(runId, {db}).status === "succeeded"` and ZERO rows in
  `listRunLegs(runId, {db})` — proving the zero-legs-means-advance path
  never inserts a leg; (c) the SAME zero-legs planner on a run with
  `stepCount: 2` ends with `step_index: 1` (advanced, not terminal) and
  zero legs for step 0; (d) the registered planner function itself receives
  the exact `step` row and a `ctx` with `runtime`/`resolver`/`config` keys
  present (assert via a `vi.fn()` planner spy capturing its call args,
  `expect(plannerSpy).toHaveBeenCalledWith(expect.objectContaining({
  planner_name: "rd-test-returns-n" }), expect.objectContaining({ runtime:
  expect.anything(), resolver: expect.anything() }))`).
  `npx vitest run runs-driver.test.ts` and `npm run typecheck` both pass;
  every other pre-existing `runs-driver.test.ts` test (submit/poll/
  advance-step/fail-run/defensive-branches/per-run-isolation describe
  blocks) passes unmodified.
  - files: `packages/khronoton-core/src/server/runs-driver.ts`,
    `packages/khronoton-core/src/server/runs-driver.test.ts`

- [x] T3: The `ouronet.aqp-evict` planner — done when: new file
  `packages/khronoton-core/src/server/planners/evict.ts` exports
  `evictPlanner: StepPlanner` (the implementation function, exported for
  direct unit testing) and, at module-eval time, calls
  `registerStepPlanner("ouronet.aqp-evict", evictPlanner)` — importing
  `registerStepPlanner`, `StepPlanner`, `PlannedLeg`, `PlannerCtx` from
  `./registry.js`. Implements exactly:
  1. Parse `step.planner_params_json` (via `JSON.parse`, following
     `store/mappers.ts`'s existing `parseJson<T>(json, fallback)` pattern —
     import/duplicate that one-line helper locally rather than importing a
     private function from another module) as `{ fvtId: string;
     patronAccount: string }`. If either field is missing/not a string,
     throw a plain `Error` with a clear message (e.g. "ouronet.aqp-evict:
     step.planner_params_json must have fvtId and patronAccount strings") —
     this is a configuration error at the SAME level as `PlannerNotRegisteredError`,
     not a runtime chain condition, so it propagates exactly like any other
     `handleReplanStep` throw (caught by `advanceInFlightRunsOnce`'s
     existing per-run isolation).
  2. Derive `executor = \`k:${step's own first signer's publicKey}\`` —
     parse `step.signers_json` the same way (`parseJson<CodexSigner[]>(...,
     [])`), take `signers[0].publicKey`, throw if the array is empty (same
     "at least one signer" contract `executor.ts`'s own `buildTransaction`
     already enforces one layer down — fail here with a clearer
     evict-specific message instead of letting that generic throw surface
     confusingly later).
  3. Build the "read the plan" probe: a `PlannedLeg`-shaped
     `CodexTxDefinition` with `pactCode:
     \`(AQP-EVCT.URHC_BuildEvictPlans "${fvtId}")\`` (string-interpolated
     the same way `store/mappers.ts`/`blockchain/stoachain.ts` already
     build Pact code strings elsewhere in this codebase — no new escaping
     helper exists to reuse, and `fvtId` is operator-configured step data,
     not external/untrusted input, matching the trust model
     `runs-driver.ts`'s own `getPactUrl`/`chainId` interpolation already
     operates under), `config` copied from `step.config_json` (parsed via
     the same local `parseJson` helper, fallback `{}` cast — matching
     `stepRowToDefinition`'s own existing null-handling), `payload: {}`,
     `gasPayer` parsed from `step.gas_payer_json` (fallback
     `{type:"gas-station"}`, matching `stepRowToDefinition`'s own
     precedent), `signers` parsed from `step.signers_json`. Call
     `executeCodexTransaction(probeDefinition, "simulate", { runtime:
     ctx.runtime, resolver: ctx.resolver, config: ctx.config })` — import
     `executeCodexTransaction` from `../executor.js`.
  4. If `!result.ok`: rethrow a plain `Error(result.error ?? "evict plan
     read failed")` — a failed PLAN READ (as opposed to a failed Full-evict
     PROBE, step 6 below) is never interpreted as "needs splitting"; there
     is no plan to split if the read itself failed.
  5. Parse the plan: `const data = (result.rawResult as { data?: unknown
     })?.data;` — `rawResult` on a successful `SimulateResult` is
     `simulation.result` (confirmed by reading `executor.ts`'s
     `runSimulate`: `rawResult: simulation.result` on the `ok:true` return
     path, where `simulation` is the `DirtyReadResult` from
     `ChainClient.dirtyRead`/`preflightRead`, whose own `.result.data`
     field carries the Pact call's actual return value). Cast `data` to an
     array of `{ beneficiary: string; scoreEntityType: number;
     scoreEntityId: string; rewardDptfId: string }` (the `EvictLeg` fields
     actually consumed by `CC_EvictSingleReward`'s args, per
     `evictSpecs.tsx`'s own field list — `poolId`/`claimable` are NOT
     passed as args to either entrypoint, so they're not needed here). If
     `data` is not an array, throw a plain `Error("ouronet.aqp-evict:
     URHC_BuildEvictPlans returned a non-array result")`.
  6. **If `data.length === 0`: return `[]`** (§C of the design — the
     zero-legs path T2 already handles).
  7. **Else, probe `CC_FullEvictRewards` as ONE candidate leg.** Build its
     `PlannedLeg`: `pactCode: \`(AQP-EVCT.CC_FullEvictRewards "${patronAccount}" "${executor}" "${fvtId}")\`` —
     the exact 3-arg order `(patron, executor, fvt-id)` per
     `evictSpecs.tsx`'s `EVICT_FULL.fields` (read
     `/home/ancientbox/ClaudeWS/OuroborosNetwork/daimons/OuronetUI/src/constants/evictSpecs.tsx`
     lines 119-138 directly to confirm this exact field order/entrypoint
     string before writing the pactCode template — do not guess at it from
     this plan's own paraphrase). Same `config`/`payload: {}`/`gasPayer`/
     `signers` as the probe above. Call `executeCodexTransaction(fullDef,
     "simulate", {...})` again.
  8. **If `fullResult.ok`: return `[fullLeg]`** — exactly one leg.
  9. **If `!fullResult.ok`:** this is the split-vs-propagate decision —
     **deviating from design.md §D.4's literal wording** (which specified
     porting OuronetUI's `"Gas limit" && "exceeded"` substring check):
     having now traced Khronoton's own `executor.ts`'s `runSimulate`
     precisely, its "refuse unmineable" branch (`gasUsed > ceiling`) is the
     ONLY `ok:false` path that also sets a numeric `gasUsed` field — every
     OTHER failure (a genuine chain-level/Pact-execution error) returns
     `ok:false` with NO `gasUsed` field at all (confirmed by reading
     `executor.ts`'s `runSimulate` return statements directly: the
     `status === "failure"` branch omits `gasUsed`; only the
     `gasUsed > ceiling` branch sets it). So: **`if (typeof
     fullResult.gasUsed === "number")` → this IS the "needs splitting"
     signal** (fan out, step 10) — **else → rethrow** `new
     Error(fullResult.error ?? "CC_FullEvictRewards simulation failed")`
     (a genuine failure, never treated as "needs splitting"). This is
     MORE precise than a message-substring check because it's a typed
     field on Khronoton's own result shape, not a string this codebase
     would otherwise have to parse out of a message it doesn't control —
     functionally it is the exact same semantic distinction design.md's
     §D.4 was reaching for (gas-ceiling refusal vs any other failure), just
     expressed through the mechanism Khronoton's own executor already
     provides rather than through a borrowed string check.
  10. **Fan out:** return one `PlannedLeg` per entry in `data`, each with
      `pactCode: \`(AQP-EVCT.CC_EvictSingleReward "${patronAccount}"
      "${executor}" "${fvtId}" "${leg.beneficiary}" ${leg.scoreEntityType}
      "${leg.scoreEntityId}" "${leg.rewardDptfId}")\`` — the exact 7-arg
      order `(patron, executor, fvt-id, beneficiary, score-entity-type,
      score-entity-id, reward-dptf-id)` per `evictSpecs.tsx`'s
      `EVICT_SINGLE.fields` (read lines 148-164 of the same OuronetUI file
      to confirm the exact field order/entrypoint string/which fields are
      Pact integers vs strings — `score-entity-type` is a plain Pact
      integer per the research's own note "1 = score, 3 = triplet," so it
      must NOT be quoted in the generated Pact code the way the string
      fields are).
  Tests in `packages/khronoton-core/src/server/planners/evict.test.ts` (new
  file): call `evictPlanner(step, ctx)` directly (no DB, no `driveRunOnce`
  — unit-test the planner function in isolation), with a hand-built
  `PlannerCtx` whose `runtime`/`resolver` mocks mirror
  `runs-driver.test.ts`'s existing `makeRuntime`/`makeResolver` fixture
  style (read that file first and reuse its `ChainClient`/`dirtyRead`/
  `submit`/`universalSignTransaction` mock shape, since this planner drives
  through the SAME real `executeCodexTransaction` machinery), and a
  `makeStepRow` fixture building a `CodexCronotonStepRow` with
  `planner_name: "ouronet.aqp-evict"`, `planner_params_json:
  JSON.stringify({fvtId: "fvt-1", patronAccount: "k:patron"})`. Cases:
  (a) `dirtyRead` mocked to return `{ result: { status: "success", data:
  [] } }` for the plan-read call → `evictPlanner` resolves to `[]`; (b)
  `dirtyRead` mocked to return a 1-entry plan AND a successful result for
  the `CC_FullEvictRewards` probe (`{ result: { status: "success", data:
  null }, gas: 50000 }`, under whatever ceiling the mock `getBlockGasLimit`/
  config implies) → resolves to exactly 1 `PlannedLeg` whose `pactCode`
  contains `"CC_FullEvictRewards"` and the configured `fvtId`/`patronAccount`;
  (c) a 3-entry plan AND the `CC_FullEvictRewards` probe's `dirtyRead` call
  mocked to report `gas` ABOVE the ceiling (triggering `runSimulate`'s own
  `gasUsed > ceiling` branch) → resolves to exactly 3 `PlannedLeg`s, each
  `pactCode` containing `"CC_EvictSingleReward"` and that entry's own
  `beneficiary`/`rewardDptfId`; (d) the `CC_FullEvictRewards` probe's
  `dirtyRead` mocked to return `{ result: { status: "failure", error: {
  message: "some other real Pact error" } } }` → `evictPlanner(...)`
  REJECTS (the promise throws), proving a non-gas failure is never silently
  treated as "needs splitting"; (e) `step.planner_params_json` missing
  `fvtId` → `evictPlanner(...)` rejects with a clear configuration-error
  message, `executeCodexTransaction`/the mock `dirtyRead` never called at
  all.
  Also: `packages/khronoton-core/src/server/index.ts` gains one more
  re-export line, placed directly after the `./planners/registry.js` line
  T1 added: `export * from "./planners/evict.js";` — this import's module-
  eval side effect (the `registerStepPlanner` call inside `evict.ts`) is
  what makes `"ouronet.aqp-evict"` actually resolvable by name once a
  consumer imports anything from this package's `/server` entry point.
  `npx vitest run planners/evict.test.ts` and `npm run typecheck` both
  pass.
  - files: `packages/khronoton-core/src/server/planners/evict.ts`,
    `packages/khronoton-core/src/server/planners/evict.test.ts`,
    `packages/khronoton-core/src/server/index.ts`

## Wave 3 (depends on Wave 2)
- [x] T4: End-to-end proof — the REAL registered `ouronet.aqp-evict`
  planner drives through the REAL `driveRunOnce`, not a test stand-in —
  done when: `packages/khronoton-core/src/server/runs-driver.test.ts`
  imports `evictPlanner` from `./planners/evict.js` (importing this module
  — rather than only `./planners/registry.js` — is what triggers its
  self-registration side effect for this test file, exactly as T3's
  `server/index.ts` re-export triggers it for a real consumer) and adds one
  new `describe("driveRunOnce — end-to-end with the real registered
  ouronet.aqp-evict planner", ...)` block with two tests, reusing this
  file's existing `seedCronoton`/real-in-memory-`better-sqlite3`/mock-
  `ChainRuntime` fixtures throughout (no new mocking style): (a) a step
  with `mode: "planner", plannerName: "ouronet.aqp-evict",
  planner_params_json: JSON.stringify({fvtId:"fvt-e2e", patronAccount:
  "k:patron-e2e"})`, with the mock `dirtyRead` stubbed to answer the
  plan-read call with a single-entry plan and the `CC_FullEvictRewards`
  probe call with a success-under-ceiling gas figure, driven through a real
  `driveRunOnce(runId, NOW, makeCtx())` call (NOT `getStepPlanner`/
  `evictPlanner` called directly — this must go through the full
  `handleReplanStep` → registry lookup → planner call → `insertRunLeg` →
  `submit-leg` chain) — asserts exactly one `submitted` leg exists whose
  `definition_json`, when parsed, contains `"CC_FullEvictRewards"`; (b) the
  SAME setup but the plan-read call answers with THREE entries and the
  `CC_FullEvictRewards` probe reports gas over ceiling — asserts exactly
  three legs end up `submitted` (parallel fan-out, all three
  `universalSignTransaction`/`submit` calls made) and the run's current
  `step_index`/status reflect the barrier clearing once all three confirm
  (poll the mock to report all three landed, then one more `driveRunOnce`
  call, matching this file's existing poll-then-advance test pattern).
  `npx vitest run runs-driver.test.ts` and `npm run typecheck` both pass;
  every pre-existing test in the file (including T2's four new ones and
  the renamed registry-routing describe block) passes unmodified.
  - files: `packages/khronoton-core/src/server/runs-driver.test.ts`
