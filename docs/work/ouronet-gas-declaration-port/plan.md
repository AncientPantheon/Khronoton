## Wave 1
- [x] T1: Port OuronetUI's closed-form gas-declaration model into a new pure module
      `packages/khronoton-core/src/server/pure/gas-declaration.ts`, with no dependency on any
      `@stoachain/*` import (the old ladder it defers to below `EVIDENCE_FLOOR` is injected by the
      caller as a plain function, never imported directly — this module stays pure like every
      other file under `server/pure/`). Export:
      - Constants: `SIG_BYTES = 128`, `MIN_DECLARED_GAS = 1_000`, `EVIDENCE_FLOOR = 20_000`,
        `FIXED_OVERHEAD = 150`, `DRIFT_FRACTION = 0.005`, `DRIFT_FLOOR = 1_000`, `SIZE_ALLOWANCE = 500`.
      - `estimateSizeChargeGas(payloadBytes: number, ed25519Signers = 0, webauthnSigners = 0): number`
        — `p = Math.max(0, payloadBytes); sizeCost = 0.01 * p; sizePenaltyCost = Math.pow(sizeCost / 512, 7);
        sigsCost = 21 * ed25519Signers + 526 * webauthnSigners; return Math.ceil(sizeCost + sizePenaltyCost + sigsCost);`.
      - `interface GasDeclaration { gasLimit: number; executionGas: number; sizeCharge: number; drift: number; clampedToCeiling: boolean }`.
      - `interface GasDeclarationInput { simulatedGas: number; simIncludesSize: boolean; cmdBytes?: number; ed25519Signers?: number; webauthnSigners?: number; ceiling: number }`.
      - `declareGasLimit(input: GasDeclarationInput, legacyLadder: (gasUsed: number) => number): GasDeclaration`
        — if `!Number.isFinite(input.simulatedGas) || input.simulatedGas <= 0`, return
        `{ gasLimit: 0, executionGas: 0, sizeCharge: 0, drift: 0, clampedToCeiling: false }`. Else if
        `input.simulatedGas < EVIDENCE_FLOOR`, `legacy = Math.min(legacyLadder(input.simulatedGas), input.ceiling)`,
        return `{ gasLimit: legacy, executionGas: input.simulatedGas, sizeCharge: 0, drift: Math.max(0, legacy - input.simulatedGas), clampedToCeiling: false }`.
        Else: `bytes = Math.max(0, input.cmdBytes ?? 0); ed = input.ed25519Signers ?? 0; wa = input.webauthnSigners ?? 0;
        signedCharge = estimateSizeChargeGas(bytes + SIG_BYTES * ed, ed, wa);
        sizeCharge = input.simIncludesSize ? Math.max(0, signedCharge - estimateSizeChargeGas(bytes, ed, wa)) : signedCharge;
        drift = Math.max(DRIFT_FLOOR, Math.ceil(input.simulatedGas * DRIFT_FRACTION));
        wanted = Math.max(MIN_DECLARED_GAS, input.simulatedGas + sizeCharge + FIXED_OVERHEAD + drift);
        gasLimit = Math.min(wanted, input.ceiling);
        return { gasLimit, executionGas: input.simulatedGas, sizeCharge, drift, clampedToCeiling: wanted > input.ceiling };`.
      - `declaredGasFor(simulatedGas: number, ceiling: number, legacyLadder: (gasUsed: number) => number): number`
        — `return declareGasLimit({ simulatedGas, simIncludesSize: false, ceiling }, legacyLadder).gasLimit;`.
      - `maxSimulatedGasAtLimit(ceiling: number): number` — `return Math.max(0, ceiling - SIZE_ALLOWANCE - FIXED_OVERHEAD);`.
      - `maxSimulatedGasFor(ceiling: number): number` — `room = ceiling - SIZE_ALLOWANCE - FIXED_OVERHEAD;
        if (room <= MIN_DECLARED_GAS) return 0; byFraction = Math.floor(room / (1 + DRIFT_FRACTION));
        return Math.ceil(byFraction * DRIFT_FRACTION) < DRIFT_FLOOR ? Math.max(0, room - DRIFT_FLOOR) : byFraction;`.
      Done when: `packages/khronoton-core/src/server/pure/gas-declaration.test.ts` exists and
      `npx vitest run src/server/pure/gas-declaration.test.ts` passes, covering: (a) the 4 worked
      examples from OuronetUI's own `declareGasLimit.ts` header table at a 2,000,000 ceiling —
      `simulatedGas=8` → `gasLimit=1000` (via a stub `legacyLadder` returning `1000` for input `8`,
      proving the sub-floor fallback path is reached and the stub's return value flows through
      unchanged); `simulatedGas=20000` (exactly `EVIDENCE_FLOOR` — the NEW formula path, NOT the
      ladder, since the guard is `< EVIDENCE_FLOOR` not `<=`) with `simIncludesSize:false,
      cmdBytes:0,ed25519Signers:0` → `gasLimit=21051` (± the exact arithmetic above, not the
      ladder's own `27000`); `simulatedGas=100000` same inputs → `gasLimit=102051`; a case near
      `simulatedGas=1751061` with realistic `cmdBytes`/`ed25519Signers` demonstrating `gasLimit`
      meaningfully below `legacyLadder(1751061)`'s own output; (b) `maxSimulatedGasAtLimit(2_000_000) === 1_999_350`;
      (c) `maxSimulatedGasFor(2_000_000)` computed exactly per the formula above (compute and assert the
      literal expected number, do not re-derive the formula inside the test); (d) `estimateSizeChargeGas`
      matches OuronetUI's own documented example magnitudes (e.g. a ~300KB payload's penalty term
      dominating); (e) a non-finite/zero/negative `simulatedGas` returns the all-zero sentinel without
      ever calling `legacyLadder`; (f) `declaredGasFor` delegates to `declareGasLimit` with
      `simIncludesSize:false` — provable by asserting it matches a direct `declareGasLimit` call with
      the same flag.
  - files: `packages/khronoton-core/src/server/pure/gas-declaration.ts`, `packages/khronoton-core/src/server/pure/gas-declaration.test.ts`

## Wave 2 (depends on Wave 1)
- [x] T2: Resequence `packages/khronoton-core/src/server/executor.ts`'s `submitTransaction` AUTO-gas
      path to preflight the UNSIGNED transaction and calibrate via `declareGasLimit` (from T1's new
      module) instead of `runtime.calculateAutoGasLimit`, signing exactly once. The MANUAL-gas path
      (the `else` branch using `dirtyRead` on an already-signed tx) stays byte-for-byte unchanged.
      Current AUTO-gas sequence (read the real code at `submitTransaction` before editing): build
      unsigned `tx` at ceiling → `signed = await signTransaction(...)` → `preflight = await
      client.preflightRead!(signed)` → refuse-unmineable check on `preflight.gas` → if calibrating,
      `calibrated = runtime.calculateAutoGasLimit(gasUsed); tx = buildTransaction(..., calibrated);
      signed = await signTransaction(...)` (a SECOND sign) → derive request key from `signed` →
      submit. New AUTO-gas sequence: build unsigned `tx` at ceiling (unchanged) → `preflight = await
      client.preflightRead!(tx)` (preflight the UNSIGNED `tx`, never `signed` — `signTransaction`
      is not called yet at this point for the AUTO-gas branch) → refuse-unmineable check unchanged →
      if calibrating, `calibrated = declareGasLimit({ simulatedGas: gasUsed, simIncludesSize: true,
      cmdBytes: Buffer.byteLength(tx.cmd, "utf8"), ed25519Signers: signers.length, ceiling },
      (g) => runtime.calculateAutoGasLimit(g)).gasLimit; tx = buildTransaction(..., calibrated)` →
      `signed = await signTransaction(...)` (the ONLY sign call in the AUTO-gas branch) → derive
      request key from `signed` / submit, unchanged. Also export `resolveCeiling` from this file
      (add the `export` keyword to its existing declaration; no signature change) so T4 (Wave 3) can
      reuse the identical live-ceiling-resolution logic rather than re-deriving it.
      Done when: `npx tsc --noEmit` is clean; the executor's existing test file covering
      `submitTransaction`'s AUTO-gas behavior (locate it via `grep -rl "calculateAutoGasLimit\|AUTO-gas" packages/khronoton-core/src/server/*.test.ts`
      — expected to be `packages/khronoton-core/src/server/executor.test.ts`) passes with its
      AUTO-gas assertions updated to check: (a) `client.preflightRead` is called with an object that
      has `sigs` either absent or empty (the unsigned shape), never with `signed`'s real sig array
      — provable by asserting on the mock call's argument identity/shape, not just call count; (b)
      `universalSignTransaction` (the runtime's own signing primitive) is called exactly ONCE for a
      successful AUTO-gas fire, not twice; (c) the final built transaction's declared `meta.gasLimit`
      (inspect the last `buildTransaction`-equivalent call, or the final signed `tx`'s baked-in
      value via the test's existing fixture inspection pattern) equals `declareGasLimit`'s computed
      output for the fixture's `gasUsed`/`cmdBytes`/signer count at or above `EVIDENCE_FLOOR`, and
      equals the UNCHANGED `calculateAutoGasLimit(gasUsed)` output for a fixture below it; (d) every
      MANUAL-gas test in the same file passes completely unmodified (no fixture change needed for
      those cases — if one needs changing, that is a regression, not an expected update).
  - files: `packages/khronoton-core/src/server/executor.ts`, `packages/khronoton-core/src/server/executor.test.ts`, (reads) `packages/khronoton-core/src/server/pure/gas-declaration.ts`, `packages/khronoton-core/src/server/seams.ts`

- [x] T3: Replace `packages/khronoton-core/src/server/pure/split-plan.ts`'s flat-fraction
      `PLANNING_MARGIN = 0.92`/`CONFIRMED_MARGIN = 0.99` room computation in `capacityFor` with
      T1's derived-headroom functions. Current signature: `capacityFor(model: SplitModel, ceiling:
      number, margin = PLANNING_MARGIN): number { const room = ceiling * margin - model.fixed;
      return room <= 0 ? 0 : Math.floor(room / model.perItem); }`. New signature: `capacityFor(model:
      SplitModel, ceiling: number, mode: "planning" | "confirmed" = "planning"): number { const
      roomCeiling = mode === "confirmed" ? maxSimulatedGasAtLimit(ceiling) : maxSimulatedGasFor(ceiling);
      const room = roomCeiling - model.fixed; return room <= 0 ? 0 : Math.floor(room / model.perItem); }`
      (import `maxSimulatedGasAtLimit`/`maxSimulatedGasFor` from T1's `../pure/gas-declaration.js`).
      Update every call site of `capacityFor` within this same file: the implicit-default-margin
      call (the extrapolated/planning case) becomes the implicit-default-mode call (no change needed
      at that call site beyond the signature itself still defaulting to `"planning"`); the
      explicit-`CONFIRMED_MARGIN` call becomes an explicit `"confirmed"` call. Remove
      `PLANNING_MARGIN`/`CONFIRMED_MARGIN` entirely — they must not remain as dead exports or
      module-local constants.
      Done when: `npx tsc --noEmit` is clean; `grep -c "PLANNING_MARGIN\|CONFIRMED_MARGIN"
      packages/khronoton-core/src/server/pure/split-plan.ts` returns `0`; the existing
      `split-plan.test.ts` passes with its margin-dependent assertions updated to the new derived
      values (e.g. any test asserting a specific `capacityFor` return value computed from the old
      `ceiling * 0.92`/`ceiling * 0.99` formula is updated to the new `maxSimulatedGasFor`/
      `maxSimulatedGasAtLimit`-derived value, not loosened or deleted); a new test asserts
      `capacityFor(model, ceiling, "confirmed")` yields MORE capacity than
      `capacityFor(model, ceiling, "planning")` for the same model/ceiling (the confirmed case
      reserves less headroom, by construction) — the one behavioral property this port is FOR.
  - files: `packages/khronoton-core/src/server/pure/split-plan.ts`, `packages/khronoton-core/src/server/pure/split-plan.test.ts`, (reads) `packages/khronoton-core/src/server/pure/gas-declaration.ts`

## Wave 3 (depends on Wave 2)
- [x] T4: Replace `packages/khronoton-core/src/server/resolvers.ts`'s `fireWithServerResolver`
      hand-set single-tx gas guard default with T1's derived ceiling function. Current: `const
      guard = opts.config?.singleTxGasGuard ?? SINGLE_TX_GAS_GUARD;` (where `SINGLE_TX_GAS_GUARD` is
      the hand-set `1_600_000` constant imported from `./seams.js`). New: resolve the live ceiling
      the same way `executor.ts` does — construct a `ChainClient` via
      `opts.runtime!.createClient(opts.runtime!.getPactUrl(fired.config.chainId))` (mirroring the
      exact pattern `executor.ts`'s own `runSimulate`/`submitTransaction` already use to get a
      client from `chainId`) and call T2's now-exported `resolveCeiling` from `./executor.js` with
      that client and the row's `chainId`; then `const guard = opts.config?.singleTxGasGuard ??
      maxSimulatedGasAtLimit(ceiling);` (import `maxSimulatedGasAtLimit` from
      `./pure/gas-declaration.js`). Keep the existing `SINGLE_TX_GAS_GUARD` import/constant in
      `seams.ts` untouched (it stays available for any caller that still wants the OLD fixed value
      via an explicit `config.singleTxGasGuard` override — only the no-override DEFAULT changes).
      Done when: `npx tsc --noEmit` is clean; the existing `resolvers.test.ts` passes with its
      single-tx-guard test(s) updated: a test asserting the default guard (no `config.singleTxGasGuard`
      set) now refuses only when `gasUsed` exceeds `maxSimulatedGasAtLimit(ceiling)` (not the old
      `1_600_000`) and fires successfully for a `gasUsed` between the old and new thresholds (proving
      the fix's whole point — a transaction the old guard would have wrongly refused now fires); a
      test asserting an explicit `config.singleTxGasGuard` override still takes priority over the
      derived default, unchanged from today's behavior.
  - files: `packages/khronoton-core/src/server/resolvers.ts`, `packages/khronoton-core/src/server/resolvers.test.ts`, (reads) `packages/khronoton-core/src/server/executor.ts`, `packages/khronoton-core/src/server/pure/gas-declaration.ts`, `packages/khronoton-core/src/server/seams.ts`
