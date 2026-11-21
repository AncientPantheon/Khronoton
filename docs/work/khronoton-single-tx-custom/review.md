# Khronoton single-tx-first Custom mode — Review

Scope: `packages/khronoton-core/src/server/schema.ts`, `schema.test.ts`,
`types.ts`, `store/cronoton.ts`, `store/cronoton.test.ts`, `single-tx.ts`
(new), `single-tx.test.ts` (new), `fire-and-record.ts` (new),
`fire-and-record.test.ts` (new), `resolvers.ts`, `tick.ts`, `tick.test.ts`,
`handlers/execute.ts`, `handlers/execute.test.ts` — the full build (T1–T4,
plan.md) for Topic 1 of `docs/work/khronoton-single-tx-chain/design.md`.

Lenses: correctness, conventions, security, tests (money-moving planner/
fire logic — full 4-lens set per this project's established convention for
this feature family).

## Round-by-round history

### Round 1 (post-build terminal review)

- **[HIGH] CONFIRMED — fixed.** `resolvers.ts`'s server-resolver postpone
  (never-submitted) was structurally indistinguishable from a genuine
  on-chain fire failure, so `single-tx.ts` could record a postponed result
  as a permanent "failure" fire, orphaning a one-time row. Fix: added
  `FireResult.postponed`, set only by `postponed(...)`; `attemptSingleTxFirst`
  checks it before recording.
- **[MEDIUM] CONFIRMED — fixed.** `handlers/execute.ts` and `single-tx.ts`
  each independently hand-copied the fire→record→finalize→audit sequence.
  Fix: extracted the shared `fire-and-record.ts` module
  (`recordAndFinalizeFire`/`fireAndRecord`), consumed by both callers.
- **[MEDIUM] CONFIRMED — fixed.** `commitCodexCronoton`/`editCodexCronoton`
  only rejected the literal `'default'` for `singleTxMode`, not other
  out-of-enum strings (TS type erasure at runtime). Fix: widened the check
  to the full allowed set at both commit and edit time.

### Round 2 (terminal re-review, 4 lenses, after Round 1 fixes)

- **[HIGH] CONFIRMED** (correctness) — `attemptSingleTxFirst` could
  inline-dispatch a registered multi-tx server-resolver orchestrator,
  bypassing `executeNow`'s own documented "never fire multi-tx inline"
  invariant (REQ-H06: queued 202) on both the scheduler tick and the
  manual-trigger endpoint, and silently dropping the multi-tx `txKeys`
  breakdown. **Fixed:** added a `getServerResolver(...)?.kind === "multi-tx"`
  guard returning `{ fired: false }` before ever simulating/firing.
- **[MEDIUM→LOW] CONFIRMED** (conventions) — `SingleTxAttemptCtx` duplicated
  `FireAndRecordCtx` field-for-field. **Fixed:** aliased
  `SingleTxAttemptCtx = FireAndRecordCtx`.
- **[LOW] CONFIRMED** (conventions) — `fire-and-record.ts` had no sibling
  test file, unlike every other logic module in `server/`. **Fixed:** added
  `fire-and-record.test.ts` (recurring/one-time terminal transition, default
  vs. custom audit action, `auditDetailExtra` merge, end-to-end `fireAndRecord`
  against a real fake `ChainRuntime`).
- **[LOW] CONFIRMED** (conventions) — the fire-dispatch options object was
  duplicated verbatim between `single-tx.ts` and `fire-and-record.ts`, and a
  comment in `single-tx.ts` referenced `execute.ts`'s retired private
  `fireAndRecord`. **Fixed:** both now pass `ctx` directly to
  `fireByServerResolver` (structurally compatible with `FireOpts`); comment
  updated.
- Security, tests: clean.

### Round 3 (terminal re-review, 4 lenses, after Round 2 fixes)

- **[HIGH→MEDIUM] CONFIRMED** (correctness) — `tick.ts`'s
  `processDueManualBatchesOnce` fires a chained row's raw top-level
  definition with no steps/single-tx awareness at all; for a
  `try_single_tx_first=1` row this bypasses the gas-ceiling
  simulate-then-decide guard entirely (the top-level fields are no longer
  inert placeholder data once this topic ships). Validator narrowed scope:
  the *generic* "manual batch ignores `codex_cronoton_steps`" gap predates
  this topic and belongs to a separate `khronoton-chained-runs` ticket; only
  the `try_single_tx_first`-specific new bypass is in scope here. **Fixed:**
  added a guard that cancels the batch (mirroring the existing
  parent-inactive cancellation) when `cronoton.try_single_tx_first` is set.
- **[LOW] CONFIRMED** (conventions) — `handlers/execute.ts`'s
  `attemptSingleTxFirst` call hand-rebuilt an equivalent ctx object instead
  of passing `ctx` directly, contradicting the module's own "no adaptation
  needed" doc and silently dropping `ctx.resolveFireMode`. **Fixed:** now
  passes `ctx` straight through.
- **[MEDIUM] CONFIRMED** (security) — single-tx-first fires never recorded
  *who* triggered them (`actor`), unlike every other fire path
  (`actor: "scheduler"`/`"ancient"`). **Fixed:** threaded an optional
  `extras.auditDetailExtra` through `attemptSingleTxFirst`; `tick.ts` passes
  `{ actor: "scheduler" }`, `execute.ts` passes `{ actor: "ancient" }`.
- Tests: clean.

### Round 4 (terminal re-review, 4 lenses, after Round 3 fixes)

- **[MEDIUM→LOW] CONFIRMED** (correctness) — `editCodexCronoton` let
  `trySingleTxFirst` be enabled while `single_tx_mode` stayed `null`
  (meaningless per its own doc comment); harmless today (only `'custom'`/
  `null` are reachable and both behave identically) but a data-hygiene trap
  once the deferred Default-mode topic needs to branch on the field.
  **Fixed:** `editCodexCronoton` now requires the resolved `single_tx_mode`
  to be `'custom'` whenever `trySingleTxFirst` will be true, mirroring the
  existing steps-count guard.
- Conventions, security, tests: clean.

### Round 5 (terminal re-review, 4 lenses, after Round 4 fix)

- **[LOW] STYLISTIC** (conventions) — the new guard's error message uses an
  escaped-quote string literal (`"...\"custom\"..."`) instead of this file's
  established backtick-template idiom for embedded quotes (the only such
  instance in the file). Harmless, zero functional impact. **Left
  unresolved** — no user available to pick fix-or-leave during this
  autonomous continuation; flagged here for a future pass.
- **[MEDIUM] CONFIRMED** (tests) — every passing test that enables
  `trySingleTxFirst` also sets `singleTxMode` in the *same* edit call, so the
  new guard's `: row.single_tx_mode` **inheritance** branch (a later edit
  flipping the flag on alone, relying on a previously-persisted `'custom'`)
  was only ever exercised via its *rejection* value (`null`), never its
  success value. **Fixed:** added a regression test exercising the
  inheritance success path plus a steady-state (unrelated-edit) assertion.
- Correctness, security: clean.

### Round 6 (terminal re-review, 4 lenses, after Round 5 fix) — CLEAN PASS

- Correctness, conventions, security, tests: **zero findings, all four
  lenses.**

## Totals

- 6 review rounds; 5 fix rounds (1 finding left open as STYLISTIC/no user
  available to choose).
- Findings: 1 HIGH→MEDIUM (manual-batch guard), 1 HIGH (multi-tx guard), 1
  HIGH (postpone misclassification), 4 MEDIUM (2 downgraded to LOW: ctx
  duplication, singleTxMode coupling; 2 stayed MEDIUM: actor attribution,
  fireAndRecord triplication; 1 stayed MEDIUM: untested inheritance path), 4
  LOW (missing test file, duplicated options+stale comment, stale ctx
  rebuild, escaped-quote style), 1 singleTxMode-enum gap (MEDIUM). All
  CONFIRMED findings fixed except the one STYLISTIC item noted above. Zero
  REFUTED.

## Final verification (postdates the last applied edit — Round 5's fix)

- `npx tsc --noEmit` — clean, no output.
- `npx vitest run` — **`Test Files 93 passed (93)` / `Tests 1356 passed
  (1356)`** (up from 1341 at the start of this review's visible portion).
- `npm run build` — clean (`tsc -p tsconfig.build.json && tsup && node
  scripts/bundle-css.mjs`, ESM + DTS builds succeeded).
- Round 6's full-scope, full-lens-set re-review (correctness, conventions,
  security, tests) — **zero CONFIRMED findings**, postdating the last
  applied edit. Loop closed.

## Behavioral verification (feature-scale, against the real compiled `dist/` artifact)

Ran a one-off script importing `@ancientpantheon/khronoton-core/server`
through the workspace-linked package exports map (exactly what a real
consumer's `import` resolves, not source) against a real in-memory
`better-sqlite3` DB and a fake `ChainRuntime` at the system boundary, driving
`codexCronotonTickOnce` through design.md's three core decision-tree
scenarios:

```
[verify-single-tx-custom] OK: fits-under-ceiling: fired via plain one-shot path, zero run rows, one success fire row — acceptance criterion #2
[verify-single-tx-custom] OK: gas-refused: fell through to the real driven chain (one run row, zero single-tx fires) — acceptance criterion #3
[verify-single-tx-custom] OK: try_single_tx_first off: byte-identical plain-fire behavior, no extra simulate call — acceptance criterion #1
[verify-single-tx-custom] all scenarios passed against the real compiled dist/ artifact.
```

All 8 of design.md's acceptance criteria are satisfied:

1. ✅ `try_single_tx_first` off is byte-identical — proven behaviorally above
   (exactly one `dirtyRead` call, the plain-fire preflight, no extra
   simulate) and by `tick.test.ts`'s dedicated test.
2. ✅ Fits → plain one-shot fire, zero run rows — proven behaviorally above
   and by `single-tx.test.ts`/`tick.test.ts`/`execute.test.ts`.
3. ✅ Gas-refused → falls through to a real driven chain — proven
   behaviorally above (`driveRunOnce` actually ran, one real run row) and by
   the dedicated unit/handler tests.
4. ✅ Genuine non-gas simulate failure surfaces as a real error, never a
   silent fallback — proven by `single-tx.test.ts`/`execute.test.ts`.
5. ✅ Fits-but-genuinely-fails-at-fire-time is recorded as a failed fire, no
   chain retry — proven by `single-tx.test.ts`.
6. ✅ Both gas-payer types (`codex`/`gas-station`) reach the identical path —
   proven by `single-tx.test.ts`.
7. ✅ `single_tx_mode: 'default'` rejected at commit/edit — proven by
   `cronoton.test.ts` (including the widened out-of-enum regression).
8. ✅ `trySingleTxFirst` on a zero-step row rejected at commit/edit — proven
   by `cronoton.test.ts`.

Ready to publish as part of `khronoton-core` 0.15.0 (pending the user's
explicit go-ahead to cut and publish the version, per this session's
established publish workflow).
