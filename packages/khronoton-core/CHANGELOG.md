# Changelog

All notable changes to `@ancientpantheon/khronoton-core`.

The engine's pre-extraction history lives in the AncientHoldings hub, whose inline scheduler ("Cronoton") this package extracts and generalises.

## 0.2.0 — 2026-07-12

Added the **server/automaton engine** on a new `@ancientpantheon/khronoton-core/server` subpath — the stand-alone layer a consuming Automaton (e.g. Mnemosyne) needs to run scheduled, signed, on-chain firing. The root `.` schedule engine (7-mode math + `tickOnce`) is byte-unchanged; this is purely additive.

Lifted faithfully from the AncientHoldings hub's inline `codex-cronoton` system (~4,250 lines) and generalised behind **six injection seams** — `KeyResolver` (codex signing), `ChainRuntime` (chain client + constants), `Database` (a minimal structural handle; `better-sqlite3` satisfies it), `onAudit`, `resolveFireMode`, and a 6-field `Config` — so the package pulls no `@stoachain/*` symbol, no database driver, and no framework. What ships:

- **Store + atomic claim-before-fire (exactly-once).** The load-bearing invariant: a due fire is claimed by a conditional `UPDATE` that re-asserts the due predicate and advances `next_fire_at` in the same statement, firing only on `changes === 1`. Two overlapping ticks fire a row once — the primary double-fire guard, no leader election. Proven at the store layer and again end-to-end.
- **Headless single-transaction executor.** `executeCodexTransaction(definition, mode, ctx)` behind the `ChainRuntime` + `KeyResolver` seams: fire never throws (structured failure), dirty-read pre-flight gate (no submit on a failing pre-flight), AUTO-gas calibrate (rebuild + re-sign at the calibrated limit), and 504/derived-request-key recovery. The Hub's cross-chain SPV block is intentionally dropped.
- **Server tick + loop.** `codexCronotonTickOnce` / `processDueManualBatchesOnce` take an injected `ctx`; `startKhronotonLoop(ctx) → stop()` drives them on `config.tickIntervalMs` with a single-instance re-entrancy guard (a multi-minute inline fire never launches an overlapping tick).
- **Server-resolver registry/dispatcher.** A generic `registerServerResolver` / `fireByServerResolver` mechanism (single-tx and multi-tx kinds) between the tick and the executor; no concrete host resolvers are shipped.
- **`installSchema(db)`** — one driver-free installer for the three tables (`codex_cronotons`, `codex_cronoton_fires`, `codex_cronoton_manual_batches`), consolidating the Hub's migration chain and genericised (no host FKs/CHECKs).
- **Two definition-of-done integration tests** — a double-fire once-only proof and a codex-signs-a-scheduled-tx proof, both end-to-end against a real in-memory SQLite with mock seams.

The subpath carries the same dual `{ types, import, require }` exports condition as the root (the 0.1.1 CJS lesson), so a `tsx`/CommonJS host can `require('@ancientpantheon/khronoton-core/server')`. `better-sqlite3` is an optional dependency (reference/test backend only); the package keeps zero required runtime dependencies. Proprietary / all-rights-reserved posture unchanged.

## 0.1.1 — 2026-07-04

Packaging fix — no API or behaviour change. Added a `require` condition to the package `exports` map (`"." → { types, import, require }`, all resolving to the ESM `dist/index.js`) so the package is a drop-in for CommonJS consumers as well as ESM ones. This makes it loadable by hosts whose runtime resolves bare specifiers through CommonJS `require` — notably the AncientHoldings hub's worker, which runs via `tsx` in CJS mode; under 0.1.0's `import`-only exports it hit `ERR_PACKAGE_PATH_NOT_EXPORTED` on a static import. Node 22.12+ (`require(esm)`) loads the ESM build synchronously; no separate CJS build is shipped. The engine code, types, and `dist/` output are byte-identical to 0.1.0. 0.1.0 is superseded (deprecate recommended).

## 0.1.0 — 2026-07-04

First public version. The schedule engine was lifted from the AncientHoldings hub's inline scheduler ("Cronoton") and generalised into pure, framework-agnostic functions — the 7-mode `ScheduleMode`/`ScheduleConfig` model, `computeNextFire` (TOTAL / MONOTONIC / PURE), `summariseSchedule`, `InvalidScheduleConfigError`, and an in-tree 5-field UTC cron parser — locked by four contract suites. The injectable `tickOnce(now, deps)` tick engine was generalised from the hub's tick loop: three host-injected hooks (`loadDue` / `enqueueFire` / `persistNextFire`), enqueue-strictly-before-persist firing, per-row isolation, an engine-enforced batch cap (default 100, `RangeError` on a non-positive-integer override), and disjoint `{ firedIds, skippedIds }` membership — locked by two more contract suites. Zero runtime dependencies, plain-`tsc` ESM build to `dist/`. Consumed by the AncientHoldings hub, which injects storage and firing through the three hooks.

## 0.0.1 — 2026-07-04

Initial package skeleton — empty but buildable. ESM-only package with an `export {};` entry point, plain-`tsc` emit to `dist/` (`.js` + `.d.ts`), vitest wired with `--passWithNoTests`, and a publish-eligible manifest (public access, `sideEffects: false`). No public API yet; the schedule math and the injectable `tickOnce` tick engine arrive in later phases. Unpublished.
