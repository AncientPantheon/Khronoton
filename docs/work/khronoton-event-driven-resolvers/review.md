# Khronoton — event-driven server resolvers — Review

Two rounds. Round 1 (4 parallel lenses: correctness, conventions, tests, security) found one HIGH the
5-task build could not see across its per-task scopes — a sibling lifecycle path (resume) that the build
never touched but that the feature broke. Every finding was adversarially validated in a fresh context
before any fix.

## Round 1 findings

### [HIGH — CONFIRMED → fixed] resume re-arms the scheduler on an event-driven cronoton
- **Where:** `server/store/cronoton.ts` `resumeCodexCronoton`
- Flagged **independently by three lenses** (correctness HIGH, conventions MEDIUM, security as an
  out-of-lens note). An event-driven row persists `external_fireable=0`, `runtime_arg_keys=NULL`,
  `next_fire_at=NULL` — its scheduler-off state carried purely by the NULL. `resumeCodexCronoton`'s guard
  was `rowExternalFireable(row) || rowRuntimeArgKeys(row).length > 0`, which is **false** for an
  event-driven row, so resume recomputed a real `next_fire_at` from the stored schedule config and the tick
  loop began auto-firing a host-fired cronoton. Pause-to-disable is the sanctioned way to disable a
  server-resolver cronoton (delete is refused for them), so pause→resume is a normal operation — this was
  reachable, not theoretical. The edit path had been fixed for this via `patch.eventDriven`; resume was
  missed because it's a separate lifecycle path with no commit/patch signal.
- **Validation** confirmed the mechanism against the actual code AND that the proposed fix is sound with no
  hole: pause preserves `next_fire_at`, every non-terminal *scheduled* active row always carries a non-null
  `next_fire_at` (recurring never null; spent one-time is terminal → blocked by `assertNotTerminal`), so a
  currently-NULL `next_fire_at` is a reliable column-free marker of scheduler-off at resume time.
- **Fix:** resume's guard became `rowSchedulerOff = row.next_fire_at === null`. Crucially this uses the
  **row's current state** (resume never converts a row), whereas the edit path keeps using the **patch
  signal** (`patch.eventDriven`) because an edit *may* be converting to/from a schedule — the two paths
  correctly use different signals. **Regression test added** (`cronoton.test.ts` case f): commit
  event-driven → assert NULL → pause → resume at a later `now` → assert still NULL and excluded from
  `fetchDueCodexCronotons`. Reverting the fix fails this test.

### [MEDIUM — CONFIRMED → fixed] trigger-only notice claimed "declares runtime arguments" for externally-fireable-only rows
- **Where:** `ui/builder/ExecuteTab.tsx`
- The `schedulerOff` display gate was (correctly, per design) broadened to include `state.externalFireable`,
  so an externally-fireable-only row (no runtime-arg keys) now takes the trigger-only notice branch — whose
  hardcoded text falsely told the user it "declares runtime arguments". (Before this change that row showed
  the *ScheduleStep*, which was more wrong — the design wanted the notice; only the wording lagged.)
- **Fix:** generalized the wording to "This cronoton never runs on a timer — it fires only via the external
  trigger endpoint or a manual run.", accurate for both the runtime-arg and externally-fireable cases; the
  event-driven case still shows its own distinct `EVENT_DRIVEN_NOTICE`. The existing ExecuteTab test still
  matches `/never runs on a timer/` so it stays load-bearing.

### [MEDIUM — CONFIRMED → fixed] no test covered the Builder options→derivation→commit seam
- **Where:** `ui/builder/Builder.tsx` / `Builder.test.tsx`
- The bridge that makes the whole feature work end-to-end — `ServerResolverOption.eventDriven` (from config)
  → `eventDrivenResolver` → both the ExecuteTab prop AND `builderToCommit` opts — had no test. The
  ExecuteTab test only supplied the prop directly; the builder-state test only called `builderToCommit`
  directly. A regression dropping `eventDriven` from the commit while keeping the ExecuteTab prop would
  leave the UI correct while committing a real `next_fire_at`, and nothing would fail.
- **Fix:** added a `Builder.test.tsx` seam test that mounts the real provider with an `eventDriven: true`
  resolver option, selects it via the real dropdown, and asserts **both** the commit body's
  `envelope.eventDriven === true` **and** the UI swap (notice shown, ScheduleStep absent, summary
  "Event-driven (host-fired)").

### [LOW — CONFIRMED → fixed] the event-driven create test's fetchDue exclusion was vacuous
- **Where:** `server/store/cronoton.test.ts`
- The DB held only the one event-driven row, so `not.toContain(id)` would pass even if `fetchDue` regressed
  to always return `[]`. **Fix:** seeded a genuinely-scheduled positive-control row and asserted it IS
  returned while the event-driven row is NOT.

## Round 2 (terminal pass) findings

Both fixes verified correct; two new LOW polish items in `cronoton.ts`, both fixed:

### [LOW → fixed] resume guard kept two now-redundant disjuncts
After adding `row.next_fire_at === null`, the trailing `|| rowExternalFireable(row) || rowRuntimeArgKeys(...)`
disjuncts could only ever be true when the leading check already was (both row types commit with NULL) —
vestigial and potentially confusing ("does this cover a reachable case?"). Reduced to
`rowSchedulerOff = row.next_fire_at === null`; provably equivalent (all 848 tests including the resume test
still pass). `rowExternalFireable`/`rowRuntimeArgKeys` remain used by the edit path.

### [LOW → fixed] stale "trigger-only" comments omitted event-driven
The create-path comment and module docblock enumerated only "externally fireable OR declaring runtime args"
while the `triggerOnly` expression now has three reasons. Updated both to name event-driven as the third
scheduler-off reason.

## Security

Clean across both rounds. `eventDriven` is a boolean, scheduling-only flag checked with strict `=== true`;
it never writes `external_fireable`, so an event-driven row is **never** HMAC-trigger-fireable (the design's
explicit reason for a dedicated flag over reusing `externalFireable`). No injection surface (no persisted
column, never bound into SQL as a string), no authz widening (commit/edit/resume are already admin-gated),
no signing/gas/key interaction. The resume fix keeps a resumed event-driven row `next_fire_at NULL` +
`external_fireable 0` — fired only by the admin-gated in-process `executeNow`.

## Final state

- **Typecheck:** clean (`tsc --noEmit`, zero errors).
- **Full suite:** `Test Files  69 passed (69)` / `Tests  848 passed (848)`.
- **Behavioral verification (feature-scale leg):** exercised against a REAL in-memory `better-sqlite3` DB +
  the real store + real `executeNow` handler (not mocks): `execute.test.ts`'s event-driven test commits an
  event-driven server-resolver row through the real store (asserting `next_fire_at` is genuinely NULL as a
  precondition) and fires it via `executeNow`, asserting a real `success` fire row — the end-to-end
  "host-fires-a-scheduler-off-cronoton" flow the feature exists to enable. `cronoton.test.ts` case (f)
  additionally exercises the full commit→pause→resume lifecycle against the real DB. (There is no standalone
  app / browser harness in this package — its real surface IS these store/handler functions, which the
  integration tests drive against real SQLite.)
- Every design.md acceptance criterion traces to a test (AC1 Builder seam; AC2 create case a; AC3 edit cases
  c/d/e + resume case f; AC4 mutual-exclusion case b; AC5 ExecuteTab + Builder seam; AC6 execute.test.ts;
  AC7 builder-state byte-identical + Builder create round-trip).
- No STYLISTIC findings left open.
