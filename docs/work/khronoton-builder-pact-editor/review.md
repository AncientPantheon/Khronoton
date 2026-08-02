# Khronoton Builder — Pact-code syntax highlighting + top/bottom layout — Review

Six rounds. Every round after the first found at least one real, evidence-backed issue the previous
round missed — including one genuine regression (a reintroduced crash bug) that a lens found only by
cross-referencing a sibling file's documented institutional knowledge. All findings below were
adversarially validated in a fresh context before being fixed; only CONFIRMED findings were fixed.

## Round 1 — initial full pass (5 lenses: correctness, conventions, security, tests, performance)

### [CONFIRMED — MEDIUM → fixed] Unmemoized Pact editor extensions force a full CodeMirror reconfigure on every render
- **Where:** `PactCodeMirror.tsx`, `pact-lang.ts`
- Flagged independently by both the performance and correctness lenses (severity reconciled HIGH→MEDIUM on
  validation: real inefficiency, not user-facing breakage). `buildPactEditorExtensions()` built a fresh
  `StreamLanguage` instance on every call; `@uiw/react-codemirror`'s reconfigure effect watches `extensions`
  by reference. **Fix:** hoisted to a module-level constant.

### [CONFIRMED — MEDIUM → fixed] `tx-size.test.ts`'s "never throws" test never exercised the catch/fallback branch
- **Where:** `tx-size.ts`, `tx-size.test.ts`
- `builderToCommit` sanitizes invalid payload JSON before the try-block runs, and the real StoaChain SDK
  doesn't reject empty/malformed-looking input — so the "accurate" path always succeeded in that test.
  **Fix attempt 1** (module mocking via `vi.mock`/`vi.resetModules`) did not reliably intercept the real,
  already-installed package's dynamic import in this environment — confirmed by two failed attempts with
  different mock strategies, both producing the accurate-path byte count instead of the fallback's.
  **Final fix:** extracted the fallback formula into its own pure `estimateFallbackBytes` function, tested
  directly and deterministically instead of trying to force the catch branch from the outside.

### [CONFIRMED — LOW → fixed] Sequential `await import()` calls in `estimateTxSize` could be parallelized
- **Where:** `tx-size.ts`
- Initially fixed to `Promise.all([...])`. **This was later found to be a real regression** — see Round 6.
  Ultimately reverted; see below.

### [CONFIRMED — MEDIUM → fixed] Stale "two-pane" docblock in `Builder.tsx`
- Contradicted the accurate top/bottom description a hundred lines below. **Fix:** corrected.

### [CONFIRMED — LOW → fixed] `PANE_WRAP`'s JSX children not re-indented after the grid→flex layout change
- **Fix:** re-indented.

### [CONFIRMED — MEDIUM → fixed] `TxMeters.tsx` bypassed the package's locale-pinned thousands formatter
- Used bare `.toLocaleString()` instead of the `.toLocaleString("en-US")` convention `ExecuteTab.tsx`/
  `ConfigTab.tsx` already used for the same kind of figure. **Fix:** applied the pinned formatter (later
  extracted to a shared module — see Round 4).

### [CONFIRMED — LOW → fixed] `JSON.stringify(state.payload)` recomputed unconditionally on every `TxMeters` render
- Severity downgraded MEDIUM→LOW on validation (real but minor). **Fix:** depend on `state.payload`
  (object reference) directly — verified safe by tracing every sibling tab's `onChange`, which all preserve
  the payload reference across unrelated edits.

### [REFUTED] Negative-number literals tokenize as two tokens (operator `-` + number)
- Technically true, but matches the reference OuronetUI grammar's own behavior exactly (checked its actual
  `Number`/`Decimal`/`Operator` grammar rules) — intentional token-category parity, not a defect.

### [STYLISTIC — deferred] `peerDependenciesMeta` key ordering in `package.json` breaks from the file's
otherwise-alphabetical convention
- Real, but zero runtime effect (JSON key order is inert) and a reasonable reviewer could argue either
  way. Left for the user to decide — not applied.

## Round 2 — re-verify Round 1 fixes + fresh pass

No new findings; Round 1's fixes verified correct. (Full suite green after applying all Round 1 fixes.)

## Round 3 — terminal pass after Round 2

### [CONFIRMED — HIGH → fixed] Round 1's reconfigure fix was incomplete
- `basicSetup` (a fresh object literal every render) and `Builder.tsx`'s inline `onChange` closure (a fresh
  function every render) are ALSO in `useCodeMirror`'s reconfigure-effect dependency array, not just
  `extensions` — so the full-reconfigure-per-keystroke behavior persisted via two different props. **Fix:**
  hoisted `basicSetup` to a module constant; wrapped `Builder.tsx`'s handler in `useCallback` with the
  functional `setState` form (empty deps).

### [CONFIRMED — MEDIUM → fixed] `TxMeters`'s Gas row inferred "simulate succeeded" from `gasUsed` alone, never checking `sim.result?.ok`
- `SimulateView` isn't a discriminated union; a non-conforming adapter could return `{ ok: false, gasUsed:
  N }`. `ExecuteTab.tsx` already gates the equivalent logic on `ok`; `TxMeters` didn't. **Fix:** added the
  `ok === true` gate (and dropped the now-redundant `used > 0` check per the same fix).

### [CONFIRMED — MEDIUM → fixed] Same stale-docblock issue Round 1 fixed in `Builder.tsx`, missed in the sibling `PactCodeEditor.tsx`
- Both the module docblock and a test title still said "the builder's left pane." **Fix:** corrected both.

### [CONFIRMED — LOW → fixed] `estimateFallbackBytes`'s primary test recomputed its expectation via the same expression the implementation uses
- Tautological — proves `TextEncoder` is deterministic, not that the formula is correct. **Fix:**
  hand-counted and hardcoded the expected byte values (verified independently via a standalone script
  before hardcoding).

## Round 4 — terminal pass after Round 3

### [CONFIRMED — MEDIUM → fixed] The new `ok`-gate on `TxMeters`'s `hasSim` was itself unverified by any test
- No test constructed `{ ok: false, gasUsed: N }` to prove the gate actually works. **Fix:** added that
  test; independently confirmed it would fail if the `ok` check were removed.

## Round 5 — terminal pass after Round 4

### [CONFIRMED — MEDIUM → fixed] `@doc`/`@model` meta tags were tokenized correctly but never colored
- `pact-lang.ts`'s `HighlightStyle` had an entry for every tag in `tokenTable` except `t.meta` — a common
  real-world Pact construct silently rendering unstyled, contradicting the design's explicit token-parity
  goal. **Fix:** added the missing rule (reuses `--khr-blue`). Also added a structural regression test
  (`PACT_TOKEN_TABLE` vs `PACT_HIGHLIGHT_SPECS` cross-check) so this exact bug class — a token registered
  but never styled — can't silently recur.

### [CONFIRMED — LOW → fixed] Dead `stream.current()` branch in the identifier tokenizer
- `StringStream.match(regExp)` never returns a bare boolean at runtime, only `null` or the match array
  (verified against the actual `@codemirror/language` implementation) — the `Array.isArray` branch was
  unreachable. **Fix:** simplified (required a `as RegExpMatchArray` type assertion, since the *declared*
  type doesn't narrow on the pattern argument's type — this assertion reflects real runtime behavior, not
  an assumption).

### [CONFIRMED — LOW → fixed] `formatThousands` triplicated verbatim across `ConfigTab.tsx`, `ExecuteTab.tsx`, `TxMeters.tsx`
- Two of the three copies predate this change; `TxMeters.tsx` added a third. **Fix:** extracted to a new
  shared `builder/format.ts`, all three now import it.

### [CONFIRMED — MEDIUM → fixed] `subBar`-omitted test in `PactCodeEditor.test.tsx` was tautological
- Asserted text that was never passed to that specific render call was absent — true regardless of the
  wrapper's actual behavior. **Fix:** added `data-testid="pact-editor-subbar"` to the wrapper and asserted
  on its presence/absence instead of unrelated text.

## Round 6 — terminal pass after Round 5

### [CONFIRMED — LOW → fixed] Stale doc comment describing a rendered "tick" `TxMeters.tsx` never draws
- `PROXY_SOFT_LIMIT`'s comment claimed a fixed tick mark on the meter; the actual implementation only uses
  it for a color-tier threshold. **Fix:** reworded to match actual behavior.

### [CONFIRMED — HIGH → REVERTED, then re-verified] Round 1/3's "parallelize the sequential imports" fix reintroduced a documented crash bug
- `tx-size.ts`'s three `@stoachain/*` dynamic imports had been collapsed into `Promise.all([...])` back in
  Round 1 (as a LOW-severity performance suggestion). This is caught only because a Round 6 pass was
  explicitly told to cross-reference `blockchain/stoachain.ts`, whose own docblock documents: `@stoachain/*`
  ESM modules internally `require()` one another, and loading them concurrently via `Promise.all` races on
  Node's ESM/CJS interop, throwing `ERR_INTERNAL_ASSERTION` on Node 24+. This environment runs Node 22, so
  832 tests stayed green throughout despite the bug being present — it would only have surfaced in
  production on a newer Node. **Fix:** reverted to three sequential `await import(...)` statements, with a
  comment explaining why and referencing this history so it isn't "optimized" again. Verified: (a) the
  revert is genuinely sequential (re-read post-fix); (b) `tx-size.test.ts`'s own `Promise.all([estimateTxSize(...),
  estimateTxSize(...)])` is a *different, safe* pattern (concurrent calls sharing the *same* import
  specifiers, which ES modules dedupe via a shared in-flight promise — not the documented bug, which
  requires *different, interdependent* specifiers loaded concurrently); (c) no other occurrence of the
  dangerous pattern exists anywhere in the reviewed scope.

### [CONFIRMED — HIGH → fixed, pre-existing] `tsup.config.ts`'s `external` list was missing `@ouronet/ouronet-core`
- Predates this change entirely (`git log` shows this pattern was never present) — `/blockchain/stoachain`'s
  lazy `@ouronet/ouronet-core/constants` import was being bundled into `dist/blockchain/stoachain.js`
  instead of resolving from the consumer's install, silently reintroducing the exact version-pinning
  conflict the 0.4.1 release existed to fix. Found because this exact file was already being touched by
  this change (the `@lezer` addition) and a lens happened to check the whole `external` array against every
  reachable lazy import. **Fix:** added `/^@ouronet/`. **Verified via a real build** (`npm run build`),
  not just a lens read — `dist/blockchain/stoachain.js` now contains a genuine external
  `await import('@ouronet/ouronet-core/constants')` rather than inlined/bundled code.

### [CONFIRMED — MEDIUM → fixed] New `--khr-*` tokens undocumented in `THEMING.md`/`CHANGELOG.md`
- Directly maps to design.md's own acceptance criterion. **Fix:** added the CHANGELOG entry naming all six
  new tokens and updated `THEMING.md`'s Tokens line — done as part of this review's closing pass (see
  final report).

## Final state

- **Full package suite:** `Test Files  69 passed (69)` / `Tests  832 passed (832)`.
- **Typecheck:** clean (`tsc --noEmit`, zero errors).
- **Build:** `npm run build` succeeds; `/blockchain/stoachain`'s dist output verified to correctly leave
  `@stoachain/*` and `@ouronet/*` external.
- Six full review rounds; the sixth round (covering the `Promise.all` revert and the `tsup.config.ts` fix)
  was verified via a real build and independent re-reading rather than a seventh full 5-lens dispatch —
  both changes are small, mechanical, and were already diagnosed precisely by Round 6's own lenses.
- One STYLISTIC finding (Round 1) remains open for the user's choice: `package.json`'s
  `peerDependenciesMeta` key ordering.
