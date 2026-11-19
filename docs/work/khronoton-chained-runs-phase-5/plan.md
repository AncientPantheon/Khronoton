## Wave 1

- [x] T1: Fix `executeNow` so a chained row starts a real run instead of
      falling through to the one-shot/multi-tx paths. — done when:
      `npx vitest run src/handlers/execute.test.ts` passes with the new
      behaviors below (plus all pre-existing tests in that file
      unchanged), and `npm run typecheck` is clean.
  - files: `packages/khronoton-core/src/handlers/execute.ts`,
    `packages/khronoton-core/src/handlers/execute.test.ts`; reads (no
    changes) `server/tick.ts` lines 147-191 (the exact branch to mirror:
    `listStepsForCronoton` → `createRun` → `driveRunOnce` → `onAudit` →
    catch `RunAlreadyInFlightError`), `server/store/runs.ts`
    (`createRun`, `getRun`, `CodexCronotonRunRow`), `server/store/steps.ts`
    (`listStepsForCronoton`), `server/store/errors.ts`
    (`RunAlreadyInFlightError`), `server/runs-driver.ts`
    (`driveRunOnce`, `RunsDriverCtx` — `RunsDriverCtx.onAudit` is
    **required** `OnAudit`, unlike `HandlerContext.onAudit?: OnAudit`
    which is optional; build the ctx passed to `driveRunOnce` with
    `onAudit: ctx.onAudit ?? defaultOnAudit` to satisfy the stricter
    type, reusing the existing `defaultOnAudit` from `seams.ts` rather
    than inventing a new no-op), `server/seams.ts` (`defaultOnAudit`).
  - Implementation, inserted into `executeNow`'s existing body
    (`execute.ts:188-212`) BEFORE the existing `multi-tx` 202-queue
    check, right after the existing `paused`/`TERMINAL_STATUSES` guards
    (both of which stay exactly as-is — they already apply to a chained
    row's parent status identically):
    ```ts
    const steps = listStepsForCronoton(row.id, { db: ctx.db });
    if (steps.length > 0) {
      try {
        const runId = createRun(
          { codexCronotonId: row.id, stepCount: steps.length },
          { db: ctx.db },
        );
        const driverCtx: RunsDriverCtx = {
          db: ctx.db,
          runtime: ctx.runtime,
          resolver: ctx.resolver,
          config: ctx.config,
          onAudit: ctx.onAudit ?? defaultOnAudit,
        };
        await driveRunOnce(runId, new Date(), driverCtx);
        await ctx.onAudit?.({
          action: "codex_cronoton.run_started",
          result: "success",
          targetKind: "codex_cronoton",
          targetId: row.id,
          detail: { codexCronotonId: row.id, runId, stepCount: steps.length, actor: "ancient" },
        });
        const run = getRun(runId, { db: ctx.db });
        return json(200, { ok: true, runId, status: run?.status ?? null });
      } catch (e) {
        if (e instanceof RunAlreadyInFlightError) {
          return err(409, "a run is already in flight for this cronoton");
        }
        throw e;
      }
    }
    ```
    Add `RunsDriverCtx`, `driveRunOnce`, `createRun`, `getRun`,
    `listStepsForCronoton`, `RunAlreadyInFlightError`, `defaultOnAudit` to
    the existing `import { ... } from "../server/index.js"` block at the
    top of `execute.ts` (all already exported from `server/index.js` —
    confirmed by reading `server/store/index.ts`'s
    `export { ..., getRun, listRunLegs, ... } from "./runs.js"` line and
    `server/index.ts`'s `export * from "./store/index.js"`/
    `export * from "./runs-driver.js"` lines, which transitively re-export
    all of these; no barrel edit needed for this task).
  - Tests (`execute.test.ts`, new cases inside the existing
    `describe("executeNow", ...)` block, using the same seeded-row
    fixture helpers already in that file):
    - "starts a real run for a chained row (≥1 step) instead of firing
      inline or 202-queuing — createRun + driveRunOnce actually ran" —
      seed a cronoton with ONE `mode:'single'` step (via `insertStep`),
      call `executeNow`; assert HTTP 200, `body.ok === true`,
      `body.runId` is a non-empty string, `body.status` is one of
      `'awaiting'|'advancing'|'succeeded'|'failed'`; assert via
      `listRunLegs(body.runId, {db})` that at least one leg was actually
      inserted (proving `driveRunOnce` really ran, not just `createRun`).
    - "returns 409 with a clear error when a run is already in flight for
      the chained cronoton, never throwing RunAlreadyInFlightError out of
      the handler" — seed a chained cronoton, call `executeNow` once
      (starts a run left non-terminal, e.g. by mocking the chain client so
      the leg never confirms), call `executeNow` a SECOND time; assert the
      second call returns HTTP 409 with an error message matching
      `/already in flight/`, and that no exception propagated out of
      the handler (the promise resolves, it doesn't reject).
    - "a chained row's executeNow audits `codex_cronoton.run_started`
      exactly once" — assert `ctx.onAudit` (a `vi.fn()`) was called with
      `action: "codex_cronoton.run_started"`.
    - "executeNow's existing plain-row and multi-tx-resolver-row behavior
      is unchanged" — re-run the EXISTING three pre-this-task tests in
      this file word-for-word (they must still pass with zero
      modification) as the regression proof — do not weaken or delete
      them.

- [x] T2: Fix `adaptMultiTxSummary` to report real failure when a
      multi-tx orchestrator's summary batches carry an `ok` field, while
      staying byte-for-byte backward compatible with a summary that
      doesn't. — done when: `npx vitest run src/server/resolvers.test.ts`
      passes with the new behaviors below (plus all pre-existing tests in
      that file unchanged), and `npm run typecheck` is clean.
  - files: `packages/khronoton-core/src/server/resolvers.ts`,
    `packages/khronoton-core/src/server/resolvers.test.ts`.
  - Implementation — replace `adaptMultiTxSummary` (`resolvers.ts:203-214`)
    with:
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
    Update the function's own doc comment (currently claims "A returned
    summary always means the run COMPLETED (`ok:true`)") to describe the
    new, strictly-additive contract: batches with no `ok` field behave
    exactly as before; batches that DO supply `ok` are honored.
  - Tests (`resolvers.test.ts`, new cases alongside the existing
    `"routes a multi-tx resolver to dispatch + adapts the run summary →
    ok:true"` test at line 328, inside the same
    `describe("fireByServerResolver: kind-routing fire dispatcher", ...)`
    block):
    - "adapts a summary whose batches ALL report `ok:false` to a failed
      fire with a descriptive error" — `run` resolves
      `{batches:[{requestKey:"rk1",ok:false},{requestKey:"rk2",ok:false}]}`;
      assert `result.ok === false` and `result.error` matches
      `/2 of 2.*failed/`.
    - "adapts a summary with MIXED batch outcomes (some ok:true, some
      ok:false) to a failed fire" — `run` resolves
      `{batches:[{requestKey:"rk1",ok:true},{requestKey:"rk2",ok:false}]}`;
      assert `result.ok === false` and `result.error` matches
      `/1 of 2.*failed/`.
    - "adapts a summary whose batches ALL report `ok:true` to a
      successful fire (explicit, not just the absent-field default)" —
      `run` resolves `{batches:[{requestKey:"rk1",ok:true}]}`; assert
      `result.ok === true`, `result.error === undefined`.
    - "the pre-existing test at line 328 (`batches:[{requestKey:
      "batch-rk-1"}]`, no `ok` field anywhere) still adapts to `ok:true`
      with no `error`" — re-run that EXACT existing test unmodified as
      the regression proof for backward compatibility; do not weaken or
      delete it.

- [x] T3: Add `listRunsForCronoton` — paginated, newest-first run history
      for one cronoton, mirroring `listFires`'s exact pagination shape. —
      done when: `npx vitest run src/server/store/runs.test.ts` passes
      with the behaviors below, and `npm run typecheck` is clean.
  - files: `packages/khronoton-core/src/server/store/runs.ts`,
    `packages/khronoton-core/src/server/store/runs.test.ts`,
    `packages/khronoton-core/src/server/store/index.ts`; reads (no
    changes) `server/store/fires.ts` lines 240-288 (the EXACT pagination
    pattern to mirror: `limit` clamped to `[1,100]` default `20`,
    `offset` clamped to `>=0` default `0`, `ORDER BY ... DESC LIMIT ?
    OFFSET ?`, a separate `COUNT(*)` query, `{rows, total}` return shape).
  - Implementation, added to `runs.ts` (after `listInFlightRuns`, before
    `listRunLegs`, matching the file's existing top-to-bottom
    read-function grouping):
    ```ts
    export function listRunsForCronoton(
      codexCronotonId: string,
      params: { limit?: number; offset?: number } = {},
      dep: DbDep,
    ): { runs: CodexCronotonRunRow[]; total: number } {
      const db = dep.db;
      const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
      const offset = Math.max(params.offset ?? 0, 0);
      const runs = db
        .prepare(
          `SELECT * FROM codex_cronoton_runs
            WHERE codex_cronoton_id = ?
            ORDER BY started_at DESC LIMIT ? OFFSET ?`,
        )
        .all(codexCronotonId, limit, offset) as CodexCronotonRunRow[];
      const totalRow = db
        .prepare("SELECT COUNT(*) AS c FROM codex_cronoton_runs WHERE codex_cronoton_id = ?")
        .get(codexCronotonId) as { c: number } | undefined;
      return { runs, total: totalRow?.c ?? 0 };
    }
    ```
    Add `listRunsForCronoton` to `store/index.ts`'s existing
    `export { ..., getRun, listRunLegs, ... } from "./runs.js"` line (no
    new line needed — extend the existing one). This transitively reaches
    `server/index.ts` via its existing `export * from "./store/index.js"`
    — no edit to `server/index.ts` itself is needed (confirmed: `getRun`/
    `listRunLegs`/`stepRowToDefinition` are ALL already exported this
    same transitive way today, despite not appearing as an explicit named
    line inside `server/index.ts`'s own text).
  - Tests (`runs.test.ts`, new `describe("listRunsForCronoton", ...)`
    block, using the file's existing real-in-memory-DB fixture style —
    never a SQL-string mock):
    - "returns runs newest-first (by `started_at`) for a cronoton with
      multiple historical runs, with `total` reflecting the full count
      regardless of the page window" — create 3 runs for one cronoton
      with distinct `started_at` values (via `createRun` + direct
      `UPDATE`, or by controlling the clock between calls), call
      `listRunsForCronoton(id, {limit:2}, {db})`; assert `runs.length
      === 2`, the two returned are the two MOST RECENT, and `total === 3`.
    - "returns an empty array (not an error) for a cronoton with zero
      runs" — assert `{runs:[], total:0}`.
    - "clamps an out-of-range limit/offset exactly like listFires does"
      — call with `{limit:500}` and `{limit:0}`/`{offset:-5}`; assert the
      same clamping behavior (`[1,100]`, `offset>=0`) `listFires`'s own
      existing tests already pin for its identical clamp logic.
    - "never returns a DIFFERENT cronoton's runs" — create runs for two
      distinct cronotons; assert `listRunsForCronoton` for cronoton A
      never includes any of cronoton B's run ids.

- [x] T4: Build the per-step standalone fire/simulate route —
      `handlers/steps.ts`'s `simulateStep`/`fireStep` — addressing a
      stored cronoton's step by index, bypassing the run/leg-table
      lifecycle entirely (a preview/testing mechanism, never
      recorded/audited like a real fire). — done when: `npx vitest run
      src/handlers/steps.test.ts` passes with the behaviors below, and
      `npm run typecheck` is clean.
  - files: `packages/khronoton-core/src/handlers/steps.ts` (new),
    `packages/khronoton-core/src/handlers/steps.test.ts` (new); reads (no
    changes) `handlers/execute.ts` (`simulateCodexTx`'s shape —
    `withConfirm`, the `chainDataFrom` helper, HTTP-200-on-`ok:false`
    convention — and `envelopeToDefinition` for the JSDoc-comment style
    to mirror, though this task does NOT reuse that function — it builds
    legs from a STORED step, not an arbitrary envelope), `handlers/http.ts`
    (`json`, `err`), `handlers/context.ts` (`Handler`, `HandlerContext`,
    `withConfirm`), `server/runs-driver.ts` lines 316-396
    (`handleReplanStep`'s exact `mode:'single'`/`mode:'planner'`
    branches — this task's leg-resolution logic must match these, not
    reinvent them: `stepRowToDefinition(step)` for single,
    `getStepPlanner(step.planner_name ?? "")` + a hand-built `PlannerCtx
    = {runtime: ctx.runtime, resolver: ctx.resolver, config: ctx.config}`
    for planner), `server/store/mappers.ts` (`stepRowToDefinition`),
    `server/store/steps.ts` (`listStepsForCronoton`,
    `CodexCronotonStepRow`), `server/index.ts` (confirms
    `getCodexCronoton`, `listStepsForCronoton`, `getStepPlanner`,
    `stepRowToDefinition`, `executeCodexTransaction`, and the
    `PlannedLeg`/`PlannerCtx` types are ALL already exported — no barrel
    edit needed for this task either).
  - Implementation:
    ```ts
    /** Resolve the leg(s) a stored step currently produces, mirroring
     * runs-driver.ts's handleReplanStep exactly — never a parallel
     * reimplementation. Returns "unregistered" for a planner-mode step
     * whose planner_name has no registered StepPlanner. */
    async function resolveStepLegs(
      step: CodexCronotonStepRow,
      ctx: HandlerContext,
    ): Promise<CodexTxDefinition[] | "unregistered"> {
      if (step.mode === "single") {
        return [stepRowToDefinition(step)];
      }
      const planner = getStepPlanner(step.planner_name ?? "");
      if (!planner) return "unregistered";
      const plannerCtx: PlannerCtx = { runtime: ctx.runtime, resolver: ctx.resolver, config: ctx.config };
      return planner(step, plannerCtx);
    }

    /** Shared step lookup: 404 on missing cronoton or missing step-at-index. */
    function findStep(
      ctx: HandlerContext,
      cronotonId: string,
      index: number,
    ): { ok: true; step: CodexCronotonStepRow } | { ok: false; response: HandlerResponse } {
      const row = getCodexCronoton(cronotonId, { db: ctx.db });
      if (!row) return { ok: false, response: err(404, "not found") };
      const step = listStepsForCronoton(cronotonId, { db: ctx.db }).find((s) => s.step_index === index);
      if (!step) return { ok: false, response: err(404, "step not found at that index") };
      return { ok: true, step };
    }

    export const simulateStep: Handler = (ctx, req) =>
      withConfirm(ctx, req, async () => {
        const id = req.params?.id;
        const index = Number.parseInt(req.params?.index ?? "", 10);
        if (!id || !Number.isInteger(index)) return err(400, "cronoton id and an integer step index are required");

        const found = findStep(ctx, id, index);
        if (!found.ok) return found.response;

        const legs = await resolveStepLegs(found.step, ctx);
        if (legs === "unregistered") {
          return err(404, `planner '${found.step.planner_name}' is not registered`);
        }

        const results = await Promise.all(
          legs.map((leg) =>
            executeCodexTransaction(leg, "simulate", { runtime: ctx.runtime, resolver: ctx.resolver, config: ctx.config }),
          ),
        );
        return json(200, {
          ok: results.every((r) => r.ok),
          legs: results.map((r, i) => ({
            ok: r.ok,
            pactCode: legs[i].pactCode,
            payload: legs[i].payload,
            gasUsed: r.gasUsed,
            error: r.error,
            rawResult: r.rawResult,
          })),
        });
      });

    export const fireStep: Handler = (ctx, req) =>
      withConfirm(ctx, req, async () => {
        const id = req.params?.id;
        const index = Number.parseInt(req.params?.index ?? "", 10);
        if (!id || !Number.isInteger(index)) return err(400, "cronoton id and an integer step index are required");

        const found = findStep(ctx, id, index);
        if (!found.ok) return found.response;

        const legs = await resolveStepLegs(found.step, ctx);
        if (legs === "unregistered") {
          return err(404, `planner '${found.step.planner_name}' is not registered`);
        }

        const results = await Promise.all(
          legs.map((leg) =>
            executeCodexTransaction(leg, "fire", { runtime: ctx.runtime, resolver: ctx.resolver, config: ctx.config }),
          ),
        );
        return json(200, {
          ok: results.every((r) => r.ok),
          legs: results.map((r, i) => ({
            ok: r.ok,
            pactCode: legs[i].pactCode,
            requestKey: r.requestKey,
            error: r.error,
            rawResult: r.rawResult,
          })),
        });
      });
    ```
    Doc-comment the file header explaining the "bypasses the run/leg-table
    lifecycle entirely — no `codex_cronoton_runs`/`codex_cronoton_run_legs`
    row is ever written here, this is a standalone preview/testing
    mechanism" posture from design.md §C, and the intended consumer route
    convention (`POST /cronotons/:id/steps/:index/{simulate,fire}`),
    matching `read.ts`'s/`execute.ts`'s own header-comment style.
  - Tests (`steps.test.ts`, new file, mirroring `execute.test.ts`'s
    fixture/mock style — a real in-memory DB, a mocked `ChainClient`):
    - "simulateStep on a mode:'single' step returns the exact same
      pactCode/payload stepRowToDefinition itself would produce for that
      step" — seed a cronoton with one `mode:'single'` step with known
      `pact_code`/`payload_json`; assert `legs[0].pactCode`/`legs[0].payload`
      equal `stepRowToDefinition(theSameStepRow)`'s own output exactly.
    - "simulateStep on a mode:'planner' step that fans out to 3 legs
      returns exactly 3 entries, each with its own pactCode" — register a
      stand-in `StepPlanner` returning 3 distinct `PlannedLeg`s, seed a
      step bound to it; assert `legs.length === 3` and each entry's
      `pactCode` is distinct.
    - "simulateStep on a mode:'planner' step whose planner_name has no
      registered StepPlanner returns 404, never throwing" — seed a step
      with `planner_name: "nonexistent.planner"`; assert HTTP 404.
    - "simulateStep/fireStep on an out-of-range step index returns 404"
      — seed a cronoton with 1 step (index 0), request index 5; assert
      HTTP 404 for both `simulateStep` and `fireStep`.
    - "fireStep actually calls executeCodexTransaction in 'fire' mode
      (not 'simulate'), proven by the mock executor seeing a submit call"
      — spy on the chain client's `submit`; assert it was called exactly
      once per leg after `fireStep`, and NEVER called after
      `simulateStep` for the identical step (a dedicated assertion that
      `simulateStep` never submits).
    - "neither simulateStep nor fireStep ever write a
      codex_cronoton_runs or codex_cronoton_run_legs row" — after calling
      both handlers, assert via a direct query against the test's own DB
      handle — `db.prepare("SELECT COUNT(*) AS c FROM codex_cronoton_runs").get().c === 0`
      and the same for `codex_cronoton_run_legs` — deliberately NOT
      `listRunsForCronoton` (T3's function, a DIFFERENT Wave 1 task this
      task must stay independent of).

## Wave 2 (depends on Wave 1 — specifically T3's `listRunsForCronoton`)

- [x] T5: Add `GET /[id]/runs` and `GET /[id]/runs/[runId]/legs` read
      handlers, mirroring `firesHandler`'s exact pagination/gate pattern. —
      done when: `npx vitest run src/handlers/read.test.ts` passes with
      the behaviors below (plus all pre-existing tests in that file
      unchanged), and `npm run typecheck` is clean.
  - files: `packages/khronoton-core/src/handlers/read.ts`,
    `packages/khronoton-core/src/handlers/read.test.ts`; reads (no
    changes) `server/index.ts` (`listRunsForCronoton` from T3,
    `listRunLegs`, `getRun` — all already exported transitively, T3's
    change did not require touching `server/index.ts` itself, so nothing
    new to add there for this task).
  - Implementation, added to `read.ts` after `firesHandler` (same file,
    same `withRead` gate, reusing the EXISTING `clampInt` helper already
    defined in this file — do not duplicate it):
    ```ts
    /** `GET /[id]/runs?limit&offset` — paginated chained-run history for
     * one cronoton. Page size defaults to 20 (matching listRunsForCronoton's
     * own default), distinct from fires' 50-default (REQ-G08 is fires-specific). */
    export async function runsHandler(
      ctx: HandlerContext,
      request: HandlerRequest,
    ): Promise<HandlerResponse> {
      return withRead(ctx, request, async () => {
        const id = request.params?.id ?? "";
        const query = request.query ?? {};
        const limit = clampInt(query.limit, { def: 20, min: 1, max: 100 });
        const offset = clampInt(query.offset, { def: 0, min: 0 });
        const { runs, total } = listRunsForCronoton(id, { limit, offset }, { db: ctx.db });
        return json(200, { ok: true, runs, total, limit, offset });
      });
    }

    /** `GET /[id]/runs/[runId]/legs` — every leg of one specific run,
     * scoped so a runId belonging to a DIFFERENT cronoton 404s rather
     * than leaking that cronoton's leg history. Unpaginated — a single
     * run's legs are bounded by the gas-ceiling-pack algorithm, never
     * realistically more than a few dozen. */
    export async function runLegsHandler(
      ctx: HandlerContext,
      request: HandlerRequest,
    ): Promise<HandlerResponse> {
      return withRead(ctx, request, async () => {
        const id = request.params?.id ?? "";
        const runId = request.params?.runId ?? "";
        const run = getRun(runId, { db: ctx.db });
        if (!run || run.codex_cronoton_id !== id) {
          return err(404, "not found");
        }
        const legs = listRunLegs(runId, { db: ctx.db });
        return json(200, { ok: true, legs });
      });
    }
    ```
    Add `listRunsForCronoton`, `listRunLegs`, `getRun` to the existing
    `import { ... } from "../server/index.js"` block at the top of
    `read.ts`.
  - Tests (`read.test.ts`, new `describe` blocks mirroring the existing
    `firesHandler` test style — real in-memory DB):
    - "GET /[id]/runs returns paginated runs newest-first with the
      correct total, mirroring listRunsForCronoton's own tested
      behavior" — seed 3 runs for one cronoton, call `runsHandler` with
      `{limit:"2"}`; assert `body.runs.length === 2`, `body.total === 3`.
    - "GET /[id]/runs/[runId]/legs returns every leg for that run" —
      seed a run with 2 legs (via `insertRunLeg` directly, matching
      `runs.test.ts`'s own fixture style), call `runLegsHandler`; assert
      `body.legs.length === 2`.
    - "GET /[id]/runs/[runId]/legs returns 404 when runId belongs to a
      DIFFERENT cronoton than :id" — seed two cronotons each with their
      own run, call `runLegsHandler` with cronoton A's `:id` param but
      cronoton B's `runId` param; assert HTTP 404, and that cronoton B's
      actual legs are never present in ANY response body across this
      test run (a leaked-data regression would otherwise be easy to miss
      if the test only checked the status code).
    - "GET /[id]/runs/[runId]/legs returns 404 for a runId that doesn't
      exist at all" — assert HTTP 404 (not a thrown error).

## Wave 3 (depends on Wave 1's T4 and Wave 2's T5)

- [x] T6: Wire the new handlers into the public `handlers/index.ts`
      barrel. — done when: `grep -n "simulateStep\|fireStep\|runsHandler\|runLegsHandler" dist/handlers/index.d.ts`
      (after `npm run build`) shows all four symbols re-exported under
      their contract names, and `npm run typecheck` is clean.
  - files: `packages/khronoton-core/src/handlers/index.ts`; reads (no
    changes) `handlers/steps.ts` (T4's `simulateStep`/`fireStep`),
    `handlers/read.ts` (T5's `runsHandler`/`runLegsHandler` — this task
    cannot start until both exist, hence Wave 3).
  - Implementation: extend the existing `// ── Read handlers (TC.2) ──`
    export block to add `runsHandler as fetchRuns, runLegsHandler as
    fetchRunLegs` (matching the existing `firesHandler as fetchFires`
    aliasing convention exactly); add a new
    `// ── Per-step standalone fire (Phase 5) ──` heading block exporting
    `export { simulateStep, fireStep } from "./steps.js";`, placed after
    the existing `// ── Execution handlers (TC.4) ──` block since it's
    the same execution-tier family, just scoped to one step instead of a
    whole committed row.
