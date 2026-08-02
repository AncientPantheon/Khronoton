# Khronoton — event-driven server resolvers — Design

## Problem

Every Khronoton cronoton carries a real per-row schedule (`schedule_mode` + `schedule_config_json` →
`next_fire_at`), and the tick loop fires it off that schedule. That's correct for a genuinely time-based
cronoton (Pythia's `pyth-flush`, hourly at :58). But some server-resolver cronotons are conceptually
**event-driven**, not time-based: Pythia's `dual-link-activate` fires when a consumer's two Apollo halves
finish verifying — an event with no meaningful clock. Today such a resolver is forced to masquerade as a
scheduled cronoton that polls every tick (the resolver returns empty accounts when nothing is ready and the
pre-fire simulate guard postpones the empty fire, so no gas burns — but the Builder misleadingly shows a
schedule editor for something that isn't schedule-driven). Per the Pythia handoff
(`HANDOFF-khronoton-event-driven-resolvers.md`, 2026-08-02), a resolver should be able to declare itself
event-driven, and selecting one in the Builder should automatically make the cronoton scheduler-off and
replace the schedule UI with an honest notice — the host then fires it on its own event via the existing
`executeNow` primitive.

## Approach

A server resolver **declares** whether it is event-driven; the Builder, seeing an event-driven resolver
selected, commits the cronoton **scheduler-off** (`next_fire_at = NULL`, so `fetchDueCodexCronotons` never
selects it) and swaps the schedule editor for an event-driven notice. The host (Pythia) fires it via the
already-existing `executeNow`. No new firing primitive; `executeNow` itself is unchanged.

This reuses the **existing trigger-only persistence path** rather than building a parallel one. Today
`createCodexCronoton` computes `triggerOnly = input.externalFireable === true || runtimeArgKeys.length > 0`
(`server/store/cronoton.ts:130`) and stores `next_fire_at = NULL` when true; the due-query already excludes
`next_fire_at IS NULL` rows (`server/store/claim.ts`). Event-driven becomes a **third reason** for
`triggerOnly`.

### The signal mechanism (the one real decision)

**Chosen: a dedicated `eventDriven?: boolean` on the commit envelope**, mapped from the Builder at commit
time and threaded `handlers → store create/edit input → triggerOnly`. This mirrors exactly how
`externalFireable` already rides `CommitEnvelope` (`handlers/cronoton.ts:59`), flows through
`toCommitInput` (`:112`) into the store's `CommitCodexCronotonInput`, and is mapped in the Builder by
`builderToCommit` (`builder-state.ts:291`, `if (state.externalFireable) body.envelope.externalFireable = true`).

**Rejected — reusing `externalFireable`:** the handoff explicitly warns against it. `externalFireable` also
enables the public HMAC trigger endpoint; an event-driven server-resolver cronoton is fired **in-process**
via `executeNow` by the host and should NOT expose the HMAC endpoint. A dedicated flag keeps "host-fired
via executeNow" and "externally fired via HMAC" as distinct, independently-controllable states.

**No new DB column** — a deliberate design point. The server computes `triggerOnly` (→ `next_fire_at NULL`)
from the commit signal at create/edit time; `next_fire_at NULL` already persists the scheduler-off state;
and the UI **re-derives** event-driven-ness at render time by looking up the currently-selected
`state.serverResolver` in the passed `serverResolverOptions` (which carry the `eventDriven` flag). On
edit-load, `detailToBuilderState` rehydrates `serverResolver` from the row's `server_resolver` column, the
Builder re-derives event-driven-ness from the options, and re-sends `eventDriven: true` on the next save —
keeping `next_fire_at NULL` without a persisted `event_driven` column.

### The edit path (a subtlety confirmed against live source)

The apply-at-next-fire edit (`store/cronoton.ts` ~343-355) computes its schedule-preservation guard from the
**persisted row**, not the incoming patch:
`rowTriggerOnly = rowExternalFireable(row) || rowRuntimeArgKeys(row).length > 0`, and only recomputes
`next_fire_at` when `scheduleChanged && !rowTriggerOnly`. Because there is no persisted `event_driven`
column, an edit to an event-driven cronoton would see `rowTriggerOnly === false` and — since the Builder's
commit body always carries a `schedule` block (so `scheduleChanged` is always true) — **resurrect a real
`next_fire_at`**, turning the scheduler back on. This is the exact failure the handoff's "confirm the edit
path threads `eventDriven`" note warns about.

Fix, threading the patch signal (no column): `EditCodexCronotonPatch` gains `eventDriven?: boolean`,
`toEditPatch` maps `envelope.eventDriven`, and the edit path forces `next_fire_at = NULL` when
`patch.eventDriven === true` (covering both event-driven→event-driven edits and a scheduled→event-driven
**conversion**, where the row's stale non-null `next_fire_at` must be cleared), otherwise falls through to
the existing `scheduleChanged && !rowTriggerOnly` recompute (covering an event-driven→scheduled conversion,
where `patch.eventDriven` is absent and a real `next_fire_at` is correctly computed). This keeps the
scheduled↔event-driven transitions consistent, not just the steady state.

### UI threading

Event-driven-ness = "does the option matching `state.serverResolver` have `eventDriven: true`". The options
live in the Builder tree (`BuilderHeader`'s `useResolverOptions`, prop-or-context), NOT in the pure
`BuilderState`/`builder-state.ts` functions. So:
- `Builder.tsx` computes `eventDrivenResolver` from `(serverResolverOptions, state.serverResolver)` once, and
  (a) passes it to `ExecuteTab` as a prop for the schedule-swap + schedule-line decision, and (b) uses it in
  `handleCommit`.
- `builderToCommit` gains an optional second arg `builderToCommit(state, opts?: { eventDriven?: boolean })`
  that sets `body.envelope.eventDriven = true` **only when truthy** (mirroring the externalFireable pattern),
  so every existing `builderToCommit(state)` call site (many in tests) is byte-identical for non-event-driven
  rows.
- The scheduler-off UI detection is broadened from "runtime-arg keys only" to also count an event-driven
  resolver **and** `externalFireable` (closing a pre-existing UI/server disagreement in the same pass). When
  event-driven specifically is selected, `ExecuteTab` renders a **distinct** notice (different wording from
  the runtime-arg "Trigger-only (external / manual)" one) and the schedule summary row reads
  "Event-driven (host-fired)".

`executeNow` needs no code change — it already fires any non-paused, non-terminal committed row through
`fireByServerResolver` independent of `next_fire_at`; this design only adds a test confirming it fires a
committed event-driven (scheduler-off) server-resolver row.

## Acceptance criteria

- [ ] `ServerResolverOption` (provider/context.tsx) carries an optional `eventDriven?: boolean` flag.
- [ ] A commit whose selected resolver is event-driven persists the row with `next_fire_at = NULL`, and
      `fetchDueCodexCronotons` never returns it (tick loop never auto-fires it).
- [ ] An edit to an event-driven cronoton keeps `next_fire_at = NULL` (does not resurrect a schedule);
      converting a scheduled cronoton to an event-driven resolver via edit clears its `next_fire_at` to NULL,
      and converting an event-driven cronoton back to a scheduled resolver recomputes a real `next_fire_at`.
- [ ] `server_resolver` + event-driven is accepted by the store; `server_resolver` + `runtime_arg_keys`
      still throws the existing mutual-exclusion error.
- [ ] In the Builder, selecting an event-driven resolver replaces the `ScheduleStep` editor with an
      event-driven notice (distinct wording from the runtime-arg trigger-only notice), and the Execute-tab
      schedule summary row reads "Event-driven (host-fired)".
- [ ] `executeNow` fires a committed event-driven server-resolver row correctly (verified by test).
- [ ] Ordinary (non-event-driven) resolver cronotons — e.g. `pyth-flush` — are unchanged: they keep their
      schedule, a real `next_fire_at`, and the full `ScheduleStep` UI. A non-event-driven commit body is
      byte-identical to today's.
- [ ] All existing khronoton-core tests pass; new tests cover the event-driven commit path, the edit-path
      transitions, the mutual-exclusion allow/deny, the `executeNow` + due-query behavior, and the UI swap.

## Out of scope

- **Both Pythia-side follow-ups**, which land in the Pythia repo (not khronoton-core) once this publishes:
  (1) tagging `dual-link-activate` with `eventDriven: true` in `KhronotonApp.tsx`'s `SERVER_RESOLVER_OPTIONS`
  (and leaving `pyth-flush` scheduled), and (2) firing `dual-link-activate` via `executeNow` when Pythia's
  verify flow marks a pair ready. Both are explicitly deferred to the Pythia repo per the handoff.
- Any change to `executeNow` itself — it already does what's needed.
- A persisted `event_driven` DB column / schema migration — deliberately avoided (see Approach).
- The external HMAC trigger endpoint — event-driven is host-fired in-process, deliberately NOT HMAC-exposed.
- Documenting the pattern in `organs/05-khronoton-engine-wire-in.md` — the handoff defers that until this
  ships and Pythia adopts it.

## Decisions

Autonomous delivery confirmed 2026-08-02 — the operator asked to implement the handoff and deliver a new
package version. Build + review run through to a clean state autonomously; the version bump/CHANGELOG/README
are prepared, and the actual `git commit`/`git push`/tag-push-publish waits for one final go-ahead once
build+review are clean (same discipline as the 0.5.0 release earlier this session — irreversible/public
actions get one last look at the real diff).

- Signal mechanism: dedicated `eventDriven?: boolean` on `CommitEnvelope` (NOT reusing `externalFireable`,
  which would wrongly enable the HMAC endpoint) — see Approach. No persisted DB column.
- Edit path: thread `patch.eventDriven` into the schedule-preservation guard and force `next_fire_at = NULL`
  when set, so the scheduled↔event-driven edit transitions stay consistent — a subtlety found by reading the
  live edit path, which guards on the persisted row, not the incoming patch.
- Target version: minor bump 0.6.0 (new optional API surface — `ServerResolverOption.eventDriven`,
  `CommitEnvelope.eventDriven` — plus a behavioral Builder change, no breaking removal).
