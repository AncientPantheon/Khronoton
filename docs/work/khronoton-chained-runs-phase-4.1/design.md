# Khronoton chained runs — Phase 4.1 (ouronet.aqp-unstall + ouronet.aqp-inject) — Design

Scope: the deferred half of the parent design's Phase 4 item — porting
OuronetUI's "inject" leg-construction logic — split out as its own phase
per Phase 4's own restructuring note (evict needed no splitting algorithm;
inject needs a second substantial port, `measureSplit.ts`, and a
materially different step shape).

## Problem

OuronetUI's `InjectChooser.tsx` tries two single-call entrypoints in
sequence (`CC_InjectFinalize` "pure", `CC_Inject` "inline-repair") via live
gas probes, and **refuses** — telling a human to go run a separate
"Unstale FVT" flow first — when both are too expensive (too many stale
member scores to repair inline). Khronoton's automaton has no human to
hand that refusal to. Per the owner's own correction: it must instead
*parallelize* the stale-score repair itself (fanning the "Unstale FVT"
flow's real mechanism — `CCp_FvtFixSlice`, a parallel-safe, order-
independent batch repair — into N legs), then inject once scores are
clean. "With no stale scores the inject is never above 2 mil" (owner).

Researching the real port target surfaced a second, more fundamental
problem: **the shared driver (`runs-driver.ts`) cannot currently support
a genuine re-plan after a leg failure**, only the "no legs yet" first-entry
case. This has been true since Phase 2/3 but never mattered until now,
because `canReplan` was always `false` for every planner Phase 3/4
actually drove (per Phase 3's own correction: `mode:'single'` steps never
re-plan; `mode:'planner'` steps only gained a real implementation in
Phase 4, and evict's own fan-out never needed a genuine retry in its
tested scope). `ouronet.aqp-unstall` is the first planner whose own
mechanism (fix-slice batches can genuinely fail and need re-probing) makes
this gap concretely reachable, so Phase 4.1 fixes it as a prerequisite.

## Approach

### A. Prerequisite fix — generation-scoped legs, so a re-plan after a failure doesn't deadlock the barrier or collide on `legIndex`

**The gap, precisely:** `handleReplanStep`'s current (Phase 4) planner
branch always inserts new legs at `legIndex: 0..N-1`. This is correct for
a step's first entry (no legs exist yet) but wrong for a genuine re-plan
(`advanceRun`'s steps 4/5/6 → `replanOrFail` → `replan-step`, reachable
whenever `canReplan:true` and a leg has genuinely failed or the barrier
deadline passed) for two reasons:
1. `idx_codex_cronoton_run_legs_slot`'s UNIQUE index on `(run_id,
   step_index, leg_index)` would throw `RunLegAlreadyExistsError` the
   instant a re-plan tries to insert at an already-occupied `legIndex`.
2. Even if that were avoided, the OLD, now-terminal (`failed`) legs from
   the prior attempt would remain in `listRunLegs`'s result forever —
   permanently defeating `advanceRun`'s barrier check
   (`legs.every(l => l.status === 'confirmed')`, pure/run-advance.ts),
   since a `failed` leg never becomes `confirmed`. The step could never
   advance again, for any future attempt, once a single leg ever failed
   once.

**Chosen fix:** use the schema's own, previously-unused
`codex_cronoton_run_legs.attempt` column (confirmed present, confirmed
unwritten by any Phase 1-4 store function) as a **generation marker**.
Each re-plan bumps the run's `attempt` counter and stamps every leg it
inserts with that new value; `driveRunOnce` only ever considers
CURRENT-generation legs for the barrier/submit/poll decision.

1. `store/runs.ts` gains `bumpRunAttempt(runId: string, dep: DbDep): void`
   — `UPDATE codex_cronoton_runs SET attempt = attempt + 1, modified_at =
   ? WHERE id = ?`. (This is the exact function Phase 3's own design
   anticipated and then deliberately cut, correctly, because nothing
   exercised it — see Phase 3's design §G. It's needed now.)
2. `insertRunLeg`'s input gains an optional `attempt?: number` (default
   `0`, preserving every existing Phase 3/4 caller's behavior exactly —
   `mode:'single'`'s one-shot insert and a planner's first-entry insert
   both still write `attempt: 0`, matching the run's own starting
   `attempt` value).
3. `driveRunOnce`'s existing `stepLegs` filter (`listRunLegs(...).filter(l
   => l.step_index === run.step_index)`) gains `&& l.attempt ===
   run.attempt` — the ONLY legs `advanceRun`'s barrier/submit/poll logic
   ever sees are the CURRENT generation's. A prior generation's `failed`
   legs become permanently invisible to the barrier check the moment a
   new generation exists — exactly the semantics needed, and they remain
   in the table as an honest history (`store/runs.ts`'s functions never
   delete a leg row).
4. `handleReplanStep`'s planner branch: before calling the planner, read
   ALL of this step's legs regardless of attempt
   (`listRunLegs(...).filter(l => l.step_index === run.step_index)`, no
   attempt filter — the attempt-filtered `stepLegs` `driveRunOnce` already
   computed is NOT what's needed here). If that list is non-empty (a
   genuine re-plan, not first entry): `bumpRunAttempt(run.id, {db:
   ctx.db})`, then re-read the run to get the new `attempt` value, and
   insert the planner's new legs starting at `legIndex:
   Math.max(...allStepLegs.map(l => l.leg_index)) + 1`, each stamped
   `attempt: newAttempt`. If empty (first entry): unchanged — insert at
   `legIndex: 0..N-1, attempt: run.attempt` (already `0`).

- *Alternative — widen the UNIQUE index to `(run_id, step_index,
  leg_index, attempt)` so `legIndex` can restart at 0 per generation:*
  rejected. Requires a schema migration to an index already shipped in an
  earlier phase of this same feature; the chosen fix needs zero schema
  change and the "ever-incrementing legIndex across generations" property
  is harmless for `parallel` stepMode (the only mode a `canReplan:true`
  planner step ever uses), which doesn't care about legIndex ordering.
- This fix is scoped to the planner branch only. `mode:'single'`'s branch
  is provably unaffected (`canReplan` is always `false` for it, so
  `replanOrFail` never returns `replan-step` for an already-populated
  single-mode step — confirmed in Phase 3's design) and is left verbatim.
- This retroactively makes `ouronet.aqp-evict`'s own re-plan-after-failure
  path (reachable since Phase 4: a fan-out leg fails, the barrier
  resolves with a mixed confirmed/failed set, `replanOrFail` re-asks the
  registered planner) correct for the first time too — Phase 4's own
  review never exercised that path, so this was a real, if narrow,
  latent gap in already-shipped code, not a regression this phase
  introduces.

### B. Porting `measureSplit.ts` — the generic gas-probe-and-pack algorithm

Ported faithfully from `OuroborosNetwork/daimons/OuronetUI/src/lib/
signing/measureSplit.ts` into a new pure module,
`src/server/pure/split-plan.ts`. This is NOT `ouronet.aqp-unstall`-specific
— it's a generic "given N items and a way to probe a candidate batch's
real gas cost, produce the fewest batches that each fit under a ceiling"
algorithm, kept here as its own pure function exactly as the source keeps
it as its own module.

Ported surface (constants and logic verified against the real source,
not re-derived):
- `SplitModel { fixed: number; perItem: number }`, `ProbeOutcome = {ok:
  true; gas: number} | {ok:false; floor: number | null}`,
  `SplitSizing`/`SplitResult<T>` discriminated unions — same shapes as
  the source's own exported types.
- `lineThrough(a, b)` — exact two-point fit, including the `a.n===b.n`
  through-origin special case and the non-positive-slope fallback, both
  ported verbatim (these aren't edge-case paranoia, they're load-bearing:
  the source's own comment explains the through-origin case deliberately
  OVER-states cost, "never under-splits").
- `capacityFor(model, ceiling, margin)` — `room = ceiling*margin -
  model.fixed; room<=0 ? 0 : floor(room/model.perItem)`.
- `evenSplit(items, count)` — batches as EQUAL as possible (first `n %
  count` batches get one extra item), never "full chunks + remainder."
- `measureSize(items, probe, ceiling)` — at most 2 probes: probe 1 item
  (fixed-cost reading), probe `min(n,64)` items (slope reading), fit a
  line, compute capacity. Short-circuits to `fitsInOne:true` if the
  sample call covers the WHOLE selection and it already fit.
- `planFromSizing(items, sizing, probe, ceiling)` — confirmation loop
  (probe the largest batch at the computed capacity; on refusal, shrink
  capacity ×0.75, up to 3 attempts) then a growth loop (secant-refit
  through the one-item reading and the just-confirmed point, re-pack
  tighter with a 0.99 margin, up to 2 attempts, only keeping a growth
  that both reduces the batch COUNT and is itself confirmed under
  ceiling).
- A combined `splitPlan(items, probe, ceiling)` wrapper calling both
  stages straight through with no pause — this is the port of the
  source's own `measureSplit()` wrapper, and the ONLY one Khronoton needs:
  OuronetUI's human-approval pause between sizing and planning
  (`splitGate`/`onApprove`) is explicitly a UI/UX concern layered OUTSIDE
  the two pure functions in the source itself, not inside them — nothing
  here needs porting for a headless automaton with no such pause.
- `onProgress` callbacks and the UI's "give up, submit one giant unmeasured
  batch anyway" fallback are explicitly NOT ported — the former is
  decorative, the latter is a documented-as-risky UI/UX policy choice
  Khronoton's automaton should not inherit (an unmeasured, possibly-
  oversized batch submitted anyway is exactly the class of risk this
  whole algorithm exists to prevent); a `splitPlan` failure propagates as
  a genuine thrown error from the planner, same as evict's own
  genuine-failure path.

**Ceiling source:** the source's `batchGasCeiling()` is a live, synchronous,
node-aware read Khronoton has no equivalent for. **Chosen simplification:**
use `ctx.config?.autoGasCeiling ?? AUTO_GAS_CEILING` (the same static
config-or-constant fallback `executor.ts`'s own `resolveCeiling` falls
back to when no live read is available) — `AUTO_GAS_CEILING` is `2_000_000`,
matching the owner's own stated "never above 2 mil" ballpark for the
clean-state case. A live block-gas-limit read would be more accurate;
this is an explicit, called-out scope reduction for Phase 4.1, not an
oversight — a future phase can thread a live ceiling through if the
static fallback proves too conservative in practice.

**Probe shape:** `(batch: readonly string[]) => Promise<ProbeOutcome>`,
implemented as: build a `CCp_FvtFixSlice` `PlannedLeg` for the batch (env-
data, never string-interpolated into `pactCode` — mirroring evict's own
fix), call `executeCodexTransaction(def, "simulate", ctx)`; `result.ok` →
`{ok:true, gas: result.gasUsed}`; `result.ok===false &&
typeof result.gasUsed === "number"` → `{ok:false, floor: result.gasUsed}`
(the SAME ceiling-refusal signal evict's planner already uses — no new
detection mechanism); any OTHER failure → rethrow, never swallowed into a
`ProbeOutcome`.

### C. `ouronet.aqp-unstall` — fans out `CCp_FvtFixSlice` repair legs

`planner_params_json`: `{ fvtId: string; patronAccount: string;
rewardDptfId: string }` (the exact 4th arg `CCp_FvtFixSlice` needs beyond
`patron`/`fvt-id`/`users`, per `fvtOwnerSpecs.tsx`'s confirmed exec
signature `(patron, fvt-id, reward-dptf-id, users)`).

1. Read `URH_FvtStalePresentUsers(fvtId)` via `executeCodexTransaction(...,
   "simulate", ...)` (same pattern as evict's plan read) → a list of
   stale account-id strings.
2. If empty → return `[]` (step trivially satisfied — the existing Phase
   4 "zero legs means instant advance" mechanism, unchanged).
3. Else → `splitPlan(staleUsers, probe, ceiling)` (§B). A `SplitFailed`
   result rethrows as a genuine error (never silently treated as "nothing
   to do").
4. Return one `PlannedLeg` per batch: `pactCode:
   "(ouronet-ns.AQP-FVT.CCp_FvtFixSlice (read-string \"patron\")
   (read-string \"fvt-id\") (read-string \"reward-dptf-id\") (read-msg
   \"users\"))"`, `payload: { patron, "fvt-id", "reward-dptf-id", users:
   batch }` — `users` (a list) goes through `(read-msg "users")`
   (env-data's generic JSON-value reader, since `read-string`/
   `read-integer` are scalar-only; `addData` already serializes array
   values as-is per `executor.ts`'s `buildTransaction`).

### D. `ouronet.aqp-inject` — the ported binary probe choice, never a refusal

**Correction found during Wave 1's build** (the implementer correctly
refused to guess and stopped rather than invent a value): both
`CC_InjectFinalize` and `CC_Inject` take FIVE arguments, not four —
`(patron:string executor:string fvt-id:string reward-dptf-id:string
amount:decimal)`, confirmed against the real deployed contract source
(`OuroborosNetwork/_onchain/Ouronet/.../03_AQP/05_FVT.pact`'s own
`defun CC_Inject`/`defun CC_InjectFinalize` signatures, not just the UI's
`OpSpec` field lists). `amount` is a genuine custody-transfer value —
`XI_FvtInjectCore`/`XE_FvtInjectCore` debit exactly `amount` tokens from
`patronAccount` into the reward vault. It is NOT derivable from any chain
read and has no sentinel/default ("inject everything" is not a contract
convention) — it must come from the cronoton's own static configuration,
same as `fvtId`/`patronAccount`/`rewardDptfId`.

`planner_params_json`: `{ fvtId: string; patronAccount: string;
rewardDptfId: string; amount: string }` — `amount` is a STRING (not a JS
`number`) specifically to avoid floating-point precision loss when a
decimal value is serialized through JSON/env-data before Pact's own
`read-decimal` interprets it; this mirrors how other parts of this
codebase already treat precision-sensitive decimal-like values as
strings rather than numbers wherever exactness matters. The operator
configuring this step's `plannerParams` is responsible for setting
`amount` to whatever this automated inject run should move each time it
fires — Khronoton has no opinion on what that amount should be, same
posture `mode:'single'` steps already have toward `pactCode`/`payload`.

1. Probe `CC_InjectFinalize` (pure, cheapest, refuses if anything stale).
   `result.ok` → return `[thatLeg]`.
2. Else probe `CC_Inject` (inline repair + distribute). `result.ok` →
   return `[thatLeg]`.
3. Else → **this planner never fans out and never refuses** (unlike
   OuronetUI's `InjectChooser`, which stops here and tells a human to go
   run Unstale FVT). By design, this state should not occur in practice —
   it means staleness reappeared between the preceding
   `ouronet.aqp-unstall` step's barrier clearing and this step's own
   probe (a narrow race, not the common case). Rethrow the genuine error
   (`CC_Inject` simulation failed) rather than inventing speculative
   recovery logic in a part of the algorithm the real source itself never
   needed to handle this way.

### E. Two-step sequencing is a documented convention, not an enforced one

A cronoton wanting "unstall-then-inject" declares TWO static steps:
step N = `mode:'planner', plannerName:'ouronet.aqp-unstall'`; step N+1 =
`mode:'planner', plannerName:'ouronet.aqp-inject'`. The registry has no
concept of "planner X must precede planner Y" — same posture the rest of
this decision-free layer already has (steps.ts's own doc: "no validation
of step sequencing... that's explicitly Phase 2's job," which itself has
no opinion on WHICH planners a cronoton chooses, only on executing
whatever step sequence exists). Getting the order right is the cronoton
author's responsibility, same as getting `pactCode` right for a
`mode:'single'` step always has been.

## Acceptance criteria

- [ ] `bumpRunAttempt` exists and is used; a `canReplan:true` planner step
      whose leg fails, gets re-planned, and whose NEW leg then succeeds,
      correctly reaches `advance-step` — proven against a real in-memory
      DB, not asserted by inspection.
- [ ] The OLD, now-superseded failed leg from a prior attempt is never
      re-submitted and never blocks the barrier for the NEW attempt (the
      `attempt`-filtered `stepLegs` read excludes it).
- [ ] A re-plan never throws `RunLegAlreadyExistsError` — new legs land at
      fresh `legIndex` values continuing from the prior generation's max.
- [ ] `ouronet.aqp-unstall` with zero stale users advances its step
      immediately with no leg ever inserted.
- [ ] `ouronet.aqp-unstall` with a stale-user list that fits one batch
      under the ceiling produces exactly one `CCp_FvtFixSlice` leg.
- [ ] `ouronet.aqp-unstall` with a stale-user list too large for one
      batch produces multiple legs whose batches are as EVEN as possible
      (not front-loaded), each probed to fit under the ceiling.
- [ ] `ouronet.aqp-inject` tries `CC_InjectFinalize` first; on its own
      refusal, tries `CC_Inject`; on THAT refusal too, propagates a real
      error — never fans out, never silently succeeds.
- [ ] Every Pact-code string built by either planner contains zero
      interpolated values — every dynamic value flows through `payload`
      and a `read-string`/`read-integer`/`read-msg` placeholder, mirroring
      evict's own closed injection vector exactly.

## Out of scope

- Any live block-gas-limit read for the splitting ceiling (§B's
  explicitly-called-out simplification) — static config-or-constant only.
- `ouronet.stoa-wrap`/`ouronet.stoa-unwrap` — Phase 4b, unchanged.
- Widening the `codex_cronoton_run_legs` UNIQUE index to include
  `attempt` — not needed given the chosen ever-incrementing-`legIndex`
  design (§A).
- Any change to Phase 2's pure `advanceRun` — the generation-scoping fix
  lives entirely in the driver (`runs-driver.ts`) and store
  (`store/runs.ts`), identical in spirit to how Phase 4's own "zero legs
  means instant advance" interpretation was kept out of the pure function.
