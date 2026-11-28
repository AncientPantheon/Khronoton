# Plan — chained run history surfacing

1. `handlers/read.ts` + `read.test.ts`: `runLegsHandler` returns `yields` alongside
   `legs` (`getYieldPool(runId, { db: ctx.db })`). Test first: seed a run with a
   `yield_as` leg confirmed via `upsertYield` directly (store-level, same as other
   `read.test.ts` setup), assert `body.yields` carries it; assert the empty-pool case
   returns `{}`; re-run the existing redaction/404/ownership tests unmodified to
   confirm no regression.
2. `provider/adapter.ts`: add `RunsView`/`RunLegsView` types + `listRuns?`/
   `listRunLegs?` to `KhronotonAdapter`. No new adapter.test.ts coverage needed —
   matches the established precedent for `commitChain?`/`updateChain?` (untested at
   the adapter-interface level; covered through `ChainedBuilder.test.tsx`'s mock
   adapter instead).
3. `ui/badges.tsx` + `badges.test.ts`: `legStatusStyle(status)` pure map +
   `LegStatusBadge` component for the 4 `CodexCronotonRunLegRow["status"]` values,
   mirroring `fireStatusStyle`/`FireStatusBadge` exactly. Test first: one assertion per
   status + the component mount smoke test (reuses the existing `badges.test.ts`
   describe-per-atom structure already in the file).
4. `ui/chained/ChainedBuilder.tsx` + `ChainedBuilder.test.tsx`: the Run History block.
   TDD in this order:
   a. Red test: edit mode + adapter with `listRuns`/`listRunLegs` → block renders,
      calls `listRuns(editId)` on mount.
   b. Red test: no adapter support (methods absent) → block absent, no call attempted.
   c. Red test: create mode (`editId` absent) → block absent even if adapter has the
      methods (no id to query).
   d. Red test: run-picker select → choosing a different run re-fetches legs for that
      run id.
   e. Red test: a failed leg renders its `error_message` and `LegStatusBadge`
      "failed".
   f. Red test: a confirmed leg with a `request_key` renders an `ExplorerLink`
      pointing at `config.explorerBase`.
   g. Red test: a planner step with `plannedCount` legs inserted shows "N leg(s)
      planned"; a zero-leg planner step (insert the run/step but no legs for that
      step_index) shows the explicit "0 legs planned (nothing to do)" phrasing, not a
      bare count.
   h. Red test: once every leg of a `yieldAs`-bearing step is `confirmed`, the block
      shows `formatStepResult`'s sentence built from `legsView.yields[yieldAs]`.
   Implement minimally after each red test is confirmed failing for the right reason;
   keep `SimRow`'s visual idiom (status-colored left border) for the new `RunRow`.
5. Full suite run (expect green, run twice for stability), `tsc --noEmit`, `npm run
   build`.
6. Nectar review: single correctness-lens pass (proportionate — this touches 3 files
   additively, no new auth/validation logic beyond the existing redaction path which
   is untouched) — explicitly check: (a) the `yields` addition doesn't change any
   existing `read.test.ts` assertion's outcome, (b) the new adapter methods are
   genuinely optional (an adapter lacking them still satisfies `assertAdapter`), (c)
   `state.steps[i]` really does map 1:1 to `leg.step_index` with no off-by-one
   (re-confirm against `chain.ts`'s `insertStep({...step, stepIndex: i})`), (d) the
   new block never renders in create mode or absent adapter support.
7. Update this design doc's acceptance checkmarks, bump version, changelog/README,
   publish, report the version back — same closing ritual as every prior release this
   session.
