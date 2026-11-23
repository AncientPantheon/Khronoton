# `ouronet.aqp-inject` executor fix + distinguishable fan-out-needed error — Design

## Problem

`injectPlanner` (`packages/khronoton-core/src/server/planners/inject.ts`) derives the Pact
`executor` argument it sends to `CC_InjectFinalize`/`CC_Inject` from the step's own first
signer's public key (`` `k:${signers[0].publicKey}` ``). Verified directly against the deployed
Ouronet contracts (`05_FVT.pact`/`04_RPS.pact`): the reward debit this `executor` names bottoms
out in `XI_FvtInjectCore`'s `(ref-TFT::C_Transfer patron injector AQP|SC_NAME reward-dptf-id
amount true)`, a DPTF (True-Fungible) transfer whose balances are keyed by `(token-id, Ouronet
glyph account)`. A `k:` native account has no DPTF balance row for any token, so every real
inject this planner drives reverts — the planner has never actually been able to move a reward.
`patron` is validated for existence only (`UEV_EnforceAccountExists`) and carries the IGNIS fee;
it holds nothing, so fixing `executor` alone (not `patron`) closes the gap.

Separately, when `CC_InjectFinalize` fails (stale stakers present) and the heavier `CC_Inject`
fallback is *also* refused specifically for being too expensive to mine, the planner currently
just rethrows — with no way for a caller to tell "this vault simply has too much staleness for
one transaction" apart from any other genuine failure. A caller that *can* react (by inserting an
`ouronet.aqp-unstall` step before this one in the chain — the mechanism `05_FVT.pact`'s own
`CCp_FvtFixSlice`/`splitPlan` already exist for, and this module's own doc comment already assumes
as the intended precondition) has no clean signal to react to.

## Approach

**Executor fix.** Add a required `executor: string` field to `InjectPlannerParams`, validated
non-empty and rejected if `k:`-prefixed (the exact bug class being fixed) — not a full
glyph-account-format check, matching every sibling planner's existing "validate shape, trust the
contract for anything beyond that" posture (there is no established glyph-regex anywhere in this
codebase to reuse, and inventing one risks being wrong about the real charset). `signers[0]`
stays required (a step with zero signers can never build or sign any leg at all — same posture
`unstallPlanner` already takes even though `CCp_FvtFixSlice` itself takes no executor arg) but is
no longer the source of the `executor` payload value. The `(read-string "executor")` payload
value is sourced from `params.executor` directly. The stale doc comment line attributing the
debited custody to `patron` is corrected to name `executor`.

**Fan-out-needed signal, not same-step fan-out (Approach 1 from the discussion with the user, who
approved it explicitly over the two alternatives considered).** `evictPlanner`'s fan-out shape
does not transfer to inject: `URHC_BuildEvictPlans` hands back a precomputed array of
*independent* legs (safe to submit in parallel, one per beneficiary), but `CC_Inject`'s cost is
driven by an inline stale-user-fix loop that runs *inside one atomic transaction* — there is no
on-chain entrypoint that splits `CC_Inject` itself into N independent legs. The real splitting
primitive, `CCp_FvtFixSlice`, is already used by `ouronet.aqp-unstall`; but this package's chained
run engine submits every leg of a `mode:'planner'` step in parallel with no serial-then-parallel
mixing within one step (`run-advance.ts:647` maps every `'planner'` step to `stepMode: 'parallel'`
unconditionally), so a single `injectPlanner` invocation cannot safely return "N fix-slice legs,
then one finalize leg" — the finalize would race the fix-slices and revert against stale state
that has not yet landed. Alternatives considered and rejected:

- *Do the fix-slice fan-out inside this step anyway* (silently turning the chain's configured
  "inject" step into a "fix-only" pass with no guarantee anything later retries the actual
  inject) — rejected: hides what actually happened on-chain from the step's own configured
  intent.
- *Add a "re-invoke this same step again next pass" mechanism* to `run-advance.ts`/
  `runs-driver.ts` so the planner can fix-slice this round and finalize next round — rejected as
  out of scope for this topic: genuine new cross-cutting engine surface in the same core that has
  taken multiple CRITICAL findings across past review rounds, deserving its own project-scale
  topic if ever pursued.

Instead: when `CC_InjectFinalize` fails and `CC_Inject` is *also* refused specifically for being
too expensive (a numeric `gasUsed` on an `{ok:false}` simulate result — the executor's existing
refuse-unmineable signal, the same one `evictPlanner` reads), throw a new, distinguishable typed
error (`InjectRequiresUnstallError`, living in `planners/inject.ts` next to the planner that
throws it, mirroring `runs-driver.ts`'s `PlannerNotRegisteredError`/`pure/yields.ts`'s
`YieldNotFoundError` precedent for a typed error living beside its throw site rather than in the
shared `store/errors.ts`) instead of a generic `Error`, publicly exported via the existing
`export * from "./planners/inject.js"` barrel in `server/index.ts`. Any OTHER second-failure
reason (non-gas) still throws the existing generic error, unchanged — mirroring `evictPlanner`'s
own "only a specifically-gas-refused failure gets special treatment" discipline.

## Acceptance criteria

- [x] `InjectPlannerParams` requires `executor: string`; a step whose
      `planner_params_json.executor` is missing, non-string, empty, or `k:`-prefixed is rejected
      before any chain call, naming the problem in the thrown error's message.
- [x] A step with a valid glyph `executor` and the pre-existing `fvtId`/`patronAccount`/
      `rewardDptfId`/`amount` fields produces a `CC_InjectFinalize` (or `CC_Inject` fallback) leg
      whose `payload.executor` is exactly `params.executor` — never a derived `k:<signer pubkey>`
      value.
- [x] `signers[0]` is still required (zero signers still rejects before any chain call) but no
      longer contributes to the `executor` payload value.
- [x] The module's doc comment no longer claims `patron`'s custody is debited; it names `executor`.
- [x] When `CC_InjectFinalize` fails and `CC_Inject` is also refused specifically for exceeding
      the gas ceiling (numeric `gasUsed` on an `{ok:false}` result), the planner throws
      `InjectRequiresUnstallError` (not a generic `Error`), distinguishable via `instanceof`, with
      a message pointing the caller at inserting an `ouronet.aqp-unstall` step first.
- [x] When `CC_InjectFinalize` fails and `CC_Inject` fails for any OTHER reason (no numeric
      `gasUsed`), the planner still throws a plain `Error` carrying the real failure reason —
      `InjectRequiresUnstallError` is never thrown for a non-gas failure.
- [x] `InjectRequiresUnstallError` is publicly exported from `@ancientpantheon/khronoton-core/server`
      (via the existing `planners/inject.js` barrel re-export), matching the established
      "every typed error this package throws is public" convention.

## Out of scope

- Any same-step fan-out inside `injectPlanner` itself (Approaches 2/3 from the discussion) —
  rejected per the Approach section above.
- Any change to `run-advance.ts`/`runs-driver.ts`'s per-step serial/parallel leg-submission model.
- Any change to `evictPlanner`/`unstallPlanner`/`stoa-wrap`/`stoa-unwrap` — this topic touches only
  `planners/inject.ts` and its test file.
- Validating that `executor`/`patronAccount` are well-formed, *registered* Ouronet glyph accounts
  beyond non-empty + not-`k:`-prefixed — the contract itself enforces the rest, matching every
  sibling planner's existing "trust the contract beyond shape" posture.
