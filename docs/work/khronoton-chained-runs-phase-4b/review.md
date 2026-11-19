# Review — Phase 4b: ouronet.stoa-wrap + ouronet.stoa-unwrap

**Scope** (resolved from plan.md's ticked tasks, T1-T3):
`packages/khronoton-core/src/server/planners/stoa-wrap.ts` (new),
`stoa-wrap.test.ts` (new), `planners/stoa-unwrap.ts` (new),
`stoa-unwrap.test.ts` (new), `server/index.ts` (barrel export additions).

**Lens set:** correctness, conventions, tests, security (4-lens tier —
same as Phases 4/4.1: a funds-moving automaton porting real
transaction-construction and, newly in this phase, Pact signer-capability
construction across a workspace boundary).

## Round 1 — full scope, full lens set

Conventions, correctness (at this point): clean. Tests and security each
found gaps.

### [LOW] `formatPactDecimal` had no upper-bound guard, violating its own "never scientific notation" contract for `n >= 1e21`
- **Verdict:** CONFIRMED by both the correctness AND security lenses
  independently (same root cause, deduped) — downgraded from the
  originally-claimed MEDIUM. `Number.prototype.toFixed` falls back to
  exponential `ToString` at `>= 1e21`; `formatPactDecimal` only guarded
  `!Number.isFinite(n) || n < 0`. Downgraded to LOW because (a) KDA/STOA's
  real, capped token economics put any real balance roughly twelve orders
  of magnitude below this threshold — theoretical-only — and (b) the
  realistic failure mode is a SAFE hard failure (Pact's lexer/
  `parseCapabilityLine` would reject the malformed exponential-notation
  token, not silently misdirect funds). **Resolution:** fixed — added
  `n >= 1e21` to the existing guard clause.

### [HIGH→MEDIUM] `stoa-unwrap`'s two "read itself fails" branches had no dedicated test, asymmetric with its sibling `stoa-wrap`
- **Verdict:** CONFIRMED, downgraded HIGH→MEDIUM on validation — the
  untested branches are simple, already-correct `if (!result.ok) throw`
  guards; the code itself wasn't in question, only its test coverage.
  **Resolution:** fixed — two new tests (UR_AccountKadena resolve-read
  failure, coin.get-balance existence-probe failure).

### [MEDIUM] `stoa-unwrap` never exercised `patronAccount`'s own shape-guard
- **Verdict:** CONFIRMED. **Resolution:** fixed — dedicated rejection test
  added.

### [MEDIUM] The `signers.length === 0` guard was untested in both planners
- **Verdict:** CONFIRMED. **Resolution:** fixed — one test per planner.

### [MEDIUM] Neither test file ever asserted the returned leg's `config`/`gasPayer` fields
- **Verdict:** CONFIRMED — the one gap the validator flagged as most
  consequential, since it touches fields affecting real on-chain
  transaction behavior (chain id, gas price/limit, gas payer), not just
  input-validation edge cases. **Resolution:** fixed — extended one
  success-path test per planner with exact `config`/`gasPayer` assertions.

### [MEDIUM] `formatPactDecimal`'s documented fractional/trailing-zero behavior was never exercised (every test used an integer balance)
- **Verdict:** CONFIRMED. **Resolution:** fixed — added fractional-balance
  tests (`5.1`, `5.25`).

### [LOW] The `typeof ... !== "string"` missing-field guards were untested in both planners
- **Verdict:** CONFIRMED. **Resolution:** fixed — one test per planner
  with an empty `planner_params_json`.

### [LOW] `formatPactDecimal`'s negative/non-finite throw branch was untested
- **Verdict:** CONFIRMED. **Resolution:** fixed — negative-balance
  rejection test added.

### [LOW] Multi-signer passthrough (`index !== 0`) was untested in both planners
- **Verdict:** CONFIRMED. **Resolution:** fixed — one test per planner
  with a 2-signer array, asserting signer 1 is returned byte-for-byte
  unchanged.

## Round 2 — behavioral verification against the real built artifact (not found by any lens)

Drove the real `ouronet.stoa-wrap` planner off `dist/server/index.js` with
the source handoff's own measured real-world value — the dispenser's
262,613.4 STOA balance — and found a genuine bug no lens or test had
caught: `formatPactDecimal`'s `n.toFixed(12)` + trailing-zero-stripping
approach reintroduces binary-floating-point representation noise for
almost any real-world balance (`(262613.4).toFixed(12) ===
"262613.400000000023"`). Every existing test used clean values (`5`,
`5.1`, `5.25`) that happen to be exactly representable enough in binary
floating point to never expose this.

### [bug, found by behavioral verification, not a lens] `formatPactDecimal` leaked floating-point noise into a signed capability line and payload for realistic balances
- **Resolution:** fixed — switched from `toFixed(12)` to `n.toString()`
  (JS's own shortest-round-trip representation, clean for any
  normal-magnitude number), plus a new `expandExponentialNotation` helper
  for the sub-`1e-6`-magnitude case where `toString()` itself falls back
  to exponential notation (which Pact decimal literals cannot express —
  the large-magnitude side was already rejected by the existing `n >=
  1e21` guard before `toString()` is ever reached). 3 regression tests
  added: the exact `262613.4` value, a sub-`1e-6` dust value (`1e-7`), and
  the `1e21` upper-bound rejection.
- A dedicated correctness+security re-check of just this fix (narrowed
  scope, not a full lens pass) came back clean: traced
  `expandExponentialNotation`'s digit-shifting arithmetic by hand across
  several magnitudes, confirmed the output character set can never
  contain an injection-risk character (`"`, `(`, `)`, space), and confirmed
  the `n === 0` short-circuit (returning `[]` before `formatPactDecimal` is
  ever called) is still in place.

## Round 3 — terminal pass, full scope, full lens set (first run)

Conventions, tests, security: clean. Correctness found a real, HIGH-severity
defect.

### [HIGH] Forcing signer 0 to `capabilityMode:'scoped'` silently dropped gas-sponsorship authority when the same key was also the gas-station's signing key
- **Verdict:** CONFIRMED, severity HIGH unchanged. Both planners
  unconditionally overwrote signer 0's `capabilityMode` to `'scoped'` with
  ONLY a `coin.TRANSFER` capability line. `executor-signers.ts`'s
  `effectiveSigners` only synthesizes its own `DALOS.GAS_PAYER`-scoped
  entry for the gas-station's signing key IF that pubkey isn't ALREADY
  present among `signers` — it checks presence by pubkey only, never
  capability content. Validation traced the full call path
  (`runs-driver.ts` → `executeCodexTransaction(..., "submit", ...)` →
  `executor.ts` → `effectiveSigners`) confirming the mutated leg's signers
  really do feed into this check at submit time, and confirmed the
  EXACT reachable pattern was baked into the DEFAULT of every original
  test fixture for both planners (signer 0's key == the default
  `gasStationSignerKey`) — meaning the bug was, in effect, silently
  "working" in every test only because no test ever asserted the full,
  correct capability string. **Resolution:** fixed — both planners now
  detect `gasPayer.type === "gas-station" && gasPayer.gasStationSignerKey
  === signer.publicKey` and append the identical `DALOS.GAS_PAYER`
  capability line `effectiveSigners` would otherwise have synthesized.
  Test fixtures changed: a new `PUB_GASSTATION` constant (distinct from
  signer 0's own key) is now the default in both test files, so ordinary
  tests stay collision-free and their original assertions remain correct;
  2 new dedicated tests per planner prove both the collision case
  (`DALOS.GAS_PAYER` appended) and the non-collision case (not appended).

### Follow-up investigated during this round: does the identical risk apply to `gasPayer.type:'codex'`?
- A second lens pass (re-checking just the gas-station fix) raised this as
  a parallel HIGH finding. Adversarially validated and **REFUTED**:
  `effectiveSigners`'s own codex branch synthesizes a bare
  `capabilityMode:'pure'` signer (no explicit capability line) when the
  key is absent — a deliberate asymmetry with the gas-station branch's
  explicit `scoped`+`DALOS.GAS_PAYER` synthesis, not an oversight mirroring
  it. Corroborated by `executor.test.ts`'s own "F-007 codex
  gas-payer-must-sign invariant" test, which frames the requirement purely
  as "must sign" (a valid signature), never "must carry an explicit
  `coin.GAS` grant" — consistent with real Kadena/Pact mechanics, where
  `coin.GAS` is auto-composed by chainweb-node around the native gas-buy
  step and is not clist-scope-gated the way a custom contract capability
  like `DALOS.GAS_PAYER` is. **No fix applied — confirmed as intentionally
  out of scope**, not a gap.

## Round 4 — terminal pass, full scope, full lens set (final)

All four lenses dispatched together over the complete, final scope (after
all three fix rounds above). **Zero findings across all four lenses.**
This is the clean terminal pass.

## Final verification (quoted, after the last applied edit)

```
> @ancientpantheon/khronoton-core@0.12.0 typecheck
> tsc --noEmit
(no errors)

 Test Files  88 passed (88)
      Tests  1223 passed (1223)

> @ancientpantheon/khronoton-core@0.12.0 build
> tsc -p tsconfig.build.json && tsup && node scripts/bundle-css.mjs
ESM ⚡️ Build success in 712ms
DTS ⚡️ Build success in 3366ms
```

## Behavioral verification (against the real built artifact, `dist/server/index.js`, not mocks)

Three separate smoke runs against the real compiled output:

1. **Caught the real bug** (before the Round 2 fix): drove
   `ouronet.stoa-wrap` with the source handoff's own measured dispenser
   balance (262,613.4 STOA) and observed `payload.amount ===
   "262613.400000000023"` — floating-point noise, not the clean
   `"262613.4"` the handoff actually measured. This is what triggered
   Round 2's fix; it was never caught by any lens or by the unit tests
   (which all used cleaner values).
2. **Confirmed the Round 2 fix**: re-ran the identical scenario after the
   fix — `payload.amount === "262613.4"` exactly, capability line
   `(coin.TRANSFER "k:1b440c72dispenser"
   "c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI" 262613.4)`.
3. **Confirmed the Round 3 fix**: drove `ouronet.stoa-wrap` with signer 0's
   key deliberately colliding with `gasStationSignerKey`, and confirmed
   the real compiled output carries BOTH capability lines:
   ```
   (coin.TRANSFER "k:dispenser" "c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI" 5.0)
   (ouronet-ns.DALOS.GAS_PAYER "" 0 0.0)
   ```

Also confirmed `getStepPlanner("ouronet.stoa-wrap"/"ouronet.stoa-unwrap")`
both resolve through the public `dist/server/index.js` barrel, and drove
`ouronet.stoa-unwrap` through both the target-exists (single-form
`pactCode`) and target-missing (two-form composite `pactCode`, with a
correctly-shaped `read-keyset` payload entry) branches off the real
artifact.

## Outcome

**4 rounds. 13 findings raised (not counting the 1 behavioral-verification-
caught bug, which no lens found), 12 CONFIRMED and fixed, 1 REFUTED (the
codex gas-payer follow-up).** Plus 1 real production bug caught by
behavioral verification alone — a reminder that this discipline step is
not optional ceremony: the test suite was green and the terminal lens pass
had already found zero findings by the time the real built artifact
exposed the floating-point bug. Terminal full-scope, full-lens-set pass
(Round 4) is clean. Full suite green (1223/1223, up from 1204 at the start
of this phase's review cycle — 19 new/tightened tests), typecheck clean,
build clean, and three independent behavioral smoke runs against the real
compiled artifact confirm every fix landed in the actual shipped output,
not just the source.

Two notable findings for a future reader:
- The gas-payer-capability-collision bug (Round 3) was latent in every
  single test fixture this phase shipped initially — a reminder that an
  exact-match test assertion only proves the code does what the test
  expects, not that the test's own setup is realistic/safe. The fix
  included correcting the fixtures themselves (introducing a
  non-colliding default key), not just the production code.
- The floating-point bug (Round 2) was only found because behavioral
  verification used a REAL measured value from the source handoff
  (262,613.4) rather than a hand-picked round test number — illustrating
  why this step exercises the real artifact with realistic inputs, not
  just whatever values are already in the unit tests.
