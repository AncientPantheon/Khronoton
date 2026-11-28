# Expose per-step run results for a chained run — Design

Handoff (hub, paraphrased): `OuroMinterStageTwo` is a 13-step chain (mint, 5 unstall
planner steps, 7 distribution legs). A single-tx cronoton only has to answer
"succeeded or failed"; a chain has to answer WHICH STEP stopped it and WHY — otherwise
a partially-distributed daily emission is invisible from the hub.

The handoff asked for three things. Investigation (reading the actual current source,
not assumed) found the picture is NOT "none of this exists":

1. **"Re-export the run/leg readers from `src/server/index.ts`."** Already done —
   `getRun`/`listRunsForCronoton`/`listRunLegs`/`listInFlightRuns` are re-exported today
   via `server/store/index.ts`'s `export { ... } from "./runs.js"` (confirmed present
   since the 0.13.0 "Add chained multi-step cronoton runs" commit), and
   `server/index.ts`'s `export * from "./store/index.js"` carries them out to the
   `/server` entry. Verified directly against the built `dist/` output, not just the
   source. **Nothing to do here.**
2. **"A read-only hub endpoint."** The HANDLER-layer logic this would call into already
   exists too: `handlers/read.ts`'s `runsHandler`/`runLegsHandler` (re-exported from
   `handlers/index.ts` as `fetchRuns`/`fetchRunLegs`), including the leg-ownership check
   (404 if `runId` doesn't belong to `:id`) and `redactLegRow` (strips a leg's `signers`
   before it's exposed through the read tier — the same capability-line redaction
   posture `store/public.ts`'s `toPublicCronotonView` already documents elsewhere).
   **The literal Next.js route file is hub-side** (a different repo/workspace this
   session has no access to) — not actionable from here. Flagged back to the user
   rather than silently skipped.
3. **"Surface it in the chained builder UI."** This is the real, actionable gap. No
   client (`KhronotonAdapter`) method exists to reach `fetchRuns`/`fetchRunLegs` at all,
   and `ChainedBuilder` has no run-history rendering. This design scopes and builds
   that piece.

## What's being added (package-only)

### 1. Client contract (`provider/adapter.ts`)

Two new OPTIONAL `KhronotonAdapter` methods, following the exact precedent set by
`commitChain?`/`simulateChain?`/`updateChain?` (optional, not in `REQUIRED_METHODS`,
not implemented by either reference adapter — `createFetchAdapter` documents itself as
covering only "the 16 seam methods," and the chained tier is left for a consumer's own
adapter to wire against its own routes):

```ts
listRuns?(id: string, query?: { limit?: number; offset?: number }): Promise<RunsView>;
listRunLegs?(id: string, runId: string): Promise<RunLegsView>;
```

New response-view types, mirroring `FiresView`'s shape:

```ts
export interface RunsView {
  ok: true;
  runs: CodexCronotonRunRow[];
  total: number;
  limit: number;
  offset: number;
}
export interface RunLegsView {
  ok: true;
  legs: CodexCronotonRunLegRow[];
  /** The run's named-yield pool ({@link getYieldPool}) — lets the UI render
   *  `formatStepResult`'s human sentence per step without a second round trip
   *  for step metadata (the caller already has `steps` from its own builder
   *  state). Added to `runLegsHandler`'s response body (see below), additive. */
  yields: Record<string, unknown>;
}
```

### 2. Handler response (`handlers/read.ts`)

`runLegsHandler` gains one additive field: `yields: getYieldPool(runId, { db: ctx.db })`
alongside the existing `legs`. This is the "NICE TO HAVE" from the handoff — "showing
those seven sentences in order IS the distribution report" — made possible with zero
extra endpoints: the yield pool is already fully populated by the time a run reaches
any terminal/intermediate state (`runs-driver.ts`'s three `upsertYield` call sites), and
`getYieldPool` already exists and is already exported; this just rides it along on the
one read a UI already has to make per run.

No existing test asserts an exact full-body shape for the success path (checked
`read.test.ts` directly), so this is a safe additive change — confirmed, not assumed.

### 3. UI (`ui/chained/ChainedBuilder.tsx`)

A new **"Run history"** block, rendered BELOW the pane filmstrip (same tier as the
existing `{sim && <SimPanel .../>}` dry-run block), not as a 4th toggleable pane. The
pane-sizing system (`panes`/`fit`/`PANE_MIN`/`PANE_MAX`) is a fixed, heavily-tuned
3-pane layout (0.20.0's whole point was fixing its overflow math for exactly that fixed
set) — adding a 4th toggle there would perturb that math for no benefit, when a
full-width block below it (the same place `SimPanel` already lives) is strictly
simpler and carries zero risk to the existing layout.

Gated on: `isEdit && editId && adapter.listRuns && adapter.listRunLegs` — absent any of
these, nothing renders (purely additive, byte-identical create-mode and
no-adapter-support behavior).

Behavior:
- On mount (edit mode, adapter support present): fetch `adapter.listRuns(editId)`
  (defaults: newest-first, per `listRunsForCronoton`'s existing `ORDER BY started_at
  DESC`). A `<select>` lets the operator pick a run; defaults to the newest (`runs[0]`).
- On run selection: fetch `adapter.listRunLegs(editId, runId)`.
- Render one row per LEG (step_index, leg_index), reusing the existing `SimRow`-style
  idiom (status-colored left border, monospace error line) via a new `RunRow`:
  - **Status** — a new `LegStatusBadge` (`badges.tsx`), covering the 4 real leg
    statuses (`pending`/`submitted`/`confirmed`/`failed`), mirroring the existing
    `FireStatusBadge`/`cronotonStatusStyle` pure-map-plus-component pattern exactly.
  - **Error** — `leg.error_message` when `failed`.
  - **Request key** — `ExplorerLink` (existing, `explorer.tsx`, `config.explorerBase`)
    when the leg has landed (`request_key` present), reusing the exact same atom
    `FireHistory` already uses for the single-tx fire table — no new explorer-link
    logic.
  - **Leg count per step** — a one-line header per step boundary, "Step k · N leg(s)
    planned" for a `planner`-mode step (from `state.steps[stepIndex].mode`); explicitly
    phrased so 0 reads as the healthy "nothing to do" case (per the handoff's own
    `ouronet.aqp-unstall` example), not an error — `"Step k · 0 legs planned (nothing to
    do)"` rather than a bare `"0"`.
  - **Result sentence** — `formatStepResult` (already exists, already designed to be
    reusable for "a server-side fire log," per its own doc comment — this is exactly
    that reuse), fed `state.steps[stepIndex].yieldAs` and
    `legsResponse.yields[state.steps[stepIndex].yieldAs]`, only once every leg for that
    step is `confirmed` (a step isn't "done" until its whole barrier clears).
- The `singleTxFirst` variant (`state.singleTxVariant`) is NOT shown here — it fires
  through the ordinary parent-cronoton fire path (`codex_cronoton_fires`, polled by
  `fires`/`FireHistory`), not through `codex_cronoton_run_legs` at all (confirmed by
  reading `commitChainedCronoton`: `singleTxFirst` folds into the PARENT row's own
  `pactCode`/`config`/etc., `input.steps[i]` is inserted at `stepIndex: i` starting at
  0 — so `state.steps[i]` already maps 1:1 to `leg.step_index` with no offset). Out of
  scope here, unchanged from today (that variant's own history is a different, already-
  existing surface).

## Acceptance criteria

1. ✅ `listRuns`/`listRunLegs` are optional `KhronotonAdapter` methods; their absence
   leaves every existing behavior byte-identical (no adapter, no block rendered).
2. ✅ `runLegsHandler`'s response carries `yields` alongside `legs`; every existing
   `read.test.ts` assertion on that handler still passes unmodified.
3. ✅ In edit mode with adapter support, opening `ChainedBuilder` for a cronoton with a
   completed run shows one row per leg, colour-coded by status, with the error message
   on a failed leg and an explorer link on a landed one.
4. ✅ A planner step with 0 planned legs on a genuinely-cleared barrier reads as the
   healthy case, not an error — but (added after review, see below) a step with 0 legs
   because the RUN FAILED there instead reads as a real failure, never "nothing to do."
5. ✅ A step whose yield-bearing legs are all confirmed shows `formatStepResult`'s sentence
   (same deterministic grammar the dry-run panel already uses).
6. ✅ Full suite green (1626/1626, stable across repeat runs), `tsc`/build clean.

## Findings from the nectar review

Single focused correctness-lens pass (proportionate to a 3-file additive change with no
new auth/validation logic). One HIGH finding, confirmed real by reading
`runs-driver.ts` directly (not assumed from the diff):

- **HIGH — a step where the run failed before planning any legs rendered a false "ok"
  result sentence, and a false "(nothing to do)" annotation.** `RunHistory`'s original
  `allConfirmed` computation treated `stepLegs.length === 0` as unconditionally "done" —
  vacuously true for a genuinely-cleared zero-leg barrier, but ALSO true for the exact
  failure mode the handoff's own motivating example describes: `handleReplanStep`
  (`runs-driver.ts`) catches a plan-time throw with `stepHasAnyLegs === false` and calls
  `handleFailRun`, terminalizing the run `failed` at that exact step with zero leg rows
  ever written and no `error_message` to show (there's no leg row to carry one). The
  component never consulted the selected run's own `status`/`step_index` to tell this
  apart from the healthy case — so the one step that aborted the run was the one step
  rendered as succeeding. Fixed: a step is only "done with zero legs" when it's
  genuinely past the run's current barrier OR the run succeeded there; it's flagged as
  a real failure ("run failed before this step planned any legs", red, no fabricated
  result sentence) when the run's own `status` is `failed` at exactly that step index;
  otherwise (an in-flight run currently sitting at that barrier) it reads as "not yet
  planned" rather than claiming either outcome. Regression test added:
  `ChainedBuilder.test.tsx`'s "a step that aborted a FAILED run before planning any
  legs..." — confirmed red against the pre-fix code (the original `allConfirmed`
  formula), green after.

## Explicitly out of scope (flagged, not solved here)

- The hub's own Next.js route file(s) — different repo, no access from this session.
- `singleTxFirst`'s own run/fire history (unrelated storage path, already covered by
  the existing `fires`/`FireHistory` surface).
- Live polling of the run-history block while open (FireHistory's own hook polls; this
  block does not, for now — a manual "Refresh" affordance is enough for an operator
  looking at a chain that already finished or is stuck, which is the stated use case;
  real-time polling of an in-flight run is a reasonable future add, not required by the
  stated acceptance scenario).
