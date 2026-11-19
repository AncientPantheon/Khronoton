# Review — Phase 2: `advanceRun` (pure decision core)

**Scope** (resolved from plan.md's ticked tasks, T1 + T2):
- `packages/khronoton-core/src/server/pure/run-advance.ts` (new)
- `packages/khronoton-core/src/server/pure/run-advance.test.ts` (new)
- `packages/khronoton-core/src/server/index.ts` (2-line re-export addition)
- `packages/khronoton-core/tests/chained-run-invariants.test.ts` (new)

**Lens set:** correctness, conventions, tests (4-file tier; no security lens — no I/O/auth/data-path surface in a pure decision function; no performance lens — reserved for 16+ files).

## Round 1

### [MEDIUM] Parallel-submit test claims "ascending legIndex order" but never exercises that property
- **Where:** `run-advance.test.ts:181-195` (original)
- **Evidence:** fixture `[leg(0,"pending"), leg(1,"pending"), leg(2,"pending")]` was already in both array-position and legIndex order, so it couldn't distinguish "preserves array order" (what `legs.filter(...).map(...)` actually does) from "sorts by legIndex" (what the title claimed).
- **Why it matters:** a future refactor that broke the implicit order guarantee would pass this test silently.
- **Suggested fix:** scramble the fixture relative to legIndex and assert on what's actually guaranteed.
- **Verdict:** CONFIRMED (nectar:validator). **Resolution:** fixed — fixture reordered to `[leg(2,"pending"), leg(0,"pending"), leg(1,"pending")]`, title changed to drop the unearned "ascending order" claim, assertion now pins array-order preservation (matching real implementation behavior and the design doc's own no-ordering-guarantee wording).

### [MEDIUM] Deadline-exceeded tests under-verify the re-plan/fail reason string
- **Where:** `run-advance.test.ts:69-92` (original)
- **Evidence:** both deadline-branch tests used `toContain("barrier deadline exceeded")` instead of the exact `toEqual` match every sibling `replanOrFail` branch (steps 5/6) used.
- **Why it matters:** a stepIndex-prefix or attempt-count-suffix corruption specific to the deadline path would slip through.
- **Suggested fix:** exact `toEqual` match, matching steps 5/6's rigor.
- **Verdict:** CONFIRMED (nectar:validator). **Resolution:** fixed — both assertions now `toEqual` the full reason string (`"step 0: barrier deadline exceeded; re-planning (attempt 1/3)"` / `"...; replan attempts exhausted (3/3)"`).

## Round 2

### [MEDIUM] No test pins the deadline boundary (`now === deadlineAt`)
- **Where:** `run-advance.ts:117`; `run-advance.test.ts` step-4 describe block
- **Evidence:** implementation uses strict `now.getTime() > new Date(run.deadlineAt).getTime()`; every existing fixture used either `deadlineAt: null` or a value far in the past — none at the exact boundary.
- **Why it matters:** a `>` → `>=` mutation at this semantically meaningful boundary (handoff §5.7's "poll once more, then decide" moment) would pass the whole suite undetected.
- **Suggested fix:** add a `deadlineAt === now` case asserting it does NOT trigger replan/fail.
- **Verdict:** CONFIRMED (nectar:validator). **Resolution:** fixed — added `"deadlineAt exactly equal to now → NOT exceeded (strict >, not >=); falls through to normal poll"`, manually mutation-tested (flipping `>` to `>=` made exactly this one test fail among 24, output quoted below), cleanly reverted.

## Round 3 — terminal pass

Correctness, conventions, and tests lenses all ran full-scope against the final on-disk state. **Zero findings across all three.**

## Mutation check (manual, not committed)

```
$ sed -i 's/now.getTime() > .../now.getTime() >= .../' run-advance.ts
 ❯ src/server/pure/run-advance.test.ts:107:15
    - "kind": "poll",
    + "kind": "replan-step",
    + "reason": "step 0: barrier deadline exceeded; re-planning (attempt 1/3)",
 Test Files  1 failed (1)
      Tests  1 failed | 23 passed (24)
```
Reverted cleanly — `git status --porcelain` confirms `run-advance.ts` back to its pre-mutation `??` (untracked, unmodified) state.

## Final verification (quoted, after last applied edit)

```
> @ancientpantheon/khronoton-core@0.12.0 typecheck
> tsc --noEmit
(no errors)

 Test Files  80 passed (80)
      Tests  1104 passed (1104)
```

## Behavioral verification (against the real built artifact, not mocks)

```
$ npm run build   # ESM + DTS build success
$ node smoke-advance.mjs   # imports dist/server/index.js directly
no legs:  [{"kind":"replan-step","reason":"step 0 has no legs yet"}]
fan-out:  [{"kind":"submit-leg","legIndex":0},{"kind":"submit-leg","legIndex":1},{"kind":"submit-leg","legIndex":2}]
poll:     [{"kind":"poll"}]
advance:  [{"kind":"advance-step"}]
terminal: [{"kind":"wait"}]
```
Matches design.md's decision algorithm exactly for a planner-produced 3-leg fan-out step walking through plan → submit → poll → advance, plus the terminal-run no-op.

## Outcome

**3 rounds. 3 findings raised, 3 CONFIRMED, 0 REFUTED, 0 STYLISTIC.** Terminal full-scope, full-lens-set pass is clean. Full suite green (1104/1104), typecheck clean, build clean, behavior verified end-to-end against the real built artifact.
