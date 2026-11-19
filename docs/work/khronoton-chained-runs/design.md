# Khronoton chained runs — Design

Source handoff:
`/home/ancientbox/ClaudeWS/OuroborosNetwork/_onchain/Ouronet/OuronetInformational/HANDOFFS/HANDOFF-khronoton-chained-runs.md`
(2026-11-18). This design shapes **Phase 0 + Phase 1 only**, per the request.
Phases 2–6 are listed at the bottom as future topics, shaped in turn.

Every file:line citation below was independently re-verified against the
current `packages/khronoton-core` source (not re-trusted from the handoff).
All of them check out. Two things the handoff got wrong, worth surfacing
before the design itself:

- **The tag-reconciliation note is stale.** §6 says "latest tag is v0.9.0,
  0.10–0.12 are untagged." That's not true of this repo right now — `v0.9.0`
  through `v0.12.0` are all tagged and all published (I did the `v0.12.0`
  tag/publish myself earlier this session, after the handoff's stated
  write date). Nothing to reconcile before the next release.
- **`store/fires.ts`'s cited line numbers (~162-163) have drifted** to ~145
  after my own `parseChainResponse` addition earlier this session. The
  substance the handoff quotes ("tx_keys_json is an unordered de-duplicated
  bag") is still accurate, just a few lines lower.

Neither changes anything about §1's core finding, which is the one that
matters and which I re-verified line-for-line: `loop.ts:53-67`'s `running`
boolean really does guard the whole pass, `tick.ts:140` really does `await
fireByServerResolver` inline, and `executor.ts:412-423` really does derive
the request key before submit. The inversion is real and Phase 0 is correctly
identified as the keystone.

## Problem

The scheduler awaits a fire's confirmation inline, inside a single-pass
`setInterval` guarded by one `running` boolean (`loop.ts:53-67`). That's fine
for a single transaction with a 5-minute `listen` ceiling. It cannot work for
a chained, fanned-out run: four evict legs awaited serially would freeze the
*entire* scheduler — every cronoton, not just this one — for up to twenty
minutes. A chained run cannot be "a longer await inside the tick"; the engine
has to stop awaiting confirmation and start polling it across ticks.

Driving job: drain+wrap (1 tx) → inject (1 tx or N SERIAL cursor-paged legs) →
evict (1 tx or N PARALLEL fed-slice legs), sequential between steps, each step
complete only when every leg confirms.

## Approach

### Phase 0 — non-blocking submit (the keystone)

A third executor mode, `"submit"`, added beside `"simulate"` and `"fire"` on
`executeCodexTransaction`. It builds, signs, pre-flights (refuse-unmineable
still applies — same safety net `fire` has today), submits, and returns —
**never calls `listenWithTimeout`**.

**Scope, precisely:** `executor.ts` + `types.ts` + `seams.ts` +
`blockchain/stoachain.ts` only. Nothing in `tick.ts`/`loop.ts`/`resolvers.ts`
changes in this phase. `fire` is untouched — same code path, same tests. This
mirrors the handoff's own instruction ("fire stays exactly as it is") and
keeps this phase's blast radius to exactly the one new capability.

**Implementation shape — extract, don't duplicate.** `runFire`
(`executor.ts:338-483`) is build → sign → preflight/refuse → submit-with-
504-recovery → listen → interpret. The first five steps are *exactly* what
`submit` needs too. Rather than copy-pasting that logic (the handoff's own
stated principle: two implementations of the same thing is two chances to
diverge), extract a private `submitTransaction(ctx, definition, signers)`
helper covering build-through-submit-with-recovery (today's lines ~349-441),
returning `{ signed, chainId, requestKey: string | null, networkId?: string }`
or a structured preflight/refuse failure. `runFire` calls it, then (only on
success) calls `listenWithTimeout` as today. The new `runSubmit` calls it and
returns immediately. This is a refactor of `runFire`'s internals with **zero
change to its external behavior or return shape** — the existing
`executor.test.ts` fire-mode suite should pass unmodified; it's the test
for exactly this guarantee.

**New result type**, following the existing `SimulateResult`/`FireResult`
discriminated-union convention (`types.ts:112-137`) rather than overloading
either:

```ts
export interface SubmitResult {
  readonly ok: boolean;
  readonly mode: "submit";
  readonly requestKey?: string;
  readonly chainId?: string;
  readonly networkId?: string;
  readonly rawResult?: unknown;      // the preflight read, on a pre-submit failure
  readonly error?: string;
  // No terminalIntent: submit never resolves a one-time row's terminal
  // state — only Phase 3's poll confirming/failing the leg does that.
}
export type ExecutorResult = SimulateResult | FireResult | SubmitResult;
```

`ok: false` covers exactly the pre-submit failures `fire` already has
(preflight failure, refuse-unmineable, sign-incompletion) — never a listen
failure, because `submit` never listens. A submit that reaches the chain
(including the ambiguous-submit-but-we-have-the-derived-key case,
`executor.ts:425-441`) is `ok: true` with a `requestKey` — "submitted" is the
whole claim this mode makes, not "confirmed."

**New seam**, same optional/best-effort shape as `preflightRead`/
`getBlockGasLimit` (`seams.ts:108-117`):

```ts
// seams.ts, on ChainClient
/**
 * Poll many request keys on one chain in a single call. Returns a map keyed
 * by requestKey; a key ABSENT from the map means "still pending" (Kadena's
 * /poll only returns landed txs), a key PRESENT means a definite
 * ListenResult. Optional — a driver without it falls back to polling keys
 * one at a time via `listen` (slower, never unsafe).
 */
pollRequestKeys?(keys: string[], chainId: string): Promise<Record<string, ListenResult>>;
```

Reusing `ListenResult` (already defined, already what `listen()` returns)
instead of inventing a new per-key result shape — same "don't invent a
second thing next to an existing one" instinct as everything else in this
package. `blockchain/stoachain.ts` implements it the same lazy/optional way
as its two siblings (`:128-146`): wraps Kadena's batch `/poll` endpoint,
one HTTP call for however many keys are outstanding on that chain — which is
exactly the property the handoff calls out as mattering ("a 10-leg step must
cost one request per tick, not ten").

**Tests (co-located, per `vitest.config.ts:3-5`'s explicit-import
convention):**
- `executor.test.ts` gains a `"submit" mode` describe block: successful
  submit returns `requestKey` and the mock client's `listen` is **never
  called**; a preflight failure returns `ok: false` with no submit attempted;
  the gas-ceiling refusal applies identically to submit as to fire; the
  504-ambiguous-submit-recovers-the-derived-key path is exercised the same
  way the existing fire tests exercise it.
- `blockchain/stoachain.test.ts` gains a `pollRequestKeys` case mirroring
  the existing `preflightRead`/`getBlockGasLimit` coverage — present on the
  returned `ChainClient`, degrades sanely on a non-2xx poll response.
- The existing `fire`-mode suite in `executor.test.ts` runs unmodified and
  must stay green — that's the proof the extraction didn't change `fire`'s
  behavior.

### Phase 1 — persistence

Two tables from the handoff, plus one it didn't specify (see "The gap," `
below). All `CREATE TABLE IF NOT EXISTS`, appended to `SCHEMA_SQL`, going
through the exact same install path every existing table does
(`schema.ts:145-152`) — no versioning, fresh installs and upgrades identical,
matching the established no-migration-needed discipline.

**The gap: static step definitions have nowhere to live.** The handoff's
`codex_cronoton_runs`/`codex_cronoton_run_legs` are both *runtime* state —
which run is at which step, which legs confirmed. Neither holds *what step 2
actually is*. `codex_cronotons` itself can't hold it either: it has exactly
one `pact_code`/`config_json`/`payload_json`/`gas_payer_json`/`signers_json`,
and the driving job's three steps are three different Pact modules with
three different payloads. Proposing a third table:

```sql
CREATE TABLE IF NOT EXISTS codex_cronoton_steps (
  id                  TEXT PRIMARY KEY,
  codex_cronoton_id   TEXT NOT NULL REFERENCES codex_cronotons(id) ON DELETE CASCADE,
  step_index          INTEGER NOT NULL,
  mode                TEXT NOT NULL CHECK (mode IN ('single', 'planner')),
  -- mode='single': a fixed one-leg transaction (mirrors codex_cronotons' own
  -- single-tx shape, one level down).
  pact_code           TEXT,
  config_json         TEXT,
  payload_json        TEXT,
  gas_payer_json      TEXT,
  signers_json        TEXT,
  -- mode='planner': a registered StepPlanner (Phase 4) builds N legs at run
  -- time. Its fan mode ('parallel' | 'serial-then-finalize') is a property of
  -- the REGISTERED planner, not stored here — storing it twice is exactly
  -- the kind of duplication that drifts.
  planner_name        TEXT,
  planner_params_json TEXT,
  idempotent          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  modified_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_cronoton_steps_order
  ON codex_cronoton_steps(codex_cronoton_id, step_index);
```

`idempotent` lives here per §5.4 ("a per-step `idempotent` flag, default
false") — it describes the step's *operation*, so the step row is where it
belongs. A `CHECK` enforces exactly one of the two shapes is meaningfully
filled, deferred to the store layer's commit validation (SQLite `CHECK`
can't easily express "pact_code XOR planner_name" cleanly without a
`CHECK ((mode='single' AND pact_code IS NOT NULL) OR (mode='planner' AND
planner_name IS NOT NULL))`, which I'd add).

```sql
CREATE TABLE IF NOT EXISTS codex_cronoton_runs (
  id                TEXT PRIMARY KEY,
  codex_cronoton_id TEXT NOT NULL REFERENCES codex_cronotons(id) ON DELETE CASCADE,
  fire_id           TEXT REFERENCES codex_cronoton_fires(id),
  status            TEXT NOT NULL DEFAULT 'planning' CHECK (status IN (
    'planning', 'awaiting', 'advancing', 'succeeded', 'failed', 'abandoned'
  )),
  step_index        INTEGER NOT NULL DEFAULT 0,
  step_count        INTEGER NOT NULL,
  started_at        TEXT NOT NULL,
  modified_at       TEXT NOT NULL,
  deadline_at       TEXT,
  attempt           INTEGER NOT NULL DEFAULT 0,
  context_json      TEXT
);
CREATE INDEX IF NOT EXISTS idx_codex_cronoton_runs_due
  ON codex_cronoton_runs(status, modified_at);
```

Plus the **self-blocking invariant (§5.6) enforced at the DB layer**, not
left to a caller's discipline — a partial unique index over the non-terminal
statuses:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_cronoton_runs_self_block
  ON codex_cronoton_runs(codex_cronoton_id)
  WHERE status IN ('planning', 'awaiting', 'advancing');
```

A second `INSERT` for the same `codex_cronoton_id` while a run is
non-terminal throws a UNIQUE constraint violation — the same
defense-in-depth-at-the-store-layer posture `assertAutoGasGate`/
`assertGasPriceBufferAnu` already establish elsewhere in this package
(reject bad state at the write site, don't trust the caller to have checked).

```sql
CREATE TABLE IF NOT EXISTS codex_cronoton_run_legs (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES codex_cronoton_runs(id) ON DELETE CASCADE,
  step_index      INTEGER NOT NULL,
  leg_index       INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'submitted', 'confirmed', 'failed'
  )),
  request_key     TEXT,
  chain_id        TEXT,
  definition_json TEXT NOT NULL,
  error_message   TEXT,
  submitted_at    TEXT,
  confirmed_at    TEXT,
  attempt         INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_cronoton_run_legs_slot
  ON codex_cronoton_run_legs(run_id, step_index, leg_index);
CREATE INDEX IF NOT EXISTS idx_codex_cronoton_run_legs_barrier
  ON codex_cronoton_run_legs(run_id, step_index, status);
```

**A leg row is written in `status='pending'` BEFORE its transaction is
submitted** (handoff's own instruction) — the enqueue-before-persist
discipline `tick.ts:98-99`'s claim-before-fire already uses, one level down.
`'pending' → 'submitted'` happens the instant Phase 0's `submit` returns a
`requestKey` (never re-derived, never re-submitted once a key exists — this
is §5.3's invariant, enforced starting here: a `'submitted'`-or-later leg
is never eligible for re-submission, only for polling). `'submitted' →
'confirmed'|'failed'` is Phase 3's poll loop — out of scope for this design,
but the column shape has to support it today or Phase 3 reshapes the table.

**Store layer (also Phase 1, not deferred to Phase 3):** a thin,
decision-free CRUD layer — `store/runs.ts` (or `store/steps.ts` +
`store/runs.ts` split the way `store/cronoton.ts`/`store/fires.ts` are
already split by table) — mirroring `store/fires.ts`'s own level of
ambition: `insertStep`/`listStepsForCronoton`, `createRun` (the self-block
constraint surfaces here as a typed `RunAlreadyInFlightError`, mirroring
`TerminalCronotonError`'s existing pattern in `store/errors.ts`),
`getRun`/`listRunLegs`, `insertRunLeg`, `markLegSubmitted`/
`markLegConfirmed`/`markLegFailed`. **No decision logic** — "is the barrier
met," "which legs are missing," "has the deadline passed" are explicitly
Phase 2's pure `advanceRun`, not this layer's job. That boundary is the
point of Phase 2 existing at all.

**Tests**, per §6's own stated destinations:
- DDL shape + idempotency (including a from-a-pre-this-change-table-shape
  upgrade case, the same pattern I used for `ensureColumn`'s own test) →
  extend `schema.test.ts`.
- `store/runs.test.ts`, co-located, real in-memory `better-sqlite3` (never a
  SQL-string mock — `claim.test.ts:1-15`'s stated rationale applies
  identically here: a mock that always reports `changes: 1` cannot prove
  the self-block constraint is real). Must include the two-racing-callers
  case for `createRun` — two concurrent "start a run for cronoton X"
  attempts, exactly one succeeds — the same shape as `claim.test.ts`'s
  two-racing-claimers proof, now at the run-creation boundary instead of the
  fire-claim boundary.

## Acceptance criteria

- [ ] `executeCodexTransaction(definition, "submit", ctx)` returns a
      `requestKey` without ever calling the injected `ChainClient.listen`,
      proven by a mock whose `listen` throws if called.
- [ ] Every existing `fire`-mode test in `executor.test.ts` passes unmodified
      after the `submitTransaction` extraction — proving `fire`'s external
      behavior genuinely didn't change.
- [ ] `submit` mode refuses an unmineable transaction (gas over ceiling)
      identically to `fire` mode, before ever calling `client.submit`.
- [ ] `ChainClient.pollRequestKeys` is present on `createStoachainRuntime`'s
      client and degrades to a documented fallback on a non-2xx response,
      mirroring `getBlockGasLimit`'s existing test.
- [ ] `installSchema` run twice on a DB that predates
      `codex_cronoton_steps`/`codex_cronoton_runs`/`codex_cronoton_run_legs`
      ends with all three tables present and no data loss (the
      pre-existing-table-shape upgrade test).
- [ ] A second `createRun` for a `codex_cronoton_id` that already has a
      non-terminal run fails (typed error, not a raw constraint-violation
      leak) while the first run's row is untouched; once the first run
      reaches a terminal status, a new run for the same cronoton succeeds.
- [ ] Two concurrent `createRun` calls for the same cronoton: exactly one
      succeeds, proven against a real in-memory DB, not a mock.
- [ ] A leg row exists in `status='pending'` the instant it's inserted,
      before any `requestKey` is known — `insertRunLeg` never requires one.

## Out of scope (this design)

- Phase 2 (pure `advanceRun` decision logic), Phase 3 (the non-blocking
  driver / `advanceInFlightRunsOnce`), Phase 4 (the `StepPlanner` registry),
  Phase 4b (the `ouronet.aqp-inject`/`ouronet.aqp-evict` built-ins), Phase 5
  (handlers/observability), Phase 6 (the merge optimiser — owner-deferred
  explicitly, not just sequenced later).
- Porting OuronetUI's evict/inject planner logic — Phase 4/4b's job, and the
  handoff is explicit that it must be ported, not re-derived.
- Any change to `tick.ts`, `loop.ts`, or `resolvers.ts` — Phase 0 is
  additive at the executor/seam layer only; the tick still fires one-shot
  rows exactly as it does today until Phase 3 exists.
- The red-team assertion on the gasless-patron/`UEV_Patron` collection-path
  question (handoff §4b) — Pact-repo work, not this package, and explicitly
  flagged as "settle before relying on the toggle unattended," i.e. before
  Phase 4b ships, not before Phase 0/1.

## Topics (phases 2–6, shaped in turn)

1. `khronoton-chained-runs-phase-2` — pure `advanceRun` decision logic
   (`src/server/pure/run-advance.ts`): barrier-met, missing-legs, deadline,
   serial-vs-parallel as one input-driven branch.
2. `khronoton-chained-runs-phase-3` — the non-blocking driver
   (`advanceInFlightRunsOnce`, wired into `startKhronotonLoop`), the tick's
   create-run-and-submit-step-0 path, and the self-blocking-vs-schedule-
   advances-anyway interaction from §5.6.
3. `khronoton-chained-runs-phase-4` — the `StepPlanner` registry +
   porting OuronetUI's inject/evict leg construction.
4. `khronoton-chained-runs-phase-4b` — **FOUR built-ins, not two** (owner
   correction, 2026-11-19): `ouronet.aqp-inject`, `ouronet.aqp-evict`, and
   two the original handoff didn't call out — `ouronet.stoa-wrap` and
   `ouronet.stoa-unwrap`. The handoff treated "drain + wrap" as a single
   plain-tx step needing no built-in, on the reasoning that it never fans
   out. That reasoning doesn't transfer: inject/evict need a built-in
   because leg-construction/split-shape is a program, not config — wrap/
   unwrap need one for an UNRELATED reason, because getting the Pact
   **capability set** right by hand (which capabilities get attached to
   which signer, scoped how) is the dangerous, easy-to-get-wrong part, with
   or without any fan-out. "Doesn't fan out" was never evidence "safe to
   author by hand." Both reasons justify a built-in independently; a step
   needing either one gets one. The driving job's three steps now map
   built-in-for-built-in: step 1 = `ouronet.stoa-wrap` (after the drain),
   step 2 = `ouronet.aqp-inject`, step 3 = `ouronet.aqp-evict`.
   `ouronet.stoa-unwrap`'s live Pact route needs its own `§7`-style
   verification pass when this phase is actually shaped — the original
   handoff only verified `wrap` (`TS01-C2::LQD\|C_WrapStoa`,
   `03_TS01-C2.pact:142`) because the driving job never needed the inverse.
   Also confirmed by the owner: per-step standalone fire (already Phase 5,
   below) applies to a built-in-backed step exactly the same as a plain
   one — no separate testing story for built-ins.
5. `khronoton-chained-runs-phase-5` — per-step standalone fire route,
   `executeNow` fixed for a chained row, `adaptMultiTxSummary` real-failure
   reporting, per-leg fire-history visibility.
6. `khronoton-chained-runs-phase-6` — the merge optimiser. Owner's explicit
   instruction: build 0–5, run the pipeline for weeks, decide with real
   numbers. Not shaped until that data exists.
