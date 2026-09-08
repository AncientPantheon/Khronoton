# Review — locked live-floor gas + priority buffer (khronoton-core 0.10.0)

Scope: uncommitted changes in `packages/khronoton-core` — 22 files (production:
`server/types.ts`, `server/seams.ts`, `blockchain/stoachain.ts`, `server/executor.ts`,
`server/store/cronoton.ts`, `server/store/mappers.ts`, `server/store/index.ts`,
`ui/builder-state.ts`, `ui/builder/ConfigTab.tsx`, `ui/builder/ExecuteTab.tsx`,
`ui/builder/Builder.tsx`, `ui/builder/TxMeters.tsx`, `ui/builder/live-gas-floor.ts` (new),
`ui/tx-size.ts`; tests for every file above plus `server/store/mappers.test.ts`;
`docs/work/gas-price-buffer/`). 16+ files → all 5 lenses each round, dispatched in
parallel.

## Round 1 (full scope)

**Findings, deduplicated (correctness + security converged on the same root cause):**

- **[HIGH → CONFIRMED]** `gasPriceBufferAnu` had zero server-side validation — a negative
  buffer, summed in *after* the floor-clamp in `stoachain.ts`'s `gasMeta`, could price a
  signed transaction below the live network floor. **Fixed:** `gasMeta` now clamps the
  buffer to 0 when non-finite or non-positive, *before* adding it to the floor-clamped
  value; `commitCodexCronoton`/`editCodexCronoton` now reject a present-and-invalid
  `gasPriceBufferAnu` before any write.
- **[MEDIUM → CONFIRMED]** No type/finiteness check server-side (NaN/Infinity could reach
  signed-tx arithmetic). **Fixed:** same store-layer check covers this (`Number.isFinite`).
- **[MEDIUM → CONFIRMED, downgraded LOW]** Client `validateConfig` missed `NaN` (only
  checked `< 0`). **Fixed:** `!Number.isFinite(...) || ... < 0`.
- **[MEDIUM → CONFIRMED, downgraded LOW]** No executor-level test for a negative buffer
  reaching `buildTransaction`. **Fixed:** added, with the local mock updated to mirror the
  real adapter's new clamp.
- **[MEDIUM → CONFIRMED, downgraded LOW]** `tx-size.ts`/`TxMeters` "grows with buffer"
  tests didn't prove the single-ANU-conversion precision fix (a buggy float-sum would also
  pass). **Fixed:** added a runtime-computed-divergent-pair test asserting the exact byte
  delta.
- **[MEDIUM → CONFIRMED, downgraded LOW]** `ExecuteTab` re-derived
  `builderToCommit`/`canCommit` on every 30s floor-poll tick, unmemoized. **Fixed:**
  wrapped both in `useMemo`.

Conventions and (after the HIGH/MEDIUM fix) performance: no findings this round.

## Round 2 (full scope, re-reviewing round 1's fixes)

Round 1's fixes were re-verified correct by fresh lenses (security: "both paths confirmed
... defense in depth"; correctness: "all six previously-confirmed issues ... check out as
correctly fixed"; performance: "genuinely effective"). Five NEW findings surfaced in the
fix code itself:

- **[LOW → CONFIRMED]** `gasLine`'s summary label read plainly "(floor)" for a transient
  negative buffer (blocked at commit, but live in UI state), implying the shown total
  equalled the floor when it was actually less. **Fixed:** added a `buffer < 0` branch
  labeling it "(floor - N)".
- **[MEDIUM → CONFIRMED]** The `gasPriceBufferAnu` validation was duplicated verbatim
  across `commitCodexCronoton`/`editCodexCronoton` instead of following the file's own
  established `assertAutoGasGate`-style shared-helper convention (validator noted an even
  stronger precedent: `runtimeArgKeysCollide` is *already* factored the same way, making
  this the sole exception). **Fixed:** extracted `assertGasPriceBufferAnu` into
  `store/mappers.ts`, called identically from both.
- **[LOW → CONFIRMED]** The tx-size.test.ts precision test's divergence-search loop broke
  on value-inequality, not the byte-length-divergence it actually needed — a latent (if
  unlikely) source of a confusing failure. **Fixed:** loop now checks byte-length
  divergence directly.
- **[MEDIUM → STYLISTIC]** Test pattern in `tx-size.test.ts` (real unmocked import +
  runtime search) looked inconsistent with `stoachain.test.ts`'s mocked/hardcoded style —
  validator found this backwards: `tx-size.test.ts`'s *entire file* already runs against
  the real installed package (documented reason: Vitest doesn't reliably mock repeated
  dynamic imports of an already-resolved package in this environment), so the new test is
  actually consistent with its own file's convention. Deferred, not fixed.
- **[MEDIUM → STYLISTIC]** Reject-path tests didn't independently verify the DB stayed
  unwritten. Validator found every other reject-path test in the same file (AutoGasGateError,
  no-future-fire, runtimeArgKeys collision, etc.) follows the identical "assert throw
  only" convention — holding only the new tests to a stricter bar. Deferred, not fixed.

## Round 3 (narrow re-review of round 2's fixes)

Tests + security: no findings (confirmed `assertGasPriceBufferAnu` isn't re-exported
through the public `server/index.ts` barrel bridge in a way that changes its trust
boundary, and the extraction is behavior-preserving). Correctness + conventions surfaced
two findings:

- **[MEDIUM → CONFIRMED]** `assertGasPriceBufferAnu` was extracted but not re-exported
  from `store/index.ts`'s barrel, breaking the explicit "mirrors `assertAutoGasGate`"
  symmetry its own doc comment claims (validator: the barrel has zero other undocumented
  exclusions — every other exported mapper is re-exported — strengthening rather than
  weakening the finding). **Fixed:** added to the barrel export list.
- **[LOW → CONFIRMED]** No direct unit tests for `assertGasPriceBufferAnu` in
  `mappers.test.ts`, unlike its mirrored sibling's full `describe` block. **Fixed:** added
  5 tests (absent/zero/positive accept; negative/non-finite reject).

## Outcome

3 rounds. 6 + 3 = 9 CONFIRMED findings, all fixed (1 HIGH, 2 MEDIUM at original severity,
6 downgraded-but-still-fixed LOW/MEDIUM). 2 STYLISTIC findings deferred to this report per
the pipeline (both were the *validator*, not just the author, concluding the existing
pattern is actually the file's own established convention — not a real defect the user
needs to weigh in on beyond this note).

### Clean pass

```
 Test Files  72 passed (72)
      Tests  938 passed (938)
```
`npx tsc --noEmit` — clean. `npm run build` — ESM + DTS + CSS bundle succeed.

Real-runtime integration (`npm run test:integration`, against installed
`@stoachain/*@4.4.0`, no mocks):
```
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

### Behavioral verification

Ran the compiled package's real store functions against a real in-memory SQLite DB
(`better-sqlite3`), exercising every acceptance criterion end-to-end:

```json
{
  "preMigrationRowHasNoBuffer": true,
  "bufferedRowStored": true,
  "negativeBufferRejectedAtCommit": true,
  "negativeBufferRejectedAtEdit": true,
  "rowUnchangedAfterFailedEdit": true
}
```

Confirms: a pre-migration row's `config_json` carries no `gasPriceBufferAnu` field (self-
heals to 0 on read); a new cronoton with a buffer commits and stores it; a negative buffer
is rejected at both commit and edit time with the row left genuinely unwritten/unchanged
(not just "throws" — checked the actual row).

## Design acceptance criteria — final check

- [x] A pre-migration cronoton loads with buffer 0 and fires at exactly the live floor —
      verified by `builder-state.test.ts` + the behavioral script above.
- [x] A buffer commits and fires with `gasPrice = anuToStoaNumber(liveFloor + buffer)` — a
      single exact conversion, not two summed — verified by `stoachain.test.ts`'s
      divergent-pair test and `executor.test.ts`.
- [x] The Builder UI's live floor display updates on interval + refocus — verified by
      `live-gas-floor.test.ts` (5 tests: initial resolve, 30s interval, visibilitychange,
      focus, graceful failure) and `Builder.test.tsx`'s mocked end-to-end render.
- [x] A negative buffer is blocked, never silently accepted — verified at THREE layers now
      (client `validateConfig`, store `commitCodexCronoton`/`editCodexCronoton`, and the
      `stoachain.ts` seam's defensive clamp) with tests at each layer plus a live DB check.
- [x] AUTO-gas rebuild re-derives `gasMeta` fresh — unchanged 0.9.0 invariant, re-tested
      with the buffer now threaded through both calls.
- [x] `BuilderConfig`/`CommitGateOptions` no longer expose `gasPriceAnu`/
      `minGasPriceAnu` — confirmed removed (`grep` returns zero references outside this
      review's own history).
