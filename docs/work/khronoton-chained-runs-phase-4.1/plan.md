## Wave 1
- [x] T1: Prerequisite store-layer fix — `bumpRunAttempt`, `touchRunDeadline`,
  and `insertRunLeg`'s generation-scoping `attempt` param — done when:
  `packages/khronoton-core/src/server/store/runs.ts` gains exactly:
  - `export function bumpRunAttempt(runId: string, dep: DbDep): void` —
    `UPDATE codex_cronoton_runs SET attempt = attempt + 1, modified_at = ?
    WHERE id = ?`. Unconditional (no precondition — incrementing is
    commutative regardless of caller ordering), matching the exact
    function Phase 3's own design anticipated and then correctly deferred
    because nothing exercised it yet (see
    `docs/work/khronoton-chained-runs-phase-3/design.md`'s §G).
  - `export function touchRunDeadline(runId: string, deadlineAt: string |
    null, dep: DbDep): void` — `UPDATE codex_cronoton_runs SET deadline_at
    = ?, modified_at = ? WHERE id = ?`. A NEW function, narrower than
    `advanceRunStep`: it touches ONLY `deadline_at`, never `step_index` or
    `attempt`. Needed because `advanceRunStep` (existing) unconditionally
    resets `attempt` to `0` as part of its contract — correct for a real
    step-advance or a step's very first deadline stamp (`attempt` is
    already `0` in both those cases), but WRONG for stamping a fresh
    deadline after `bumpRunAttempt` just incremented `attempt` for a
    genuine re-plan: calling `advanceRunStep` there would silently reset
    the bump back to `0` on every single re-plan, making
    `replanOrFail`'s `attempt < maxReplanAttempts` check permanently true
    and turning `maxReplanAttempts` into dead config (an infinite retry
    loop with no error ever surfacing). `touchRunDeadline` exists
    specifically to avoid this interaction — no optimistic-concurrency
    guard needed (unlike `advanceRunStep`'s `WHERE step_index = ?`): it
    never touches `step_index`, so there is no stale-precondition case to
    guard against.
  - `insertRunLeg`'s input gains an optional `attempt?: number` (default
    `0` when omitted — every existing Phase 3/4 caller's behavior is
    byte-identical, since a run's `attempt` already starts at `0` and
    `mode:'single'`/a step's first `mode:'planner'` entry both insert
    while `run.attempt` is still `0`): the `INSERT` statement's column
    list gains `attempt`, binding `input.attempt ?? 0` as the final
    parameter — `INSERT INTO codex_cronoton_run_legs (id, run_id,
    step_index, leg_index, definition_json, attempt) VALUES (?, ?, ?, ?,
    ?, ?)`.
  `packages/khronoton-core/src/server/store/index.ts` gains
  `bumpRunAttempt, touchRunDeadline` added to the existing `export {
  listInFlightRuns, advanceRunStep, markRunTerminal, ... } from
  "./runs.js"` line (read the file first to find the exact existing
  line and extend it, matching the file's own grouping convention — do
  not invent a new section).
  Tests in `packages/khronoton-core/src/server/store/runs.test.ts`
  (reusing the file's existing `seedCronoton`/real-in-memory-
  `better-sqlite3` pattern): (a) `bumpRunAttempt` increments a run's
  `attempt` from `0` to `1`, and a second call increments it to `2`
  (cumulative, not reset); (b) `touchRunDeadline` updates only
  `deadline_at`/`modified_at`, leaving `step_index`/`attempt` unchanged
  (seed a run with `attempt` already bumped via raw SQL or
  `bumpRunAttempt`, call `touchRunDeadline`, assert `attempt` is still
  whatever it was before the call); (c) `insertRunLeg` called with no
  `attempt` field inserts a row with `attempt: 0` (unchanged default
  behavior — a regression guard for every existing caller); (d)
  `insertRunLeg` called with `attempt: 1` inserts a row with `attempt: 1`,
  and a SECOND `insertRunLeg` call for the SAME `(runId, stepIndex,
  legIndex)` but with `attempt: 2` still throws `RunLegAlreadyExistsError`
  (the unique index has no `attempt` dimension — confirming the design's
  own "legIndex must keep incrementing across generations, attempt alone
  can't disambiguate a slot" rationale, so a future reader doesn't
  mistake `attempt` for something the index already accounts for).
  `npx vitest run store/runs.test.ts` and `npm run typecheck` both pass;
  every pre-existing test in that file passes unmodified.
  - files: `packages/khronoton-core/src/server/store/runs.ts`,
    `packages/khronoton-core/src/server/store/runs.test.ts`,
    `packages/khronoton-core/src/server/store/index.ts`

- [x] T2: Port `measureSplit.ts`'s generic gas-probe-and-pack algorithm —
  done when: new file `packages/khronoton-core/src/server/pure/split-plan.ts`
  exports exactly (ported faithfully from
  `OuroborosNetwork/daimons/OuronetUI/src/lib/signing/measureSplit.ts` —
  read that file IN FULL first, plus its `evenSplit` dependency in
  `node_modules/@ouronet/papyrus/dist/batch.js` lines ~111-124, both in
  that OTHER workspace; do not guess at any formula, quote/copy the exact
  arithmetic):
  - `export interface SplitModel { fixed: number; perItem: number; }`
  - `export type ProbeOutcome = { ok: true; gas: number } | { ok: false;
    floor: number | null };`
  - `export type SplitSizing = { ok: true; fitsInOne: boolean; measuredGas:
    number | null; estimatedTotalGas: number; estimatedTransactions:
    number; model: SplitModel; probes: number; readings: { one: { n:
    number; gas: number }; sample: { n: number; gas: number } }; } | {
    ok: false; reason: string; infeasible?: { singleItemGas: number;
    ceiling: number }; estimatedTotalGas?: number; probes: number; };`
  - `export type SplitResult<T> = { ok: true; batches: T[][]; worstBatchGas:
    number; estimatedTotalGas: number; model: SplitModel; probes: number;
    } | { ok: false; reason: string; infeasible?: { singleItemGas: number;
    ceiling: number }; estimatedTotalGas?: number; probes: number; };`
  - `export function lineThrough(a: {n:number;gas:number}, b:
    {n:number;gas:number}): SplitModel` — exact port: if `a.n === b.n`,
    `{fixed:0, perItem: Math.max(a.gas/Math.max(a.n,1),
    Number.MIN_VALUE)}`; else `slope = (b.gas-a.gas)/(b.n-a.n)`; if
    `!(slope > 0)`, `{fixed:0, perItem: Math.max(Math.max(a.gas/Math.max(a.n,1),
    b.gas/Math.max(b.n,1)), Number.MIN_VALUE)}`; else `{fixed:
    Math.max(0, a.gas - slope*a.n), perItem: slope}`.
  - `export function capacityFor(model: SplitModel, ceiling: number, margin
    = 0.92): number` — `const room = ceiling*margin - model.fixed; return
    room <= 0 ? 0 : Math.floor(room / model.perItem);`.
  - `export function evenSplit<T>(items: readonly T[], count: number):
    T[][]` — exact port of the papyrus `evenSplit` cited above: `batches =
    Math.max(1, Math.min(count, items.length || 1))`; `n===0` → `[[]]`;
    else `base = Math.floor(n/batches)`, `extra = n % batches`, the first
    `extra` batches get `base+1` items, the rest get `base`.
  - `export async function measureSize<T>(items: readonly T[], probe:
    (batch: readonly T[]) => Promise<ProbeOutcome>, ceiling: number):
    Promise<SplitSizing>` — exact port of the source's algorithm (`n===0`
    short-circuit; probe 1 item, fail/infeasible checks; `n===1`
    short-circuit returning a MEASURED not modelled model; probe
    `min(n,64)` items; `lineThrough` the two readings; if the sample
    covered the whole selection and fit, `fitsInOne:true` with the
    MEASURED gas; else `capacityFor` → `capacity<1` fail, else
    `fitsInOne:false` with `estimatedTransactions: Math.max(1,
    Math.ceil(n/capacity))` and `readings` carrying both probes forward).
  - `export async function planFromSizing<T>(items: readonly T[], sizing:
    Extract<SplitSizing, {ok:true}>, probe: (batch: readonly T[]) =>
    Promise<ProbeOutcome>, ceiling: number): Promise<SplitResult<T>>` —
    exact port: confirmation loop (`capacityFor` the model; up to 3
    attempts, each probing the largest batch at the current capacity,
    shrinking capacity ×0.75 — `Math.floor(capacity*0.75)` — on refusal,
    breaking with a "could not confirm" failure if shrinking makes no
    further progress or 3 attempts exhaust) then a growth loop (up to 2
    attempts, each refitting `lineThrough` through the ORIGINAL one-item
    reading and the just-confirmed point, `capacityFor` with margin `0.99`
    not `0.92`, re-packing only if the result has FEWER batches than the
    current best AND the new largest batch also confirms under ceiling,
    otherwise keeping the last confirmed `best` and stopping).
  - `export async function splitPlan<T>(items: readonly T[], probe: (batch:
    readonly T[]) => Promise<ProbeOutcome>, ceiling: number):
    Promise<SplitResult<T>>` — calls `measureSize` then, if
    `sizing.fitsInOne`, returns `{ok:true, batches:[items], worstBatchGas:
    sizing.measuredGas ?? 0, estimatedTotalGas: sizing.estimatedTotalGas,
    model: sizing.model, probes: sizing.probes}` directly (no need to call
    `planFromSizing` at all when everything already fits in one
    measured batch); else calls `planFromSizing(items, sizing, probe,
    ceiling)` and returns its result. This is the ONE function any
    planner actually calls — `measureSize`/`planFromSizing` are exported
    separately only because the ported source itself exports them
    separately (and because splitting them makes each stage
    independently testable), not because any caller in this phase needs
    the two-stage split itself (that two-stage split exists in the source
    ONLY to let a human approve between sizing and planning — explicitly
    not needed for a headless automaton, per design.md §B).
  Deliberately NOT ported: `onProgress` callbacks, the source's own
  "give up and submit one unmeasured giant batch anyway" UI fallback —
  neither exists in this module; a `splitPlan` failure is a plain
  `{ok:false, reason, ...}` return (not a thrown error — the CALLER
  decides whether to throw, matching how `evictPlanner` itself decides
  what to do with a `SimulateResult.ok:false`, not something `split-plan.ts`
  should decide on anyone's behalf).
  Tests in `packages/khronoton-core/src/server/pure/split-plan.test.ts`
  (pure function tests, no DB, no chain client — a hand-written `probe`
  function per test returning canned `ProbeOutcome`s, counting its own
  call count): (a) `splitPlan` with 1 item and a probe returning
  `{ok:true,gas:100}` once → `{ok:true, batches:[[item]], ...}`, probe
  called exactly once; (b) `splitPlan` with 200 items where the
  single-item probe and the 64-sample probe both succeed under ceiling
  AND the sample covers fewer than all 200 items (so `fitsInOne` is
  false) → `measureSize` returns `estimatedTransactions > 1`, and
  `planFromSizing`'s confirmation probe (one more call) succeeds
  immediately → final result has `batches.length >= 2`, batches as EVEN
  as possible (assert via `Math.abs(batches[0].length -
  batches[batches.length-1].length) <= 1`); (c) a confirmation probe
  that refuses once (`{ok:false, floor: X}`) then succeeds on the
  shrunk capacity → still returns `ok:true`, confirms the shrink-and-
  retry loop actually ran (probe called the expected number of
  additional times); (d) a single ITEM whose own probe reports
  `gas > ceiling` → `measureSize` returns `{ok:false, infeasible:
  {singleItemGas, ceiling}}` and `splitPlan` propagates that `ok:false`
  (never throws — confirms the "caller decides" contract); (e)
  `evenSplit([1..10], 3)` → `[[1,2,3,4],[5,6,7],[8,9,10]]` (first `10%3=1`
  batch gets the extra item) — a direct unit test of the ported helper
  matching the source's own documented example shape.
  `npx vitest run pure/split-plan.test.ts` and `npm run typecheck` both
  pass.
  - files: `packages/khronoton-core/src/server/pure/split-plan.ts`,
    `packages/khronoton-core/src/server/pure/split-plan.test.ts`

- [x] T3: `ouronet.aqp-inject` planner — done when: new file
  `packages/khronoton-core/src/server/planners/inject.ts` exports
  `injectPlanner: StepPlanner` and self-registers
  (`registerStepPlanner("ouronet.aqp-inject", injectPlanner)`), mirroring
  `planners/evict.ts`'s exact established shape (read that file in full
  first — same local `parseJson<T>` duplication, same
  `EvictPlannerParams`-style local params interface, same
  `${ctx.runtime.namespace}.AQP-FVT` namespace-prefix construction pattern,
  same env-data-only `pactCode` construction with zero interpolated
  values). `planner_params_json` shape: `{ fvtId: string; patronAccount:
  string; rewardDptfId: string; amount: string }` — **`amount` confirmed
  required** (a Wave-1 build attempt correctly stopped rather than guess
  at this): both `CC_InjectFinalize` and `CC_Inject` take FIVE Pact args,
  `(patron:string executor:string fvt-id:string reward-dptf-id:string
  amount:decimal)`, confirmed against the real deployed contract source
  `OuroborosNetwork/_onchain/Ouronet/1_SOVEREIGN/STAGE_02/2_Core/03_AQP/05_FVT.pact`'s
  own `defun CC_Inject`/`defun CC_InjectFinalize` (around lines 189-197,
  3301-3318, 3536-3567 per the Wave-1 agent's own citation — re-confirm
  these line numbers still match before trusting them, the file may have
  moved). `amount` is real money moved out of `patronAccount`'s custody
  (`XI_FvtInjectCore`/`XE_FvtInjectCore` debit exactly `amount` tokens) —
  it is operator-configured static step data, same as the other three
  fields, NOT derivable from any chain read or defaultable to a sentinel.
  `amount` is typed as a STRING in `planner_params_json` (not a JS
  `number`) specifically to avoid floating-point precision loss before
  Pact's own `read-decimal` interprets it — the UI-level `OpSpec.fields`
  entries in `fvtOwnerSpecs.tsx` (`INJECT_FINALIZE`) and `aqpConsumerSpecs.tsx`
  (`INJECT_FVT`, the real "CC_Inject"/inline-repair entrypoint — it does
  NOT live in `fvtOwnerSpecs.tsx` despite the similar naming, per the
  Wave-1 agent's correction) both declare `amount` as their 5th field of
  kind `decimal`, confirming the field ORDER is `patron, executor,
  fvt-id, reward-dptf-id, amount` for both entrypoints. Re-read both
  files directly to confirm the exact `entrypoint` strings and field
  order before writing any pactCode template — do not trust this plan's
  own paraphrase as a substitute for reading the real source. Algorithm:
  1. Parse `fvtId`/`patronAccount`/`rewardDptfId`/`amount` (all four as
     strings — `amount` need not be numeric-parsed/validated beyond
     `typeof === "string"`, since it flows through env-data to Pact's own
     `read-decimal`, which does its own real validation on-chain), derive
     `executor = k:<signers[0].publicKey>` — identical validation shape to
     `evictPlanner`'s own (throw a clear config-error message, never call
     the chain, if any is missing/wrong-type).
  2. Build a `CC_InjectFinalize` `PlannedLeg` (env-data for every
     dynamic value including `amount` via `(read-decimal "amount")`,
     matching `evictPlanner`'s pattern exactly), simulate it. `result.ok`
     → return `[thatLeg]`.
  3. Else build a `CC_Inject` `PlannedLeg` (same 5 env-data fields),
     simulate it. `result.ok` → return `[thatLeg]`.
  4. Else → **never fans out, never silently succeeds** — rethrow
     `new Error(result.error ?? "CC_Inject simulation failed")`
     regardless of whether `result.gasUsed` is a number or not (unlike
     `evictPlanner`, which fans out on a numeric `gasUsed`; `injectPlanner`
     has no fan-out leg shape to produce at all — a too-expensive `CC_Inject`
     here means staleness reappeared after the preceding
     `ouronet.aqp-unstall` step already ran, a narrow race this planner
     reports as a genuine failure rather than inventing recovery logic
     the real ported source itself never needed).
  Tests in `packages/khronoton-core/src/server/planners/inject.test.ts`
  (mirroring `evict.test.ts`'s exact mock-fixture style — hand-built
  `ChainClient`/`ChainRuntime`/`KeyResolver`, calling `injectPlanner`
  directly, no DB): (a) `CC_InjectFinalize` simulate succeeds → returns
  exactly one leg whose `pactCode` is the exact fully-qualified string
  (`ouronet-ns.AQP-FVT...`, asserted via `toBe`, not `toContain`,
  mirroring evict.test.ts's own tightened assertions) AND whose `payload`
  equals exactly `{ patron, executor, "fvt-id", "reward-dptf-id", amount
  }` with the configured `amount` string present and unmodified (a
  regression guard specifically for the field this task's own Wave-1
  attempt found missing); (b) `CC_InjectFinalize` fails (any reason)
  but `CC_Inject` succeeds → returns exactly one leg whose `pactCode`
  contains `"CC_Inject"` (and NOT `"CC_InjectFinalize"` — assert both);
  (c) BOTH simulate calls fail → `injectPlanner(...)` rejects, and the
  rejection message is NOT swallowed/reinterpreted regardless of whether
  the second failure's `result.gasUsed` happens to be a number (seed a
  test where it IS a number, to prove `injectPlanner` does NOT fan out
  the way `evictPlanner` would); (d) a config error (missing `fvtId`)
  rejects before any simulate call is attempted; (e) a config error
  (missing `amount` specifically) also rejects before any simulate call
  is attempted — a separate case from (d) since this is the field most
  likely to be silently dropped in a future edit.
  `npx vitest run planners/inject.test.ts` and `npm run typecheck` both
  pass. Also: `packages/khronoton-core/src/server/index.ts` gains one new
  line, `export * from "./planners/inject.js";`, placed directly after
  the existing `./planners/evict.js` line (inside the same heading
  comment block Phase 4's T5 added — extend its wording to also mention
  `injectPlanner`, don't duplicate the block).
  - files: `packages/khronoton-core/src/server/planners/inject.ts`,
    `packages/khronoton-core/src/server/planners/inject.test.ts`,
    `packages/khronoton-core/src/server/index.ts`

## Wave 2 (depends on Wave 1)
- [x] T4: Generation-scoped re-plan fix in `runs-driver.ts` — done when:
  `packages/khronoton-core/src/server/runs-driver.ts` imports
  `bumpRunAttempt`, `touchRunDeadline` from `./store/runs.js` (added to
  the existing import line from that module), and:
  1. `driveRunOnce`'s existing `stepLegs` filter —
     `listRunLegs(runId, { db: ctx.db }).filter((l) => l.step_index ===
     run.step_index)` — gains `&& l.attempt === run.attempt`, so
     `advanceRun`'s barrier/submit/poll decisions only ever see the
     CURRENT generation's legs; a prior generation's terminal
     (`failed`) legs become invisible to the barrier check the moment a
     new generation exists, without ever being deleted (they remain in
     the table as history).
  2. `handleReplanStep`'s `mode:'planner'` branch is rewritten to: after
     computing `legs: PlannedLeg[]` from the planner call and the
     existing `legs.length === 0` → `handleAdvanceStep` short-circuit
     (UNCHANGED), read `const allStepLegs = listRunLegs(run.id, { db:
     ctx.db }).filter((l) => l.step_index === run.step_index);` (every
     generation, NOT attempt-filtered — this is deliberately a SEPARATE
     read from `driveRunOnce`'s own attempt-filtered `stepLegs`, since
     this one needs to see every prior generation's `leg_index` values
     too, to compute one that can never collide). Then:
     ```ts
     const isReplan = allStepLegs.length > 0;
     const newAttempt = isReplan ? run.attempt + 1 : run.attempt;
     const startLegIndex = isReplan
       ? Math.max(...allStepLegs.map((l) => l.leg_index)) + 1
       : 0;
     if (isReplan) {
       bumpRunAttempt(run.id, { db: ctx.db });
       touchRunDeadline(run.id, computeStepDeadline(now, ctx), { db: ctx.db });
     }
     legs.forEach((leg, i) => {
       insertRunLeg(
         { runId: run.id, stepIndex: run.step_index, legIndex: startLegIndex + i,
           definitionJson: JSON.stringify(leg), attempt: newAttempt },
         { db: ctx.db },
       );
     });
     if (!isReplan) {
       advanceRunStep(
         run.id,
         { fromStepIndex: run.step_index, toStepIndex: run.step_index, deadlineAt: computeStepDeadline(now, ctx) },
         { db: ctx.db },
       );
     }
     return true;
     ```
     (the first-entry path — `isReplan === false` — is BYTE-IDENTICAL in
     final effect to the current code: `advanceRunStep` stamps the
     deadline and resets `attempt` to `0`, which it already was; the
     replan path uses `bumpRunAttempt` + `touchRunDeadline` INSTEAD of
     `advanceRunStep`, specifically to avoid `advanceRunStep`'s own
     attempt-reset side effect undoing the bump — see T1's rationale).
  3. The `mode:'single'` branch is UNTOUCHED (it never reaches a replan,
     per design.md §A's own confirmation that `canReplan` is always
     `false` for it).
  Tests in `packages/khronoton-core/src/server/runs-driver.test.ts`
  (reusing the file's existing fixtures; register a throwaway test
  planner the same way the file's own `"driveRunOnce — mode:'planner'
  routes through the real registry"` block already does — do NOT use
  the real `ouronet.aqp-evict`/`ouronet.aqp-unstall`/`ouronet.aqp-inject`
  planners for these tests, keeping this task's tests independent of
  T3/T5): add a new `describe("driveRunOnce — generation-scoped re-plan
  after a genuine leg failure", ...)` block with: (a) a
  `canReplan:true`-driving test planner (`mode:'planner'`,
  `maxReplanAttempts: 3`) whose FIRST call returns one leg that then gets
  marked `failed` (via a mocked `submit` success + a mocked `poll`
  landing a failure result), triggering a genuine `replanOrFail` →
  `replan-step`; the planner's SECOND call (a `vi.fn()` spy, call-count
  2) returns a NEW leg that succeeds — assert: the run's `attempt` is now
  `1` (bumped), the OLD failed leg and the NEW leg have DIFFERENT
  `leg_index` values (no `RunLegAlreadyExistsError`), the OLD leg's
  `attempt` is `0` and the NEW leg's `attempt` is `1`, and the run
  eventually reaches `status: "succeeded"` once the new leg confirms
  (proving the barrier correctly cleared despite the old failed leg
  still sitting in the table); (b) the SAME scenario repeated until
  `maxReplanAttempts` is exhausted (e.g. `maxReplanAttempts: 1`, the
  planner's every call produces a leg that fails) — assert the run
  reaches `status: "failed"` (not an infinite loop, not a thrown
  `RunLegAlreadyExistsError`) — this is the test that would have caught
  the `advanceRunStep`-resets-attempt interaction bug T1/T4's design
  explicitly calls out, by proving the run genuinely terminates rather
  than retrying forever.
  `npx vitest run runs-driver.test.ts` and `npm run typecheck` both
  pass; every pre-existing test in the file (including Phase 4's T2/T4
  additions) passes unmodified.
  - files: `packages/khronoton-core/src/server/runs-driver.ts`,
    `packages/khronoton-core/src/server/runs-driver.test.ts`

- [x] T5: `ouronet.aqp-unstall` planner — done when: new file
  `packages/khronoton-core/src/server/planners/unstall.ts` exports
  `unstallPlanner: StepPlanner` and self-registers
  (`registerStepPlanner("ouronet.aqp-unstall", unstallPlanner)`), importing
  `splitPlan`, `type ProbeOutcome` from `../pure/split-plan.js` (T2) and
  otherwise mirroring `planners/evict.ts`'s established shape exactly
  (local `parseJson`, local params interface, `${ctx.runtime.namespace}.
  AQP-FVT` prefix, env-data-only `pactCode`). `planner_params_json` shape:
  `{ fvtId: string; patronAccount: string; rewardDptfId: string }` (same
  three fields `injectPlanner`/T3 uses — confirm `CCp_FvtFixSlice`'s
  exact exec signature `(patron, fvt-id, reward-dptf-id, users)` against
  `OuroborosNetwork/daimons/OuronetUI/src/constants/fvtOwnerSpecs.tsx`'s
  `FVT_FIX_SLICE` `OpSpec.fields` directly before writing the pactCode
  template). Algorithm:
  1. Parse params, derive `executor` — identical validation shape to
     `evictPlanner`/`injectPlanner`.
  2. Read `URH_FvtStalePresentUsers(fvtId)` via a `"simulate"` call
     (same pattern as `evictPlanner`'s plan-read probe) → a list of
     stale account-id strings (`result.rawResult.data` cast to
     `string[]`, with a runtime `Array.isArray` + `every(s => typeof s
     === "string")` check before trusting it — this is a LIVE CHAIN
     READ, same trust posture as `evictPlanner`'s own plan-read
     validation). A failed read rethrows (never "needs splitting" — no
     list to split).
  3. If the list is empty → return `[]` (step trivially satisfied).
  4. Else build the `probe: (batch: readonly string[]) =>
     Promise<ProbeOutcome>` callback required by `splitPlan`: construct
     a `CCp_FvtFixSlice` `PlannedLeg` for the candidate batch (`users`
     passed via `(read-msg "users")`, since it's a list — `read-string`/
     `read-integer` are scalar-only; `payload.users = batch` — an
     ARRAY value, which `executor.ts`'s `buildTransaction` already
     passes through `addData` unchanged regardless of value type), call
     `executeCodexTransaction(def, "simulate", executorCtx)`; `result.ok`
     → `{ok:true, gas: result.gasUsed ?? 0}`; `result.ok===false &&
     typeof result.gasUsed === "number"` → `{ok:false, floor:
     result.gasUsed}`; any OTHER failure → rethrow (never swallowed into
     a `ProbeOutcome` — `splitPlan` itself never calls `probe` in a context
     where a genuine error should be treated as "infeasible," so letting
     it propagate out of the `probe` callback and up through `splitPlan`
     unchanged is correct and requires no special handling in
     `splitPlan` itself).
  5. `const ceiling = ctx.config?.autoGasCeiling ?? AUTO_GAS_CEILING;`
     (import `AUTO_GAS_CEILING` from `../seams.js` — design.md §B's
     explicitly-scoped-down static ceiling, no live block-gas-limit
     read in this phase).
  6. `const result = await splitPlan(staleUsers, probe, ceiling);` — if
     `!result.ok`, rethrow `new Error(result.reason)`.
  7. Return one `PlannedLeg` per batch in `result.batches`, each
     `payload.users` set to that batch.
  Tests in `packages/khronoton-core/src/server/planners/unstall.test.ts`
  (mirroring `evict.test.ts`'s mock style): (a) empty stale-user list →
  `[]`, no further chain calls; (b) a small stale-user list whose probe
  always succeeds under ceiling → exactly ONE leg (confirms `splitPlan`'s
  own `fitsInOne` short-circuit is reached, not just trusted on faith);
  (c) a larger stale-user list whose single-batch probe is refused
  (reports `gasUsed` over ceiling) → MULTIPLE legs, each containing a
  disjoint subset of the original users (assert every user appears in
  exactly one leg's `payload.users`, covering the whole original list —
  this is the test that would catch a `splitPlan`/`evenSplit` porting
  bug that duplicated or dropped an item); (d) a stale-user read that
  fails for a genuine reason → `unstallPlanner(...)` rejects, never
  silently returns `[]`.
  `npx vitest run planners/unstall.test.ts` and `npm run typecheck` both
  pass. Also: `packages/khronoton-core/src/server/index.ts` gains one new
  line, `export * from "./planners/unstall.js";`, in the same heading
  block as T3's addition.
  - files: `packages/khronoton-core/src/server/planners/unstall.ts`,
    `packages/khronoton-core/src/server/planners/unstall.test.ts`,
    `packages/khronoton-core/src/server/index.ts`

## Wave 3 (depends on Wave 2)
- [x] T6: End-to-end proof — the REAL `ouronet.aqp-unstall` planner
  correctly drives through the T4 generation-scoping fix under a genuine
  failure-and-retry, via the REAL `driveRunOnce` — done when:
  `packages/khronoton-core/src/server/runs-driver.test.ts` imports
  `unstallPlanner` from `./planners/unstall.js` (triggering its
  self-registration) and adds a new `describe("driveRunOnce —
  end-to-end: ouronet.aqp-unstall fans out, one batch fails, and the
  REAL planner's re-plan uses a fresh leg generation", ...)` block with
  one test: a 4-user stale list whose `splitPlan` call (via mocked
  `dirtyRead` gas readings) produces 2 batches of 2 users each; the
  FIRST batch's leg is submitted then polled as `failed`; this triggers
  a genuine re-plan through the REAL `unstallPlanner` (not a stand-in),
  which re-reads `URH_FvtStalePresentUsers` (now mocked to report only
  the 2 users from the failed batch, since the other batch already
  landed) and produces exactly 1 new leg for them; that new leg
  succeeds. Assert: the run reaches `step_index` advancing past this
  step (or `status:"succeeded"` if it's the only step), the ORIGINAL
  failed leg and the new leg have different `leg_index` values, and
  `getRun(...).attempt` reflects exactly one bump. `npx vitest run
  runs-driver.test.ts` and `npm run typecheck` both pass; every
  pre-existing test in the file (including T4's two new tests) passes
  unmodified.
  - files: `packages/khronoton-core/src/server/runs-driver.test.ts`
