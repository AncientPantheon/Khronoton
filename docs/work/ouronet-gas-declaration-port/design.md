# Port OuronetUI's closed-form gas-declaration model into Khronoton — Design

## Problem

Khronoton computes three gas-ceiling decisions using hand-set constants/fractions that OuronetUI
has already proven go stale and waste real gas once the model underneath them changes:

1. **AUTO-gas calibration** (`executor.ts`'s `submitTransaction`) calls `runtime.calculateAutoGasLimit(gasUsed)`
   — wired straight through to `@stoachain/stoa-core/gas`'s OLD nine-band multiplier ladder
   (confirmed still current in the latest published `stoa-core@4.5.0` — nothing newer exists to pick
   up via a dependency bump). OuronetUI replaced this ladder (commits `99df0c7d`/`78f9a24d`,
   2026-11-03/04) with a measured, closed-form model (`src/lib/gas/declareGasLimit.ts`) that is
   demonstrably tighter and based on 30 real mined transactions, not guessed multipliers. That new
   model is NOT in any published package yet — its own header states the shared-package promotion
   is a stated future plan, not done — so there is nothing to "capture" from upstream today; it has
   to be ported directly, the same way `pure/split-plan.ts` was already ported from OuronetUI's
   `measureSplit.ts` once before.
2. **The single-tx-first gas guard** (`server/seams.ts`'s `SINGLE_TX_GAS_GUARD = 1_600_000`,
   consumed by `resolvers.ts`'s `fireWithServerResolver`) is a hand-set constant of the exact kind
   OuronetUI's own `BATCH_SAFETY_BUFFER = 50_000` was, before OuronetUI replaced it with a value
   *derived* from the declaration formula (`maxSimulatedGasAtLimit`). At a 2,000,000 ceiling,
   Khronoton's hand-set guard leaves ~400,000 gas (20% of the ceiling) unused on every single-tx
   attempt — refusing/falling back to the chain for transactions that would actually fit.
3. **The fan-out planners' batch-sizing margins** (`pure/split-plan.ts`'s `PLANNING_MARGIN = 0.92`/
   `CONFIRMED_MARGIN = 0.99`) are Khronoton's own earlier port of OuronetUI's *older* `measureSplit.ts`
   (done at Phase 4.1, before this rework existed) — the same flat-fraction-of-the-whole-ceiling
   problem the new model's `maxSimulatedGasFor`/`maxSimulatedGasAtLimit` were built to replace.

## Approach

Port OuronetUI's real algorithm directly into a new pure Khronoton module, then rewire all three
consumers above to use it — not a partial/shortcut version of any of the three.

**New module: `packages/khronoton-core/src/server/pure/gas-declaration.ts`.** Ports, verbatim in
formula (condensed doc commentary, full attribution to the source), from
`OuroborosNetwork/daimons/OuronetUI/src/lib/gas/declareGasLimit.ts` and `src/lib/gas-limits.ts`:

- `estimateSizeChargeGas(payloadBytes, ed25519Signers, webauthnSigners = 0)` — the chain-level size
  charge formula (`0.01*bytes + (0.01*bytes/512)^7 + 21*ed25519 + 526*webauthn`, ceil'd). Pure
  arithmetic, no app dependency — confirmed by reading `gas-limits.ts` directly. Khronoton has no
  WebAuthn/passkey signer concept (server-side automation, not a browser), so every Khronoton call
  site always passes `webauthnSigners: 0` — the parameter stays, for fidelity to the real formula,
  but is never non-zero here.
- `declareGasLimit(input)` — the core formula: below `EVIDENCE_FLOOR` (20,000) defers to the
  existing `calculateAutoGasLimit` (still imported from `@stoachain/stoa-core/gas` — the ladder
  stays authoritative exactly where OuronetUI's own evidence says it should); at or above it,
  `gasLimit = min(max(MIN_DECLARED_GAS, simulatedGas + sizeCharge + FIXED_OVERHEAD + drift), ceiling)`,
  `drift = max(DRIFT_FLOOR, ceil(simulatedGas * DRIFT_FRACTION))`, with `FIXED_OVERHEAD=150`,
  `DRIFT_FRACTION=0.005`, `DRIFT_FLOOR=1_000`, `MIN_DECLARED_GAS=1_000`, `SIG_BYTES=128` ported
  verbatim (StoaChain/Kadena-chain-measured constants, which fits — `blockchain/stoachain.ts` is
  already the StoaChain-specific adapter boundary this kind of chain-measured number belongs
  behind, same posture `AUTO_GAS_CEILING`/`SINGLE_TX_GAS_GUARD` already take).
- `declaredGasFor(simulatedGas, ceiling)` — the simple `(number) => number` shape, ported for
  completeness/fidelity to the real algorithm even though no current Khronoton call site needs it
  (every Khronoton AUTO-gas call site, once resequenced below, has real byte/signer data available,
  so it always calls the fuller `declareGasLimit` directly rather than the byte-blind shortcut).
- `maxSimulatedGasAtLimit(ceiling)` = `ceiling - SIZE_ALLOWANCE(500) - FIXED_OVERHEAD(150)` — the
  derived "already-measured single transaction" ceiling.
- `maxSimulatedGasFor(ceiling)` — the derived "batch size solved from an extrapolated model"
  ceiling (reserves the full drift fraction), ported verbatim including its own two-branch
  floor/fraction logic.

**Consumer 1 — `executor.ts`'s AUTO-gas path, resequenced to match OuronetUI's actual call order,
not just its formula.** Read both codebases' real call sequences this session: OuronetUI previews
UNSIGNED (`buildTransaction` → `local(unsigned, {preflight:true, signatureVerification:false})` →
calibrate → rebuild → SIGN once, only after calibrating). Khronoton's CURRENT code signs TWICE
(signs once to get something to preflight, preflights the SIGNED artifact, calibrates, rebuilds,
signs AGAIN for the real submission) — `preflightRead(signed)`, not `preflightRead(tx)`. This
matters for correctness, not just style: `declareGasLimit`'s `simIncludesSize`+signature-byte-delta
correction is specifically derived against a reading of the UNSIGNED command (OuronetUI's own doc:
"`/local` carries EMPTY signature strings" — true of an unsigned preview, not asserted as a
universal node behavior regardless of what's actually sent). Preflighting Khronoton's
already-fully-signed artifact instead would make the "is the signature byte cost already counted or
not" question genuinely ambiguous — not something to guess at. Resolving it by matching OuronetUI's
own sequencing removes the ambiguity entirely (same input shape → same, already-measured-correct
formula applies unchanged) and, as a side effect, removes Khronoton's redundant first signing:

1. Build UNSIGNED at the resolved ceiling (`autoGasLimit ? ceiling : undefined`) — unchanged.
2. `preflightRead(tx)` on the **unsigned** build (was: sign first, then `preflightRead(signed)`).
3. Refuse-unmineable check — unchanged (`gasUsed > ceiling`).
4. Calibrate via `declareGasLimit({ simulatedGas: gasUsed, simIncludesSize: true, cmdBytes:
   Buffer.byteLength(tx.cmd, "utf8"), ed25519Signers: signers.length, ceiling }).gasLimit` instead
   of `runtime.calculateAutoGasLimit(gasUsed)`.
5. Rebuild at the calibrated limit, **sign once** (was: sign a second time on top of the first).
6. Derive request key / submit — unchanged.

The MANUAL-gas path (`dirtyRead` on the signed tx, no calibration) is untouched entirely — this
whole model is AUTO-gas-specific, exactly as it is in OuronetUI.

**Consumer 2 — `resolvers.ts`'s `fireWithServerResolver` single-tx safety guard.** Replace the
`opts.config?.singleTxGasGuard ?? SINGLE_TX_GAS_GUARD` fallback with `opts.config?.singleTxGasGuard
?? maxSimulatedGasAtLimit(ceiling)`, resolving `ceiling` the same way `executor.ts` already does
(reusing `resolveCeiling`'s existing live-fetch-with-fallback logic — exported or lifted to a shared
call, confirmed during planning). `config.singleTxGasGuard` stays as an explicit override seam (same
pattern `config.autoGasCeiling` already uses to override the live ceiling fetch) — nothing removed,
only the no-override DEFAULT changes from a hand-set constant to a derived one.

**Consumer 3 — `pure/split-plan.ts`'s `capacityFor`.** Replace the flat-fraction-of-ceiling room
computation with the same derived-headroom principle: the extrapolated-model case
(`PLANNING_MARGIN`'s current role) uses `maxSimulatedGasFor(ceiling)` as the room ceiling instead of
`ceiling * 0.92`; the confirmed-at-this-size case (`CONFIRMED_MARGIN`'s current role) uses
`maxSimulatedGasAtLimit(ceiling)` instead of `ceiling * 0.99`. `capacityFor`'s call sites (both
inside `split-plan.ts` itself — no external callers exist outside this module, confirmed by this
session's own read of the file) are updated to the new shape; `PLANNING_MARGIN`/`CONFIRMED_MARGIN`
are removed, not left dead.

**Alternatives considered and rejected** (per the earlier discussion — restated here since the
design doc is the permanent record): scoping this to only the single-tx-guard swap (rejected — the
user explicitly wants the full algorithm, not a subset); treating `declaredGasFor`'s byte-blind
shortcut as a safe drop-in for `calculateAutoGasLimit` without resequencing (rejected — would
double-count or omit the signature-byte term depending on what the chain's preflight endpoint
actually does with an already-signed request body, which isn't knowable from either codebase's
client-side source alone; resequencing to match OuronetUI's own unsigned-preview pattern removes the
ambiguity instead of guessing through it).

## Acceptance criteria

- [x] `pure/gas-declaration.ts` exports `estimateSizeChargeGas`, `declareGasLimit`, `declaredGasFor`,
      `maxSimulatedGasAtLimit`, `maxSimulatedGasFor`, and the six named constants
      (`SIG_BYTES`/`MIN_DECLARED_GAS`/`EVIDENCE_FLOOR`/`FIXED_OVERHEAD`/`DRIFT_FRACTION`/`DRIFT_FLOOR`/`SIZE_ALLOWANCE`),
      each producing byte-identical results to OuronetUI's own module for the same inputs (pinned by
      tests ported from OuronetUI's own `declareGasLimit`/`gas-limits` test fixtures where they
      exist, plus the worked examples in `declareGasLimit.ts`'s own header table).
- [x] An AUTO-gas fire's `preflightRead` call receives the **unsigned** built transaction, not an
      already-signed one — provable by a test asserting `preflightRead` is called before
      `universalSignTransaction` for an AUTO-gas fire (order, not just call count).
- [x] An AUTO-gas fire signs **exactly once**, not twice — provable by asserting
      `universalSignTransaction`'s call count for a successful AUTO-gas fire.
- [x] An AUTO-gas fire's final declared `gasLimit` (the value baked into the signed+submitted
      transaction's `meta.gasLimit`) comes from `declareGasLimit`, not `calculateAutoGasLimit` —
      provable by a case where the two formulas would disagree (a simulated gas figure at or above
      `EVIDENCE_FLOOR`) and asserting the submitted `gasLimit` matches the new formula's output.
  - [ ] Below `EVIDENCE_FLOOR`, the AUTO-gas fire's declared limit is byte-identical to today's
      `calculateAutoGasLimit` output (the ladder stays authoritative down there, unchanged).
- [x] A MANUAL-gas fire's behavior (no preflight resequencing, no calibration, `dirtyRead` as today)
      is byte-identical before and after this change — proven by the existing manual-gas test suite
      passing unmodified.
- [x] `fireWithServerResolver`'s single-tx guard, with no `config.singleTxGasGuard` override set,
      refuses a simulate whose `gasUsed` exceeds `maxSimulatedGasAtLimit(ceiling)` — not the old
      hand-set `1_600_000` — and fires one that fits under the new, higher derived threshold.
- [x] An explicit `config.singleTxGasGuard` override still takes priority over the derived default,
      unchanged behavior for any caller already relying on it.
- [x] `pure/split-plan.ts`'s batch-capacity decisions use `maxSimulatedGasFor`/`maxSimulatedGasAtLimit`
      in place of `PLANNING_MARGIN`/`CONFIRMED_MARGIN`; both constants are removed from the file, not
      left unused.
- [x] Every existing `evict`/`unstall`/single-tx-first/executor test continues to pass (or is
      updated where its fixture specifically measured the OLD constants' exact numeric output, in
      which case the updated expectation is the NEW formula's output, not a loosened assertion).

## Out of scope

- Changing `@stoachain/stoa-core`, or waiting for/depending on its eventual promotion of this model
  upstream — this topic ports the logic directly into Khronoton now; if/when stoa-core ever ships an
  equivalent, reconciling the two becomes a separate, later decision.
- Any WebAuthn/passkey-signer-specific behavior — Khronoton has no such signer kind; the ported
  functions' `webauthnSigners` parameter exists for fidelity only and is always called with `0`.
- Any change to `calculateAutoGasLimit`'s own ladder formula (still used verbatim below
  `EVIDENCE_FLOOR`) or to `@stoachain/stoa-core/gas`'s export itself.
- Any change to the Builder UI / `/ui` subpath's own gas-preview display logic — this topic is the
  server-side engine (`/server` subpath) only, mirroring how `khronoton-auto-gas-handoff.md`'s
  original ask was scoped.
