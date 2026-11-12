# @ancientpantheon/khronoton-core

The headless scheduler engine of the AncientPantheon stack — pure 7-mode schedule math plus an injectable `tickOnce` tick engine. Extracted from the AncientHoldings hub's inline scheduler ("Cronoton"), generalised into a framework-agnostic library: **no database, no job queue, no framework**. Hosts inject storage and firing behaviour via hooks; the engine only decides *when* things are due and *what* to fire.

Khronoton is the "When do I act?" Constructor of the Pantheon architecture — the heartbeat that separates an autonomous Automaton from a human-triggered Daimon. See the [repo README](https://github.com/AncientPantheon/Khronoton) for the full positioning.

## Status

**`0.12.0` on public npmjs** — **MINOR.** Released 2026-11-11. Any codex-cronoton can now opt into a public, unauthenticated, token-gated observability view of its schedule, health, and fire history — the concrete driver being a UI that wants to embed a cronoton's next-fire time and recent executions on a public-facing page, without exposing the authenticated admin surface. New `public_token`/`public_observable` columns (added via a new `ensureColumn` upgrade helper — the first time `installSchema` has needed to add a column to an already-provisioned database, not just a fresh install); a new `server/store/public.ts` surface (`setPublicObservable`, `getCodexCronotonByPublicToken`, `getCronotonFireCounts`, `deriveCronotonHealth`, `toPublicCronotonView`); and a new `handlers/public.ts` `publicCronotonHandler` that deliberately never calls `ctx.auth` — gated purely on token validity plus the observable flag, with an unknown token and a known-but-non-observable token returning the identical 404. The sanitizing projector never includes `pact_code`, `payload_json`, `signers_json`, `gas_payer_json`, `server_resolver`, `created_by`, `config_json`, raw fire error text, or the internal row `id` — the public token is the only public identifier. **1027 specs pass.**

**`0.11.0` on public npmjs** — **MINOR.** Released 2026-09-17. Two independent handoffs, shipped together. **Editor Save:** an always-visible edit-mode `SaveBar` (Simulate + Save changes + live status) now renders on every tab, gated on the edited row having actually loaded so it can never fire a Simulate against a blank default state; the Execute tab's own Commit button is edit-aware ("Save changes"); a new shared `useCommitGate(state, sim)` hook keeps both surfaces reading the identical commit body and gate, computed once. **Auto self-calibrating gas:** `autoGasLimit` now defaults to `true` for new cronotons; `ChainClient` gains optional `preflightRead` (accurate gas via the SDK's preflight mode, replacing `dirtyRead`'s execution-only measurement for AUTO fires) and `getBlockGasLimit` (a live block-ceiling fetch with a static fallback); a transaction whose measured gas exceeds the resolved ceiling is now refused with a structured error — never silently capped or submitted — for both AUTO and MANUAL fires, with the ceiling itself validated against `NaN`/non-finite/non-positive values before use. **980 specs pass.**

**`0.10.0` on public npmjs** — **MINOR.** Released 2026-09-08. The Builder's absolute "Gas Price (ANU)" field is gone: the UI now shows a read-only, live-refreshing "Live Network Floor" plus an editable "Priority Buffer (ANU above floor)" (default 0), and every fire prices as `liveFloor(creationTime) + buffer`. New optional `CodexTxConfig.gasPriceBufferAnu` (absent/pre-migration rows default to 0, self-healing with no DB migration); `gasPrice` stays, `@deprecated`, for reading historical rows. `ChainRuntime.gasMeta` gains an optional 2nd `bufferAnu` param (non-breaking) — the adapter sums floor+buffer **in ANU** before the one conversion, not two summed STOA floats. A negative/non-finite buffer can never underprice a fire — enforced at three layers: client `validateConfig`, the store's `commitCodexCronoton`/`editCodexCronoton` (reject before any write), and the seam's own defensive clamp. New `useLiveGasFloor()` hook polls every 30s plus visibilitychange/focus. `BuilderConfig.gasPriceAnu` and `CommitGateOptions.minGasPriceAnu` are **removed** (not deprecated-in-place) — both lost all meaning once there's no absolute price to floor-check. **938 specs pass** (+5 real-runtime integration specs).

**`0.9.0` on public npmjs** — **MINOR.** Released 2026-09-07. Scheduled transactions are now priced against the chain's **live** gas floor at fire time instead of a static value stored at creation time. A cronoton's `gasPrice` was persisted once at creation and read back verbatim on every tick, so as chainweb's post-fork Yin Engine floor rises, a long-lived cronoton silently drifts below it and its fire is rejected — with nobody watching a 3am tick. (Live, not theoretical: at release the floor was **11,569 ANU** against a stored default of **10,000**.) Adds an **optional** `ChainRuntime.gasMeta(floorAnu)` seam returning `{ creationTime, gasPrice }` from one clock read; the stored price becomes a **floor an operator can raise, never a cap**, so existing rows **self-heal with no migration**. `creationTime` is now stamped explicitly from the same call that produced the price (it was previously auto-stamped by the Pact builder from a second, independent clock read), and the AUTO-gas rebuild re-derives both fresh. Transaction meta uses the precision-safe `anuToStoaNumber` rather than float division. A StoaChain fire on a runtime lacking `gasMeta` **fails loudly** rather than silently reusing the stale price. Requires a coordinated bump of `@stoachain/stoa-core@^4.4.0`, `@stoachain/kadena-stoic-legacy@^4.4.0`, `@ouronet/ouronet-core@^4.6.0`. **907 specs pass** (+5 real-runtime integration specs).

**`0.8.0` on public npmjs** — **MINOR.** Released 2026-08-03. Finalizes the evented-resolver UI. **(1)** The cronoton **DETAIL** card's "Schedule" field now reads **"Evented"** for a trigger-only/evented row (it previously showed the stored schedule like "Daily at 12:00 UTC" while Next Fire already read "—"); the list and detail now share one `isTriggerOnly(row)` predicate (`external_fireable === 1 || runtime-arg keys`) so they can't drift. **(2)** A system (`server_resolver`) cronoton is now **deletable behind a confirm-gated warning** instead of a hard 409: `DELETE /[id]?force=1` permits the delete (the 409 still stands without force), threaded via `ConfirmOpts.force` + both reference adapters + the widened `remove.run({ force })`; the bundled Builder's Delete button is enabled for an admin on a system row and shows a warning naming the resolver before deleting, with the audit recording `forced: true`. Ordinary scheduled cronotons and non-forced deletes are unchanged. **893 specs pass.**

**`0.7.0` on public npmjs** — **MINOR.** Released 2026-08-03. Makes event-driven resolvers **server-authoritative**: `SingleTxResolver`/`MultiTxResolver` gain an `evented?` flag, and the **store** forces an evented resolver's cronoton scheduleless (`next_fire_at = NULL`, excluded from the due-query) **and `external_fireable = 1`** even when a schedule is sent — the guarantee no longer depends on the consumer. Adds `GET /resolvers` (+ an OPTIONAL `resolvers()` adapter method and `useServerResolvers` hook) so the Builder learns which resolvers are evented; the list shows **"Evented"** as the next-fire for a trigger-only row; and the store enforces **one resolver ↔ one cronoton** (a second bind is rejected). Deliberately reverses 0.6.0's HMAC stance — an evented row is now HMAC-fireable — codifying Pythia's shipped behavior (see version history). **871 specs pass.**

**`0.6.1` on public npmjs** — **PATCH.** Released 2026-08-02. Fixes a crash that white-screened the Khronoton admin list whenever it held ≥1 cronoton: `listCodexCronotons` returned a camelCase 9-field projection while `CronotonList` renders full snake_case rows, so `pact_code` was `undefined` and crashed `pactPreview`. The list now returns full `CodexCronotonRow`s (`SELECT *`, like `getCodexCronoton`) and `pactPreview` guards a missing `pact_code`. **850 specs pass.**

**`0.6.0` on public npmjs** — **MINOR.** Released 2026-08-02. Server resolvers can now declare themselves **event-driven** (`ServerResolverOption.eventDriven`): selecting one in the Builder commits the cronoton scheduler-off (`next_fire_at = NULL`, never auto-fired) and swaps the schedule editor for an event-driven notice — the host fires it in-process via the existing `executeNow` (not the HMAC endpoint). Ordinary scheduled resolvers are unchanged. **848 specs pass.**

**`0.5.0` on public npmjs** — **MINOR.** Released 2026-08-02. The Builder screen's Pact-code editor is now syntax-highlighted (via the package's `--khr-*` theme tokens, five new ones added), moved to a full-width top strip (~7 lines, internal scroll) with the header/tabs/tab content full-width below it, and gained a live tx-size/gas metering strip. `@uiw/react-codemirror` + the CodeMirror/Lezer packages it now depends on for highlighting are real optional `peerDependencies`. **832 specs pass.**

**`0.4.2` on public npmjs** — **PATCH.** Released 2026-07-22. Aligns the `peerDependenciesMeta` key with the `@ouronet/ouronet-core` peer renamed in 0.4.1 (the meta entry still named the old `@stoachain` peer). No code change. **799 specs pass.**

**`0.4.1` on public npmjs** — **PATCH (dependency rename, no code change).** Released 2026-07-22. `@stoachain/ouronet-core` → `@ouronet/ouronet-core` — same code, new scope, following the Phase-4 split into OuroborosNetwork/ouronet-libs. **799 specs pass.**

**`0.4.0` on public npmjs** — the complete drop-in codex-cronoton experience, matching the AncientHoldings Hub, now **chain-polyglot**. On top of the byte-unchanged root `.` schedule engine and `/server` automaton engine (both from 0.2.0), the package ships the whole experience layer as subpaths so a consumer wires the Hub's cronoton UX end to end without re-implementing it:

- **`/handlers`** — framework-agnostic HTTP route handlers over the `/server` store + executor (list/get/fires/signers/commit/edit/pause/resume/delete/simulate/execute-now/trigger/batch/recover), driven by a tiny `HandlerRequest`/`HandlerResponse` seam so any router (Next.js, Express, …) can mount them.
- **`/provider` + `/hooks`** — the React data layer: `<KhronotonProvider adapter={…}>`, the 16-method `KhronotonAdapter` seam with two reference adapters (`createFetchAdapter` over HTTP, `createMemoryAdapter` over in-process handlers), the shared `runGated` confirm-retry, and the data + action hooks (`useCronotons`/`useCronoton`/`useCronotonFires`/`useManualBatch` + the lifecycle/execute action hooks).
- **`/ui` + `/ui.css`** — the React UI at full Hub parity: the four screens **List**, **Detail/Observe** (fire history with 50/page pager, definition-drift flag, result tooltip, pluggable multi-tx renderer, wired recover), **Builder** (syntax-highlighted Pact-code editor full-width on top, Config/Payload/Gas Payer/Signatures/Execute tabs full-width below, Simulate→AUTO-gas calibrate, a live tx-size/gas metering strip), and a **Public** read-only transparency view — themed entirely through `--khr-*` CSS variables inside `<KhronotonUiRoot>`.

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

## Public observability (`public_token` / `publicCronotonHandler`) — since 0.12.0

Every cronoton can opt into a **public, unauthenticated, read-only** view of
its own state — schedule, status, health, and complete fire history — for a
host that wants to embed "next mint at…" + recent executions on a
public-facing page without exposing its authenticated admin surface at all.
**Off by default.** Nothing is public until an admin explicitly flips it on
for that one cronoton.

**1. Opt a cronoton in** (admin-side, through your own authenticated route —
this call has no auth of its own, same as every other `/server` store
function):

```ts
import { setPublicObservable } from '@ancientpantheon/khronoton-core/server';

const { publicToken } = setPublicObservable(cronotonId, { observable: true }, { db });
// publicToken is minted ONCE, the first time a row goes observable, and is
// STABLE across later observable:false -> observable:true toggles (so an
// embed URL built from it never has to be re-minted). Pass
// { observable: true, regenerate: true } to force a fresh token instead
// (e.g. if the old one leaked). { observable: false } hides the cronoton
// again WITHOUT clearing the stored token, so re-enabling reuses it.
```

Build your public embed URL from `publicToken` — it's an opaque,
160-bit (`crypto.randomBytes(20)`, base64url) string, not the cronoton's
internal `id`. The internal `id` never appears anywhere in the public
surface.

**2. Mount the route** (host-side, any router — this one handler is the
entire public surface):

```ts
import { publicCronotonHandler } from '@ancientpantheon/khronoton-core/handlers';

// e.g. a Next.js API route: pages/api/public/cronoton/[token].ts
export default async function handler(req, res) {
  const result = await publicCronotonHandler(
    { db, runtime, resolver, auth: yourAuthSeam }, // auth is REQUIRED by the
                                                     // HandlerContext type but
                                                     // is NEVER actually called
                                                     // by this one handler —
                                                     // any AuthSeam satisfies it
    { params: { token: req.query.token }, query: req.query },
  );
  // YOUR responsibility, not this package's: Cache-Control + CORS.
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.setHeader('Access-Control-Allow-Origin', '*'); // or your embed's origin
  res.status(result.status).json(result.body);
}
```

Unlike every other handler in `/handlers`, `publicCronotonHandler`
**deliberately never calls `ctx.auth`** — that's not an oversight, it's the
whole point: this route's trust boundary is "does this token resolve to an
observable row," entirely independent of whatever your admin `AuthSeam`
would otherwise require. An unknown token and a known-but-currently-disabled
token return the **identical** `404 { error: "not found" }` — the two cases
are indistinguishable on purpose, so a probing request can never learn
whether a given token ever existed.

**3. The response**, for a known, currently-observable token:

```jsonc
{
  "ok": true,
  "name": "DailyStoicismMint",
  "description": "Mints the daily Stoicism allotment",
  "status": "active",                 // active | paused | completed | error
  "schedule": { "mode": "daily-at-utc", "humanText": "Daily at 18:00 UTC" },
  "triggerOnly": false,                // true = fires on demand (event/HMAC/runtime-arg), no timer
  "nextFireAt": "2026-11-11T18:00:00.000Z",
  "lastFireAt": "2026-11-10T18:00:00.000Z",
  "isOverdue": false,                  // active + scheduled + nextFireAt already passed
  "since": "2026-01-01T00:00:00.000Z", // row's created_at
  "counts": {
    "fired": 42, "succeeded": 41, "failed": 1,
    "lastSuccessAt": "...", "lastFailureAt": "...",
    "currentFailStreak": 0,            // consecutive failures ending at the most recent fire
    "successRatePercent": 98
  },
  "health": "healthy",                 // healthy | degraded | down — derived traffic light
  "fires": {
    "page": [
      { "firedAt": "...", "status": "success", "chainId": "0", "requestKey": "...", "txKeys": [], "recoveredAt": null, "mode": "live" }
    ],
    "total": 42, "limit": 50, "offset": 0  // ?limit=&offset= page the COMPLETE history, not just "last 20"
  }
}
```

**Never present, under any circumstances:** `pact_code`, `payload_json`,
`signers_json`, `gas_payer_json`, `server_resolver`, `created_by`,
`config_json`, a fire's raw `errorMessage`/`chainResponse`, or the internal
row `id`. A fire's `status` already says `"failure"` when relevant — no raw
error text ever ships alongside it. See
`src/server/store/public.ts`'s `toPublicCronotonView` for the one place this
guarantee is enforced (it builds the response field-by-field and never
spreads the underlying row/fire objects).

`health` is a simple derived traffic light, not a new source of truth:
`"down"` once `currentFailStreak` hits 3, `"degraded"` at 1–2 or whenever
`isOverdue` is true, `"healthy"` otherwise — call `deriveCronotonHealth`
yourself if you need the same rule outside this response shape.

## Install

```bash
npm install @ancientpantheon/khronoton-core
```

## Version history

**v0.12.0** — Opt-in public cronoton observability. A cronoton's state (schedule, status, fire history, success/fail counts) was previously visible only through the authenticated admin surface (`listHandler`/`getHandler`/`firesHandler` behind `withRead` + the host's `AuthSeam`) — nothing let a host expose one cronoton's state to an unauthenticated, cross-origin caller (the concrete driver: embedding a mint's next-fire time + recent executions in a public-facing page), and this is framed as a general capability, not a one-off. **Schema.** Two new `codex_cronotons` columns: `public_token TEXT` (unique, nullable) and `public_observable INTEGER NOT NULL DEFAULT 0` (off by default). SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so `installSchema` (`server/schema.ts`) gains a small reusable `ensureColumn(db, table, column, columnDefSql)` helper (`PRAGMA table_info` → conditional `ALTER TABLE ADD COLUMN`), called once for each new column, immediately after `CREATE TABLE IF NOT EXISTS` — the FIRST time this package has needed to add a column to an already-provisioned database rather than just a fresh install, since the same call handles both a brand-new DB (the columns are absent from the `CREATE TABLE` literal) and an existing host's DB identically. A `CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_cronotons_public_token` follows — SQLite's unique index already permits multiple `NULL`s, so non-observable rows with no token never collide. **Store (`server/store/public.ts`).** `setPublicObservable(id, { observable, regenerate? }, dep)` toggles `public_observable` and mints `public_token` lazily: once, the first time a row is made observable (`crypto.randomBytes(20).toString("base64url")`), and never again on a plain disable→re-enable toggle — stable, so an embed URL built from the token never needs re-minting; `regenerate: true` is the only way to force a new one. A call against an unknown id throws the existing `CodexCronotonValidationError("not found")` — no new error type. `getCodexCronotonByPublicToken(token, dep)` resolves a row with one query (`WHERE public_token = ? AND public_observable = 1`), so an unknown token and a known-but-non-observable token are **indistinguishable** — both `null` — matching the "never 403, never leak which" rule one layer up in the handler. `getCronotonFireCounts(id, dep)` computes whole-history aggregates independently of any paginated fires window (a page of 20 out of 150 fires would under-report every aggregate): one query for `fired`/`succeeded`/`failed`/`lastSuccessAt`/`lastFailureAt`, plus a DESC-ordered scan (capped at 1000 rows) counting leading `'failure'` statuses for `currentFailStreak` — the scan stops at the first non-failure, so a success anywhere further back in the history never dilutes the trailing streak count. `deriveCronotonHealth({ currentFailStreak, isOverdue })` is a pure, standalone traffic-light rule: `"down"` at a streak ≥ 3, `"degraded"` at 1–2 or when overdue, `"healthy"` otherwise. `toPublicCronotonView(row, counts, firesPage, now?)` is the sanitizing projector and the ONLY place the privacy guarantee is enforced — it builds the DTO field-by-field from the row/fires, never spreading either, so `pact_code`, `payload_json`, `signers_json`, `gas_payer_json`, `server_resolver`, `created_by`, `config_json`, a fire's raw `errorMessage`/`chainResponse`, and the internal row `id` can never ride along by accident; the public token is the only public identifier the view carries. The view includes `schedule.humanText` (via `summariseSchedule`) and `schedule.cron` only for a `cron-expression` row, `triggerOnly` (reusing `rowExternalFireable`), `isOverdue` (true only for an `active` row whose `next_fire_at` has passed — overdue only makes sense for a row the scheduler is actually ticking), and a `fires` page whose `total`/`limit`/`offset` are passed through from `listFires` verbatim, not recomputed. **Handler (`handlers/public.ts`).** `publicCronotonHandler(ctx, request)`, added to the barrel, is a framework-agnostic `GET /<token>` route that is **unauthenticated by design** — it never calls `ctx.auth`/`withRead`/`withConfirm` at all, a deliberately different trust tier than the admin gates, authorizing purely on token validity plus the `public_observable` flag. Returns `{ status: 404, body: { error: "not found" } }` for both an unknown token and a known-but-non-observable one (byte-identical, never distinguishable), `200` with the sanitized view otherwise. `limit`/`offset` are parsed from `request.query` with a local, file-private copy of `read.ts`'s `firesHandler` clamp (1..100, default 50) — `read.ts`'s own `clampInt`/`firstScalar` are module-private, so this is a deliberate duplicate rather than a cross-handler import — over the cronoton's **complete** fire history, not a fixed "last 20": a cronoton with 150 fires is fully reachable across repeated calls with increasing `offset`, and `fires.total` always reports 150 regardless of the requested window. Cache-Control and CORS stay entirely host-side, unchanged package convention (`HandlerResponse` carries no headers field). Entirely additive — no existing export, column default, or admin-surface response shape changes for a cronoton that never opts in. Reviewed via nectar across 4 rounds (correctness/conventions/security/tests lenses each round, adversarial validation throughout, 16 CONFIRMED findings total, zero REFUTED, zero STYLISTIC): round 1 (7 findings) caught the two most significant — a `triggerOnly` gap that missed a plain-`eventDriven` cronoton (no persisted column distinguishes it; fixed by gating on `next_fire_at === null` excluding terminal one-time rows) and a clamp-default mismatch (the handler's own doc comment and CHANGELOG claimed parity with the admin `firesHandler`'s default of 50 while actually defaulting to 20) — plus an `ORDER BY` tiebreak gap, a `modified_at` omission, and two test-coverage gaps; round 2 re-verified round 1's fixes and caught that the `triggerOnly` fix's own comment asserted a false invariant (`claimDueCodexCronoton` also nulls `next_fire_at` on an ordinary row, not just the terminal-intent writer), plus two more test gaps; round 3 found the round-1 `ORDER BY` tiebreak itself was wrong — it sorted on the fire row's random `crypto.randomUUID()` id instead of a chronological key, fixed to SQLite's implicit `rowid` — plus two more test-coverage gaps; round 4 added a `mapStoreError` safety net this one unauthenticated handler had been missing (every sibling handler gets it for free from `withRead`/`withConfirm`) and closed the last two test gaps (`health`'s wiring inside the projector, and the fail-streak's 1000-row cap); round 5 found that round 4's own safety net had a real (if narrow) hole — a malformed `chain_response_json` row's `JSON.parse` failure was uncaught in `server/store/fires.ts`'s shared `listFires` (unlike its sibling `parseTxKeys`, which already tolerated bad input), and Node 20+'s V8 embeds a snippet of the actual malformed input text in that error's message — which `mapStoreError`'s generic passthrough would then have forwarded verbatim into the public route's 500 body, bypassing `toPublicCronotonView`'s sanitization entirely. Fixed at the root (`fires.ts` gains the same try/catch-degrade-to-null guard as `parseTxKeys`, benefiting every current and future caller of `listFires`, not just this one route) rather than only patched at this one call site. Full history in `docs/work/public-cronoton-observability/review.md`. Released 2026-11-11. **1027 specs pass.**

**v0.11.0** — Discoverable edit-mode Save + auto self-calibrating gas. Two independent handoffs built and shipped together. **Editor Save.** Editing an existing cronoton had no discoverable Save — the only action was the "Commit Codex Cronoton" button on the last (Execute) tab, silently disabled under AUTO gas until a Simulate ran, with the reason invisible from any other tab. Adds an always-visible edit-mode `SaveBar` (`ui/builder/SaveBar.tsx`) — Simulate, Save changes, and a live status line — rendered above the Pact editor/tabs on every tab, gated on `Builder.tsx`'s `editReady` (the edited row having actually finished loading) so it can never fire a Simulate against the blank default `makeEmptyBuilderState()` during the load window. The Execute tab's own Commit button is now edit-aware ("Save changes" / "Saving…"); create mode is byte-identical to before. A new shared `useCommitGate(state, sim)` hook (`ui/builder/use-commit-gate.ts`), extracted from `ExecuteTab.tsx`'s own prior inline logic, is called ONCE in `Builder.tsx` and threaded as `commit`/`gate` props to both `SaveBar` and `ExecuteTab` — no risk of two independent `builderToCommit`/`canCommit` call sites drifting apart, and no duplicate computation on every keystroke when both are mounted. Both of `SaveBar`'s buttons are `canMutate(access)`-gated in their CLICK HANDLERS, not just their `disabled` attribute (a directly-dispatched click event still reaches a React handler regardless of the DOM disabled state). **Auto self-calibrating gas.** Khronoton transactions defaulted to a fixed, manually-set gas limit, so fires over-reserved gas wildly — a real pool-payout fire measured 594 gas used against a 600,000 limit. `makeEmptyBuilderState()`'s `config.autoGasLimit` now defaults to `true`. `ChainClient` (`server/seams.ts`) gains two new optional methods: `preflightRead` — implemented in `blockchain/stoachain.ts` via the SDK's raw `local(tx, {preflight:true, signatureVerification:false})`, NOT its `.preflight` convenience alias (which also forces `signatureVerification:true`) — measures the TRUE gas including the transaction-size charge that plain `dirtyRead` omits; `getBlockGasLimit` does a best-effort `/config` fetch (mirroring OuronetUI's `gas-limits.ts`, ported without its browser-oriented module-level mutable-singleton cache — this package fetches fresh per fire instead, since a Node server core handling concurrent fires can't safely share that kind of global state) falling back to the existing static `AUTO_GAS_CEILING` on any failure. `executor.ts`'s `runSimulate`/`runFire` were reordered so the `ChainClient` is constructed BEFORE ceiling resolution (ceiling resolution needs it) — a real sequencing fix, not just an addition. AUTO-gas fires now calibrate from `preflightRead`; a runtime missing it hard-throws on an AUTO-gas fire only (mirroring the 0.9.0 `gasMeta` precedent — silent fallback would ship the exact over-reservation bug this exists to fix), while a MANUAL-gas fire on the same un-upgraded runtime is completely unaffected. A new refuse-unmineable check returns a structured `{ok:false, error}` — never a silent cap, never a submit — when measured gas exceeds the resolved ceiling, for BOTH AUTO and MANUAL fires. The ceiling itself (from either the live fetch or an explicit `Config.autoGasCeiling` override) is validated via a new `isSaneCeiling` check (`Number.isFinite && > 0`) before use — `NaN` in particular would otherwise silently defeat the refuse check entirely, since every `gasUsed > NaN` comparison is `false` in JS. Reviewed via nectar (2 rounds, 5 lenses then a targeted 2-lens re-pass, adversarial validation throughout): 9 CONFIRMED findings fixed, including two initially-HIGH findings (the `SaveBar` pre-load readiness gap; its originally-unguarded Simulate click) validated down to MEDIUM once the actual blast radius was traced against the code (Save itself stayed correctly disabled during the load window; the server independently re-authorizes via its own `withConfirm`/`auth.requireConfirm` gate regardless of what the UI allows). Full history in `docs/work/khronoton-editor-save-and-auto-gas/review.md`. Released 2026-09-17. **980 specs pass.**

**v0.10.0** — Locked live-floor gas + priority buffer. 0.9.0 made the executor floor a *stored* absolute price against the live Yin Engine floor so a fire could no longer underprice, but the Builder UI still framed gas price as something an operator *sets* — the wrong model for a recurring transaction, since any absolute number typed today is guaranteed to go stale as the live floor keeps rising every ~3h. This finishes the redesign: the UI shows a read-only, live-refreshing "Live Network Floor" display plus an editable "Priority Buffer (ANU above floor)" (default 0), and every fire prices as `liveFloor(creationTime) + buffer`, derived fresh at build time — never a cached/stored absolute value. **Schema.** `CodexTxConfig` gains optional `gasPriceBufferAnu`; `gasPrice` stays, `@deprecated`, read-only, so historical `config_json` still parses — absence (every pre-migration row) defaults to 0, self-healing with no DB migration. **Seam.** `ChainRuntime.gasMeta(floorAnu, bufferAnu?)` — the buffer is a new optional 2nd parameter (non-breaking: TypeScript accepts a shorter existing implementation as satisfying the widened optional signature). The adapter (`blockchain/stoachain.ts`) sums `floorAnu + bufferAnu` **in ANU**, inside the adapter, before the **one** `anuToStoaNumber` conversion at the end — summing two independently-converted STOA floats instead produces a different serialized value in roughly 1 in 5 floor/buffer pairs, reintroducing the exact precision bug 0.9.0 fixed. `buildTransaction` always calls `gasMeta(0, config.gasPriceBufferAnu ?? 0)` now — there is no more stored absolute value to raise to a floor, so the seam's first argument is always 0. **Defense in depth.** A negative or non-finite buffer can never underprice a fire, enforced at three independent layers: `ui/builder-state.ts`'s `validateConfig` blocks commit client-side; `server/store/cronoton.ts`'s `commitCodexCronoton`/`editCodexCronoton` reject a present-and-invalid `gasPriceBufferAnu` before any write, so a caller reaching the store directly (bypassing the Builder UI) can't persist a row that silently underprices every future fire; and `blockchain/stoachain.ts`'s `gasMeta` clamps a bad buffer to 0 as a third line of defense for any `CodexTxDefinition` built outside the store entirely. **Live display.** New `useLiveGasFloor()` hook (`ui/builder/live-gas-floor.ts`) polls the live floor every 30s plus a `visibilitychange`/`focus` refresh — browsers throttle `setInterval` in backgrounded tabs, and this Builder screen is routinely left open for hours — called once in `Builder.tsx`, threaded to `ConfigTab` and `ExecuteTab`. **Precision fix applied a second place.** `ui/tx-size.ts`'s size estimator now uses the same floor+buffer-summed-in-ANU-then-converted-once formula the executor uses, instead of the deprecated absolute `gasPrice`. **Breaking at the UI-type layer.** `BuilderConfig.gasPriceAnu` and `CommitGateOptions.minGasPriceAnu` are **removed**, not deprecated-in-place — both lose all meaning once there is no absolute price to floor-check against, and keeping them would be actively misleading; `CodexTxConfig` itself stays additive. Reviewed via nectar across 3 rounds (5 lenses each, adversarial validation): round 1 found and fixed a HIGH gap (server-side validation of the buffer was entirely absent) plus 5 lower-severity test-coverage/UI gaps; round 2 re-verified those fixes and caught 3 more small issues (a misleading UI label, duplicated validation logic, a test-loop robustness nit); round 3 caught one last barrel-export asymmetry — all fixed, full history in `docs/work/gas-price-buffer/review.md`. Released 2026-09-08. **938 specs pass** (+5 real-runtime integration specs).

**v0.9.0** — Live gas floor at fire time. `buildTransaction` priced every fire off `definition.config.gasPrice`, a plain ANU number persisted in `codex_cronotons` at creation time and read back verbatim on every tick (`server/tick.ts`, `server/store/mappers.ts`) — never re-derived. Post-fork, chainweb-node validates a signed transaction's price against the rising Yin Engine floor **as of that transaction's own `creationTime`**, so a cronoton created at the builder's 10,000 ANU default is already underpriced and drifts further as it ages; because this is unattended automation, the rejection surfaces at 3am with nobody watching. **The seam.** `ChainRuntime` gains an **optional** `gasMeta(floorAnu): { creationTime, gasPrice }`. Optional keeps the package chain-POLYGLOT and `@stoachain/*` an optional peer dependency — a chain without a rising floor omits it — but the executor **hard throws** when a StoaChain fire finds it missing, because a silent fallback to the stored value would ship the original bug to anyone who did not notice they must upgrade their adapter. In `fire` mode that throw is caught by the existing F-002 wrapper and returned as a structured `{ ok: false, error }`, so a one-time entry still records its spent attempt instead of re-firing forever. **Floor, not cap.** The implementation returns `max(storedAnu, minGasPriceAnu(creationTime))`, so an operator may still price above the minimum and existing stored rows self-heal with **no database migration**. **One clock read.** `setMeta` previously omitted `creationTime` entirely, letting the Pact builder auto-stamp its own at `createTransaction()` — an independent second read the price no longer corresponded to. Both fields now come from a single `stoaGasMeta()`-derived call, and the AUTO-gas calibrated rebuild+re-sign re-enters the seam rather than reusing the pre-flight values, so the two builds cannot straddle a 3-hour tick boundary and underprice the transaction that actually ships (pinned by a regression spec that fails if the call is hoisted out of `buildTransaction`). **Precision.** Transaction meta now converts via `anuToStoaNumber` (exact padded-decimal) instead of `anuToStoa` (float division), which upstream documents as unsafe for a value chainweb hashes and validates exactly; the same fix lands in `ui/tx-size.ts`'s fee meter, whose purpose is predicting the real signed transaction's byte size. **Builder gate.** `validateConfig` accepts `CommitGateOptions.minGasPriceAnu` in place of a hardcoded `>= 10000` check that accepted already-underpriced values, and names the applied floor in its message; omitting it falls back to the genesis floor, under-rejecting rather than over-rejecting since the executor raises the price at fire time regardless. **Boundary.** `blockchain/stoachain.ts` is the only module that knows the Yin Engine exists, wrapping `@stoachain/stoa-core/gas` rather than reimplementing a formula already independently reimplemented four times across the ecosystem; `/server` stays free of any `@stoachain/*` import. Requires a coordinated dependency bump — stoa-core 4.4.0 peer-pins kadena-stoic-legacy 4.4.0 exactly, and only ouronet-core 4.6.0 accepts stoa-core 4.4.0, so the three move together. All new surface (`StoaGasMeta`, `ChainRuntime.gasMeta`, `CommitGateOptions.minGasPriceAnu`) is additive. Released 2026-09-07. **907 specs pass** (+5 real-runtime integration specs).

**v0.8.0** — Finalizes the evented-resolver UI (the last two gaps after 0.7.0). **Fix 1 — DETAIL "Schedule" reads "Evented".** The read-only cronoton detail card rendered the stored `schedule_config` (e.g. "Daily at 12:00 UTC") for a trigger-only/evented row even though Next Fire already showed "—" and the edit form already disabled the scheduler; root cause was `Detail.tsx` deriving `triggerOnly` from runtime-arg keys only, ignoring `external_fireable`. The list's predicate is extracted to a shared `isTriggerOnly(row)` (`row.external_fireable === 1 || parseRuntimeArgKeys(row.runtime_arg_keys).length > 0`) in `ui/row-derive.ts`, used by both the list next-fire cell and the detail Schedule cell so they can't drift; the detail Schedule cell now reads **"Evented"** for a trigger-only row. **Fix 2 — confirm-gated system delete.** `DELETE /[id]` hard-refused any `server_resolver` ("system") cronoton with `409 { protected: true }`; it now accepts `?force=1` (still behind the admin confirm gate) to permit the delete, while the 409 stands without force. Threaded end-to-end: `ConfirmOpts.force` → `createFetchAdapter` sends `?force=1` / `createMemoryAdapter` passes `query: { force: "1" }` → the widened `DeleteAction`/`remove.run({ force })` action hook. In the bundled Builder, `deleteDisabled` now **enables** the Delete button for an admin on a system cronoton (non-admins still blocked), and both the detail and list `handleDelete` show a `deleteSystemConfirm` warning naming the resolver — *"This is the automaton's `<name>` template. Deleting it stops that capability until it's recreated. Delete anyway?"* — as the first prompt, keeping the existing in-gate password confirm. The delete audit is preserved and records `forced: true` for a forced system delete. Ordinary scheduled cronotons, non-system deletes, and `delete(id)`/`remove.run()` without force are byte-identical to 0.7.0; a system delete without force still 409s. All new surface (`ConfirmOpts.force`, `DeleteRunOpts`, `deleteSystemConfirm`, `row-derive`'s `isTriggerOnly`) is additive. Released 2026-08-03. **893 specs pass.**

**v0.7.0** — Server-authoritative evented resolvers. `SingleTxResolver`/`MultiTxResolver` gain an optional `evented?` flag; the **store** (`createCodexCronoton`/`editCodexCronoton`, via an acyclic `getServerResolver` lookup) forces an evented resolver's cronoton `next_fire_at = NULL` **and `external_fireable = 1`** even when a real schedule is committed, so the scheduleless guarantee lives in the package rather than each consumer's proxy (`fetchDueCodexCronotons` skips it; an evented→non-evented edit re-arms `next_fire_at` and clears `external_fireable`; a genuine non-evented external-fireable row is never clobbered). A new `GET /resolvers` handler + `listServerResolvers()` expose `{ name, kind, evented }`; the `KhronotonAdapter` read tier gains an **OPTIONAL** `resolvers()` method (both reference adapters implement it, but it is **not** in `REQUIRED_METHODS`, so older adapters still pass `assertAdapter`), consumed by the new `useServerResolvers` hook. The Builder makes `eventDrivenResolver` server-authoritative (registry `evented` OR the 0.6.0 `serverResolverOptions.eventDriven` fallback), commits `externalFireable: true` for an evented resolver (derived at commit time — never stuck when switching away), and the `CronotonList` next-fire cell reads **"Evented"** for a trigger-only row (`external_fireable === 1` or runtime-arg keys). The store also enforces **one resolver ↔ one cronoton** — a second `createCodexCronoton` reusing a bound `server_resolver` throws `CodexCronotonValidationError` naming the existing id (→ 400). **Deliberate reversal of 0.6.0's HMAC stance:** an evented row is now `external_fireable = 1` and thus HMAC-fireable — a conscious choice codifying Pythia's already-shipped production behavior (v2.7.19/2.7.20), giving one persisted signal the store, Builder, and list all read; manually firing an evented resolver just re-runs its idempotent resolve (no-ops when nothing is ready). The published 0.6.0 `eventDriven` surface is kept intact as an additive fallback; ordinary scheduled resolvers are unchanged. Released 2026-08-03. **871 specs pass.**

**v0.6.1** — Fix a CronotonList white-screen crash on any non-empty list. `listCodexCronotons` returned a camelCase 9-field projection while the read handler declares `CodexCronotonRow[]` and `CronotonList` renders full snake_case fields — so `pact_code`/`schedule_mode`/`schedule_config_json`/`next_fire_at`/`last_fire_at`/`runtime_arg_keys`/`description`/`server_resolver` were all `undefined` and `pactPreview(row.pact_code).replace(...)` crashed. The list now returns full `CodexCronotonRow`s via `SELECT *` (matching the declared type and what the UI reads), and `pactPreview` guards a missing/non-string `pact_code` → `"(empty)"`. `CodexCronotonListItem` is now a deprecated alias of `CodexCronotonRow`. Released 2026-08-02. **850 specs pass.**

**v0.6.0** — Event-driven server resolvers. `ServerResolverOption` gains an optional `eventDriven` flag; a cronoton on an event-driven resolver commits scheduler-off (`next_fire_at = NULL`, excluded from the tick due-query) and the Builder shows an "Event-driven (host-fired)" notice instead of a schedule editor. The host fires it via the existing `executeNow` primitive, in-process — event-driven is a dedicated commit-envelope flag, deliberately NOT `externalFireable`, so it never exposes the public HMAC trigger endpoint. `server_resolver` + event-driven is allowed; `server_resolver` + `runtime_arg_keys` stays forbidden. No new DB column (the `next_fire_at = NULL` state carries it; edit and pause/resume keep it NULL). Ordinary scheduled resolvers unchanged; a non-event-driven commit body is byte-identical to 0.5.0. Released 2026-08-02. **848 specs pass.**

**v0.5.0** — Builder screen upgrade: the Pact-code editor is syntax-highlighted (keywords, definitions, types, strings, numbers, booleans, comments, `@doc`/`@model` annotations, parens/atoms — colored via new `--khr-syntax-*`/`--khr-selection` tokens, not hardcoded), moved to a full-width top strip (~7 lines, internal scroll) with the header/tab bar/tab content full-width below it as the one standard layout, and gained a live tx-size/gas metering strip (local byte estimate against StoaChain's 2 MB ceiling; gas-used-vs-limit once Simulate runs). `@uiw/react-codemirror`, `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@lezer/highlight` are now real optional `peerDependencies` instead of silently relied upon via hoisting. Released 2026-08-02. **832 specs pass.**

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
