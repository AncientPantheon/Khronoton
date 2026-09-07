# Live gas floor at fire time (khronoton-core 0.9.0)

## Problem

`server/executor.ts:102` priced every fire off `definition.config.gasPrice` — a static ANU
number persisted in `codex_cronotons` at cronoton-creation time and read back verbatim on
every tick (`server/tick.ts`, `server/store/mappers.ts`). Post-fork, chainweb-node rejects a
signed tx priced below the Yin Engine floor *as of that tx's own `creationTime`*. The floor
rises 1 ANU / 3h from 10,000 at genesis. So a cronoton created today at the builder default
(10,000 ANU) is already underpriced, and every stored cronoton drifts further below the floor
the longer it lives. This is unattended automation — nobody is watching a 3am tick fire.

`@stoachain/stoa-core@4.4.0` now exports the canonical formula (`minGasPriceAnu`,
`anuToStoaNumber`, `stoaGasMeta`) from `@stoachain/stoa-core/gas`, so nobody reimplements it.

## Two bugs, not one

1. **Stale price.** The stored value is never re-derived against the live floor.
2. **Precision.** `runtime.anuToStoa` is plain float division. Upstream is explicit that this
   is fine for UI display but NOT for a value going into tx meta that chainweb hashes and
   validates exactly — that needs `anuToStoaNumber`, which builds the decimal string by
   padding. Present at the meta site *and* at `ui/tx-size.ts:88`'s fee meter.

## Why not import stoa-core directly into the executor

The originating handoff prescribed importing `@stoachain/stoa-core/gas` straight into
`executor.ts`. Rejected — it breaks two load-bearing properties:

- `executor.ts`'s header declares it pulls NO `@stoachain/*` symbol and does NO dynamic
  `import()`; every chain value arrives via the injected `ChainRuntime`.
- `@stoachain/stoa-core` is an **optional** peerDependency. A static import makes it mandatory
  in the core server path and breaks khronoton's chain-polyglot design, where each
  `/blockchain/<chain>` subpath teaches the engine one chain's dialect.

`blockchain/stoachain.ts` already maps `anuToStoa: gas.anuToStoa` — the adapter is where this
belongs.

## Why one seam call, not two

The handoff prescribed a bare `minGasPriceAnu(creationTime)`. `creationTime` does not exist
anywhere in this repo (zero references): `buildTransaction`'s `setMeta` never set it, so the
Kadena builder auto-stamped its own at `createTransaction()`. Deriving the floor from a
separately-read clock is exactly the race `stoaGasMeta`'s own doc warns about — "a tick
boundary crossing between two separate reads silently underprices the tx."

So the seam returns **both** fields from **one** clock read, and both go into `setMeta`.

## Design

Extend `ChainRuntime` with an OPTIONAL capability:

```ts
gasMeta?(floorAnu: number): { creationTime: number; gasPrice: number };
```

- **Optional** keeps this a MINOR bump: khronoton-core stays chain-polyglot, stoa-core stays
  an optional peer, and non-StoaChain runtimes need no change.
- **Absent + a StoaChain fire ⇒ hard throw**, never a silent fallback to the static value.
  A silent fallback ships the bug forever to anyone who doesn't notice they must opt in.
- `floorAnu` in, floored price out: all Yin/ANU/STOA math stays inside the adapter, so the
  executor keeps zero chain-unit knowledge.

`Math.max(storedAnu, minGasPriceAnu(creationTime))` — the stored value stays an
**operator-raisable floor**, never a cap. Existing rows self-heal with no DB migration.

### Call-site freshness

`buildTransaction` calls the seam once per invocation. The auto-gas path calls
`buildTransaction` a second time to rebuild + re-sign at the calibrated limit, so that rebuild
re-enters the seam and gets a fresh read automatically. A regression test pins this so nobody
later hoists the call out of `buildTransaction`.

### F-002 interaction

`fire` NEVER throws (F-002). A missing-capability throw from `buildTransaction` is caught by
the existing `executeCodexTransaction` wrapper and returned as a structured
`{ ok: false, error }` — clear, not silent, and the one-time entry still records its
terminalIntent instead of re-firing forever.

## Scope

- `server/seams.ts` — the optional capability + docs.
- `server/executor.ts` — `buildTransaction` uses it; `setMeta` now carries `creationTime`.
- `blockchain/stoachain.ts` — implement from `@stoachain/stoa-core/gas`.
- `provider/memory-adapter.ts` — `throwingRuntime` stub.
- `ui/tx-size.ts` — `anuToStoaNumber` at the fee meter.
- `ui/builder-state.ts` — the hardcoded `>= 10000` gate.
- Repin stoa-core `^4.3.6` → `^4.4.0`; version 0.8.0 → 0.9.0.

Out of scope: `StoaChain/_hub/AncientHoldings` (standalone app, no seam needed — separate
corrected handoff). Pythia needs zero code changes: `meterChainRuntime` wraps with `...base`,
so the new field passes through; it needs only a release bumping khronoton-core.
