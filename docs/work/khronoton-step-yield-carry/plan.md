## Wave 1
- [x] T1: Add the yields storage layer — schema table/column, store CRUD,
      and the `yield_as` step field (applies uniformly to BOTH step
      modes: for `mode:'single'` it names what to store the confirmed
      leg's on-chain return value as; for `mode:'planner'` it names what
      to store the planner's returned yield value as — the step row
      itself owns the yield's NAME either way, never the planner) — done
      when: `npx vitest run src/server/schema.test.ts` passes including
      a new test asserting (a) `codex_cronoton_run_yields` exists with
      columns `(id, run_id, name, value_json, step_index, created_at)`
      and a UNIQUE index on `(run_id, name)`, and (b) `codex_cronoton_steps`
      has a nullable `yield_as TEXT` column, both confirmed via
      `PRAGMA table_info`/`PRAGMA index_list` on a fresh install AND on a
      re-run against an already-provisioned DB (idempotent, matching the
      existing `public_token`/`claimed_at` `ensureColumn` precedent); AND
      `npx vitest run src/server/store/yields.test.ts` passes with new
      tests proving `upsertYield` inserts a new `(runId, name)` row, a
      second `upsertYield` call with the SAME `(runId, name)` overwrites
      `value_json`/`step_index` (via `ON CONFLICT(run_id, name) DO
      UPDATE`) rather than erroring or duplicating, and `getYieldPool`
      returns `{}` for a run with zero yields and the correct
      `{name: value}` map (round-tripping a string, a number, and a
      decimal-string value) after one or more upserts; AND `npx vitest
      run src/server/store/steps.test.ts` passes with a new test proving
      `insertStep({..., yieldAs: "drainedAmount"})` persists `yield_as:
      "drainedAmount"` on the row `listStepsForCronoton` returns (tested
      for BOTH a `mode:'single'` and a `mode:'planner'` step), and
      omitting `yieldAs` leaves `yield_as: null` (backward compatible
      with every existing `insertStep` call in the test suite).
  - files: `packages/khronoton-core/src/server/schema.ts`,
    `packages/khronoton-core/src/server/schema.test.ts`,
    `packages/khronoton-core/src/server/store/steps.ts`,
    `packages/khronoton-core/src/server/store/steps.test.ts`,
    `packages/khronoton-core/src/server/store/yields.ts` (new),
    `packages/khronoton-core/src/server/store/yields.test.ts` (new),
    `packages/khronoton-core/src/server/store/index.ts`
  - Implementation: in `schema.ts`'s `SCHEMA_SQL`, add
    `CREATE TABLE IF NOT EXISTS codex_cronoton_run_yields (id TEXT PRIMARY
    KEY, run_id TEXT NOT NULL REFERENCES codex_cronoton_runs(id) ON DELETE
    CASCADE, name TEXT NOT NULL, value_json TEXT NOT NULL, step_index
    INTEGER NOT NULL, created_at TEXT NOT NULL); CREATE UNIQUE INDEX IF
    NOT EXISTS idx_codex_cronoton_run_yields_name ON
    codex_cronoton_run_yields(run_id, name);`; in `installSchema`, add
    `ensureColumn(db, "codex_cronoton_steps", "yield_as", "TEXT")`
    alongside the existing `ensureColumn` calls. In `store/steps.ts`, add
    `yieldAs?: string` to `InsertStepInput` and `yield_as: string | null`
    to `CodexCronotonStepRow`; thread `input.yieldAs ?? null` into
    `insertStep`'s `INSERT` statement/params (new `yield_as` column,
    column list, and `?` placeholder) — this applies identically
    regardless of `mode`, no branching needed. Create `store/yields.ts`
    mirroring `store/runs.ts`'s style (`crypto.randomUUID()` ids,
    `{ db: ctx.db }`-shaped `DbDep` second arg) with: `export function
    upsertYield(input: { runId: string; name: string; value: unknown;
    stepIndex: number }, dep: DbDep): void` running `INSERT INTO
    codex_cronoton_run_yields (id, run_id, name, value_json, step_index,
    created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, name) DO
    UPDATE SET value_json = excluded.value_json, step_index =
    excluded.step_index, created_at = excluded.created_at` (value
    JSON-stringified); and `export function getYieldPool(runId: string,
    dep: DbDep): Record<string, unknown>` doing `SELECT name, value_json
    FROM codex_cronoton_run_yields WHERE run_id = ?` and
    `JSON.parse`-ing each `value_json` into the returned map. Barrel both
    from `store/index.ts` alongside the existing `runs.js`/`steps.js`
    export blocks.

- [x] T2: Add the pure yield-reference resolver — done when: `npx vitest
      run src/server/pure/yields.test.ts` passes with new tests proving
      `resolveYieldRefs({"amount": {"$yield": "drainedAmount"}}, {
      drainedAmount: "123.45" })` returns `{"amount": "123.45"}`;
      resolution recurses into nested objects and arrays (e.g. a
      `$yield` reference inside a nested object one level deep, and
      inside an array element, both resolve correctly); a value with NO
      `$yield` reference anywhere (e.g. `{"patronAccount": "k:abc"}`)
      passes through completely unchanged (same keys/values, proving
      zero behavior change for every existing step definition with no
      placeholders); and `resolveYieldRefs({"amount": {"$yield":
      "neverProduced"}}, {})` throws `YieldNotFoundError` with a message
      naming `"neverProduced"`.
  - files: `packages/khronoton-core/src/server/pure/yields.ts` (new),
    `packages/khronoton-core/src/server/pure/yields.test.ts` (new)
  - Implementation: `export class YieldNotFoundError extends Error`
    (constructor takes the missing name, message e.g. `` `no yield named
    "${name}" has been produced yet in this run` ``, `this.name =
    "YieldNotFoundError"` — mirroring `runs-driver.ts`'s
    `PlannerNotRegisteredError` precedent of living next to its own
    primary thrower rather than in `store/errors.ts`). `export function
    resolveYieldRefs(value: unknown, pool: Record<string, unknown>):
    unknown` — recursively walks `value`: arrays map each element through
    `resolveYieldRefs`; a plain object whose OWN keys are exactly
    `["$yield"]` and whose `$yield` value is a string looks that string
    up in `pool`, throwing `YieldNotFoundError` if the name is absent,
    else returning `pool[name]` (not recursed into further — a yielded
    value is already resolved); any OTHER plain object has every one of
    its own entries individually passed through `resolveYieldRefs`
    (`Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
    resolveYieldRefs(v, pool)]))`); anything else (string/number/
    boolean/null) returns as-is.

- [x] T3: Let `ouronet.stoa-wrap` consume an externally-supplied amount
      instead of always self-probing, and always report its final amount
      back out — the planner-contract change (Wave 2's T4) will let a
      LATER step reference that amount via `{"$yield":...}`; this task
      only changes `stoa-wrap.ts` itself and does not depend on the
      yield mechanism's own files — done when: `npx vitest run
      src/server/planners/stoa-wrap.test.ts` passes with new tests
      proving (1) a step whose `planner_params_json` includes
      `amountOverride: "50.0"` builds its one leg using `"50.0"` as the
      wrap amount WITHOUT calling `coin.get-balance` at all (assert the
      test `ChainClient`'s simulate/probe function is never invoked —
      today's live-probe test already asserts it IS invoked when no
      override is given, so this proves the branch is genuinely skipped,
      not just ignored); (2) an `amountOverride` that does not match
      `/^\d+\.\d+$/` (e.g. `"abc"` or a bare integer `"5"`) throws a
      clear error before building any leg, same shape as this file's
      existing `patronAccount` shape-guard errors; (3) the returned value
      (whether produced via `amountOverride` or the existing live-probe
      path) is `{ legs: [theLeg], yield: "<the exact amount string used
      for that leg>" }` — NOT a bare `PlannedLeg[]` anymore, in BOTH the
      override and the live-probe cases; and (4) every pre-existing test
      in this file (the live-probe path, the zero-balance `[]` case, the
      gas-payer capability-append logic) passes with its assertions
      updated only to unwrap `.legs`/read `.yield` from the new return
      shape — no change to what amount/leg content those tests assert.
  - files: `packages/khronoton-core/src/server/planners/stoa-wrap.ts`,
    `packages/khronoton-core/src/server/planners/stoa-wrap.test.ts`
  - Implementation: add `amountOverride?: string` to
    `StoaWrapPlannerParams`. After parsing `params`, if
    `params.amountOverride !== undefined`: validate it against
    `/^\d+\.\d+$/` (throw `` `ouronet.stoa-wrap: amountOverride must be a
    non-negative decimal string (e.g. "5.0"), got ${JSON.stringify(
    params.amountOverride)}` `` on mismatch, mirroring `inject.ts`'s own
    `amount` validation message style), then skip the `coin.get-balance`
    `executeCodexTransaction(..., "simulate", ...)` probe entirely and
    use `params.amountOverride` directly as `amount` (skip
    `formatPactDecimal`/`data === 0` handling too — the override is
    already a validated, final decimal string). When NO override is
    given, keep every existing line of the live-probe path byte-for-byte
    (including the `data === 0` → `return []` case, which still returns
    a bare array with no `yield` field — nothing was built, nothing to
    report). Change the function's final return in the "built one leg"
    case (both override and probed paths) from `return [leg];` to
    `return { legs: [leg], yield: amount };` (the SAME `amount` string
    already used to build the leg's payload/capability line — report
    exactly what was actually used, never a separately-recomputed value).

## Wave 2 (depends on Wave 1's T2)
- [x] T4: Widen the `StepPlanner` contract to allow an optional yield
      value, and make `resolvePlannerFor` resolve `$yield` references in
      a step's `planner_params_json` against a supplied pool before a
      caller ever invokes the planner — done when: `npx vitest run
      src/server/planners/registry.test.ts` passes with new tests
      proving (a) a test planner returning the bare-array shape
      (`PlannedLeg[]`, the shape `evict`/`inject`/`unstall`/`stoa-unwrap`
      still return after this task — only `stoa-wrap`, Wave 1's T3,
      switched shapes) still type-checks and `normalizePlannerResult`
      returns `{ legs: thatArray }` with no `yield` key; (b) a test
      planner returning `{ legs, yield: 42 }` normalizes to `{ legs,
      yield: 42 }` unchanged; (c)
      `resolvePlannerFor(step, seams, { drainedAmount: "123.45" })`
      where `step.planner_params_json` is
      `'{"amount":{"$yield":"drainedAmount"}}'` returns a `resolvedStep`
      whose `planner_params_json` parses to `{"amount":"123.45"}` (the
      literal placeholder is gone, replaced by the real value); (d)
      `resolvePlannerFor(step, seams)` called with NO pool argument
      (every call site before Wave 3) behaves byte-identical to today —
      defaults to resolving against `{}`, so a step with no `$yield`
      references anywhere is completely unaffected; and (e) `npx vitest
      run` across `evict.test.ts`/`inject.test.ts`/`unstall.test.ts`/
      `stoa-unwrap.test.ts` still passes unmodified — zero source changes
      required in any of those four built-in planner files (only
      `stoa-wrap.ts`, already updated in Wave 1's T3, has a different
      return shape).
  - files: `packages/khronoton-core/src/server/planners/registry.ts`,
    `packages/khronoton-core/src/server/planners/registry.test.ts`
  - Implementation: import `resolveYieldRefs` from `../pure/yields.js`.
    Widen `StepPlanner`'s return type to `Promise<PlannedLeg[] | { legs:
    PlannedLeg[]; yield?: unknown }>` — a bare value, no name field; the
    NAME a yield is stored under always comes from the consuming step's
    own `step.yield_as` (Wave 1's T1), decided by whoever WROTE the
    planner's producing step, never by the planner itself (so two
    differently-named steps both running `ouronet.stoa-wrap` in one chain
    can yield under two different names without any planner code
    knowing either name). Add `export function normalizePlannerResult(
    result: Awaited<ReturnType<StepPlanner>>): { legs: PlannedLeg[];
    yield?: unknown }` — if `Array.isArray(result)` return `{ legs:
    result }`, else return `result` as-is — the SINGLE shared normalizer
    both `runs-driver.ts` (Wave 3's T5) and `handlers/steps.ts` (Wave 3's
    T6) call, so neither hand-rolls its own array-vs-object check. Widen
    `resolvePlannerFor`'s signature to `(step, seams, yieldPool:
    Record<string, unknown> = {})`, returning `{ planner, plannerCtx,
    resolvedStep } | undefined` where `resolvedStep` is `{ ...step,
    planner_params_json: JSON.stringify(resolveYieldRefs(JSON.parse(
    step.planner_params_json ?? "{}"), yieldPool)) }` — every existing
    caller (today passing only `(step, seams)`) is unaffected by the new
    optional third parameter defaulting to `{}`.

## Wave 3 (depends on Wave 1's T1/T3 and Wave 2's T4; T5 and T6 touch disjoint files)
- [x] T5: Wire yield production and consumption into the real chained-run
      driver, for both step modes — done when: `npx vitest run
      src/server/runs-driver.test.ts` passes with new tests proving, via
      real `driveRunOnce` calls against a real in-memory DB (no mocks,
      matching this file's existing fixture style):
      (1) a 2-step run — step 0 `mode:'planner'` with `yield_as:
      "drainedAmount"` using a test-registered planner returning `{ legs,
      yield: "123.45" }`; step 1 `mode:'planner'` with
      `planner_params_json` containing `{"amount":{"$yield":
      "drainedAmount"}}` — after driving both steps to confirmation, step
      1's INSERTED leg's `definition_json` (read back via
      `listRunLegs`) contains the literal string `"123.45"` somewhere in
      its parsed `payload`, never the literal `{"$yield":...}`
      placeholder text;
      (2) a `mode:'single'` step 0 with `yield_as: "collected"` set,
      driven through a fake `ChainClient` whose `pollRequestKeys`
      resolves with `{result: {status:'success', data: 77}}` for its
      request key — after `handlePoll` runs, `getYieldPool(runId, {db})`
      returns `{collected: 77}`; a following step referencing
      `{"$yield":"collected"}` resolves it correctly;
      (3) a step whose `planner_params_json` references a yield name no
      earlier step in the run ever produced causes `driveRunOnce` to
      throw (propagating `YieldNotFoundError` through the existing
      `handleReplanStep` catch exactly the way `PlannerNotRegisteredError`
      already propagates today — reusing that established catch path,
      not a new one);
      (4) a REPLAN scenario: a planner-mode step 0 (`yield_as: "x"`)
      whose first attempt's leg fails, triggering a genuine re-plan
      (`attempt` bumped) — the test planner returns a DIFFERENT yield
      value on its second invocation than its first — after the second
      attempt's leg confirms, `getYieldPool` shows ONLY the second
      attempt's value, never the first's (proving a replan's upsert
      genuinely overwrites, not just "also inserts");
      (5) a realistic end-to-end capstone importing the REAL registered
      `ouronet.stoa-wrap`/`ouronet.aqp-inject` planners (for their
      self-registration side effect, the same pattern this file already
      uses for `evictPlanner`/`unstallPlanner`) in a 2-step run: step 0
      `mode:'planner'`, `planner_name: 'ouronet.stoa-wrap'`, `yield_as:
      "wrappedAmount"`, `planner_params_json: {"patronAccount":
      "k:...", "amountOverride": "50.0"}` (using Wave 1 T3's override so
      this test needs no live-balance mock); step 1 `mode:'planner'`,
      `planner_name: 'ouronet.aqp-inject'`, `planner_params_json:
      {"fvtId":"...", "patronAccount":"k:...", "rewardDptfId":"...",
      "amount": {"$yield":"wrappedAmount"}}` — driven to `succeeded`,
      asserting step 1's submitted leg's `payload.amount === "50.0"` —
      proving the exact motivating case (an amount genuinely carried
      from wrap into inject, not independently re-probed or statically
      pre-set) works with the REAL shipped planners, not test stand-ins;
      and (6) every pre-existing test in this file (none of which use
      `$yield`/`yield_as` anywhere) passes completely unmodified, proving
      zero regression for the entire existing single-mode/planner-mode/
      replan/concurrency-claim test surface this file already covers.
  - files: `packages/khronoton-core/src/server/runs-driver.ts`,
    `packages/khronoton-core/src/server/runs-driver.test.ts`
  - Implementation: import `getYieldPool`/`upsertYield` from
    `./store/yields.js`, `normalizePlannerResult` from
    `./planners/registry.js`, and `resolveYieldRefs` from
    `./pure/yields.js`. In `handleReplanStepInner`'s `mode === 'planner'`
    branch (currently `const resolved = resolvePlannerFor(step, ctx); ...
    const legs: PlannedLeg[] = await resolved.planner(step,
    resolved.plannerCtx);`): fetch `const pool = getYieldPool(run.id, {
    db: ctx.db });`, call `resolvePlannerFor(step, ctx, pool)`, invoke
    `resolved.planner(resolved.resolvedStep, resolved.plannerCtx)`,
    normalize via `normalizePlannerResult`, use `.legs` where `legs` was
    used before, and if `normalized.yield !== undefined && step.yield_as`
    call `upsertYield({ runId: run.id, name: step.yield_as, value:
    normalized.yield, stepIndex: run.step_index }, { db: ctx.db })`
    before inserting the legs (a planner that yields on a step with no
    `yield_as` set simply has that value discarded — documented with a
    one-line comment, not an error, since the leg-building itself still
    succeeded). In the SAME function's `mode === 'single'` branch
    (currently `const definition = stepRowToDefinition(step);`): fetch
    the same pool, build `const resolvedStep = { ...step, payload_json:
    JSON.stringify(resolveYieldRefs(JSON.parse(step.payload_json ??
    "{}"), pool)) };`, then call `stepRowToDefinition(resolvedStep)`
    instead of `stepRowToDefinition(step)`. In `handlePoll`: add a
    `step: CodexCronotonStepRow` parameter (update its one call site
    inside `executeAction`, which already has `step` in scope, to pass it
    through); inside the `landed.result.status === "success"` branch,
    before/alongside the existing `markLegConfirmed(leg.id, { db:
    ctx.db })` call, if `step.mode === "single" && step.yield_as` call
    `upsertYield({ runId: <the run id already in scope>, name:
    step.yield_as, value: landed.result.data, stepIndex: step.step_index
    }, { db: ctx.db })`.

- [x] T6: Apply the same `$yield` resolution to the standalone per-step
      fire/simulate route, always against an empty pool (no run context
      exists for a standalone fire) — done when: `npx vitest run
      src/handlers/steps.test.ts` passes with new tests proving (1) a
      `mode:'planner'` step whose `planner_params_json` contains a
      `{"$yield":"x"}` reference makes both `simulateStep` and `fireStep`
      return a clear, named error response (never silently passing the
      literal placeholder object through to the planner or the chain
      call); (2) a `mode:'single'` step whose `payload_json` contains a
      `{"$yield":"x"}` reference fails the same way; and (3) every
      pre-existing test in this file passes unmodified — no step
      definition without a `$yield` reference changes behavior.
  - files: `packages/khronoton-core/src/handlers/steps.ts`,
    `packages/khronoton-core/src/handlers/steps.test.ts`
  - Implementation: import `resolveYieldRefs`/`YieldNotFoundError` from
    `../server/pure/yields.js` and `normalizePlannerResult` from
    `../server/planners/registry.js` (both already public via the
    `server/index.js` barrel per Wave 1/2). In `resolveStepLegs`'s
    `mode === "single"` branch, wrap in a try/catch:
    `stepRowToDefinition({ ...step, payload_json: JSON.stringify(
    resolveYieldRefs(JSON.parse(step.payload_json ?? "{}"), {})) })`,
    catching `YieldNotFoundError` and returning `{ ok: false }` (matching
    this function's existing `{ok:false}` convention for the
    unregistered-planner case, rather than letting it throw past the
    handler). In the `mode === "planner"` branch, call `resolvePlannerFor
    (step, ctx, {})` (empty pool — explicit, not relying on the default,
    since a standalone fire deliberately has no run to source yields
    from), invoke `resolved.planner(resolved.resolvedStep,
    resolved.plannerCtx)` inside the same try/catch, normalize via
    `normalizePlannerResult`, and return `{ ok: true, legs:
    normalized.legs }` (the standalone route has no run to persist a
    yield into, so `normalized.yield`, if present, is deliberately
    discarded here — documented in a comment, not silently dropped
    without explanation).
