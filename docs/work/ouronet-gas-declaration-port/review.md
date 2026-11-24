# Port OuronetUI's closed-form gas-declaration model into Khronoton — Review

Scope: `server/pure/gas-declaration.ts` (new), `server/executor.ts`, `server/resolvers.ts`,
`server/pure/split-plan.ts`, `server/types.ts`, plus each file's test suite. 4 tasks across 3 waves
(`docs/work/ouronet-gas-declaration-port/plan.md`), all ticked complete.

Lenses: correctness, conventions, security, tests — money-moving gas-ceiling/calibration logic
feeding directly into signed Pact transaction `gasLimit`/capability decisions, matching this
project's established convention for this file family.

## Round 1

- **[MEDIUM] CONFIRMED** (correctness) — `declareGasLimit`'s sub-floor branch hardcoded
  `clampedToCeiling: false` even when the legacy ladder's own output genuinely got clamped to
  `ceiling`, contradicting the field's documented contract. **Fixed:** compute the ladder's raw
  output once, set `clampedToCeiling: ladderOutput > ceiling`.
- **[MEDIUM] CONFIRMED** (correctness) — `executor.ts`'s `runSimulate` still called
  `runtime.calculateAutoGasLimit` directly for its `calibratedGasLimit` preview, diverging from what
  `submitTransaction` now actually declares at fire time once that path was ported — the exact
  inconsistency this topic exists to eliminate, left standing on the preview path. **Fixed:**
  resequenced `runSimulate` to preflight the UNSIGNED `tx` (matching `submitTransaction`'s own fix,
  for the same signature-byte-ambiguity reason) and route `calibratedGasLimit` through
  `declareGasLimit`.
- Conventions, security, tests: clean.

## Round 2 (terminal re-review, 4 lenses, after Round 1 fixes)

- **[MEDIUM] CONFIRMED** (correctness) — `runSimulate` still signed the transaction unconditionally
  even though resequencing made the AUTO-gas branch never read `signed` at all — wasted
  resolver/sign work on every AUTO-gas simulate, and (since the sign ran before the
  `preflightRead`-availability check) capable of masking that check's own clearer error behind an
  unrelated signing failure. **Fixed:** only the MANUAL-gas branch signs now, mirroring
  `submitTransaction`'s own `if`/`else` exactly.
- **[MEDIUM] CONFIRMED** (conventions) — the fix re-duplicated the identical five-field
  `declareGasLimit` construction in both `runSimulate` and `submitTransaction`, reopening the exact
  drift risk Round 1's fix just closed. **Fixed:** extracted a shared `calibrateAutoGas(runtime, tx,
  gasUsed, signers, ceiling)` helper, used by both call sites.
- Security, tests: clean.

## Round 3 (terminal re-review, 4 lenses, after Round 2 fixes)

- **[LOW] CONFIRMED** (correctness) — `types.ts`'s `ExecutorMode` doc comment still claimed every
  `simulate` call "signs + dirty-reads," no longer true for AUTO-gas after Round 2's fix removed its
  sign call. **Fixed:** updated the comment to describe the real MANUAL-gas-signs/AUTO-gas-never-signs
  split.
- Conventions, security, tests: clean.

## Round 4 (terminal re-review, 4 lenses, after Round 3 fix)

- **[LOW] CONFIRMED** (conventions) — the Round 3 doc fix copy-pasted `executor.ts`'s own "this
  module's own `calibrateAutoGas`" wording into `types.ts`, where `calibrateAutoGas` doesn't exist —
  inconsistent with this same file's own established "name the file explicitly" cross-reference
  convention. **Fixed:** "this module's own" → "`executor.ts`'s own".
- Correctness, security, tests: clean.

## Round 5 (terminal re-review, 4 lenses, after Round 4 fix) — CLEAN PASS

- Correctness, conventions, security, tests: **zero findings, all four lenses.**

## Totals

- 5 review rounds; 4 fix rounds. 6 CONFIRMED findings fixed (2 MEDIUM correctness, 1 MEDIUM
  correctness, 1 MEDIUM conventions, 2 LOW doc-accuracy), 0 REFUTED, 0 STYLISTIC.

## Final verification (postdates the last applied edit)

- `npx tsc --noEmit` — clean, no output.
- `npx vitest run` — **`Test Files 98 passed (98)` / `Tests 1465 passed (1465)`** (up from 1454 at
  the start of this topic's build — 11 new tests: 4 in `gas-declaration.test.ts`, 2 in
  `executor.test.ts`'s resequencing block, plus the pre-existing suite's margin/behavior updates in
  `split-plan.test.ts`/`resolvers.test.ts`).
- `npm run build` — clean (`tsc -p tsconfig.build.json && tsup && node scripts/bundle-css.mjs`).
- Round 5's full-scope, full-lens-set re-review — **zero CONFIRMED findings**, postdating the last
  applied edit. Loop closed.

## Behavioral verification (feature-scale, against the real compiled `dist/` artifact)

`gas-declaration.ts` is an internal pure module — like its sibling `pure/split-plan.ts`, it is
deliberately NOT part of `package.json`'s `exports` map (confirmed by reading it: the map only
exposes `.`, `/server`, `/handlers`, `/provider`, `/hooks`, `/ui`, `/ui.css`,
`/blockchain/stoachain` — no deep-subpath wildcard), and no task in plan.md ever called for adding
it. Every real consumer (`executor.ts`, `resolvers.ts`, `split-plan.ts`) reaches it via a relative
import inside the package; this is correct by design, not a gap. So the verification script
imports the compiled file directly by its real `dist/server/pure/gas-declaration.js` path instead
of through the public package name — this still exercises the actual build artifact (catching any
tsc/tsup transpilation drift from source), just not the npm public-API surface, which this module
was never meant to be part of. Ran this script, confirming:

```
[verify-gas-declaration-port] OK: at EVIDENCE_FLOOR (20,000 gas), the new formula is used (not the
  legacy ladder) and disagrees with it — declareGasLimit → 21,150; legacy ladder (calculateAutoGasLimit) → 27,000
[verify-gas-declaration-port] OK: maxSimulatedGasAtLimit(2,000,000) = 1,999,350 (was 1,600,000 hand-set)
[verify-gas-declaration-port] OK: maxSimulatedGasFor(2,000,000) = 1,989,402 — strictly less headroom
  than maxSimulatedGasAtLimit, as the "extrapolated vs. measured" design calls for
[verify-gas-declaration-port] OK: below EVIDENCE_FLOOR (8 gas), declareGasLimit defers to the injected
  legacy ladder unchanged — gasLimit = 1,000, legacyLadder called exactly once
[verify-gas-declaration-port] all scenarios passed against the real compiled dist/ artifact.
```

All of design.md's acceptance criteria are satisfied:

1. ✅ `pure/gas-declaration.ts` exports everything specified, byte-identical to OuronetUI's own
   formula for the same inputs — proven by `gas-declaration.test.ts`'s worked-example tests and the
   behavioral script above.
2. ✅ AUTO-gas `preflightRead` receives the unsigned build — proven by `executor.test.ts`'s
   `invocationCallOrder` assertion.
3. ✅ AUTO-gas signs exactly once (now: for `fire`/`submit`; zero times for `simulate`, an even
   stronger result than the original criterion anticipated, since Round 2's fix found `simulate`
   never needed to sign at all).
4. ✅ `calibratedGasLimit`/declared `gasLimit` at/above `EVIDENCE_FLOOR` comes from `declareGasLimit`,
   proven to disagree with the old ladder — both in `executor.test.ts` and the behavioral script.
   4b. ✅ Below `EVIDENCE_FLOOR`, byte-identical to the old ladder — proven both ways.
5. ✅ MANUAL-gas fire is byte-for-byte unchanged — the entire pre-existing MANUAL-gas test suite
   passes unmodified.
6. ✅ `fireWithServerResolver`'s guard defaults to `maxSimulatedGasAtLimit(ceiling)`, not the
   hand-set `1,600,000` — proven by `resolvers.test.ts` and the behavioral script.
7. ✅ An explicit `config.singleTxGasGuard` override still takes priority — proven by
   `resolvers.test.ts`.
8. ✅ `split-plan.ts`'s `capacityFor` uses the derived headroom functions; `PLANNING_MARGIN`/
   `CONFIRMED_MARGIN` are fully removed (`grep -c` returns `0`).
9. ✅ Every pre-existing planner/single-tx-first/executor test still passes (updated where it
   specifically measured the old formula's exact numeric output, never loosened).

Ready to ship as part of the next `khronoton-core` release. **Not yet committed or version-bumped**
— see the note to the user on coordinating this with the concurrent, uncommitted ChainedBuilder UI
work already occupying `package.json`'s `0.17.0` in this same working tree.
