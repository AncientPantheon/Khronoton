# AQP planners: route through Talos + stop paying gas for pure reads — Design

Handoff (hub, measured on a live 13-step dry run, `OuroMinterStageTwoV2`, signed `/local` true
mode): all five `ouronet.aqp-unstall` steps failed with `"Failed to buy gas: Payable Modules /
form count not satisfied"`, while every hand-written `ouronet-ns.DSP`/`ouronet-ns.TS*` step in the
SAME run passed. Two independent, stacked bugs, both confirmed by reading the actual code (not
assumed from the handoff alone):

## Gate 1 — not a payable module

`ouronet-ns.DALOS.GAS_PAYER` whitelists a single-form exec by prefix: `"(coin.C_"`,
`"(ouronet-ns.TS"`, `"(ouronet-ns.DSP"`, `"(ouronet-ns.STOAICO."`. `unstall.ts`/`inject.ts`'s
`${ns}.AQP-FVT.*` and `evict.ts`'s `${ns}.AQP-EVCT.*` write legs match none of these — Talos
(`TS02-C3`) is the only client-reachable path into the core `AQP-FVT`/`AQP-EVCT` entrypoints;
OuronetUI's own `fvtOwnerSpecs.tsx:328` already routes through
`"TS02-C3.AQP-FVT|CCp_FvtFixSlice"`. `stoa-wrap.ts`/`stoa-unwrap.ts` are unaffected for their own
WRITE legs — both already route through `TS01-C2`, confirmed by reading them — so Gate 1 only
blocks the three planners that call `AQP-FVT`/`AQP-EVCT` directly: `unstall.ts`, `inject.ts`,
`evict.ts`.

**Fix 1: route every write leg in these three planners through `TS02-C3`, keeping the exact same
argument order.** The member name's `|` is part of the literal function name, not a namespace
separator — `AQP-FVT|CCp_FvtFixSlice` is one identifier on the `TS02-C3` module, not
`AQP-FVT.CCp_FvtFixSlice` qualified access:

| File | Old call | New call |
|---|---|---|
| `unstall.ts` | `(${ns}.AQP-FVT.CCp_FvtFixSlice patron fvt-id reward-dptf-id users)` | `(${ns}.TS02-C3.AQP-FVT\|CCp_FvtFixSlice patron fvt-id reward-dptf-id users)` |
| `inject.ts` | `(${ns}.AQP-FVT.CC_Inject ...)` / `CC_InjectFinalize` | `(${ns}.TS02-C3.AQP-FVT\|CC_Inject ...)` / `AQP-FVT\|CC_InjectFinalize` |
| `evict.ts` | `(${ns}.AQP-EVCT.CC_FullEvictRewards ...)` / `CC_EvictSingleReward` | `(${ns}.TS02-C3.AQP-EVCT\|CC_FullEvictRewards ...)` / `AQP-EVCT\|CC_EvictSingleReward` |

The PLAN READS (`URH_FvtStalePresentUsers`, `URHC_BuildEvictPlans`) stay on `AQP-FVT`/`AQP-EVCT`
directly — Talos exposes client WRITE entrypoints only, by design; there is no reader to route a
read through, and the handoff explicitly asks not to invent one.

## Gate 2 — inter-module call gate

Core `CCp_FvtFixSlice`/`CC_Inject`/`CC_InjectFinalize`/the `AQP-EVCT` entrypoints open with
`(P|UEV_IMC)` — a contract-level check requiring a CALLING MODULE, which a direct `exec` has none
of. This is enforced by the CONTRACT itself, independent of gas — fixed by the exact same Fix 1
above (routing through `TS02-C3`, a real calling module), nothing additional needed.

## The read-only bug (separate, and the one that actually blocks today)

Gates 1/2 explain why the WRITE leg fails. But the handoff's measured proof — three of the five
failing vaults have ZERO stale users, and a zero-stale vault returns `[]` BEFORE ever building a
write leg, yet still failed — proves the PLAN READ itself fails first, before Fix 1 is even
reached. Confirmed by reading `executor.ts`'s `runSimulate` (the one path EVERY planner's
`executeCodexTransaction(leg, "simulate", ctx)` call goes through): under `autoGasLimit: true`
(the step's own AUTO-gas config, inherited verbatim by every plan-read call today), it calls
`client.preflightRead(tx)`, never `client.dirtyRead`. Kadena's `/local` preflight mode runs the
FULL submission pipeline, including the coin contract's `buy-gas`/`redeem-gas` — which is exactly
where `GAS_PAYER`'s whitelist (Gate 1) is enforced — even though nothing is actually being
submitted. A plain `dirtyRead` never runs `buy-gas`/`redeem-gas` at all (confirmed: `tx-size.ts`'s
`estimateTxSize` already builds and uses a transaction with zero signers for an unrelated purpose,
proving the SDK's builder supports a bare unsigned command with no gas-payer baggage at all), so a
read built and executed that way can never hit Gate 1, regardless of AUTO/MANUAL gas.

This is NOT limited to the three Talos-routing planners — reading the actual code found it affects
**every plan read across all four built-in planners that have one**:
`unstall.ts`'s `URH_FvtStalePresentUsers`, `evict.ts`'s `URHC_BuildEvictPlans`,
`stoa-wrap.ts`'s `coin.get-balance` balance probe (its own module doc comment already SAYS "a
`dirtyRead` simulate, never a signed tx" — the code just never actually did that), and
`stoa-unwrap.ts`'s `UR_AccountKadena` + `coin.get-balance` existence probe. `inject.ts` has no plan
read at all (it simulates its two candidate WRITE legs directly to decide which one to submit —
those correctly stay on `executeCodexTransaction`/preflight, since they ARE real future
transactions that genuinely need gas-sponsorship measurement, not pure reads).

**Fix 2: every plan read goes through a new `dirtyReadPlan` helper (`executor.ts`) — a direct,
unsigned, zero-signer `ChainRuntime.dirtyRead` call, never `executeCodexTransaction`.** It builds
the bare minimum transaction (`Pact.builder.execution(code).setMeta({chainId}).setNetworkId(...)`
+ an `addData` loop over the payload — no signer, no gas meta, no gas payer) and reads it via
`runtime.createClient(runtime.getPactUrl(chainId)).dirtyRead(tx)` directly. A read needs no
sponsorship and should never consult the gas station, exactly as the handoff states — switching a
step to MANUAL gas does NOT fix this (a MANUAL-gas step's read already happened to land on
`dirtyRead` today, by accident of `runSimulate`'s own AUTO/MANUAL branch, which is exactly why this
bug was invisible under this package's own MANUAL-gas-fixtured unit tests), but does nothing for
the Gate 1/2 write-leg failure either.

## Explicitly not solved here

- Talos reader for the plan-read entrypoints — the handoff explicitly asks not to invent one.
- The separate `$read` planner-param request (`docs/work/inject-fanout/HANDOFF.md`) — unrelated
  and unchanged.

## Acceptance criteria

1. ✅ `unstall.ts`/`inject.ts`/`evict.ts`'s write legs route through `TS02-C3` with the
   `<module>|<entrypoint>` literal function name, identical argument order to before.
2. ✅ `unstall.ts`/`evict.ts`/`stoa-wrap.ts`/`stoa-unwrap.ts`'s plan reads execute via the new
   `dirtyReadPlan` helper — unsigned, zero-signer, no gas meta, never `preflightRead`-eligible —
   regardless of the step's own `autoGasLimit` setting. Each has a dedicated regression test
   proving `preflightRead` is never called even with `autoGasLimit: true`.
3. ✅ `inject.ts` is unchanged for FIX 2 (it has no plan read); its two write-leg probes are
   rerouted per FIX 1.
4. ✅ Every existing planner test passes with its own assertions intact (call counts, returned leg
   shapes) — only each file's own hardcoded expected `pactCode` strings (and one real-planner
   end-to-end sign-count, which genuinely dropped by one since the plan read no longer signs at
   all) changed, since that's the literal thing being fixed.
5. ✅ Full suite green (1650/1650, stable across repeat runs), `tsc`/build clean.

## Findings from the nectar review

Full correctness + conventions lens dispatch (proportionate to real business-logic changes across
5 planner files plus a new executor primitive, unlike the smaller UI-only changes earlier this
session). Correctness: no findings — directly verified every write-leg pactCode string's module
prefix/member-name/argument order, confirmed the plan reads in `unstall.ts`/`evict.ts` genuinely
stayed on the core module (never accidentally moved to `TS02-C3`), confirmed `dirtyReadPlan` builds
a genuinely zero-signer unsigned transaction at all 5 call sites, confirmed `inject.ts` has no
`dirtyReadPlan` usage at all, confirmed no dead `executorCtx`/unused imports were left behind in
`stoa-wrap.ts`/`stoa-unwrap.ts`, and confirmed every "never calls preflightRead" regression test
genuinely exercises `autoGasLimit: true` (not a vacuous MANUAL-gas copy).

Conventions: 2 MEDIUM — `evict.test.ts` and `inject.test.ts` each had a leftover comment directly
above their updated `pactCode` assertion that still described the OLD, pre-fix call target ("The
FULL namespaced pact code — `ouronet-ns.AQP-EVCT`/`AQP-FVT`... never a bare/hardcoded reference"),
even though the asserted string two lines below had already been updated to the new Talos-routed
form. Both predated the Talos-routing fix and were never touched when the call target changed —
exactly the "stale comment actively misleads the next reader" failure mode this codebase's own
documentation culture treats as worse than no comment at all. Fixed: both rewritten to describe
the actual Talos-routed form being asserted.
