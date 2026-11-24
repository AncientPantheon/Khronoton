# Built-in descriptor + composable-fragment layer — Review

Scope: `src/builtins/descriptors.ts` (new), `src/builtins/descriptors.test.ts` (new), one appended
re-export line in `src/ui/index.ts`. 3 tasks across 3 waves (`docs/work/builtin-descriptors/plan.md`),
all ticked complete.

Lenses: correctness, conventions, security, tests — this module constructs Pact capability lines
and raw Pact expression fragments from operator-supplied params, intended for direct splicing into
signed transactions; matches this project's established convention for Pact-payload-adjacent work.

## Round 1

- **[HIGH→REFUTED]** (correctness) — a finding claimed `stoa-wrap`/`stoa-unwrap`'s composable
  fragments read `(read-string "executor")` but never supply that payload key. **Refuted on
  validation:** confirmed intentional — `docs/work/builtin-descriptors/plan.md`'s own text states
  composable mode has no signer to derive `executor` from, and the surrounding hand-written block
  is meant to supply it via its own env-data; a pre-existing `toEqual` test on the full payload
  object already locks in the absence as correct. No change made.
- **[MEDIUM] CONFIRMED** (correctness) — the `transmit-anew` branch used `params.receiverPublicKey`
  with no presence/type check, silently producing a malformed `{ keys: [undefined] }` keyset instead
  of failing loudly, inconsistent with `stoa-unwrap`'s own validated `needsCreate:"yes"` branch.
  **Fixed:** throw a descriptive error when `receiverPublicKey` is missing/empty, for both transmit
  descriptors.
- **[LOW→STYLISTIC]** (conventions) — the amount literal-vs-expression ternary was duplicated
  verbatim across all 4 composable `toFragment` bodies. Validator noted the file's own
  per-module-duplication convention doesn't license or forbid same-file duplication either way, and
  the extraction's benefit is marginal for a 2-3 line pattern — ruled STYLISTIC. **Left unresolved**
  — no user available to pick fix-or-leave during this autonomous continuation; flagged for a
  future pass.
- **[HIGH→MEDIUM] CONFIRMED** (security) — `patronAccount`/`targetAccount`/`sender`/`receiver` were
  spliced raw into `requiredCaps[].line` with zero shape validation, despite the real sibling
  planners (`stoa-wrap.ts`) enforcing the identical `ACCOUNT_SHAPE` regex before trusting a value
  enough to reach a signed capability line. Validator downgraded HIGH→MEDIUM since nothing in this
  repo calls `toFragment` outside tests yet (the consuming ChainedBuilder UI wiring is explicitly
  deferred per design.md) — real, but not yet live-reachable. **Fixed:** added `assertAccountShape`
  (the real planners' own regex), applied before every account field reaches a capability line or
  `pactExpr`, including `targetAccount` unconditionally (not just inside `stoa-unwrap`'s
  `needsCreate:"yes"` branch, which a sibling finding — see below — confirmed was the same root
  cause at finer granularity and should merge into this one fix).
- **[MEDIUM]** (security) — `targetAccount`'s one existing regex guard only covered
  `stoa-unwrap`'s `needsCreate:"yes"` branch, leaving the cap-line splice unguarded on the `"no"`
  path. Validator confirmed this is the SAME root cause as the account-field-injection finding above,
  just described at finer granularity, and recommended merging rather than fixing twice. **Merged
  and fixed together** with the account-field-injection fix.
- **[HIGH→MEDIUM] CONFIRMED** (security) — `amountCeiling`/`capAmount` were spliced into capability
  lines with zero decimal-shape validation, the identical injection shape as the account fields,
  downgraded for the same not-yet-live-reachable reason. **Fixed:** added `assertLiteralDecimal`,
  applied before either field reaches any capability line.
- **[MEDIUM] CONFIRMED** (security) — `namespace` is spliced directly into the EXECUTED `pactExpr`
  itself (not merely a capability permission line) with zero shape validation — a stronger
  primitive than cap-line corruption, since it affects the code that runs. Validator kept this at
  MEDIUM rather than HIGH given the same operator who supplies `namespace` already hand-authors the
  surrounding Pact block, so exploiting it requires attacking one's own transaction. **Fixed:**
  added `assertNamespaceShape` (a Pact-identifier regex), applied before `namespace` reaches
  `pactExpr`.
- Tests: clean.

## Round 2 (terminal re-review, 4 lenses, after Round 1 fixes) — CLEAN PASS

- Correctness, conventions, security, tests: **zero findings, all four lenses.** (The tests lens
  noted, but explicitly did not report as a finding, that the new regression block tests
  `patronAccount`/`amountCeiling`/`namespace` rejection only via `stoa-wrap` and only
  `targetAccount` via `stoa-unwrap`, even though `stoa-unwrap` independently calls the same three
  validators — a minor coverage-completeness observation, not a behavior-vs-implementation defect,
  left as-is.)

## Totals

- 2 review rounds; 1 fix round. 4 CONFIRMED findings fixed (1 MEDIUM correctness, 3 MEDIUM security
  — one of which absorbed a second, merged finding), 1 REFUTED, 1 STYLISTIC left open pending user
  choice.

## Final verification (postdates the last applied edit)

- `npx tsc --noEmit` — clean, no output.
- `npx vitest run` — **`Test Files 98 passed (98)` / `Tests 1464 passed (1464)`** at the point this
  topic's own fixes landed (10 new tests: 9 malformed-field rejection cases + the
  receiverPublicKey-presence cases, across all 4 composable descriptors).
- `npm run build` — clean.
- Round 2's full-scope, full-lens-set re-review — **zero CONFIRMED findings**, postdating the last
  applied edit. Loop closed.

## Behavioral verification (feature-scale, against the real compiled `dist/` artifact)

Ran a one-off script (`packages/khronoton-core/verify-builtin-descriptors.mjs`) importing
`BUILTIN_DESCRIPTORS` from `@ancientpantheon/khronoton-core/ui`, resolved through the package's
real `exports` map (confirmed present via `node -e "import('./dist/ui/index.js')..."` before
writing the assertions) against the actual compiled `dist/ui/index.js` → `dist/builtins/descriptors.js`
wiring, confirming:

```
[verify-builtin-descriptors] OK: all 7 descriptors present (3 standalone, 4 composable): ouronet.aqp-evict, ouronet.aqp-inject, ouronet.aqp-unstall, ouronet.stoa-transmit, ouronet.stoa-unwrap, ouronet.stoa-wrap, ouronet.urstoa-transmit
[verify-builtin-descriptors] OK: ouronet.stoa-wrap.toFragment({...}) with a literal amount produces the documented pactExpr/requiredCaps shape
[verify-builtin-descriptors] OK: ouronet.stoa-wrap.toFragment rejects a patronAccount containing a quote, before building any fragment
[verify-builtin-descriptors] OK: ouronet.stoa-transmit variant:"transmit-anew" rejects a missing receiverPublicKey, never silently emits a malformed keyset
[verify-builtin-descriptors] all scenarios passed against the real compiled dist/ artifact.
```

All 7 of design.md's acceptance criteria are satisfied — zero imports from `server/executor.js`/
`@stoachain/*`/`node:crypto` (mechanically checkable, confirmed empty import list); all 7 built-ins
registered with correct `name`s; standalone params match their real planners' interfaces one-for-one;
composable `toFragment` is pure/deterministic/snapshot-tested for both literal and `allowExpr` cases;
`amountCeiling`/`capAmount` sourcing is correctly distinct (never `amount`); `preview()` lists the
real entrypoints in the real try-order; the 5 run-time planners are byte-unchanged; `/ui`'s barrel
gained exactly one line.

Ready to ship as part of the next `khronoton-core` release. **Not yet committed or version-bumped**
— see the note to the user on coordinating this with the concurrent, uncommitted ChainedBuilder UI
work already occupying `package.json`'s `0.17.0` in this same working tree.
