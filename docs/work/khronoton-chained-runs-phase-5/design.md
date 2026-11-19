# khronoton-chained-runs-phase-5 — Design

## Problem

Per the parent design (`docs/work/khronoton-chained-runs/design.md:361-363`)
and the source handoff's own §"Phase 5 — handlers and observability"
(`HANDOFF-khronoton-chained-runs.md:328-339`), four handler/observability
gaps remain now that the chained-run engine itself (Phases 2-4b) is built,
reviewed, and shipped:

1. **`executeNow` doesn't know chained runs exist.** It predates Phase 2-4b
   entirely (`handlers/execute.ts:188-212`): it reads only the flat
   `CodexCronotonRow` and branches ONLY on `server_resolver` kind. A
   chained row (one with `codex_cronoton_steps` rows) firing on demand
   today either silently fires the row's own (irrelevant/absent) flat
   definition or falls into the unrelated multi-tx 202-queue path —
   neither of which starts a run.
2. **`adaptMultiTxSummary` always reports success.** `resolvers.ts:203-214`
   hardcodes `ok: true` unconditionally, regardless of whether the
   consumer-supplied `MultiTxResolver.run()`'s returned summary describes
   a partial or total failure. A failed multi-tx operation is recorded as
   a successful fire row.
3. **No standalone way to fire or preview ONE step of a chained cronoton.**
   The handoff is explicit that "individual steps must be firable
   standalone for testing" (handoff §0, reconfirmed by the owner in
   Phase 4.1's design.md §E: "no separate testing story for built-ins").
   The building blocks exist (`simulateCodexTx` previews an arbitrary
   envelope; `executeCodexTransaction` is exported) but nothing addresses
   *a stored cronoton's step by index*.
4. **Per-leg fire history is invisible.** `listRunLegs(runId, dep)`
   already exists in `store/runs.ts:162` and works, but nothing queries
   "which run(s) does this cronoton have" (no `listRunsForCronoton`
   exists), no handler exposes either query, and no UI hook mirrors
   `useCronotonFires.ts`'s pattern for legs. An operator debugging a stuck
   or failed chained run has no way to see it through this package's own
   surface.

## Approach

### A. Fix `executeNow` for a chained row — mirror `tick.ts`'s own branch, don't reinvent it

`tick.ts:147-191` already has the exact logic this needs: check
`listStepsForCronoton(row.id, dep)`; if non-empty, `createRun` +
`driveRunOnce` + audit, catching `RunAlreadyInFlightError` (the
`codex_cronoton_runs(codex_cronoton_id)` partial-unique-index self-block,
schema.ts:149-151) as a benign "already running" signal rather than a
crash. `executeNow` gets the SAME branch, inserted before the existing
`multi-tx` 202-queue check (a row is either chained OR server-resolver-
bound in practice; chained rows don't carry a meaningful
`server_resolver`, so checking steps first is strictly safe and avoids a
chained row ever reaching the multi-tx check at all):

```
if steps.length > 0:
  try: runId = createRun(...); await driveRunOnce(runId, now, ctx); audit "run_started"
       return 200 { ok:true, runId, status: getRun(runId).status }
  catch RunAlreadyInFlightError:
       return 409 { ok:false, error: "a run is already in flight for this cronoton" }
```

Unlike the scheduler's tick (which silently skips on self-block — it'll
retry next pass), an EXPLICIT on-demand request surfaces the conflict as
a real 409, since the caller asked for an action right now and deserves to
know it didn't happen (new behavior, not a port of tick's skip).

The response reports `status` (the run's `codex_cronoton_runs.status` —
`'planning'|'awaiting'|'advancing'|'succeeded'|'failed'|'abandoned'`)
rather than a single `ok` boolean, because `driveRunOnce` only drives ONE
synchronous pass — a multi-step/multi-leg run may still be `awaiting`
confirmation when this call returns, and collapsing that into `ok:true`/
`ok:false` would misrepresent an in-progress run as either done or failed.
Still HTTP 200 (not 202): `driveRunOnce` genuinely runs its first pass
SYNCHRONOUSLY within this request (unlike the multi-tx case, which is
fully async and has no in-request progress to report at all — REQ-H06's
202 is about THAT architectural gap, not "this will take time").
`paused`/terminal-status guards stay exactly as they are today (lines
195-198) — they apply identically to a chained row's parent `codex_cronotons`
status.

### B. Fix `adaptMultiTxSummary` to report real failure — a minimal, backward-compatible, OPT-IN contract

The core difficulty: `MultiTxResolver.run()`'s return type is
`Promise<unknown>` BY DESIGN (`resolvers.ts:77`: *"its concrete signature/
return is defined by the orchestrator that registers it"*) — this package
ships no concrete multi-tx orchestrator (`handlers/execute.ts:18-19`), so
there is no real, verifiable production summary shape to test this
against (unlike Phase 4b's wrap/unwrap, where a real on-chain contract was
there to confirm against). Inventing a rigid required shape would be
guessing a contract no real consumer has agreed to.

The fix: widen the EXISTING duck-typed extraction (which already reads
`summary.batches[].requestKey`) to ALSO read an OPTIONAL `ok: boolean` on
each batch, computing the overall result's `ok` as "true only if every
batch that supplies an `ok` field reports `true`, AND at least one batch
supplied one" — otherwise (no batch provides `ok` at all — the status quo
for any consumer who hasn't adopted this field) fall back to the CURRENT
behavior (`ok: true`), so this is purely additive and never breaks an
existing registered orchestrator that doesn't know about this field yet:

```ts
function adaptMultiTxSummary(summary: unknown): FireResult {
  const s = (summary ?? {}) as { batches?: Array<{ requestKey?: string; ok?: unknown }> };
  const batches = Array.isArray(s.batches) ? s.batches : [];
  const firstBatchKey = batches.length > 0 ? batches[0]?.requestKey : undefined;
  const okFields = batches.filter((b) => typeof b.ok === "boolean");
  const ok = okFields.length === 0 ? true : okFields.every((b) => b.ok === true);
  const failedCount = okFields.filter((b) => b.ok === false).length;
  return {
    ok,
    mode: "fire",
    requestKey: firstBatchKey,
    rawResult: summary,
    error: ok ? undefined : `${failedCount} of ${okFields.length} reporting batch(es) failed`,
    terminalIntent: null,
  };
}
```

This is a **documented, judgment-call scope boundary** (flagged explicitly
for the review, not a silent guess): a multi-tx orchestrator that wants
its real failures recorded must put a boolean `ok` on each batch object
it returns; one that doesn't is unchanged from today. The alternative
(requiring a specific shape) isn't buildable without a real consumer to
verify against, and false-negative-failing an orchestrator that was
working fine before this change would be strictly worse than the status
quo bug.

### C. Per-step standalone fire/simulate route

New file `handlers/steps.ts`, two handlers mirroring `simulateCodexTx`'s
existing shape (`execute.ts:141-180`) but addressing a STORED cronoton's
step by index rather than an arbitrary envelope — the handoff's named
route: `POST /cronotons/:id/steps/:index/{simulate,fire}`.

Shared resolution logic (both handlers): `listStepsForCronoton(id, dep)`
→ find the entry at `step_index === index` (404 if absent — no dedicated
"get one step" store query needed; a cronoton's step list is always
small). Build the leg(s) to run:
- `mode:'single'` → exactly one leg, via the EXISTING
  `stepRowToDefinition(step)` (`store/mappers.ts:45`) — the same function
  `runs-driver.ts`'s own `handleReplanStep` uses for a `mode:'single'`
  step (`runs-driver.ts:385`), so standalone-fire's leg is byte-identical
  to what a real run would build, not a parallel reimplementation.
- `mode:'planner'` → `getStepPlanner(step.planner_name)` (404 if
  unregistered — matches `PlannerNotRegisteredError`'s situation, but a
  404 here since this is a request-shape problem, not a run-time one),
  then call it with a hand-built `PlannerCtx = { runtime: ctx.runtime,
  resolver: ctx.resolver, config: ctx.config }` — EXACTLY
  `runs-driver.ts:326`'s own construction. Zero legs is a valid result
  (the planner decided there's nothing to do): respond with an empty
  `legs: []` array, not an error.

**Deliberately bypasses the run/leg-table lifecycle entirely** — no
`codex_cronoton_runs` row, no `codex_cronoton_run_legs` rows are ever
created by this route. This is a standalone preview/fire mechanism for
testing a step in isolation (the handoff's own stated purpose), not an
alternate way to advance a real run; mixing the two would let an ad-hoc
standalone fire corrupt a real run's barrier/attempt bookkeeping. A
`mode:'planner'` step that fans out to N legs gets ALL N legs
simulated/fired here (never just the first) — a partial preview of a
fan-out step would misrepresent it.

```
POST /cronotons/:id/steps/:index/simulate
  -> 404 {error} if cronoton or step-at-index not found
  -> 404 {error} if mode:'planner' and planner_name unregistered
  -> 200 { ok:true, legs: [{ ok, pactCode, payload, gasUsed, error, rawResult }, ...] }
     (one entry per leg the step currently resolves to; "ok" true iff ALL entries ok)

POST /cronotons/:id/steps/:index/fire
  -> same resolution/404s as simulate
  -> 200 { ok:true, legs: [{ ok, requestKey, error, rawResult }, ...] }
     (each leg ACTUALLY submitted via executeCodexTransaction(leg, "fire", ctx) —
      no record written to codex_cronoton_fires OR codex_cronoton_run_legs;
      this is deliberately NOT audited/recorded like fireAndRecord does,
      since there is no owning run/fire row for a standalone fire to attach to)
```

Behind `withConfirm` (the SAME confirm gate `executeNow`/`simulateCodexTx`
use — firing real money-moving Pact code standalone is exactly as
sensitive as firing a committed row).

### D. Per-leg fire-history visibility — the leg table is the record of truth, per the handoff's own recommendation

The handoff is explicit about which of its two offered options to take:
*"Either widen [`FireTxKey`] or let the leg table be the record of
truth and have fire history read from it. The latter is cleaner"*
(handoff, Phase 5 section). This design takes that recommendation: no
change to `FireTxKey`/`tx_keys_json` at all; a NEW read path over
`codex_cronoton_runs`/`codex_cronoton_run_legs` instead, mirroring
`listFires`/`firesHandler`'s existing pagination pattern exactly
(`store/fires.ts:240-288`, `handlers/read.ts:137-149`).

**New store function**, `store/runs.ts`: `listRunsForCronoton(
codexCronotonId, {limit, offset}, dep): {runs, total}` — same
limit-clamp-[1,100]-default-20 / offset-clamp-[0,∞)-default-0 /
`ORDER BY started_at DESC LIMIT ? OFFSET ?` / separate `COUNT(*)` shape as
`listFires`, scoped to `WHERE codex_cronoton_id = ?` against
`codex_cronoton_runs`. Exported through `store/index.ts` → `server/index.ts`
(mirroring how `listFires`/`listRunLegs` are already re-exported — note
`listRunLegs` itself is NOT currently re-exported from `server/index.ts`
despite existing in `store/runs.ts` since Phase 1/3 — this phase adds
that missing barrel line too, a one-line gap this phase closes alongside
the new function).

**New handlers**, `handlers/read.ts` (same file `firesHandler` lives in —
same read-tier, same `withRead` gate, same file-scope as its closest
sibling, not a new file):
```
GET /[id]/runs?limit&offset
  -> 200 { ok:true, runs, total, limit, offset }   (listRunsForCronoton)

GET /[id]/runs/[runId]/legs
  -> 404 if runId doesn't exist OR belongs to a DIFFERENT cronoton
     (getRun(runId)?.codex_cronoton_id !== id — scoping check, so a
      run-id guess can't leak a different cronoton's leg history)
  -> 200 { ok:true, legs }                          (listRunLegs, unpaginated —
     a single run's legs are bounded by the gas-ceiling-pack algorithm,
     realistically never more than a few dozen; no pagination parameters
     to keep the two new routes' shapes simple and consistent with each
     other, re-visit only if a real deployment ever needs it)
```

No new UI hook in this phase (`useCronotonFires.ts`'s sibling for runs/
legs) — out of scope, see below; the handler surface is the acceptance
bar, matching how Phase 4.1/4b's planners shipped with no UI consumer
either.

## Acceptance criteria

- [ ] `executeNow` on a chained row (≥1 `codex_cronoton_steps` row) starts
      a real run (`createRun` + `driveRunOnce`), proven against a real
      in-memory DB — not a one-shot fire, not a 202-queue.
- [ ] `executeNow` on a chained row that ALREADY has a non-terminal run in
      flight returns HTTP 409 with a clear error, never throwing an
      unhandled `RunAlreadyInFlightError` out of the handler.
- [ ] `executeNow`'s existing plain-row and multi-tx-resolver-row behavior
      is completely unchanged (regression-proven, not just "didn't
      change the code path").
- [ ] `adaptMultiTxSummary` reports `ok:false` with a descriptive `error`
      when every batch in the summary supplies `ok:false`; reports
      `ok:true` when every batch supplies `ok:true`; reports `ok:false`
      when batches are MIXED (some `ok:true`, some `ok:false`).
- [ ] `adaptMultiTxSummary` on a summary with NO `ok` field on any batch
      (the pre-this-phase shape) still reports `ok:true` — the fix is
      strictly additive, proven by a test using the exact shape the
      function's pre-existing tests already used.
- [ ] A `POST .../steps/:index/simulate` on a `mode:'single'` step returns
      the exact same `pactCode`/`payload` a real run would submit for that
      step (byte-identical to `stepRowToDefinition`'s own output).
- [ ] A `POST .../steps/:index/simulate` on a `mode:'planner'` step that
      fans out to N legs returns N entries, not 1.
- [ ] A `POST .../steps/:index/{simulate,fire}` on an out-of-range index
      returns 404, never a thrown error.
- [ ] `GET /[id]/runs` returns paginated runs newest-first for a cronoton
      with multiple historical runs, with `total` reflecting the full
      count regardless of the page window.
- [ ] `GET /[id]/runs/[runId]/legs` returns 404 (not another cronoton's
      legs) when `runId` belongs to a DIFFERENT cronoton than `:id`.

## Out of scope

- A UI hook/component surfacing runs/legs (mirroring `useCronotonFires.ts`)
  — this phase ships the handler/store surface only, matching how prior
  phases' planners shipped with no UI consumer.
- Widening `FireTxKey`/`tx_keys_json` to carry per-leg step indices — the
  handoff's own recommended alternative (the leg table as record of
  truth) is taken instead; `FireTxKey` is untouched.
- Any change to `fireAndRecord`'s own recording behavior for a PLAIN
  one-shot row — only the chained-row branch inside `executeNow` is new.
- Requiring (vs. accepting as optional) a specific `MultiTxResolver.run()`
  return shape — no real consumer exists in this package to validate a
  required contract against; see §B's judgment call.
- Recording/auditing a standalone per-step fire the way `fireAndRecord`
  audits a real fire — deliberately not integrated into the run/fire
  lifecycle (see §C); this is a preview/testing mechanism, not an
  alternate production fire path.
- Phase 6 (the merge optimiser) — explicitly owner-deferred, unrelated to
  this topic.
- A reconciliation sweep that frees a stale `claimed_at` lease before the
  full step deadline elapses. The §A concurrency fix's `claimLegForSubmit`/
  `releaseLegClaim` pair (added during review, not in the original design
  above) is a two-phase claim: a process crash strictly between a won claim
  and the matching `markLegSubmitted`/`releaseLegClaim` call leaves exactly
  one leg row permanently orphaned (`pending`, `claimed_at` set, never
  re-selected). This is harmless (the run still recovers via the existing
  deadline-exceeded re-plan/fail path, just bounded by the full
  `RUN_STEP_DEADLINE_MS` — 10 minutes by default — rather than the next
  pass) and reviewed/accepted as a bounded tradeoff, not a stuck-forever
  state. A lease-expiry sweep would close this gap but is new recovery
  machinery deserving its own scoped design, not a drive-by addition to
  this phase. See `store/runs.ts`'s `claimLegForSubmit` doc comment.
