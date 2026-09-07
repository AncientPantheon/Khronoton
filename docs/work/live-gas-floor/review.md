# Review — live gas floor at fire time (khronoton-core 0.9.0)

Scope: uncommitted changes in `packages/khronoton-core` (18 files) — production
(`src/server/seams.ts`, `src/server/executor.ts`, `src/blockchain/stoachain.ts`,
`src/provider/memory-adapter.ts`, `src/ui/tx-size.ts`, `src/ui/builder-state.ts`,
`package.json`), tests (`src/server/executor.test.ts`, `src/blockchain/stoachain.test.ts`,
`src/blockchain/stoachain.real.test.ts`, `src/server/resolvers.test.ts`,
`src/ui/builder-state.test.ts`, `tests/codex-signs-scheduled-tx.test.ts`,
`tests/double-fire.test.ts`, `tests/handlers/harness.ts`), docs (`CHANGELOG.md`,
`README.md`), and `package-lock.json`. 16+ files → all 5 lenses, dispatched in parallel.

## Round 1

### Lens findings (deduplicated)

**[HIGH] correctness — `gasMeta` documented as chain-specific/optional but enforced as
globally mandatory** (`src/server/seams.ts:130-144`, `src/server/executor.ts:109-116`)

- Verdict: **REFUTED**
- Validation note: the unconditional hard-throw is intentional, disclosed by the very
  paragraph the finding quotes ("Failing loudly on an un-upgraded runtime adapter is the
  point" — generic, not StoaChain-scoped), and explicitly tested
  (`executor.test.ts:700-722`, `describe("executeCodexTransaction — runtime WITHOUT the
  gasMeta capability")`). Only one `ChainRuntime` implementation exists in the repo
  (`stoachain.ts`); the claimed harm to a hypothetical non-StoaChain integrator is
  speculative. The suggested fix (an opt-out flag) would reintroduce the exact
  silent-stale-price risk this hard-throw exists to prevent. Discarded.

**[MEDIUM] tests — "ONE clock read, not two" test asserts `toHaveBeenCalled()`, not call
count; mocks never reset between tests** (`src/blockchain/stoachain.test.ts:170-177`)

- Verdict: **CONFIRMED**
- Validation note: confirmed no `clearMocks`/`restoreMocks` in `vitest.config.ts` and no
  spy reset in the file's `beforeEach` (only `mockNowS` was reset); `mockStoaGasMeta`'s
  call count accumulates across the two preceding tests in the same `describe` block.
  The real implementation (`stoachain.ts:97`) calls `gas.stoaGasMeta()` exactly once
  today, so the invariant is true but unenforced — a regression to a second call (e.g.
  a second clock read added for logging) would go undetected.
- **Fixed:** `stoachain.test.ts` — added `mockStoaGasMeta.mockClear()` to the describe
  block's `beforeEach` (scoped reset, doesn't touch other describe blocks' fixtures),
  and changed the assertion from `toHaveBeenCalled()` to `toHaveBeenCalledTimes(1)`.

**correctness, security, performance** (remaining scope): no findings.
**conventions**: no findings.

### Clean pass (after the fix)

```
 Test Files  71 passed (71)
      Tests  907 passed (907)
```
`npx tsc --noEmit` — clean, no output.

Real-runtime integration (`npm run test:integration`, against installed
`@stoachain/*@4.4.0`, no mocks):
```
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

### Behavioral verification

Ran the real, installed `@stoachain/stoa-core@4.4.0` formula directly (not the test
suite) to confirm the acceptance criterion end-to-end — a stale stored price is raised
to the live floor:

```json
{"nowS":1788819915,"liveFloorAnu":11569,"storedDefaultAnu":10000,"flooredGasPrice":1.1569e-8}
```

The builder's genesis-default 10,000 ANU is still below the live floor today, and
`gasMeta(10000)` correctly floors it to `anuToStoaNumber(11569)` — matching
`stoachain.real.test.ts`'s "gasMeta floors a STALE stored price against the REAL Yin
Engine" spec, which asserts the identical relationship against the real, unmocked
package.

## Outcome

One round. One CONFIRMED finding (test-coverage gap), fixed. One HIGH finding REFUTED
after adversarial validation (intentional, tested, documented behavior). Zero findings
from correctness (on the production code), conventions, security, performance.

Clean pass confirmed post-fix: typecheck clean, 907/907 unit specs, 5/5 real-runtime
integration specs, and a direct behavioral check against the installed package.
