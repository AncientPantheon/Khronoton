# Changelog

All notable changes to `@ancientpantheon/khronoton-core`.

The engine's pre-extraction history lives in the AncientHoldings hub, whose inline scheduler ("Cronoton") this package extracts and generalises.

## 0.4.1 — 2026-07-22

**PATCH — dependency rename, no code change.**

The Ouronet protocol dependency moved scope: `@stoachain/ouronet-core` → **`@ouronet/ouronet-core`**. Same code and version line; the package was split out of `StoaChain/stoa-js` into [`OuroborosNetwork/ouronet-libs`](https://github.com/OuroborosNetwork/ouronet-libs) in the Phase-4 reorganisation so that published identity matches org ownership. The old name is deprecated on npm.

This needs a release rather than a local edit: the published `0.4.0` peer-depends on the old name, and a consumer that also depends on the new one ends up demanding two different chain versions at once — `@ouronet/ouronet-core` pins `@stoachain/kadena-stoic-legacy` exactly, so the two cannot coexist. Anyone consuming this package alongside the renamed stack should move to 0.4.1.

**799 specs pass.**

## 0.4.0 — 2026-07-13

Made khronoton **chain-polyglot**: the package now ships the chain adapters it needs to talk to each supported chain, as a `/blockchain/<chain>` subpath family — rather than a separate npm package per chain. This keeps khronoton a single drop-in for every automaton while it speaks each chain's language natively. Root `.`/`/server`/`/handlers` outputs are unchanged.

- **`/blockchain/stoachain`** — `createStoachainRuntime(config?) → Promise<ChainRuntime>` wraps the `@stoachain/*` runtime (client, signing, gas, constants) into the core `ChainRuntime` seam, so a StoaChain automaton (Mnemosyne, Caduceus, Aletheia, …) injects one object instead of reaching for `@stoachain/*` directly. Loads the SDK via SEQUENTIAL `await import()` (concurrent `Promise.all` crashes Node 24 with `ERR_INTERNAL_ASSERTION`); an optional `nodeBaseUrl` routes `getPactUrl`. Future chains land as sibling `/blockchain/<chain>` subpaths.
- **Optional-peer model.** Each chain's SDK is an **optional peer dependency** (`@stoachain/*@^4.3.6` for `/blockchain/stoachain`) and is imported LAZILY inside the factory. So `npm install @ancientpantheon/khronoton-core` pulls zero chain SDKs, importing the subpath costs nothing, and only calling the factory needs the SDK — a consumer carries only the chain(s) it actually uses. `react` remains an optional peer for the `/provider`/`/hooks`/`/ui` subpaths.
- **Consolidation.** This folds in the previously-separate `@ancientpantheon/khronoton-stoachain` package (built + tested but never published to npm); that package is removed. Its tests move into core under `src/blockchain/`: 8 mocked adapter tests run in the normal gate, while the 2 real-`@stoachain` integration tests (`*.real.test.ts`) run via `npm run test:integration` — kept OUT of the publish/CI gate so a release never depends on the external chain SDK's behaviour in the CI environment.
- **Packaging.** `/blockchain/stoachain` carries dual `{ types, import, require }` conditions and is dist-smoked under both; it builds via tsup with `@stoachain/*` external, so the byte-stable `tsc` core (`.`/`/server`/`/handlers`) is untouched.

## 0.3.0 — 2026-07-13

Added the complete drop-in **codex-cronoton experience layer** — the UI, API handlers, and React data layer a consumer needs to reproduce the AncientHoldings Hub's cronoton UX end to end. The root `.` schedule engine and the `/server` automaton engine are **byte-unchanged** from 0.2.0 (verified by SHA-256 over the `dist/index.*` + `dist/server/**` outputs); this release is purely additive on new subpaths.

- **`/handlers` — framework-agnostic HTTP route handlers.** The full route surface over the `/server` store + executor — list / get / fires / signers / commit / edit / pause / resume / delete / simulate / execute-now / trigger / start-batch / get-batch / cancel-batch / recover — driven by a tiny `HandlerRequest`/`HandlerResponse` + `AuthSeam` contract so any router (Next.js route handlers, Express, …) mounts them without adaptation. Confirm-gated mutations raise a `NeedsConfirmError` the client layer re-prompts on.
- **`/provider` + `/hooks` — the React data layer.** `<KhronotonProvider adapter={…}>`, the 16-method `KhronotonAdapter` seam, two reference adapters (`createFetchAdapter` over HTTP, `createMemoryAdapter` over an in-process handler context), the shared `runGated` confirm→retry-once helper, and the data + action hooks (`useCronotons` / `useCronoton` / `useCronotonFires` [50/page + fires-while-running poller] / `useManualBatch` [batch poller] / `useCronotonActions` / the execute tier). Reference adapters keep their error contract via a shared status→seam map.
- **`/ui` + `/ui.css` — the React UI at full Hub parity.** Four screens: **List** (three access tiers, resolver pill, confirm-gated row actions), **Detail/Observe** (header actions with shared disable predicates, two-column metadata, the fire-history card with a 50/page pager, definition-drift flag, result tooltip, pluggable multi-tx renderer, and the wired recover affordance, plus the manual-batch and runtime-arg-trigger cards), **Builder** (two-pane Pact editor + Config/Payload/Gas Payer/Signatures/Execute tabs, create and edit, Simulate→AUTO-gas calibrate, commit gate), and a **Public** read-only transparency view. Styled entirely through `--khr-*` CSS variables scoped to `<KhronotonUiRoot>` — no Tailwind, no bundled assets.
- **Chain edge stays separate.** The `@stoachain/*` `ChainRuntime` implementation ships as the standalone `@ancientpantheon/khronoton-stoachain` adapter (peer-depending `@stoachain/*`), so `@ancientpantheon/khronoton-core` remains zero-runtime-dependency and chain-agnostic. `react` is an **optional peer** used only by the `/provider`, `/hooks`, and `/ui` subpaths.
- **Packaging.** All 6 JS subpaths carry dual `{ types, import, require }` conditions (dist-smoked under both `require` and `import`); `/ui.css` is a plain stylesheet export. `.tsx`/CSS entries build via tsup; `.`/`/server`/`/handlers` stay on plain `tsc` so the pre-existing outputs never move.

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
