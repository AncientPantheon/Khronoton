# Khronoton chained runs — Phase 4 (StepPlanner registry + ouronet.aqp-evict) — Design

Scope per the parent design's "Topics" item 3 — **re-scoped after research**, see
"Restructuring" below. This phase builds the `StepPlanner` registry
infrastructure and registers exactly one real, ported planner:
`ouronet.aqp-evict`. The heavier `ouronet.aqp-inject`/`ouronet.aqp-unstall`
pair — which needs a second ported module (a gas-probe-and-pack splitter)
and a genuinely different step shape — is deferred to its own next phase
(Phase 4.1, not yet shaped) rather than bundled in here.

## Restructuring — why this differs from the parent design's framing

The parent design framed Phase 4 as "the `StepPlanner` registry + porting
OuronetUI's inject/evict leg construction," as one undifferentiated unit.
Research into the actual OuronetUI source (a different workspace entirely,
`OuroborosNetwork/daimons/OuronetUI`) found three corrections to that framing:

1. **"Evict" was ambiguous and the wrong file was initially targeted.**
   OuronetUI has two unrelated features that both plausibly match "evict":
   `vacatePlan.ts` (pool-draining, internally called "vacate") and the real
   target — **Evict Rewards** (`EvictSection.tsx`/`evictSpecs.tsx`, paying
   beneficiaries across reward lanes, contract `AQP-EVCT`). The owner's own
   framing ("how many users need to be paid and how many reward lanes there
   are") confirmed the rewards feature, not vacate.
2. **Inject is not a leg-count planner at all, by itself.** OuronetUI's
   `InjectChooser.tsx` is a binary live-probe choice between two single-call
   entrypoints (`CC_InjectFinalize` "pure", `CC_Inject` "inline-repair"),
   with a hard **refuse** when both are too expensive — the human is told to
   go run a separate "Unstale FVT" flow first, then come back. The owner's
   own correction: Khronoton's automaton can't ask a human to do that, so
   its version must *parallelize* the stale-score repair instead of
   refusing. That repair flow (`FvtUnstaleFlow.tsx`) depends on
   `src/lib/signing/measureSplit.ts` — a generic, non-inject-specific
   gas-probe-and-pack algorithm (`measureSize`/`planFromSizing`) that is a
   second substantial module to port, structurally unrelated to evict.
3. **Evict turned out to need no packing algorithm at all** — leg count
   comes directly from a Pact *read* (`URHC_BuildEvictPlans`) that computes
   the plan ON-CHAIN; the client never decides leg count itself. This makes
   evict considerably simpler than inject/unstall, and a much better first
   real planner to validate the registry mechanism against.

Net: Phase 4 (this topic) = registry + evict. A new Phase 4.1 (shaped
separately, after this one ships and is reviewed) = unstall + inject,
including the `measureSplit.ts` port. Phase 4b (the wrap/unwrap built-ins)
and Phases 5/6 are unchanged from the parent design's own numbering.

## Problem

Phase 3's driver throws `PlannerNotRegisteredError` for any `mode:'planner'`
step — by design, since no registry existed yet. A chained cronoton can
declare a planner-mode step today, but nothing can ever actually drive it.
Separately, `advanceRun`'s step 2 ("no legs yet → `replan-step`") assumes
every step needs at least one leg to make progress; evict's real "try one
tx, only fan out on actual refusal" shape needs the planner to sometimes
decide a step can be satisfied with a *single* leg and sometimes with many,
decided fresh each time it's asked — which the existing `handleReplanStep`
(always builds from a static step row via `stepRowToDefinition`) cannot do.

## Approach

### A. The `StepPlanner` registry

**Chosen:** a plain, synchronous-registration module-level `Map<string,
StepPlanner>` in a new file `src/server/planners/registry.ts`, mirroring
the simplicity of this package's other small registries (no DI container,
no async plugin loading — `registerServerResolver`/`resolvers.ts`'s own
existing pattern for the unrelated server-resolver concept is the closest
precedent and is followed directly).

```ts
export interface PlannerCtx {
  runtime: ChainRuntime;
  resolver: KeyResolver;
  config?: Partial<Config>;
}

export interface PlannedLeg {
  pactCode: string;
  config: CodexTxConfig;
  payload: Record<string, unknown>;
  gasPayer: CodexGasPayer;
  signers: CodexSigner[];
}

export type StepPlanner = (
  step: CodexCronotonStepRow,
  ctx: PlannerCtx,
) => Promise<PlannedLeg[]>;

export function registerStepPlanner(name: string, planner: StepPlanner): void;
export function getStepPlanner(name: string): StepPlanner | undefined;
```

- *Alternative — pass the planner the full `RunState`/run id so it can read
  its own run's context_json:* rejected for this phase. `ouronet.aqp-evict`
  needs only the step's own static config (which `fvtId`/pool the step
  targets) plus live chain reads it does itself — it has no need of run-level
  context. Keep the surface minimal; widen it in Phase 4.1 if the unstall
  planner genuinely needs something `step` alone can't carry (it doesn't —
  `fvt-id` is exactly the kind of static per-step config the `step` row
  already carries in its own `config_json`).
- A `PlannedLeg[]` return of **length 0** is a legal, meaningful value (§C) —
  not an error, not "nothing to do yet," but "this step's barrier is
  already met with zero work required."

### B. `runs-driver.ts`'s `handleReplanStep` calls the real registry

**Chosen:** replace the current unconditional
`if (step.mode === "planner") throw new PlannerNotRegisteredError(...)` with:
look up `getStepPlanner(step.planner_name)`; if absent, throw
`PlannerNotRegisteredError` (unchanged — a genuinely unregistered name is
still a hard stop); if present, call it with `(step, { runtime: ctx.runtime,
resolver: ctx.resolver, config: ctx.config })`, then insert one `insertRunLeg`
call per returned `PlannedLeg` at `legIndex = 0..N-1`, `stepIndex:
run.step_index` — exactly the existing insert shape `handleReplanStep`
already uses for `mode:'single'`, just looped instead of singular.

### C. Zero legs from a planner call means "this step is already satisfied"

**Chosen:** if the planner returns `[]`, `handleReplanStep` does NOT call
`insertRunLeg` at all — it calls the same `handleAdvanceStep` logic
`advance-step` actions use (terminal if this was the last step, else
`advanceRunStep` to `stepIndex + 1`), treating an empty plan as an
instantly-cleared barrier.

- *Alternative — have the planner itself be unreachable via `replan-step`
  when "nothing to do," by inventing a seventh `RunAction` kind in Phase 2's
  pure `advanceRun`:* rejected. `advanceRun` is already reviewed, stable,
  and genuinely has no reason to know about this — "zero legs needed" is a
  **planner-specific** outcome of a specific registered planner's own
  decision, not a new category of pure decision logic the whole chained-run
  engine needs to understand. Keeping this interpretation entirely inside
  `handleReplanStep` (which already owns "what does a replan-step action
  concretely DO") is the narrower, correctly-scoped change — Phase 2's pure
  function and its own test suite are untouched.
- This is evict's actual "try `CC_FullEvictRewards` first" case producing
  *one* leg (not zero) — the zero-leg case is for a DIFFERENT, equally real
  scenario this interpretation also has to handle correctly: a pool/FVT with
  literally nothing owed right now (`URHC_BuildEvictPlans` returns an empty
  list). `evict`'s planner returns `[]` in exactly that case, and the step
  must advance immediately, not insert a pointless leg or wait on a barrier
  that can never be satisfied by a leg that was never built.

### D. The `ouronet.aqp-evict` planner itself

Ported from `EvictSection.tsx`/`evictSpecs.tsx`/`fvtChain.ts` (OuronetUI),
per design.md's "must port verbatim" list from the research pass:

1. **Read the plan.** One Pact local read, `(AQP-EVCT.URHC_BuildEvictPlans
   <fvt-id>)` — ported as a new `evictPlans(fvtId)` builder alongside the
   existing `rowToDefinition`-style mappers, called via `ctx.runtime`'s
   existing `dirtyRead`-shaped local-read path (no new seam member needed —
   this is exactly what `ChainClient.dirtyRead` already does). The decoded
   result is `EvictLeg[]` (`{ beneficiary, scoreEntityType, scoreEntityId,
   rewardDptfId, poolId, claimable }`), field-for-field ported from
   `fvtChain.ts`'s own decoder (no on-chain schema exists to typecheck
   against, matching the source's own caveat).
2. **If `legs.length === 0`:** return `[]` (§C handles the rest).
3. **Else, try `CC_FullEvictRewards` as ONE leg first.** Build its
   `PlannedLeg` (no leg-list argument — it re-reads the plan inside its own
   transaction, per the source's own "staleness-proof" design) and
   **simulate** it via `executeCodexTransaction(def, "simulate", ctx)`
   (Phase 0's existing mode, reused exactly as design.md intended it to be
   reusable). If `result.ok`, return `[thatOneLeg]`.
4. **If the simulate failed AND the error looks like a real gas-ceiling
   refusal** — `error.includes("Gas limit") && error.includes("exceeded")`,
   ported VERBATIM from `@ouronet/papyrus`'s `isGasLimitExceededMessage`
   (confirmed to mirror `@stoachain/stoa-core`'s own `createSimulationError`
   classification — the same family Khronoton's own `blockchain/stoachain.ts`
   adapter already depends on, so this check is not a new, invented
   heuristic but the SAME one the shipped chain adapter's errors already
   speak) — **fan out**: return one `PlannedLeg` per `EvictLeg`
   (`CC_EvictSingleReward`, one reward per transaction, per the source's
   "Single" fan-out mode; the deprecated "Multi" mode is never ported, per
   the source's own exclusion of it from `EVICT_RECOMMENDED`).
5. **If the simulate failed for any OTHER reason:** do not swallow it —
   rethrow, so it surfaces as a genuine `replan-step`/driver-level error
   (caught by `advanceInFlightRunsOnce`'s existing per-run isolation,
   logged, `errored`), never silently treated as "needs splitting."

Capability construction for both `CC_FullEvictRewards` and
`CC_EvictSingleReward`: plain `gas-station` `CodexGasPayer`, ordinary `pure`
signers — confirmed by the research pass that neither entrypoint declares
any `nativeCaps` in the source. No scoped capability is attached beyond the
standard `GAS_PAYER` the existing gas-station synthesis already provides
(Phase 0's `effectiveSigners`); this planner needs to do nothing special
here, and per the research's own explicit warning, adding one "to be safe"
would itself be a deviation from the ported behavior, not a safety
improvement.

### E. What's explicitly NOT ported in this phase

- The "construct-then-send, frozen snapshot" batching discipline
  (`EvictRewardsFlow.tsx`) — not needed. Khronoton's planner is already
  called once per `driveRunOnce` pass and its returned legs are inserted
  once; there's no separate "snapshot now, broadcast later" step to
  replicate, since the chained-run engine's own submit-one-at-a-time
  sequencing already prevents the race the snapshot exists to avoid.
- `EVICT_WORST_LEG_GAS`/`EVICT_GAS_BUDGET`/`evictFitsInOne` — explicitly
  NOT ported, per the research's own finding that this is a display-only
  pessimistic bound in the source, never a gate. The real gate is the
  simulate-and-check-the-actual-refusal step (§D.3-4).
- The deprecated `CCp_EvictMultiRewards`/"Multi" mode.

## Acceptance criteria

- [ ] `registerStepPlanner`/`getStepPlanner` exist, and a chained run whose
      current step has `mode: 'planner', plannerName: 'ouronet.aqp-evict'`
      no longer throws `PlannerNotRegisteredError` — it drives through the
      registered planner instead.
- [ ] A step whose `URHC_BuildEvictPlans` read returns zero legs (nothing
      owed) advances immediately with NO leg ever inserted for that step —
      proven via a fixture where the mocked read returns `[]`.
- [ ] A step whose plan is small enough that the simulated
      `CC_FullEvictRewards` call succeeds produces exactly ONE leg (not one
      per beneficiary).
- [ ] A step whose simulated `CC_FullEvictRewards` call fails with a message
      containing both `"Gas limit"` and `"exceeded"` produces exactly one
      `PlannedLeg` per `EvictLeg` the plan read returned (`CC_EvictSingleReward`
      fan-out), proven against a multi-beneficiary fixture.
- [ ] A step whose simulated `CC_FullEvictRewards` call fails for a
      DIFFERENT reason (not gas-shaped) propagates as a real error — the run
      lands in `advanceInFlightRunsOnce`'s `erroredIds`, never silently
      treated as "needs splitting."
- [ ] Every existing `runs-driver.test.ts` test (the `PlannerNotRegisteredError`
      guard test included, now exercised against an UNREGISTERED planner
      name rather than every planner-mode step) passes unmodified for the
      genuinely-unregistered case.

## Out of scope

- `ouronet.aqp-inject`/`ouronet.aqp-unstall` and the `measureSplit.ts` port
  — deferred to Phase 4.1 (not yet shaped).
- `ouronet.stoa-wrap`/`ouronet.stoa-unwrap` — Phase 4b, unchanged from the
  parent design.
- Any change to Phase 2's pure `advanceRun` — §C's "zero legs" handling
  lives entirely in `runs-driver.ts`.
- A generic/pluggable planner-loading mechanism (dynamic imports, external
  packages) — planners are registered by straightforward, synchronous,
  in-process function calls, mirroring `registerServerResolver`'s existing
  precedent exactly.
