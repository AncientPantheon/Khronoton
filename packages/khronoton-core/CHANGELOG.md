# Changelog

All notable changes to `@ancientpantheon/khronoton-core`.

The engine's pre-extraction history lives in the AncientHoldings hub, whose inline scheduler ("Cronoton") this package extracts and generalises.

## 0.1.1 — 2026-07-04

Packaging fix — no API or behaviour change. Added a `require` condition to the package `exports` map (`"." → { types, import, require }`, all resolving to the ESM `dist/index.js`) so the package is a drop-in for CommonJS consumers as well as ESM ones. This makes it loadable by hosts whose runtime resolves bare specifiers through CommonJS `require` — notably the AncientHoldings hub's worker, which runs via `tsx` in CJS mode; under 0.1.0's `import`-only exports it hit `ERR_PACKAGE_PATH_NOT_EXPORTED` on a static import. Node 22.12+ (`require(esm)`) loads the ESM build synchronously; no separate CJS build is shipped. The engine code, types, and `dist/` output are byte-identical to 0.1.0. 0.1.0 is superseded (deprecate recommended).

## 0.1.0 — 2026-07-04

First public version. The schedule engine was lifted from the AncientHoldings hub's inline scheduler ("Cronoton") and generalised into pure, framework-agnostic functions — the 7-mode `ScheduleMode`/`ScheduleConfig` model, `computeNextFire` (TOTAL / MONOTONIC / PURE), `summariseSchedule`, `InvalidScheduleConfigError`, and an in-tree 5-field UTC cron parser — locked by four contract suites. The injectable `tickOnce(now, deps)` tick engine was generalised from the hub's tick loop: three host-injected hooks (`loadDue` / `enqueueFire` / `persistNextFire`), enqueue-strictly-before-persist firing, per-row isolation, an engine-enforced batch cap (default 100, `RangeError` on a non-positive-integer override), and disjoint `{ firedIds, skippedIds }` membership — locked by two more contract suites. Zero runtime dependencies, plain-`tsc` ESM build to `dist/`. Consumed by the AncientHoldings hub, which injects storage and firing through the three hooks.

## 0.0.1 — 2026-07-04

Initial package skeleton — empty but buildable. ESM-only package with an `export {};` entry point, plain-`tsc` emit to `dist/` (`.js` + `.d.ts`), vitest wired with `--passWithNoTests`, and a publish-eligible manifest (public access, `sideEffects: false`). No public API yet; the schedule math and the injectable `tickOnce` tick engine arrive in later phases. Unpublished.
