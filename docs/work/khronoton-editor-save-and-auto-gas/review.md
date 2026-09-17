# Review — discoverable edit-mode Save + auto self-calibrating gas (khronoton-core)

Scope: uncommitted changes in `packages/khronoton-core` — 15 code files (production:
`server/seams.ts`, `blockchain/stoachain.ts`, `server/executor.ts`, `ui/builder-state.ts`,
`ui/builder/ExecuteTab.tsx`, `ui/builder/Builder.tsx`, `ui/builder/SaveBar.tsx` (new),
`ui/builder/use-commit-gate.ts` (new), `ui/builder/format.ts`; tests for every file above).
16+ files (counting the 2 designs' combined scope) → all 5 lenses, dispatched in parallel.

## Round 1 (full scope)

**Findings, deduplicated (8 total — the tests lens's and security lens's NaN-ceiling
findings converged on the same root cause and were merged):**

- **[HIGH → CONFIRMED, downgraded MEDIUM]** `SaveBar` rendered (and its Simulate button
  was clickable) before the edit row finished loading — during that window `state` is
  still `makeEmptyBuilderState()`, so Simulate could dry-run a blank transaction instead
  of the cronoton being edited. Validator noted Save itself stayed correctly disabled
  during the window (the gate is also computed from the same empty state), narrowing the
  real blast radius to Simulate only. **Fixed:** `SaveBar`'s render condition in
  `Builder.tsx` changed to `isEdit && editReady`.
- **[HIGH → CONFIRMED, downgraded MEDIUM]** `SaveBar`'s `onSimulate` had no
  `canMutate(access)` guard, asymmetric with `onSaveClick`'s double-guard (disabled
  attribute + click-handler check) — a bypassed `disabled` attribute (e.g. a directly
  dispatched click event) could trigger a real sign + dry-run for a non-admin. Validator
  confirmed the server has its own independent `withConfirm`/`auth.requireConfirm` gate
  and that a native `disabled` blocks real human clicks — narrowing this from a live
  exploit to a defense-in-depth/consistency gap. **Fixed:** added the same guard to
  `onSimulate`.
- **[MEDIUM → CONFIRMED]** `resolveCeiling` in `executor.ts` trusted a `NaN`/non-finite
  ceiling verbatim (`typeof NaN === "number"` is `true`, and `gasUsed > NaN` is always
  `false`) — silently defeating the refuse-unmineable check rather than falling back as
  documented. Validator confirmed this is unreachable for the one shipped adapter
  (`stoachain.ts` already range-checks) but a real gap in the executor's own defensive
  contract for any future `ChainClient`. **Fixed:** new `isSaneCeiling` validator applied
  to both the config-override and live-fetch paths.
- **[MEDIUM → CONFIRMED, downgraded LOW]** No test distinguished a single reused
  `ChainClient` from a regression constructing a second one for ceiling resolution.
  Validator noted the `resolveCeiling(ctx, client)` signature already makes this
  regression harder to introduce than a typical aliasing trap. **Fixed:** added a
  `createClient` call-count assertion.
- **[MEDIUM → CONFIRMED]** `SaveBar.tsx`'s postponed-detail pluralization was a
  character-for-character copy of `ExecuteTab.tsx`'s — validator confirmed `format.ts`'s
  own doc comment documents this exact drift risk as the reason a prior duplication
  (`formatThousands`) was extracted. **Fixed:** extracted `postponedMessage()` to
  `format.ts`.
- **[MEDIUM → CONFIRMED]** `executeCodexTransaction`'s function-level doc comment still
  described the pre-submit check generically as "dirty-read", inconsistent with the
  already-updated module-level doc. **Fixed:** updated to describe the AUTO/MANUAL
  `preflightRead`/`dirtyRead` split.
- **[LOW → CONFIRMED]** Inconsistent "Simulate failed:" (SaveBar) vs "Simulation failed —"
  (ExecuteTab) phrasing for the same event — validator confirmed both can be
  simultaneously on-screen (edit mode, Execute tab active, same shared `sim` object),
  ruling out a "different voice" STYLISTIC defense. **Fixed:** aligned to the latter.
- **[LOW → CONFIRMED]** `SaveBar` and `ExecuteTab` each called `useCommitGate`
  independently — `builderToCommit`/`canCommit` ran twice per keystroke when both were
  mounted (edit mode, Execute tab active). Validator calibrated this against this
  package's own prior review precedent (a near-identical pattern was downgraded to LOW
  for a single component) and confirmed it's still proportionally minor. **Fixed:**
  lifted the hook to a single call in `Builder.tsx`, threaded as `commit`/`gate` props.

Correctness (beyond the readiness gap) and performance (beyond the double-compute):
no findings this round.

## Round 2 (terminal, targeted re-review of the fixes)

Correctness + security: no findings — every fix independently re-traced against the
actual landed code (the `editReady` gate correctly wraps `SaveBar`'s render; the
`onSimulate` guard covers both non-admin and logged-out; `isSaneCeiling` correctly
rejects `NaN`/`0`/negative/`Infinity`; the `useCommitGate` lift's `useMemo` dependencies
are correct).

Tests + conventions: one new finding —

- **[MEDIUM → CONFIRMED, downgraded LOW]** The new shared `postponedMessage` helper had
  no direct unit test; its singular (`plannedCount: 1`) and absent-count branches were
  never exercised by either component test. **Fixed:** added a `describe("postponedMessage"
  , ...)` block to `format.test.ts` covering all three branches.

## Outcome

2 rounds. 9 CONFIRMED findings total, all fixed (2 downgraded from HIGH to MEDIUM after
validation narrowed their real-world blast radius; 2 downgraded from MEDIUM to LOW; the
rest held at their claimed severity). Zero REFUTED, zero STYLISTIC this pass.

### Clean pass

```
 Test Files  74 passed (74)
      Tests  980 passed (980)
```
`npx tsc --noEmit` — clean. `npm run build` — ESM + DTS + CSS bundle succeed.

### Behavioral verification

This is a combined UI + server feature; the test suite itself constitutes the
behavioral-verification leg for both halves — `Builder.test.tsx` mounts the real
`Builder` component (real `SaveBar`, real `ExecuteTab`, real tab-switching, a fake
adapter at the network boundary only) and drives it via real DOM events (typing,
clicking tabs, clicking Simulate/Save), including the new readiness test that uses a
genuinely controllable/delayed `adapter.get` promise to prove `SaveBar` cannot render
against a stale/blank state. `executor.test.ts` calls the real
`executeCodexTransaction`/`buildTransaction`/`resolveCeiling` functions with only the
`ChainRuntime`/`ChainClient` seam mocked (the same boundary every prior topic in this
package's history has used as the legitimate injection point) — including the new
`isSaneCeiling` matrix (`NaN`, `0`, `-1`, `Infinity`) run against the real validator
function, and the `createClient`-called-once assertion against the real, reordered
`runSimulate`/`runFire` control flow.
