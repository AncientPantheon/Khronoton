/**
 * Per-step standalone fire/simulate route: `simulateStep`/`fireStep` address a
 * STORED cronoton's step by index — `POST /cronotons/:id/steps/:index/simulate`
 * and `POST /cronotons/:id/steps/:index/fire` — rather than an arbitrary
 * envelope (`simulateCodexTx`'s own job, `execute.ts`). Both mirror
 * `simulateCodexTx`'s shape: behind {@link withConfirm} (firing standalone Pact
 * code is exactly as sensitive as firing a committed row), HTTP 200 even when
 * the resulting `ok` is false (a chain/build failure rides in the body).
 *
 * **Deliberately bypasses the run/leg-table lifecycle entirely** (design.md
 * §C): no `codex_cronoton_runs` row, no `codex_cronoton_run_legs` rows are
 * ever written here. This is a standalone preview/fire mechanism for testing
 * a step in isolation, not an alternate way to advance a real run — mixing
 * the two would let an ad-hoc standalone fire corrupt a real run's
 * barrier/attempt bookkeeping. A `mode:'planner'` step that fans out to N
 * legs gets ALL N legs simulated/fired here (never just the first).
 */
import { json, err, type HandlerResponse } from "./http.js";
import { withConfirm, type Handler, type HandlerContext } from "./context.js";
import {
  getCodexCronoton,
  getStepByIndex,
  resolvePlannerFor,
  stepRowToDefinition,
  executeCodexTransaction,
  type CodexCronotonRow,
  type CodexCronotonStepRow,
  type CodexTxDefinition,
} from "../server/index.js";
import { resolveSingleStepPayload, YieldNotFoundError } from "../server/pure/yields.js";
import { normalizePlannerResult } from "../server/planners/registry.js";

/** Terminal statuses cannot be fired on demand — same set `execute.ts`'s
 * `executeNow`/`triggerCronoton` already enforce, duplicated locally per
 * this codebase's own per-module-small-constant convention (`parseJson`,
 * `STOA_AUTONOMIC_LIQUIDPOT`, etc.) rather than importing a sibling
 * handler module's private constant. */
const TERMINAL_STATUSES = new Set<CodexCronotonRow["status"]>(["completed", "error"]);

/** Resolve the leg(s) a stored step currently produces, via the SAME shared
 * `resolvePlannerFor` helper `runs-driver.ts`'s `handleReplanStep` uses —
 * not a parallel reimplementation, so the two call sites can never drift.
 * Returns a DISCRIMINATED failure reason rather than a bare `{ok:false}` —
 * a real review finding caught that collapsing "planner not registered"
 * and "unresolved $yield reference" into the same untagged shape made
 * every caller report a misleading `planner 'null' is not registered`
 * message for a `mode:'single'` step (whose `planner_name` is always
 * `null`) that actually failed on a yield reference, not a planner lookup.
 *
 * A standalone fire/simulate has no run, so no yield pool to resolve a
 * `{"$yield": "<name>"}` reference against — every resolution here runs
 * against an explicit empty pool (`docs/work/khronoton-step-yield-carry/
 * design.md`'s "Consuming a yield"). A step that references a yield (e.g.
 * authored for chained-run use, then fired standalone to preview it) always
 * fails `YieldNotFoundError`; caught here and reported as its own reason,
 * rather than letting it escape uncaught to the handler's generic 500
 * catch-all or being folded into the unrelated planner-not-registered case. */
async function resolveStepLegs(
  step: CodexCronotonStepRow,
  ctx: HandlerContext,
): Promise<
  | { ok: true; legs: CodexTxDefinition[] }
  | { ok: false; reason: "planner-not-registered" }
  | { ok: false; reason: "yield-not-found"; message: string }
> {
  try {
    if (step.mode === "single") {
      // Same shared helper `runs-driver.ts`'s single-mode branch uses — not
      // a parallel reimplementation (a review finding caught the two call
      // sites independently re-deriving the identical sequence).
      const resolvedStep = resolveSingleStepPayload(step, {});
      return { ok: true, legs: [stepRowToDefinition(resolvedStep)] };
    }
    const resolved = resolvePlannerFor(step, ctx, {});
    if (!resolved) return { ok: false, reason: "planner-not-registered" };
    const result = await resolved.planner(resolved.resolvedStep, resolved.plannerCtx);
    // The standalone route has no run to persist a yield into, so
    // `normalized.yield`, if present, is deliberately discarded here.
    const normalized = normalizePlannerResult(result);
    return { ok: true, legs: normalized.legs };
  } catch (error) {
    if (error instanceof YieldNotFoundError) {
      return { ok: false, reason: "yield-not-found", message: error.message };
    }
    throw error;
  }
}

/** Shared 404 body for either `resolveStepLegs` failure reason, so
 * `simulateStep`/`fireStep` never independently decide how to phrase it. */
function resolveStepLegsErrorResponse(
  step: CodexCronotonStepRow,
  resolved: { ok: false; reason: "planner-not-registered" } | { ok: false; reason: "yield-not-found"; message: string },
): HandlerResponse {
  if (resolved.reason === "yield-not-found") {
    return err(404, `cannot resolve this step: ${resolved.message}`);
  }
  return err(404, `planner '${step.planner_name}' is not registered`);
}

/** Shared step lookup: 404 on missing cronoton or missing step-at-index.
 * Returns the parent cronoton row too (not just the step) so `fireStep`
 * can enforce the SAME paused/terminal guard `executeNow`/`triggerCronoton`
 * already enforce before it submits anything real to chain. */
function findStep(
  ctx: HandlerContext,
  cronotonId: string,
  index: number,
): { ok: true; row: CodexCronotonRow; step: CodexCronotonStepRow } | { ok: false; response: HandlerResponse } {
  const row = getCodexCronoton(cronotonId, { db: ctx.db });
  if (!row) return { ok: false, response: err(404, "not found") };
  const step = getStepByIndex(cronotonId, index, { db: ctx.db });
  if (!step) return { ok: false, response: err(404, "step not found at that index") };
  return { ok: true, row, step };
}

export const simulateStep: Handler = (ctx, req) =>
  withConfirm(ctx, req, async () => {
    const id = req.params?.id;
    const index = Number.parseInt(req.params?.index ?? "", 10);
    if (!id || !Number.isInteger(index)) return err(400, "cronoton id and an integer step index are required");

    const found = findStep(ctx, id, index);
    if (!found.ok) return found.response;

    const resolved = await resolveStepLegs(found.step, ctx);
    if (!resolved.ok) {
      return resolveStepLegsErrorResponse(found.step, resolved);
    }
    const legs = resolved.legs;

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

    // Same guard `executeNow`/`triggerCronoton` enforce before firing
    // anything real — a paused or terminal cronoton must stay un-fireable
    // through EVERY route that can submit its Pact code to chain, not just
    // the ones that go through the run/fire lifecycle. `simulateStep` needs
    // no equivalent guard: it never submits.
    if (found.row.status === "paused") return err(400, "cannot execute a paused cronoton");
    if (TERMINAL_STATUSES.has(found.row.status)) return err(400, "cannot execute a terminal cronoton");

    const resolved = await resolveStepLegs(found.step, ctx);
    if (!resolved.ok) {
      return resolveStepLegsErrorResponse(found.step, resolved);
    }
    const legs = resolved.legs;

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
