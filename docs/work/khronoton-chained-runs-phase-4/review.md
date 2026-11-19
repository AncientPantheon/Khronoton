# Review — Phase 4: StepPlanner registry + ouronet.aqp-evict

**Scope** (resolved from plan.md's ticked tasks, T1-T4):
`store` n/a — `src/server/planners/registry.ts` (new), `planners/registry.test.ts`
(new), `planners/evict.ts` (new), `planners/evict.test.ts` (new),
`server/index.ts`, `runs-driver.ts`, `runs-driver.test.ts`.

**Lens set:** correctness, conventions, tests, security (4-lens tier for 7
files, security included given this is a funds-moving automaton porting
real transaction-construction logic across a workspace boundary).

## Round 1

### [CRITICAL] All three `AQP-EVCT` pact-code call sites were missing the `ouronet-ns.` module namespace prefix
- **Verdict:** CONFIRMED, not downgraded. Traced to the actual deployed
  contract (`(namespace "ouronet-ns")` preceding the `AQP-EVCT` module
  declaration in the OTHER workspace's on-chain source) — a bare
  `AQP-EVCT.*` reference is unresolvable by Pact's namespace mechanism.
  This bug originated in the plan's own literal code snippets, which the
  implementer faithfully followed — my own mistake, caught by review.
  Would have broken every single real invocation (plan read, probe, and
  every fanned-out leg). **Resolution:** fixed — `const evct =
  \`${ctx.runtime.namespace}.AQP-EVCT\`` built from the already-populated
  seam, used in all three pact-code templates; tests tightened from
  `toContain(...)` substrings to exact `toBe(fullyQualifiedPactCode)`.

### [CRITICAL] Pact-code injection via unescaped, unvalidated chain-read fields spliced into a signed transaction
- **Verdict:** CONFIRMED, not downgraded (explicitly distinguished from the
  Phase 3 "submit-before-claim" precedent that WAS downgraded: that gap
  sat on dead code awaiting a caller that doesn't exist, this sat on the
  live, reachable fan-out path, and its safety depended on trusting an
  external, unverified contract's write-side validation — a materially
  weaker assumption). `beneficiary`/`scoreEntityType`/`scoreEntityId`/
  `rewardDptfId` came from a live chain read and were string-interpolated
  directly into `pactCode` with zero escaping — `scoreEntityType` even
  unquoted, needing no quote-escape at all to inject. **Resolution:**
  fixed — every interpolated value (including `patronAccount`/`fvtId`/
  `executor`) now flows through `payload` (env-data, `addData` per
  `executor.ts`'s `buildTransaction`) and is read back via `(read-string
  "key")`/`(read-integer "key")` placeholders; `pactCode` itself is now a
  FIXED string per entrypoint with zero interpolated values, mirroring
  `pure/runtime-args.ts`'s existing "never string-concatenate into
  pactCode" precedent. Added `isWellFormedEvictLeg` (type-shape guard) and
  rewrote the affected tests to assert exact pactCode/payload shape
  (including a dedicated adversarial test proving a hostile
  quote/paren-laden beneficiary string flows safely into payload and never
  appears in pactCode).

### [MEDIUM] Design's "genuine-failure propagates to erroredIds" acceptance criterion was never exercised end-to-end with the real planner
- **Verdict:** CONFIRMED. **Resolution:** fixed — added a third
  end-to-end test proving a genuine non-gas failure from the REAL
  `evictPlanner` (not an unregistered stand-in) propagates through
  `handleReplanStep`/`driveRunOnce` to `advanceInFlightRunsOnce`'s
  `erroredIds`.

### [LOW] Test title claimed to verify `config` propagation but the assertion never checked it
- **Verdict:** CONFIRMED. **Resolution:** fixed — the test now sets and
  asserts a real `config` value threaded through to the planner's ctx.

### [LOW] New planner barrel exports lacked the file's own explanatory-comment convention
- **Verdict:** CONFIRMED. **Resolution:** fixed — added a heading comment
  for the `planners/*` exports matching the file's established style,
  explicitly noting the self-registration side effect is load-bearing.

## Round 2

### [MEDIUM] A test named "rejects a plan entry whose scoreEntityType is not an integer" never exercised the `Number.isInteger` branch
- **Verdict:** CONFIRMED. The test passed a STRING, which short-circuits
  the earlier `typeof === "number"` check before `Number.isInteger` is
  ever reached — the integer-check itself was untested, dead code from the
  suite's perspective. **Resolution:** fixed — split into three tests
  (wrong-typeof, typeof-number-but-non-integer via `1.5`, and a wrong-type
  `beneficiary` case), each confirmed via mutation-style reasoning to
  uniquely force the branch it claims.

### [STYLISTIC] `PlannedLeg` omits the `readonly` modifiers `CodexTxDefinition` (the type it's modeled on) declares
- **Verdict:** downgraded from the originally-claimed LOW — the doc
  comment's "matching... exactly" language is scoped to field-set/
  serialization shape (what `JSON.stringify`/`parseLegDefinition` care
  about), not to TypeScript's compile-time-only `readonly` modifier, so
  it isn't actually a broken documented contract. Real but a preference.
  **Resolution: user declined / left as-is** (no behavioral difference
  either way).

## Round 3 — terminal pass

All four lenses (correctness, conventions, tests, security) ran full-scope
against the final on-disk state. **Zero findings across all four.**

## Final verification (quoted, after the last applied edit)

```
> @ancientpantheon/khronoton-core@0.12.0 typecheck
> tsc --noEmit
(no errors)

 Test Files  83 passed (83)
      Tests  1152 passed (1152)

ESM ⚡️ Build success in 644ms
DTS ⚡️ Build success in 3248ms
```

## Behavioral verification (against the real built artifact, not mocks)

Confirmed `getStepPlanner("ouronet.aqp-evict")` resolves to a real function
through the public `dist/server/index.js` barrel, then drove a 2-beneficiary
plan through the real `codexCronotonTickOnce` with a mocked chain reporting
the `CC_FullEvictRewards` probe over the gas ceiling. The REAL Pact code
built and about to be signed/submitted, read directly off the built
artifact's output:

```
(ouronet-ns.AQP-EVCT.CC_EvictSingleReward (read-string "patron") (read-string "executor")
 (read-string "fvt-id") (read-string "beneficiary") (read-integer "score-entity-type")
 (read-string "score-entity-id") (read-string "reward-dptf-id"))

payload: {"patron":"k:patron-smoke","executor":"k:aaaa...","fvt-id":"fvt-smoke",
          "beneficiary":"k:ben-1","score-entity-type":1,"score-entity-id":"se-1",
          "reward-dptf-id":"dptf-1"}
```

This confirms both CRITICAL fixes directly: the namespace is
`ouronet-ns.AQP-EVCT` (not bare `AQP-EVCT`), and every value is env-data
read back via `read-string`/`read-integer` — never concatenated into the
Pact source. Fan-out produced exactly 2 legs for the 2-entry mock plan, one
per beneficiary, matching `evictSpecs.tsx`'s `CC_EvictSingleReward` field
order exactly.

One honest caveat: this ad-hoc smoke script's own hand-rolled mock didn't
precisely account for every internal `simulate`/preflight call the submit
path makes (a shared call-counter bled across the plan-read, full-probe,
and an additional submit-time check), so the legs didn't reach `submitted`
in this particular script. This is a limitation of the improvised script,
not a reviewed-code defect — the real submit-to-confirm lifecycle (fan-out
→ submit → poll → confirm → succeed) is already proven by the project's own
carefully-sequenced end-to-end test in `runs-driver.test.ts`, part of the
1152/1152 passing suite quoted above.

## Outcome

**3 rounds. 7 findings raised, 6 CONFIRMED (5 fixed + 1 user-choice
pending/declined), 1 downgraded to STYLISTIC and declined, 0 REFUTED.**
Terminal full-scope, full-lens-set pass is clean. Full suite green
(1152/1152), typecheck clean, build clean, and the exact generated Pact
code/payload shape verified against the real built artifact — the two
CRITICAL findings (missing namespace, Pact-code injection) would have
broken or endangered every real invocation of this planner had they
shipped; both are now closed and independently re-confirmed in round 2's
and round 3's security passes.
