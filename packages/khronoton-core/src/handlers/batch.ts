/**
 * Manual-batch handlers — the "Execute ×N" lifecycle (start / observe / stop).
 *
 * The tier split is the whole point of this group (REQ-H09): STARTING a batch is
 * a mutation that spends chain gas up to N times, so it runs the CONFIRM gate and
 * demands a fresh admin-confirm. OBSERVING and STOPPING a batch are deliberately
 * confirm-FREE — they run the READ gate so an operator can watch progress or halt
 * a runaway batch with a single click, without a confirm round-trip standing
 * between them and the stop button. The count-bounds / already-active / not-active
 * guards live in the store (`createManualBatch`) and surface here as its typed
 * errors, mapped to 400/404/409 by the kernel's `mapStoreError`.
 */
import {
  createManualBatch,
  getActiveManualBatchForCronoton,
  cancelManualBatch,
  manualBatchView,
} from "../server/index.js";

import { withConfirm, withRead, type HandlerContext } from "./context.js";
import { json, type HandlerRequest, type HandlerResponse } from "./http.js";

/**
 * POST `/[id]/execute-batch` — start a manual batch of `body.count` fires.
 * Confirm-gated. The store validates the count bounds (config-driven 2–60),
 * that the parent cronoton exists + is active + is not one-time, and that no
 * batch is already running; its typed errors map to 400/404/409.
 */
export async function startExecuteBatch(
  ctx: HandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  return withConfirm(ctx, req, async (identity) => {
    const cronotonId = req.params?.id ?? "";
    const count = (req.body as { count?: unknown } | undefined)?.count;
    const row = createManualBatch(
      { cronotonId, total: count as number, createdBy: identity?.email ?? identity?.id ?? "unknown" },
      { db: ctx.db, config: ctx.config },
    );
    return json(200, { ok: true, batch: manualBatchView(row) });
  });
}

/**
 * GET `/[id]/execute-batch` — the active batch for a cronoton, or null.
 * Read-gated (confirm-free): polled while a batch runs, so it never demands a
 * fresh confirm.
 */
export async function getExecuteBatch(
  ctx: HandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  return withRead(ctx, req, async () => {
    const cronotonId = req.params?.id ?? "";
    const batch = getActiveManualBatchForCronoton(cronotonId, { db: ctx.db });
    return json(200, { ok: true, batch: batch ? manualBatchView(batch) : null });
  });
}

/**
 * DELETE `/[id]/execute-batch` — stop the running batch. Read-gated
 * (deliberately confirm-FREE — one-click stop, REQ-H09) and idempotent:
 * `cancelled` is false when the batch was already inactive.
 */
export async function cancelExecuteBatch(
  ctx: HandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  return withRead(ctx, req, async () => {
    // The route param is the CRONOTON id (same `/[id]/execute-batch` path as
    // start/get). Resolve the active batch for that cronoton, then cancel by its
    // own UUID — `cancelManualBatch` filters on the batch PK, not the cronoton.
    const cronotonId = req.params?.id ?? "";
    const active = getActiveManualBatchForCronoton(cronotonId, { db: ctx.db });
    const cancelled = active ? cancelManualBatch(active.id, { db: ctx.db }).ok : false;
    return json(200, { ok: true, cancelled });
  });
}
