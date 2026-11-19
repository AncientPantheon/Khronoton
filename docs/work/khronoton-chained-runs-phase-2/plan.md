## Wave 1
- [x] T1: Implement `advanceRun` and its full branch-coverage unit tests —
  done when: `src/server/pure/run-advance.ts` exports `StepMode`,
  `RunState`, `LegState`, `RunPolicy`, `RunAction`, and `advanceRun(run,
  legs, now, policy): RunAction[]` implementing exactly the Decision
  algorithm in `docs/work/khronoton-chained-runs-phase-2/design.md`
  (terminal→wait; no-legs→replan-step; all-confirmed→advance-step checked
  before the deadline test; deadline-exceeded-and-barrier-not-met→
  replan-or-fail; serial-mode-any-failed→replan-or-fail immediately even
  with later legs still pending; parallel-mode-failed-but-not-all-resolved→
  falls through to submit/poll; parallel-mode-failed-and-all-resolved→
  replan-or-fail; parallel submit-all-pending as one `submit-leg` action per
  leg; parallel poll when nothing pending and barrier unmet; serial poll
  when any leg `submitted`; serial submit of the lowest-index pending leg
  only when none `submitted`; serial defensive `wait` fallback;
  `canReplan: false`→`fail-run` immediately on any failure regardless of
  `attempt`; `deadlineAt: null`→deadline branch never triggers), and
  `src/server/index.ts` re-exports `advanceRun` plus the five types above
  from the pure-helpers block (next to the existing `parseCapabilityLine`/
  `parseRuntimeArgKeys` re-exports, line ~76-84 today). `npm run typecheck`
  and `npx vitest run src/server/pure/run-advance.test.ts` both pass, with
  `run-advance.test.ts` containing at least one `it` per branch named in
  this task (terminal status ×3, no-legs, all-confirmed-ignores-deadline,
  deadline-exceeded ×2 step-modes ×2 attempt-states, serial-mid-sequence-
  failure, parallel-failure-while-siblings-still-in-flight, parallel-
  failure-once-all-resolved, parallel-submit-emits-one-action-per-pending-
  leg, parallel-poll, serial-poll-blocks-further-submit, serial-picks-
  lowest-pending-index, canReplan-false-fails-immediately, deadlineAt-null).
  - files: `packages/khronoton-core/src/server/pure/run-advance.ts`,
    `packages/khronoton-core/src/server/pure/run-advance.test.ts`,
    `packages/khronoton-core/src/server/index.ts`

## Wave 2 (depends on Wave 1)
- [x] T2: Add the cross-cutting "never advance past an unconfirmed leg"
  invariant gate — done when: `packages/khronoton-core/tests/chained-run-
  invariants.test.ts` exists, imports `advanceRun`/`RunState`/`LegState`/
  `RunPolicy` from `../src/server/pure/run-advance.js` (no DB, no driver —
  this invariant is a pure property of `advanceRun` itself, mirroring
  `tests/double-fire.test.ts`'s existing cross-cutting-gate role but for
  this phase's own invariant rather than raising a store-layer proof to the
  tick layer), and asserts: for every one of the representative
  `RunState`/`LegState[]`/`RunPolicy` fixtures covering non-terminal runs
  with at least one non-`confirmed` leg (reusing/paralleling T1's test
  fixtures for terminal, no-legs, deadline-exceeded, serial-failure, and
  parallel-failure-mid-flight cases), `advanceRun(...)` never returns an
  action array containing `{ kind: "advance-step" }`. `npx vitest run
  tests/chained-run-invariants.test.ts` passes, and temporarily editing
  `run-advance.ts`'s barrier check from `legs.every(l => l.status ===
  "confirmed")` to `legs.some(l => l.status === "confirmed")` (a mutation
  that would wrongly advance on a partial barrier) makes this test fail —
  confirmed manually during review, not committed.
  - files: `packages/khronoton-core/tests/chained-run-invariants.test.ts`
