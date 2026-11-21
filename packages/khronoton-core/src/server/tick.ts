/**
 * The server tick — the async select → claim → fire → record → finalize → audit
 * sequence, lifted from the Hub `lib/codex-cronoton/tick.ts` into a pure
 * ctx-taking form.
 *
 * The Hub reached its DB, audit log, and fire dispatcher through ambient globals
 * (`getDb()`, `logAuditFromWorker`, a `stoicism-mint` re-export). Here every one
 * of those is injected on {@link TickCtx} and threaded explicitly: `{ db }` into
 * each store call, `{ db, resolveFireMode }` into the fire record, the full
 * `{ runtime, resolver, config, db, deps }` into {@link fireByServerResolver},
 * and `onAudit(...)` for the two audit action strings.
 *
 * ── CLAIM-BEFORE-FIRE / once-only contract (LOAD-BEARING) ─────────────────────
 * Because the fire runs inline and can block for minutes, each due row's
 * `next_fire_at` MUST be advanced (recurring) or cleared (one-time) atomically
 * BEFORE the await via {@link claimDueCodexCronoton}:
 *   - claim wins (true)  → the row is no longer due/re-selectable; fire it.
 *   - claim lost (false) → an overlapping tick or a manual Execute-Now already
 *     claimed it → SKIP (no fire).
 * The per-row atomic claim is the PRIMARY double-fire guard.
 *
 * ── Failure policy ────────────────────────────────────────────────────────────
 * Single attempt, no retry, no backoff, NO auto-pause. Exactly ONE fire row per
 * fire. A recurring FAILURE stays `active` (its next_fire_at was already advanced
 * by the claim — the failure lives only in fire history). A one-time fire applies
 * the executor's terminal intent (success → completed, failure → error). The fire
 * dispatcher NEVER throws — the tick reads `result.ok`; the surrounding try/catch
 * isolates only orchestration errors (rowToDefinition parse, recordFire write).
 *
 * The ONLY status write this tick issues is the one-time terminal transition via
 * {@link applyTerminalIntent}. It NEVER writes `status='paused'` and issues NO
 * post-fire recurring advance (the claim already advanced it).
 */

import {
  fetchDueCodexCronotons,
  claimDueCodexCronoton,
  applyTerminalIntent,
} from "./store/claim.js";
import { rowToDefinition } from "./store/mappers.js";
import { recordFire } from "./store/fires.js";
import { computeDefinitionFingerprint } from "./pure/fingerprint.js";
import {
  fetchDueManualBatches,
  claimManualBatchFire,
  cancelManualBatch,
} from "./store/manual-batch.js";
import { getCodexCronoton } from "./store/cronoton.js";
import { fireByServerResolver } from "./resolvers.js";
import { TICK_BATCH_LIMIT } from "./seams.js";
import { createRun } from "./store/runs.js";
import { RunAlreadyInFlightError } from "./store/errors.js";
import { listStepsForCronoton } from "./store/steps.js";
import { driveRunOnce } from "./runs-driver.js";
import { attemptSingleTxFirst } from "./single-tx.js";
import type {
  ChainRuntime,
  Config,
  Database,
  KeyResolver,
  OnAudit,
  ResolveFireMode,
} from "./seams.js";
import type { FireTxKey } from "./types.js";

/**
 * The injected context the tick runs against — a structural SUPERSET of the
 * executor's `{ runtime, resolver }`, so {@link fireByServerResolver} receives
 * `runtime`+`resolver`+`db` straight off it. Every host capability the Hub tick
 * reached for ambiently arrives here.
 */
export interface TickCtx {
  db: Database;
  resolver: KeyResolver;
  runtime: ChainRuntime;
  onAudit: OnAudit;
  resolveFireMode: ResolveFireMode;
  config: Config;
}

/**
 * One multi-tx `onTx` collector + the `FireTxKey[]` it fills, threaded into
 * {@link fireByServerResolver} so an INLINE multi-tx fire records the per-tx
 * breakdown. A no-op for single-tx/no-resolver rows (the single-tx path never
 * invokes `onTx`), so it is safe to pass unconditionally.
 */
function makeTxKeyCollector(): {
  txKeys: FireTxKey[];
  deps: { onTx: (tx: { kind: string; chainId: string; requestKey: string; ok?: boolean }) => void };
} {
  const txKeys: FireTxKey[] = [];
  return {
    txKeys,
    deps: {
      onTx: (tx) =>
        txKeys.push({
          kind: tx.kind as FireTxKey["kind"],
          chainId: tx.chainId,
          requestKey: tx.requestKey,
          ok: tx.ok,
        }),
    },
  };
}

export interface CodexTickResult {
  /** Rows that fired successfully (result ok:true). */
  firedIds: string[];
  /** Rows that fired but the dispatcher returned ok:false (fired-and-failed). */
  failedIds: string[];
  /** Rows skipped without firing (lost claim, or an orchestration error). */
  skippedIds: string[];
  /**
   * Chained-run ids created AND driven inline this pass (design.md §B).
   * `loop.ts` passes this as `advanceInFlightRunsOnce`'s `excludeRunIds` so
   * the sweep pass a moment later doesn't re-drive — and re-poll — a run
   * this same tick pass already drove as far as it would synchronously go.
   */
  drivenRunIds: string[];
}

/**
 * Select → claim → fire → record → finalize → audit for every due codex
 * cronoton. Fires INLINE via {@link fireByServerResolver} (map §8 divergence #3:
 * always through the dispatcher, never the executor directly).
 */
export async function codexCronotonTickOnce(
  now: Date,
  ctx: TickCtx,
): Promise<CodexTickResult> {
  const firedIds: string[] = [];
  const failedIds: string[] = [];
  const skippedIds: string[] = [];
  const drivenRunIds: string[] = [];

  const due = fetchDueCodexCronotons(now, ctx.config?.tickBatchLimit ?? TICK_BATCH_LIMIT, {
    db: ctx.db,
  });

  for (const row of due) {
    try {
      const claimed = claimDueCodexCronoton(row, now, { db: ctx.db });
      if (!claimed) {
        skippedIds.push(row.id);
        continue;
      }

      // Try-single-tx-first decision — ahead of the chained/plain branch below,
      // per docs/work/khronoton-single-tx-custom/design.md. `fired: false` means
      // either the flag is off or the simulate was refused specifically for
      // being too expensive; either way fall through to the existing
      // chained/plain decision unchanged. `fired: true` means the single-tx
      // variant was actually fired (successfully or not) — the chained/plain
      // path below is never reached for this row.
      const attempt = await attemptSingleTxFirst(row, ctx, { auditDetailExtra: { actor: "scheduler" } });
      if (attempt.fired) {
        if (attempt.result!.ok) firedIds.push(row.id);
        else failedIds.push(row.id);
        continue;
      }

      // Chained (≥1 codex_cronoton_steps row) vs plain — design.md §A/§B. A
      // chained row never reaches the one-shot fire path below: its lifecycle
      // lives in codex_cronoton_runs/..._run_legs, not codex_cronoton_fires.
      const steps = listStepsForCronoton(row.id, { db: ctx.db });
      if (steps.length > 0) {
        try {
          const runId = createRun(
            { codexCronotonId: row.id, stepCount: steps.length },
            { db: ctx.db },
          );
          // Drive the freshly created run forward synchronously in this SAME
          // tick pass, so step 0's leg is built AND submitted without waiting
          // a full tickIntervalMs for the next advanceInFlightRunsOnce pass.
          await driveRunOnce(runId, now, ctx);
          // onAudit before the firedIds/drivenRunIds pushes, mirroring the
          // plain-fire path below: onAudit "may be sync or async" (seams.ts)
          // and isn't guaranteed non-throwing — a throw here is caught by
          // the outer per-row catch and lands row.id in skippedIds, so it
          // must never ALSO already be in firedIds by that point.
          await ctx.onAudit({
            action: "codex_cronoton.run_started",
            result: "success",
            targetKind: "codex_cronoton",
            targetId: row.id,
            detail: {
              codexCronotonId: row.id,
              runId,
              stepCount: steps.length,
              actor: "scheduler",
            },
          });
          firedIds.push(row.id);
          drivenRunIds.push(runId);
        } catch (err) {
          if (err instanceof RunAlreadyInFlightError) {
            // Self-blocked: an existing non-terminal run for this cronoton is
            // already being driven by advanceInFlightRunsOnce every pass —
            // the claim already advanced next_fire_at regardless (§C).
            skippedIds.push(row.id);
          } else {
            throw err;
          }
        }
        continue;
      }

      const scheduleKind: "one-time" | "recurring" =
        row.schedule_mode === "one-time" ? "one-time" : "recurring";

      const definition = rowToDefinition(row);
      const { txKeys, deps: collectDeps } = makeTxKeyCollector();
      const result = await fireByServerResolver(definition, row, {
        runtime: ctx.runtime,
        resolver: ctx.resolver,
        config: ctx.config,
        db: ctx.db,
        deps: collectDeps,
      });
      const fingerprint = computeDefinitionFingerprint(row);

      const fireId = recordFire(
        {
          codexCronotonId: row.id,
          jobId: null,
          firedAt: now.toISOString(),
          status: result.ok ? "success" : "failure",
          requestKey: result.requestKey,
          chainId: result.chainId,
          errorMessage: result.error,
          chainResponse: result.rawResult,
          definitionFingerprint: fingerprint,
          txKeys,
        },
        { db: ctx.db, resolveFireMode: ctx.resolveFireMode },
      );

      // Recurring: next_fire_at was already advanced by the claim (a failed
      // recurring stays active — no post-fire advance). One-time: next_fire_at
      // was already cleared by the claim — apply the terminal status.
      if (scheduleKind === "one-time") {
        applyTerminalIntent(row.id, result.terminalIntent, { db: ctx.db });
      }

      await ctx.onAudit({
        action: result.ok ? "codex_cronoton.fire" : "codex_cronoton.fire_failed",
        result: result.ok ? "success" : "failure",
        targetKind: "codex_cronoton",
        targetId: row.id,
        detail: {
          codexCronotonId: row.id,
          fireId,
          requestKey: result.requestKey,
          chainId: result.chainId,
          actor: "scheduler",
          scheduleKind,
          terminalStatus: result.terminalIntent?.status,
          definitionFingerprint: fingerprint,
          errorMessage: result.error,
          message: result.error,
        },
      });

      if (result.ok) firedIds.push(row.id);
      else failedIds.push(row.id);
    } catch (err) {
      // Orchestration error (rowToDefinition parse, recordFire write). The claim
      // already advanced/cleared next_fire_at, so this row will NOT re-arm;
      // isolate the failure and continue to the next row. Surface the diagnostic
      // (matching the Hub) so a "fired but the fire-record write failed" case is
      // never silent — the id also lands in skippedIds.
      console.error(`khronoton tick: codex cronoton ${row.id} skipped after an orchestration error`, err);
      skippedIds.push(row.id);
    }
  }

  return { firedIds, failedIds, skippedIds, drivenRunIds };
}

export interface CodexManualBatchTickResult {
  /** Batch ids that fired a slot successfully this tick. */
  firedIds: string[];
  /** Batch ids that fired a slot but the dispatcher returned ok:false. */
  failedIds: string[];
  /** Batch ids skipped (lost claim / orchestration error). */
  skippedIds: string[];
  /** Batch ids auto-cancelled because the parent cronoton is no longer active. */
  cancelledIds: string[];
}

/**
 * Process due manual-execution batches — the "Execute Now ×N" rail. For each
 * batch with a due slot it fires the PARENT cronoton ONCE (the same shared fire +
 * fire-row recording as the scheduled tick), spaced by the batch's interval. Each
 * slot is CLAIMED before the inline fire so an overlapping tick cannot double-fire
 * it. A batch fire records a fire row + a `manual_fire` audit (actor 'ancient',
 * via 'manual_batch', attributed to the batch's creator) and NEVER advances the
 * cronoton's own schedule. If the parent has left 'active', the batch is
 * auto-cancelled instead of fired.
 */
export async function processDueManualBatchesOnce(
  now: Date,
  ctx: TickCtx,
): Promise<CodexManualBatchTickResult> {
  const firedIds: string[] = [];
  const failedIds: string[] = [];
  const skippedIds: string[] = [];
  const cancelledIds: string[] = [];

  const due = fetchDueManualBatches(now, ctx.config?.tickBatchLimit ?? TICK_BATCH_LIMIT, {
    db: ctx.db,
  });

  for (const batch of due) {
    try {
      const cronoton = getCodexCronoton(batch.codex_cronoton_id, { db: ctx.db });
      if (!cronoton || cronoton.status !== "active") {
        // Parent paused / deleted / terminal — stop the batch.
        cancelManualBatch(batch.id, { db: ctx.db });
        cancelledIds.push(batch.id);
        continue;
      }
      if (cronoton.try_single_tx_first) {
        // A review finding caught this: this loop fires the parent's raw
        // top-level definition directly via `fireByServerResolver`, with NO
        // `attemptSingleTxFirst` gas-ceiling simulate-then-decide guard — the
        // exact guard `codexCronotonTickOnce`'s due-row branch and
        // `executeNow`'s manual-trigger branch both now apply ahead of this
        // same definition. A `try_single_tx_first=1` row's top-level fields
        // are no longer inert placeholder data (docs/work/
        // khronoton-single-tx-custom/design.md) — they are the operator's
        // real single-tx Pact code, so firing them here on a repeating timer
        // with no gas check is a genuinely new, unsafe bypass this topic's
        // own change in field semantics introduces. Stop the batch rather
        // than risk an unmineable (or unintended) repeated submission; the
        // operator can re-trigger via `executeNow`, which DOES apply the
        // guard. (Manual batches on an ORDINARY chained row — zero
        // `try_single_tx_first` — already bypass the step machinery
        // entirely; that is a separate, pre-existing gap this fix does not
        // attempt to close.)
        cancelManualBatch(batch.id, { db: ctx.db });
        cancelledIds.push(batch.id);
        continue;
      }

      const claimed = claimManualBatchFire(batch, now, { db: ctx.db });
      if (!claimed) {
        skippedIds.push(batch.id);
        continue;
      }
      const batchIndex = batch.completed + 1;

      const definition = rowToDefinition(cronoton);
      const { txKeys, deps: collectDeps } = makeTxKeyCollector();
      const result = await fireByServerResolver(definition, cronoton, {
        runtime: ctx.runtime,
        resolver: ctx.resolver,
        config: ctx.config,
        db: ctx.db,
        deps: collectDeps,
      });
      const fingerprint = computeDefinitionFingerprint(cronoton);

      const fireId = recordFire(
        {
          codexCronotonId: cronoton.id,
          jobId: null,
          firedAt: now.toISOString(),
          status: result.ok ? "success" : "failure",
          requestKey: result.requestKey,
          chainId: result.chainId,
          errorMessage: result.error,
          chainResponse: result.rawResult,
          definitionFingerprint: fingerprint,
          txKeys,
        },
        { db: ctx.db, resolveFireMode: ctx.resolveFireMode },
      );

      await ctx.onAudit({
        action: result.ok ? "codex_cronoton.manual_fire" : "codex_cronoton.fire_failed",
        result: result.ok ? "success" : "failure",
        targetKind: "codex_cronoton",
        targetId: cronoton.id,
        detail: {
          codexCronotonId: cronoton.id,
          fireId,
          actor: "ancient",
          via: "manual_batch",
          batchId: batch.id,
          batchIndex,
          batchTotal: batch.total,
          scheduleKind: "recurring",
          createdBy: batch.created_by,
          requestKey: result.requestKey,
          chainId: result.chainId,
          definitionFingerprint: fingerprint,
          errorMessage: result.error,
          message: result.error,
        },
      });

      if (result.ok) firedIds.push(batch.id);
      else failedIds.push(batch.id);
    } catch (err) {
      // Isolate the per-batch orchestration failure and surface the diagnostic
      // (matching the Hub) rather than dropping it silently.
      console.error(`khronoton tick: manual batch ${batch.id} skipped after an orchestration error`, err);
      skippedIds.push(batch.id);
    }
  }

  return { firedIds, failedIds, skippedIds, cancelledIds };
}
