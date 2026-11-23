# `ouronet.aqp-inject` executor fix + distinguishable fan-out-needed error — Review

Scope: `packages/khronoton-core/src/server/planners/inject.ts`, `inject.test.ts`, plus a
mechanical fixture fix in `runs-driver.test.ts` (two pre-existing real-planner integration tests'
`ouronet.aqp-inject` fixtures needed an `executor` field added to keep passing against the new,
stricter validation — not part of this topic's own design, done to unblock the full suite).

Lenses: correctness, conventions, security, tests — money-moving planner logic (feeds directly
into signed Pact transaction payloads naming the on-chain token-debited account), matching this
project's established convention for planner-touching work even though the diff is only 3 files
(the skill's own "≤3 files" tier would allow just 2 lenses inline; ran the full 4-lens set anyway
given the content).

## Round 1

- **[MEDIUM] CONFIRMED** (correctness) — the pre-existing "missing fvtId"/"missing amount
  specifically" tests both also omitted the new `executor` field, so the combined validation
  guard's static error message (naming all five required fields regardless of which are actually
  missing) meant these tests would keep passing even if the `fvtId`/`amount` checks themselves
  were silently dropped from the guard — false confidence in regression coverage for two
  load-bearing fields. **Fixed:** both fixtures now supply every other required field (including
  `executor`), properly isolating the one field each test claims to exercise, mirroring the
  already-correct "missing executor" test's own pattern.
- Conventions, security, tests: clean.

## Round 2 (terminal re-review, 4 lenses, after the Round 1 fix) — CLEAN PASS

- Correctness, conventions, security, tests: **zero findings, all four lenses.**

## Totals

- 2 review rounds; 1 fix round. 1 CONFIRMED finding fixed, 0 REFUTED, 0 STYLISTIC.

## Final verification (postdates the last applied edit)

- `npx tsc --noEmit` — clean, no output.
- `npx vitest run` — **`Test Files 93 passed (93)` / `Tests 1360 passed (1360)`** (up from 1356 at
  the start of this topic — 4 new tests in `inject.test.ts`: missing/empty/`k:`-prefixed executor
  rejection, and the `InjectRequiresUnstallError`-vs-plain-`Error` branching).
- `npm run build` — clean (`tsc -p tsconfig.build.json && tsup && node scripts/bundle-css.mjs`,
  ESM + DTS builds succeeded).
- Round 2's full-scope, full-lens-set re-review — **zero CONFIRMED findings**, postdating the last
  applied edit. Loop closed.

## Behavioral verification (feature-scale, against the real compiled `dist/` artifact)

Ran a one-off script importing `injectPlanner`/`InjectRequiresUnstallError` from
`@ancientpantheon/khronoton-core/server` through the workspace-linked package exports map (exactly
what a real consumer's `import` resolves, not source), against a fake `ChainRuntime` at the system
boundary, driving all four of design.md's core scenarios:

```
[verify-inject-executor-fix] OK: executor flows into payload from planner_params_json, never derived from the signer — acceptance criterion #2
[verify-inject-executor-fix] OK: k:-prefixed executor rejected before any chain call — the exact bug class this fix closes
[verify-inject-executor-fix] OK: CC_InjectFinalize fail + CC_Inject gas-refused throws the distinguishable InjectRequiresUnstallError — acceptance criterion #5
[verify-inject-executor-fix] OK: CC_InjectFinalize fail + CC_Inject genuine non-gas fail throws a plain Error, never InjectRequiresUnstallError — acceptance criterion #6
[verify-inject-executor-fix] all scenarios passed against the real compiled dist/ artifact.
```

All 7 of design.md's acceptance criteria are satisfied (criteria 1/3/4 — missing/empty executor
rejection, `signers[0]` no longer sourcing `executor`, the doc-comment fix — are proven by
`inject.test.ts`'s own unit tests plus direct reading of the shipped `inject.ts` source; criteria
2/5/6 are additionally proven behaviorally above against the real built artifact; criterion 7 —
`InjectRequiresUnstallError` publicly exported — is proven by the behavioral script's own
successful `import` of it from the package's public `/server` subpath).

Ready to publish as a new `khronoton-core` patch/minor version (pending the user's go-ahead on
exact version bump + the downstream AncientHoldings Hub handback, per the task's own release &
handback requirement).
