# @ancientpantheon/khronoton-core

The headless scheduler engine of the AncientPantheon stack — pure 7-mode schedule math plus an injectable `tickOnce` tick engine. Extracted from the AncientHoldings hub's inline scheduler ("Cronoton"), generalised into a framework-agnostic library: **no database, no job queue, no framework**. Hosts inject storage and firing behaviour via hooks; the engine only decides *when* things are due and *what* to fire.

Khronoton is the "When do I act?" Constructor of the Pantheon architecture — the heartbeat that separates an autonomous Automaton from a human-triggered Daimon. See the [repo README](https://github.com/AncientPantheon/Khronoton) for the full positioning.

## Status

**`0.1.0` on public npmjs** — first published version of the headless scheduler engine. Both engines are implemented and locked by contract suites in `tests/`: the schedule math (the 7-mode model, `computeNextFire`, `summariseSchedule`, and the in-tree cron parser) and the injectable `tickOnce(now, deps)` tick engine. Consumed by the AncientHoldings hub, which injects storage and firing through the three hooks.

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

## Install

Not yet installable — the package is unpublished. Once released:

```bash
npm install @ancientpantheon/khronoton-core
```

## Version history

**v0.1.0** — First published version: 7-mode schedule engine + injectable tickOnce tick engine.

**v0.0.1** — Initial package skeleton, then the pure schedule engine: the 7-mode `ScheduleMode`/`ScheduleConfig` model, `computeNextFire` (TOTAL / MONOTONIC / PURE), `summariseSchedule`, `InvalidScheduleConfigError`, and an in-tree 5-field UTC cron parser — lifted faithfully from the AncientHoldings hub and locked by four contract suites. Then the injectable `tickOnce(now, deps)` tick engine: three host-injected hooks (`loadDue`/`enqueueFire`/`persistNextFire`), enqueue-before-persist firing, per-row isolation, an engine-enforced batch cap, and `{ firedIds, skippedIds }` membership — generalised from the hub's tick loop and locked by two more contract suites. Zero runtime dependencies, plain-`tsc` ESM build to `dist/`. Still unpublished.

## License

Proprietary — **all rights reserved** by AncientHoldings (ancientholdings.eu). See [LICENSE](./LICENSE).

This package is published for the operational convenience of AncientHoldings and its own systems. Public availability on the registry grants **no** license or right to any third party: no use, copying, modification, or distribution is permitted without the prior explicit written consent of AncientHoldings. Not open source.
