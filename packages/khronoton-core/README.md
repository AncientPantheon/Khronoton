# @ancientpantheon/khronoton-core

The headless scheduler engine of the AncientPantheon stack — pure 7-mode schedule math plus an injectable `tickOnce` tick engine. Extracted from the AncientHoldings hub's inline scheduler ("Cronoton"), generalised into a framework-agnostic library: **no database, no job queue, no framework**. Hosts inject storage and firing behaviour via hooks; the engine only decides *when* things are due and *what* to fire.

Khronoton is the "When do I act?" Constructor of the Pantheon architecture — the heartbeat that separates an autonomous Automaton from a human-triggered Daimon. See the [repo README](https://github.com/AncientPantheon/Khronoton) for the full positioning.

## Status

**`0.4.2` on public npmjs** — **PATCH.** Released 2026-07-22. Aligns the `peerDependenciesMeta` key with the `@ouronet/ouronet-core` peer renamed in 0.4.1 (the meta entry still named the old `@stoachain` peer). No code change. **799 specs pass.**

**`0.4.1` on public npmjs** — **PATCH (dependency rename, no code change).** Released 2026-07-22. `@stoachain/ouronet-core` → `@ouronet/ouronet-core` — same code, new scope, following the Phase-4 split into OuroborosNetwork/ouronet-libs. **799 specs pass.**

**`0.4.0` on public npmjs** — the complete drop-in codex-cronoton experience, matching the AncientHoldings Hub, now **chain-polyglot**. On top of the byte-unchanged root `.` schedule engine and `/server` automaton engine (both from 0.2.0), the package ships the whole experience layer as subpaths so a consumer wires the Hub's cronoton UX end to end without re-implementing it:

- **`/handlers`** — framework-agnostic HTTP route handlers over the `/server` store + executor (list/get/fires/signers/commit/edit/pause/resume/delete/simulate/execute-now/trigger/batch/recover), driven by a tiny `HandlerRequest`/`HandlerResponse` seam so any router (Next.js, Express, …) can mount them.
- **`/provider` + `/hooks`** — the React data layer: `<KhronotonProvider adapter={…}>`, the 16-method `KhronotonAdapter` seam with two reference adapters (`createFetchAdapter` over HTTP, `createMemoryAdapter` over in-process handlers), the shared `runGated` confirm-retry, and the data + action hooks (`useCronotons`/`useCronoton`/`useCronotonFires`/`useManualBatch` + the lifecycle/execute action hooks).
- **`/ui` + `/ui.css`** — the React UI at full Hub parity: the four screens **List**, **Detail/Observe** (fire history with 50/page pager, definition-drift flag, result tooltip, pluggable multi-tx renderer, wired recover), **Builder** (two-pane create + edit, Config/Payload/Gas Payer/Signatures/Execute tabs, Simulate→AUTO-gas calibrate), and a **Public** read-only transparency view — themed entirely through `--khr-*` CSS variables inside `<KhronotonUiRoot>`.

Khronoton isn't chain-*agnostic* — it's chain-*polyglot*: the root schedule/tick engine orchestrates, and the **`/blockchain/<chain>`** subpath family teaches it to speak each supported chain's language natively (0.4.0):

- **`/blockchain/stoachain`** — `createStoachainRuntime(config?)` wraps the `@stoachain/*` runtime into the core `ChainRuntime` seam, so a StoaChain automaton injects one object instead of reaching for `@stoachain/*` directly. Future chains land as sibling subpaths (`/blockchain/<chain>`).

Each chain's SDK is an **optional peer dependency** (`@stoachain/*` for `/blockchain/stoachain`), and the adapter imports it lazily — so `npm install @ancientpantheon/khronoton-core` pulls **zero** chain SDKs, and you carry only the SDK(s) for the chain(s) you actually import. It's one package, one version, one drop-in for every automaton. Likewise React is an optional peer for the `/provider`, `/hooks`, and `/ui` subpaths only. Every JS subpath resolves under both import conditions (ESM `import` + CJS `require`); the root `.`, `/server`, and `/handlers` outputs are byte-identical to 0.3.0/0.2.0.

## Schedule engine

The engine exports pure functions over a discriminated `ScheduleConfig` union — no side effects, no clock reads, no randomness. You pass in the current time (`now`) explicitly; two calls with identical arguments always return identical results.

### The 7 schedule modes

`ScheduleMode` is one of seven string literals, each paired with its own config shape:

| Mode | Config fields | Fires |
| --- | --- | --- |
| `daily-at-utc` | `hours: number[]`, `minute: number` | At each listed UTC hour every day |
| `every-n-minutes` | `startDate: string` (ISO), `intervalMinutes: number` | Every N minutes, anchored to `startDate` |
| `weekly` | `daysOfWeek: number[]` (0–6), `hour`, `minute` | At the given UTC time on each listed weekday |
| `monthly` | `daysOfMonth: number[]` (1–31), `hour`, `minute` | At the given UTC time on each listed day of month |
| `cron-expression` | `expression: string` | Per the 5-field UTC cron expression (see below) |
| `one-time` | `fireAt: string` (ISO) | Exactly once, then terminal |
| `several-times-per-day` | `times: { hour; minute }[]` | At each listed UTC time-of-day, every day |

### `computeNextFire(mode, config, now)`

```ts
computeNextFire(mode: ScheduleMode, config: ScheduleConfig, now: Date): Date | null
```

Returns the next instant strictly after `now` at which the schedule is due. The contract is **TOTAL**, **MONOTONIC**, and **PURE**:

- **TOTAL** — a valid `(mode, config, now)` triple never throws; a malformed config throws `InvalidScheduleConfigError`. Recurring modes always yield a future `Date`. The terminal `one-time` mode yields `null` once its single fire is in the past (a valid result, not an error).
- **MONOTONIC** — for the same recurring schedule, a later `now` yields an equal-or-later next-fire; every recurring mode iterates strictly forward from `now`.
- **PURE** — no `Math.random`, no `Date.now()`; `now` is the explicit input.

```ts
import { computeNextFire } from '@ancientpantheon/khronoton-core';

computeNextFire(
  'daily-at-utc',
  { mode: 'daily-at-utc', hours: [12], minute: 0 },
  new Date('2026-06-01T00:00:00.000Z'),
); // → Date 2026-06-01T12:00:00.000Z
```

### `summariseSchedule(mode, config)`

```ts
summariseSchedule(mode: ScheduleMode, config: ScheduleConfig): string
```

Returns a short human-readable description of a schedule (e.g. `"One-time at 2026-07-01T12:00:00.000Z UTC"`). Pure — it never reads `Date.now()` or the system locale.

### In-tree cron parser

The `cron-expression` mode is backed by a pruned in-tree parser — **no `cron-parser` dependency is added**. It accepts the standard 5-field UTC shape `minute hour dayOfMonth month dayOfWeek`, with this per-field syntax:

| Syntax | Meaning |
| --- | --- |
| `*` | any value |
| `N` | a literal integer |
| `N,M,...` | a comma list |
| `N-M` | an inclusive range |
| `*/STEP` | step from the field's start |
| `N/M` | step from `N` |

Explicitly **rejected** (throws `InvalidScheduleConfigError`): `@hourly`/`@daily` and other `@macro` shorthands, a seconds field (6-field expressions), and the Quartz extensions `L`, `W`, and `#`.

`dayOfMonth` and `dayOfWeek` follow standard cron **OR-matching** when both are restricted: a day matches if it satisfies *either* field. A field written as its full range (`1-31` for dayOfMonth, `0-6` for dayOfWeek) is detected as a wildcard, so the OR only applies when both fields are genuinely restricted.

### Errors

`InvalidScheduleConfigError` is the single typed reject for malformed configs (out-of-range values, non-integer times, unparseable ISO instants, malformed cron expressions). Well-formed inputs never throw.

## Tick engine

`tickOnce(now, deps)` walks the rows that are due at `now` and fires each once, delegating all host coupling to three injected hooks. It performs no storage, queue, clock, or framework access of its own — the host supplies those through `deps`. It calls `computeNextFire` internally to decide each row's next instant.

```ts
import { tickOnce } from '@ancientpantheon/khronoton-core';
import type { TickRow, TickResult, TickDeps } from '@ancientpantheon/khronoton-core';

tickOnce(now: Date, deps: TickDeps): TickResult
```

### The three injected hooks

| Hook | Signature | Role |
| --- | --- | --- |
| `loadDue` | `(now: Date) => TickRow[]` | Return the rows due at `now`. A throw here propagates out of `tickOnce` (isolation is per-row, not batch-level). |
| `enqueueFire` | `(row: TickRow) => void` | Dispatch the fire (queue/audit). Receives the host's **full** row object — the generic engine reads only `id`/`mode`/`config`, so any extra host fields ride along untouched. |
| `persistNextFire` | `(id: string, nextDate: Date, firedAt: Date) => void` | Durably record the advance. `firedAt` is the tick's explicit `now` — never a clock read. |

A `TickRow` is `{ id: string; mode: ScheduleMode; config: ScheduleConfig | string }`. Its `config` accepts **both host forms**: a typed `ScheduleConfig` object, or a JSON string that the engine parses per-row inside the isolated try (so one unparseable row is skipped, not the whole batch).

### Result semantics

`tickOnce` returns `{ firedIds: string[]; skippedIds: string[] }`:

- **Fired** — a row's id lands in `firedIds` only when **both** `enqueueFire` and `persistNextFire` returned without throwing.
- **Skipped** — every other processed outcome lands in `skippedIds`: an unparseable config, a `computeNextFire` rejection, a throwing hook, or a spent `one-time` schedule (`computeNextFire` → `null`, a valid terminal state, not an error and not logged).
- The two sets are disjoint and together cover exactly the rows that were processed.

### Guarantees

- **Enqueue strictly before persist**, and persist runs **only after** enqueue succeeds. A crash between the two re-fires the row on the next tick rather than silently dropping it. An `enqueueFire` throw leaves `persistNextFire` uncalled for that row.
- **Per-row isolation** — each row is processed in its own `try`; one bad row is logged and skipped, and the tick continues. No status or row mutation: the engine's only write channel is `persistNextFire`, whose signature cannot express a status change.
- **Batch cap** — at most `maxBatch` rows are processed per tick (default **100**), regardless of how many `loadDue` returns. Overflow rows appear in **neither** result set; they stay due and are re-read next tick. A provided `maxBatch` that is not a positive integer (`0`, negative, fractional, `NaN`) throws a `RangeError` **before** any hook runs — never a silent zero-batch or dropped-tail.
- **Synchronous** — `tickOnce` returns a plain object, not a Promise. The engine holds no in-memory timers and carries no state across calls, so it is restart-safe: the host re-reads due state via `loadDue` each tick.

### Optional deps

- `maxBatch?: number` — override the default 100 (positive integer only; see above).
- `logError?: (message: string) => void` — redirect skip logging; defaults to `console.error`.

### Host preconditions

1. **The three hooks must themselves be synchronous.** TypeScript's `=> void` contextual typing silently accepts an `async` hook, but its returned Promise is neither awaited nor error-handled — an async hook voids the enqueue-before-persist ordering and the per-row-isolation guarantees. Async hosts are a future, separate additive API.
2. **`loadDue` must return at most one row per id.** The fired/skipped disjoint-set semantics assume unique ids; behavior under duplicate ids is unspecified.

```ts
const result = tickOnce(new Date('2026-05-24T12:00:00.500Z'), {
  loadDue: () => [
    { id: 'r1', mode: 'daily-at-utc', config: { mode: 'daily-at-utc', hours: [12], minute: 0 } },
  ],
  enqueueFire: (row) => queue.push(row.id),
  persistNextFire: (id, nextDate, firedAt) => db.advance(id, nextDate, firedAt),
});
// → { firedIds: ['r1'], skippedIds: [] }; nextDate = 2026-05-25T12:00:00.000Z, firedAt = the passed now
```

## What this package does NOT contain

Persistence, queues, timers, HTTP, or any framework binding — those stay in the host (the AncientHoldings hub keeps its own glue and imports this package for the scheduling logic). The `tickOnce` tick engine walks due schedules and invokes host hooks, but it never touches storage, queues, or clocks itself — the host injects all coupling through `loadDue`/`enqueueFire`/`persistNextFire`.

## Server engine (`/server`)

The `@ancientpantheon/khronoton-core/server` subpath is the stand-alone automaton layer: everything needed to run scheduled, signed, on-chain firing on top of the root schedule engine. It ships **no** chain client, **no** database driver, and **no** framework — the host injects those through six seams. The root `.` import (pure schedule math + `tickOnce`) is byte-unchanged and carries no server dependency.

```ts
import {
  installSchema,
  codexCronotonTickOnce,
  processDueManualBatchesOnce,
  startKhronotonLoop,
  executeCodexTransaction,
  registerServerResolver,
  fireByServerResolver,
} from '@ancientpantheon/khronoton-core/server';
```

### The six injection seams

The host provides these; the engine stays framework- and chain-agnostic:

- **`KeyResolver`** — resolves a public key to a signing keypair (`getKeyPairByPublicKey`, `listCodexPubs`). This is where the codex signs.
- **`ChainRuntime`** — the chain client + constants: a Pact builder, `createClient(url) → { dirtyRead, submit, listen }`, a universal signer, gas helpers (`calculateAutoGasLimit`, `anuToStoa`), and `networkId` / `namespace` / `getPactUrl` / `gasStationAccount`.
- **`Database`** — a minimal structural handle (`exec`, `prepare(...).run/get/all`); a `better-sqlite3` instance satisfies it structurally, but any driver of that shape works. Run `installSchema(db)` once to create the three tables.
- **`onAudit`** — a sink called once per fire with `{ action, result, targetKind, targetId, detail }`.
- **`resolveFireMode`** — synchronous `(cronotonId) => 'test' | 'live'`; a per-row `fire_mode_override='live'` wins first.
- **`Config`** — six optional knobs; each defaults when omitted:

  | Field | Default | Meaning |
  | --- | --- | --- |
  | `tickIntervalMs` | `30_000` | Loop interval |
  | `listenTimeoutMs` | `300_000` | Fire listen timeout |
  | `autoGasCeiling` | `2_000_000` | AUTO-gas pre-flight build ceiling |
  | `singleTxGasGuard` | `1_600_000` | Server-resolver single-tx gas guard |
  | `tickBatchLimit` | `100` | Rows claimed per tick |
  | `manualBatch` | `{ min: 2, max: 60, intervalSeconds: 60 }` | Manual-batch bounds + spacing |

  (There is no `gasPriceFloor` or `ttl` knob — the executor uses each cronoton's own `definition.config` gas price and TTL directly.)

### Exactly-once (claim-before-fire)

A due fire happens **once and only once**. Before firing, the tick issues an atomic conditional `UPDATE` that re-asserts the row is still due and advances its `next_fire_at` in the same statement; it fires only if that write claimed the row (`changes === 1`). Two overlapping ticks on the same row → the second claim is a no-op → no double-submit. This is the primary double-fire guard and needs **no leader election**; a multi-worker lease, if ever wanted, is the host's concern.

### Wire-in recipe (Automaton host, e.g. Mnemosyne)

```ts
import Database from 'better-sqlite3';
import { installSchema, startKhronotonLoop } from '@ancientpantheon/khronoton-core/server';

const db = new Database('automaton.db');
db.pragma('foreign_keys = ON');
installSchema(db);

const ctx = {
  db,
  resolver,        // your KeyResolver adapter
  runtime,         // your ChainRuntime adapter
  onAudit,         // your audit sink
  resolveFireMode, // () => 'test' | 'live'
  config,          // full Config (or omit fields to take the defaults above)
};

const { stop } = startKhronotonLoop(ctx); // ticks every config.tickIntervalMs; call stop() to halt
```

### API route contract (deferred)

This bump ships the engine only. Framework-agnostic HTTP handlers (create/edit/list/trigger/simulate a cronoton) are **not** included — a host writes thin routes over the exported store + `executeCodexTransaction`/`fireByServerResolver` surface. The route contract is documented for that; concrete handlers arrive in a later bump.

### Node floor

The `/server` subpath's CJS `require` condition relies on Node's `require(esm)` support (Node **≥ 20.19 / ≥ 22.12**), the same mechanism as the root's 0.1.1 `require` condition — so the effective Node floor for CommonJS consumers is ≥ 20.19. The package `engines` field stays `>=20` (unchanged), matching the root.

## Install

```bash
npm install @ancientpantheon/khronoton-core
```

## Version history

**v0.4.2** — fix dangling `peerDependenciesMeta` key (was still `@stoachain/ouronet-core`). Released 2026-07-22. **799 specs pass.**

**v0.4.1** — dependency rename, no code change. Released 2026-07-22. `@stoachain/ouronet-core` → `@ouronet/ouronet-core`. **799 specs pass.**

**v0.4.0** — Made khronoton **chain-polyglot**: added the `/blockchain/<chain>` subpath family, starting with `/blockchain/stoachain` (`createStoachainRuntime(config?)` → the core `ChainRuntime` seam, wrapping `@stoachain/*`). Each chain's SDK is an **optional peer dependency** imported lazily, so the package stays zero-SDK on install and a consumer carries only the chains it imports — one package, one drop-in for every automaton, rather than a separate npm package per chain. (This folds in the previously-separate `@ancientpantheon/khronoton-stoachain`, which is removed and was never published.) Root `.`/`/server`/`/handlers` outputs unchanged. React and `@stoachain/*` are optional peers for their respective subpaths only.

**v0.3.0** — Added the complete drop-in **experience layer** on new subpaths, byte-preserving the root `.` and `/server` outputs from 0.2.0: `/handlers` (framework-agnostic HTTP route handlers over the store + executor, behind a tiny request/response seam), `/provider` + `/hooks` (the React data layer — `<KhronotonProvider>`, the 16-method `KhronotonAdapter` seam with `createFetchAdapter`/`createMemoryAdapter` reference adapters, the shared `runGated` confirm-retry, and the data + action hooks), and `/ui` + `/ui.css` (the React UI at full Hub parity — the four screens List, Detail/Observe with the 50/page fire-history pager + definition-drift + result tooltip + pluggable multi-tx renderer + wired recover, the two-pane create/edit Builder with Simulate→AUTO-gas calibrate, and a Public read-only view — themed via `--khr-*` inside `<KhronotonUiRoot>`). Chain specifics stay out of core as the separate `@ancientpantheon/khronoton-stoachain` `ChainRuntime` adapter; core stays zero-runtime-dependency with React an optional peer for the three React subpaths. Every JS subpath resolves under both ESM `import` and CJS `require`.

**v0.2.0** — Added the server/automaton engine on the new `@ancientpantheon/khronoton-core/server` subpath (dual ESM `import` + CJS `require`), behind six injection seams (`KeyResolver`, `ChainRuntime`, `Database`, `onAudit`, `resolveFireMode`, `Config`): the store + atomic claim-before-fire (exactly-once, proven end-to-end), the headless single-transaction executor (never-throws-on-fire, dirty-read pre-flight, AUTO-gas calibrate, 504/derived-key recovery), the server tick + `startKhronotonLoop`, the server-resolver registry/dispatcher, and `installSchema` for the three tables — lifted faithfully from the AncientHoldings hub's inline `codex-cronoton` system and generalised. The root `.` schedule engine is unchanged.

**v0.1.1** — Packaging fix: added a `require` condition to the exports map so the package is a drop-in for CommonJS consumers (e.g. the hub's tsx/CJS worker) as well as ESM. No API or behaviour change from v0.1.0.

**v0.1.0** — First published version: 7-mode schedule engine + injectable tickOnce tick engine.

**v0.0.1** — Initial package skeleton, then the pure schedule engine: the 7-mode `ScheduleMode`/`ScheduleConfig` model, `computeNextFire` (TOTAL / MONOTONIC / PURE), `summariseSchedule`, `InvalidScheduleConfigError`, and an in-tree 5-field UTC cron parser — lifted faithfully from the AncientHoldings hub and locked by four contract suites. Then the injectable `tickOnce(now, deps)` tick engine: three host-injected hooks (`loadDue`/`enqueueFire`/`persistNextFire`), enqueue-before-persist firing, per-row isolation, an engine-enforced batch cap, and `{ firedIds, skippedIds }` membership — generalised from the hub's tick loop and locked by two more contract suites. Zero runtime dependencies, plain-`tsc` ESM build to `dist/`. Still unpublished.

## License

Proprietary — **all rights reserved** by AncientHoldings (ancientholdings.eu). See [LICENSE](./LICENSE).

This package is published for the operational convenience of AncientHoldings and its own systems. Public availability on the registry grants **no** license or right to any third party: no use, copying, modification, or distribution is permitted without the prior explicit written consent of AncientHoldings. Not open source.
