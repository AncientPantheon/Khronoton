# Plan

1. `executor.ts`: new exported `dirtyReadPlan(runtime, chainId, pactCode, payload)` helper +
   `DirtyReadPlanResult` type. Re-export from `server/index.ts` alongside `executeCodexTransaction`.
   Test first (`executor.test.ts`, new describe block): builds an unsigned, zero-signer tx (assert
   the fake builder's `addSigner` is never called), calls `dirtyRead` (never `preflightRead`, even
   when the fake client defines one and the test resembles an AUTO-gas shape), returns `{ok:true,
   data}` on success / `{ok:false, error}` on a failure result.
2. `unstall.ts`: the plan read (`URH_FvtStalePresentUsers`) switches to `dirtyReadPlan`; the write
   leg (`CCp_FvtFixSlice`) moves to `TS02-C3.AQP-FVT|CCp_FvtFixSlice`. Update `unstall.test.ts`'s
   hardcoded expected `pactCode` strings (2 occurrences) to the new form — call-count/shape
   assertions otherwise unchanged. Add one new test: the plan read never calls `preflightRead`
   even when the step's `config_json` has `autoGasLimit: true` (the regression this whole fix
   closes) — confirmed red against the pre-fix code first.
3. `evict.ts`: the plan read (`URHC_BuildEvictPlans`) switches to `dirtyReadPlan`; both write legs
   (`CC_FullEvictRewards`/`CC_EvictSingleReward`) move to `TS02-C3.AQP-EVCT|...`. Same test-update
   + new AUTO-gas-preflight-never-called regression test.
4. `inject.ts`: both write-leg probes (`CC_InjectFinalize`/`CC_Inject`) move to
   `TS02-C3.AQP-FVT|...` — no FIX 2 change (no plan read exists here). Update
   `inject.test.ts`'s hardcoded expected `pactCode` strings.
5. `stoa-wrap.ts`: the balance probe (`coin.get-balance`) switches to `dirtyReadPlan`. No module-
   path change (write leg already on `TS01-C2`, untouched). Update `stoa-wrap.test.ts` + add the
   AUTO-gas-preflight-never-called regression test.
6. `stoa-unwrap.ts`: both probes (`UR_AccountKadena`, `coin.get-balance`) switch to
   `dirtyReadPlan`. No module-path change. Update `stoa-unwrap.test.ts` + regression test.
7. Full suite run twice (stability), `tsc --noEmit`, `npm run build`.
8. Nectar review: dispatch correctness + conventions lenses in parallel (this touches real
   business logic across 5 planner files plus a new executor primitive — a full multi-lens pass is
   proportionate, unlike the smaller UI-only changes earlier this session). Explicitly check: (a)
   the literal `|`-containing function names are correctly embedded in the Pact source strings
   (not accidentally treated as a path separator anywhere), (b) `dirtyReadPlan`'s tx really carries
   zero signers/gas meta in every call site, (c) no call site still reads a plan result off the
   old `.rawResult.data` shape after switching to the new helper's flatter `{data}` shape, (d) the
   split between "plan read -> dirtyReadPlan" and "candidate write leg probe -> stays on
   executeCodexTransaction/simulate" is applied consistently and doesn't conflate the two
   anywhere (inject.ts's two probes are candidate WRITE legs, not plan reads — must stay on
   simulate).
9. Update design.md's acceptance checkmarks, bump version, changelog/README, publish.
