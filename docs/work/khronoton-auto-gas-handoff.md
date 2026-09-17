# Handoff — Khronoton package: make **auto self-calibrating gas** the default (model on OuronetUI)

**For:** the `@ancientpantheon/khronoton-core` package agent.
**From:** AncientHoldings Hub. **Date:** 2026-09-17.
**Companion:** `khronoton-editor-save-handoff.md` (the Save-button gap) — separate concern.

## The problem

Khronoton transactions default to a **fixed, manually-set gas limit**, so fires
over-reserve gas wildly — e.g. a pool-payout fire measured **594 gas used against
a 600,000 limit**. Operators shouldn't have to guess a limit, and a fixed limit
is wrong for every tx whose size/cost differs from the guess.

**Desired default:** every khronoton, when constructed, should **auto-size its own
gas** — simulate at the block ceiling, read the real gas, calibrate with a buffer,
and set a proper limit sized to that specific transaction. No manual limit unless
the operator deliberately overrides. This is exactly what **OuronetUI** already
does; please lift that behavior into the package so **all** khronoton consumers get
it by default.

## Reference implementation — OuronetUI (copy this)

Repo: `OuroborosNetwork/daimons/OuronetUI`.

### The loop — `src/hooks/useTransactionBuilder.ts`
`simulate()` (~L375) and the gas-adjustment step of `execute()` (~L443–500):

1. **Build the sim tx at the block gas limit** (the ceiling), not at a guess:
   `buildTransaction(pactCode, config, getBlockGasLimit())`.
2. **PREFLIGHT `/local`** — the crucial detail:
   `local(simTx, { preflight: true, signatureVerification: false })`.
   > A plain `dirtyRead` reports EXECUTION gas only (stays ~1 regardless of size)
   > and omits `initialGasOf` — the transaction-**size** charge, where the real
   > cost lives and which binds at ~397 KiB. Preflight measures the true gas.
3. **Read `simulation.gas`** → `gasUsed`.
4. **Refuse the unmineable case:** if `gasUsed > getBlockGasLimit()` (or, when
   preflight fails, `estimateSizeChargeGas(...) > getBlockGasLimit()`) → stop with
   a clear "needs N gas, over the block limit — no setting can mine it" error.
   Don't silently cap.
5. **Calibrate:** when auto-gas is on and `gasUsed > 0`,
   `setGasLimit(Math.min(calculateAutoGasLimit(gasUsed), getBlockGasLimit()))`,
   rebuild the tx at that limit, then sign/submit.

### The primitives — `src/lib/gas-limits.ts` + `@stoachain/stoa-core/gas`
- `calculateAutoGasLimit(gasUsed)` — **from `@stoachain/stoa-core/gas`**, the SINGLE
  source of truth for the buffer math (graduated proportional + flat buffer,
  clamped to `[MIN_AUTO_GAS_LIMIT=1000, node gas limit]`). Do **not** re-implement
  the buffer — import this.
- `getBlockGasLimit()` / `fetchBlockGasLimit(pactUrl)` — the live block gas limit
  read from the node's `/config` (fallback `STOA_BLOCK_GAS_LIMIT = 2_000_000`).
  Use this as the simulate ceiling; **don't hardcode 2,000,000** (StoaChain runs
  2M, chainweb default is 1.6M, Kadena mainnet 150k).
- `estimateSizeChargeGas(bytes, edSigners, webauthnSigners)` — client-side estimate
  of the size charge (grows as the 7th power of size), used to explain *why* a tx
  is unmineable when preflight can't run.

### Server-side reference (autonomic fires have no browser)
The Hub's own executor already runs this loop **server-side** at fire time for its
`autoGasLimit` path: `lib/codex-cronoton/executor.ts` pre-flights at the ceiling,
calibrates via `calculateAutoGasLimit`, and re-signs at the calibrated limit before
submit. Scheduled khronotons fire with no browser, so the package's **engine fire
path** must do the calibrate→re-sign server-side (the `/ui` Builder does it at
build/simulate time for interactive construction).

## The ask (package level)

Make auto self-calibrating gas the **default** for constructed khronoton
transactions, so every consumer gets it without opting in:

1. **Default `autoGasLimit` ON** for new khronotons — in the `/ui` `Builder`
   defaults AND as the engine's default when a stored cronoton doesn't pin a
   manual limit.
2. **Fire-time / build-time calibration** — run the OuronetUI loop above:
   build at the live block limit → **preflight** `/local` → `calculateAutoGasLimit`
   (clamped to the block limit) → set that limit → sign/submit. This must run
   **server-side in the engine** for autonomic fires (mirror the Hub executor),
   and at simulate/build time in the `/ui` Builder for interactive construction.
3. **Reuse the shared primitives** — `calculateAutoGasLimit` from
   `@stoachain/stoa-core/gas`, and a live block-gas-limit fetch (mirror
   `getBlockGasLimit`/`fetchBlockGasLimit`); don't hardcode 2M and don't fork the
   buffer math.
4. **Refuse the unmineable case** loudly (gasUsed or size-charge > block limit)
   instead of over-reserving or silently failing at fire time.
5. A manual limit stays available as a deliberate override; AUTO is just the
   default.

## Why this belongs in the package

The Hub, OuronetUI and every other khronoton consumer otherwise each re-implement
(or forget) the calibrate loop. `calculateAutoGasLimit` is already the shared
buffer primitive; putting the whole simulate→calibrate→size-a-proper-limit flow in
the package's construction/fire path means every khronoton is correctly-sized by
default, and the 594/600,000-style waste disappears everywhere at once.

## Notes
- Not a security or correctness change to firing — purely gas sizing.
- The Hub currently sets some fixed limits deliberately (`payout-bulk-tx.ts`
  `DEFAULT_BULK_GAS_LIMIT = 600000` headroom for a full bulk batch). Those are the
  Hub's own orchestrator choices; the package default going AUTO doesn't force them
  — but once the package auto-sizes, the Hub can drop such fixed limits in favor of
  the package default where a per-fire size varies.
