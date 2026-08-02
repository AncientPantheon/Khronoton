Dependency note: this is a vertical slice through the package's layers
(provider type → server store → handlers → client UI), so the waves are ordered
by that stack. 5 tasks, 3 waves.

## Wave 1

- [x] T1: Add the `eventDriven` flag to `ServerResolverOption` —
  done when: `packages/khronoton-core/src/provider/context.tsx`'s `ServerResolverOption` interface (currently
  `{ value: string; label: string; note?: string }`, ~line 27) gains an optional
  `eventDriven?: boolean;` field with a doc comment describing it: "When true, a cronoton using this resolver
  is EVENT-DRIVEN — the scheduler never auto-fires it (persisted scheduler-off); the host application fires it
  on its own trigger via `executeNow`. Selecting such a resolver in the Builder replaces the schedule UI with
  an event-driven notice. Omit/false = ordinary scheduled cronoton." No other change. This is a type-only,
  additive optional field — it has no dedicated test (nothing in the repo tests this interface's shape in
  isolation); it is exercised end-to-end by T5's Builder wiring. Verify `npm run typecheck --workspace=
  @ancientpantheon/khronoton-core` stays clean after the addition.
  - files: `packages/khronoton-core/src/provider/context.tsx`

- [x] T2: Thread `eventDriven` through the server store (create + edit persistence) —
  done when, in `packages/khronoton-core/src/server/store/cronoton.ts`:
  - `CommitCodexCronotonInput` (the create input interface, has `serverResolver?`/`externalFireable?`/
    `runtimeArgKeys?` ~lines 54-59) gains `eventDriven?: boolean;`.
  - `EditCodexCronotonPatch` (has `serverResolver?: string | null` ~lines 246-257) gains
    `eventDriven?: boolean;`.
  - The create-path `triggerOnly` expression (~line 130, currently
    `const triggerOnly = input.externalFireable === true || runtimeArgKeys.length > 0;`) becomes
    `... || input.eventDriven === true;` so an event-driven create persists `next_fire_at = NULL`.
  - The mutual-exclusion throw (~lines 117-123, `if (input.serverResolver && runtimeArgKeys.length > 0) throw
    ...`) is LEFT UNCHANGED and is NOT broadened — `server_resolver` + `eventDriven` must remain allowed;
    only `server_resolver` + `runtime_arg_keys` stays forbidden.
  - The apply-at-next-fire edit path (the `editCodexCronoton`/apply function, ~lines 261-360; `nextFireAt` is
    declared ~286 as `row.next_fire_at` and today only reassigned inside the `if (scheduleChanged &&
    !rowTriggerOnly)` branch ~347-355): change the `next_fire_at` resolution so that
    **when `patch.eventDriven === true`, `nextFireAt` is forced to `null`** (this handles both an
    event-driven→event-driven edit — keep NULL — and a scheduled→event-driven conversion — clear the row's
    stale non-null `next_fire_at`); **otherwise** keep the existing behavior exactly
    (`if (scheduleChanged && !rowTriggerOnly)` recomputes a real `next_fire_at` — this handles an
    event-driven→scheduled conversion, where `patch.eventDriven` is absent). Place the `patch.eventDriven`
    check so it takes precedence over the `scheduleChanged` recompute (e.g. an early
    `if (patch.eventDriven === true) { nextFireAt = null; } else if (scheduleChanged && !rowTriggerOnly)
    { ... }`), and make sure the row's `next_fire_at` column is actually written with this value (the
    UPDATE at ~365 already writes `next_fire_at = ?` from `nextFireAt` — confirm it does, and that
    `changedFields` includes something when only the schedule/eventDriven-derived next_fire_at changed so the
    write isn't skipped by the `if (changedFields.length === 0) return` early-out; if forcing NULL on a
    scheduled→event-driven conversion would otherwise leave `changedFields` empty, push a marker like
    `"schedule"` so the UPDATE runs).
  - `packages/khronoton-core/src/server/store/claim.ts`'s `fetchDueCodexCronotons` is NOT changed — it
    already excludes `next_fire_at IS NULL` rows; it is the ASSERTION TARGET of a test below.
  Tests (add to the existing store test file — find it via the neighboring
  `packages/khronoton-core/src/server/store/cronoton.test.ts` and/or `claim.test.ts`; they open a
  better-sqlite3 in-memory DB + `installSchema` per the existing pattern):
  (a) creating a cronoton with `{ serverResolver: "r", eventDriven: true }` persists `next_fire_at = NULL`
      and `fetchDueCodexCronotons` (given a `now` past any schedule) does NOT return that row's id;
  (b) `{ serverResolver: "r", eventDriven: true }` does NOT throw (server_resolver + event-driven allowed),
      while `{ serverResolver: "r", runtimeArgKeys: ["x"] }` STILL throws the existing mutual-exclusion error;
  (c) editing an event-driven row (patch `{ eventDriven: true }` + a schedule patch) keeps `next_fire_at`
      NULL; (d) editing a normally-scheduled row to `{ eventDriven: true }` (+ schedule patch) sets its
      `next_fire_at` to NULL; (e) editing an event-driven row to a scheduled resolver (patch WITHOUT
      `eventDriven`, WITH a schedule patch) recomputes a real non-null `next_fire_at`.
  - files: `packages/khronoton-core/src/server/store/cronoton.ts`,
    `packages/khronoton-core/src/server/store/cronoton.test.ts` (and/or the existing `claim.test.ts` for the
    fetchDue assertion, whichever matches the repo's existing test layout)

## Wave 2 (depends on Wave 1)

- [x] T3: Thread `eventDriven` through the handlers commit body + edit patch —
  done when, in `packages/khronoton-core/src/handlers/cronoton.ts`:
  - `CommitEnvelope` (has `serverResolver?`/`externalFireable?`/`runtimeArgKeys?` ~lines 57-61) gains
    `eventDriven?: boolean;`.
  - `toCommitInput` (~lines 100-114, which maps `envelope.serverResolver`/`externalFireable`/`runtimeArgKeys`
    into the store's `CommitCodexCronotonInput`) also maps `eventDriven: envelope.eventDriven`.
  - `toEditPatch` (~lines 118-140, which currently maps `e.serverResolver` etc into `EditCodexCronotonPatch`)
    also maps `if (e.eventDriven !== undefined) patch.eventDriven = e.eventDriven;`.
  Depends on T2 (`CommitCodexCronotonInput.eventDriven` and `EditCodexCronotonPatch.eventDriven` must already
  exist, or this file fails to typecheck).
  Tests (add to the existing handlers/commit test file — find it near
  `packages/khronoton-core/src/handlers/cronoton.test.ts`): a commit body whose
  `envelope.eventDriven === true` produces a store create input carrying `eventDriven: true`; an edit body
  whose `envelope.eventDriven === true` produces an edit patch carrying `eventDriven: true`; a commit/edit
  body with `eventDriven` absent produces input/patch with `eventDriven` undefined (unchanged from today).
  If the existing test suite drives these through the real store rather than asserting the mapped
  input/patch directly, follow that pattern instead (commit an event-driven body via the handler and assert
  the persisted row's `next_fire_at` is NULL).
  - files: `packages/khronoton-core/src/handlers/cronoton.ts`,
    `packages/khronoton-core/src/handlers/cronoton.test.ts`

- [x] T4: Confirm + test that `executeNow` fires a committed event-driven (scheduler-off) server-resolver row
  — done when: NO production code changes to `executeNow`/`fireByServerResolver` (they already fire any
  non-paused, non-terminal committed row independent of `next_fire_at`); a NEW test proves a cronoton
  committed with a `serverResolver` + `eventDriven: true` (so `next_fire_at = NULL`) fires correctly through
  the `executeNow` path. Locate the existing executeNow / fireByServerResolver test harness first
  (`packages/khronoton-core/src/handlers/execute.test.ts` and/or `packages/khronoton-core/src/server/
  resolvers.test.ts` — reuse whichever already stands up a mock `ChainRuntime` + a registered test
  server-resolver and calls the execute/fire path; do not invent a new harness). The test: register a test
  server resolver, commit an event-driven row bound to it (via the store create with `eventDriven: true`),
  call `executeNow` for that row's id, and assert it fires (reaches the resolver / produces a fire record /
  the harness's existing success assertion) — i.e. scheduler-off does not block a host-initiated
  `executeNow`. Depends on T2 (store must accept `eventDriven`). This task touches ONLY a test file, disjoint
  from T3's `handlers/cronoton.ts`, so it runs in parallel with T3.
  - files: the existing executeNow/fire test file (`packages/khronoton-core/src/handlers/execute.test.ts`
    or `packages/khronoton-core/src/server/resolvers.test.ts` — whichever the repo already uses for this
    path; add to it, don't create a parallel harness)

## Wave 3 (depends on Wave 2)

- [x] T5: Make the Builder event-driven-aware end to end (client wiring) —
  done when the three client files below are wired so that selecting an event-driven resolver commits
  scheduler-off and shows an event-driven notice instead of a schedule editor. Grouped as ONE task because
  they form a single prop/serialization contract (splitting them would leave dangling references between
  `Builder.tsx`'s new prop and `ExecuteTab.tsx`'s interface).
  1. `packages/khronoton-core/src/ui/builder-state.ts` — extend `builderToCommit`'s signature to
     `builderToCommit(state: BuilderState, opts?: { eventDriven?: boolean }): CommitBody` and add, alongside
     the existing `if (state.externalFireable) body.envelope.externalFireable = true;` (~line 291),
     `if (opts?.eventDriven) body.envelope.eventDriven = true;` — ONLY-when-truthy, so every existing
     `builderToCommit(state)` call site (no opts) produces a byte-identical body for non-event-driven rows.
     Do NOT change `isTriggerOnly` (leave it keyed on runtime-arg keys only — other consumers like
     `autoGasWaived` depend on its current meaning; the externalFireable/event-driven display broadening
     happens in ExecuteTab, below).
  2. `packages/khronoton-core/src/ui/builder/Builder.tsx` — read the resolver options from the same source
     `BuilderHeader` uses so they cannot diverge: call `useKhronotonConfig()` (import from
     `../../provider/context.js`; it returns `KhronotonConfig` whose `serverResolverOptions:
     ServerResolverOption[]` is exactly what `BuilderHeader`'s `useResolverOptions` falls back to). Compute
     `const eventDrivenResolver = Boolean(state.serverResolver && config.serverResolverOptions.find((o) =>
     o.value === state.serverResolver)?.eventDriven);`. In `handleCommit` (~line 187), change
     `const body = builderToCommit(state);` to `builderToCommit(state, { eventDriven: eventDrivenResolver })`.
     Pass `eventDrivenResolver={eventDrivenResolver}` to `<ExecuteTab .../>` (~line 276).
  3. `packages/khronoton-core/src/ui/builder/ExecuteTab.tsx` — add `eventDrivenResolver?: boolean` to
     `ExecuteTabProps`. Broaden the schedule-off decision LOCALLY (do not touch the imported `isTriggerOnly`):
     where it computes `const triggerOnly = isTriggerOnly(state);` (~line 208), keep that but add a separate
     `const schedulerOff = isTriggerOnly(state) || state.externalFireable || Boolean(eventDrivenResolver);`
     and use `schedulerOff` for the ScheduleStep-vs-notice swap (~lines 280-288): when `schedulerOff` is true,
     render a notice instead of `<ScheduleStep>`, and when `eventDrivenResolver` specifically is true, the
     notice text is DISTINCT: "Event-driven — the host application fires this when its trigger condition is
     met; there is no schedule." (the existing runtime-arg/external "Trigger-only…" notice stays for the
     non-event-driven scheduler-off cases). Update `scheduleLine(state)` (~lines 166-170) to also take the
     event-driven signal: when `eventDrivenResolver` is true it returns `"Event-driven (host-fired)"`, else
     when `isTriggerOnly(state) || state.externalFireable` it returns the existing `TRIGGER_ONLY_SCHEDULE`
     constant, else the existing `summariseSchedule(...)` line (pass `eventDrivenResolver` into `scheduleLine`
     or inline the check at its call site ~line 264 — implementer's call, keep it readable).
  Tests:
  - `packages/khronoton-core/src/ui/builder-state.test.ts`: `builderToCommit(state, { eventDriven: true })`
    sets `body.envelope.eventDriven === true`; `builderToCommit(state, { eventDriven: false })` and
    `builderToCommit(state)` (no opts) produce a body with `envelope.eventDriven === undefined`, byte-identical
    to today for an otherwise-unchanged state (assert deep-equality against `builderToCommit(state)`).
  - `packages/khronoton-core/src/ui/builder/ExecuteTab.test.tsx`: with `eventDrivenResolver` true, the
    Execute tab renders the "Event-driven —" notice, does NOT render the ScheduleStep, and the Schedule
    summary row (`data-testid="summary-schedule"`) reads `"Event-driven (host-fired)"`; with
    `eventDrivenResolver` false/absent and no runtime args/externalFireable, it renders the ScheduleStep as
    today (a normal scheduled resolver keeps its schedule UI). Follow the file's existing mount/harness
    pattern.
  - If `Builder.test.tsx`'s existing create/edit round-trip assertions call `builderToCommit(...)` to build
    the expected body, confirm they still pass unchanged (a non-event-driven row's body is byte-identical);
    only adjust an existing assertion if the new `useKhronotonConfig()` call requires the test's provider
    wrapper to supply a config (the fake-adapter mount already wraps in `<KhronotonProvider>` +
    `<KhronotonUiRoot>` — verify `serverResolverOptions` defaults to `[]` there so `eventDrivenResolver`
    computes false and nothing changes).
  Depends on T3 (`CommitEnvelope.eventDriven` must exist for `builderToCommit` to set it) and T1
  (`ServerResolverOption.eventDriven` must exist for the Builder's lookup).
  - files: `packages/khronoton-core/src/ui/builder-state.ts`,
    `packages/khronoton-core/src/ui/builder/Builder.tsx`,
    `packages/khronoton-core/src/ui/builder/ExecuteTab.tsx`,
    `packages/khronoton-core/src/ui/builder-state.test.ts`,
    `packages/khronoton-core/src/ui/builder/ExecuteTab.test.tsx`
