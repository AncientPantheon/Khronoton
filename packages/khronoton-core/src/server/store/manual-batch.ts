/**
 * manual-batch — the create / due-fetch / claim / cancel lifecycle for
 * `codex_cronoton_manual_batches` ("Execute Now ×N").
 *
 * The centerpiece is {@link claimManualBatchFire}: a single conditional UPDATE
 * that increments `completed`, advances `next_at` (+interval, or NULL on the
 * final slot) and flips `status` to 'completed' on the last slot IN THE SAME
 * statement. The WHERE clause re-asserts the due predicate so two racing
 * claimers see exactly one win — the once-only guarantee mirrored from
 * {@link claimDueCodexCronoton}.
 *
 * Count bounds and inter-fire cadence read from an OPTIONAL injected config
 * ({@link Config.manualBatch}); the exported constants back them as DEFAULTS.
 */
import crypto from "node:crypto";

import type { Config, DbDep } from "../seams.js";
import type { CodexManualBatchRow } from "../types.js";
import { getCodexCronoton } from "./cronoton.js";
import {
  CodexCronotonValidationError,
  ManualBatchActiveError,
  MANUAL_BATCH_INTERVAL_SECONDS,
  MANUAL_BATCH_MAX,
  MANUAL_BATCH_MIN,
} from "./errors.js";

export function getManualBatch(id: string, dep: DbDep): CodexManualBatchRow | null {
  const row = dep.db
    .prepare("SELECT * FROM codex_cronoton_manual_batches WHERE id = ?")
    .get(id) as CodexManualBatchRow | undefined;
  return row ?? null;
}

/** The one active batch for a cronoton (at most one is allowed at a time). */
export function getActiveManualBatchForCronoton(
  cronotonId: string,
  dep: DbDep,
): CodexManualBatchRow | null {
  const row = dep.db
    .prepare(
      `SELECT * FROM codex_cronoton_manual_batches
        WHERE codex_cronoton_id = ? AND status = 'active'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(cronotonId) as CodexManualBatchRow | undefined;
  return row ?? null;
}

export interface CreateManualBatchInput {
  cronotonId: string;
  total: number;
  createdBy: string;
}

interface CreateManualBatchOpts extends DbDep {
  now?: Date;
  /** Overrides the default count bounds and inter-fire cadence. */
  config?: Partial<Config>;
}

/**
 * Create a manual execution batch. Validates the count bounds, that the parent
 * cronoton exists + is active + is NOT one-time (a single fire spends a one-time
 * entry, so batching it is meaningless), and that no batch is already running
 * for it. `next_at = now` so the first fire is picked up on the next worker tick.
 */
export function createManualBatch(
  input: CreateManualBatchInput,
  opts: CreateManualBatchOpts,
): CodexManualBatchRow {
  const db = opts.db;
  const { min, max, intervalSeconds } = opts.config?.manualBatch ?? {
    min: MANUAL_BATCH_MIN,
    max: MANUAL_BATCH_MAX,
    intervalSeconds: MANUAL_BATCH_INTERVAL_SECONDS,
  };

  const total = Math.trunc(input.total);
  if (!Number.isFinite(input.total) || total < min || total > max) {
    throw new CodexCronotonValidationError(
      `count must be an integer between ${min} and ${max}`,
    );
  }

  const cronoton = getCodexCronoton(input.cronotonId, { db });
  if (!cronoton) throw new CodexCronotonValidationError("not found");
  if (cronoton.status !== "active") {
    throw new CodexCronotonValidationError(
      `cannot batch-execute a codex cronoton with status '${cronoton.status}'`,
    );
  }
  if (cronoton.schedule_mode === "one-time") {
    throw new CodexCronotonValidationError(
      "one-time codex cronotons cannot be batch-executed (a single fire spends them)",
    );
  }
  if (getActiveManualBatchForCronoton(input.cronotonId, { db })) {
    throw new ManualBatchActiveError();
  }

  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO codex_cronoton_manual_batches
       (id, codex_cronoton_id, total, completed, interval_seconds, status,
        next_at, created_at, modified_at, created_by)
       VALUES (?, ?, ?, 0, ?, 'active', ?, ?, ?, ?)`,
  ).run(
    id,
    input.cronotonId,
    total,
    intervalSeconds,
    nowIso,
    nowIso,
    nowIso,
    input.createdBy,
  );

  return getManualBatch(id, { db })!;
}

/** Active batches with a due slot (`next_at <= now`), oldest-first. */
export function fetchDueManualBatches(
  now: Date,
  limit: number,
  dep: DbDep,
): CodexManualBatchRow[] {
  return dep.db
    .prepare(
      `SELECT * FROM codex_cronoton_manual_batches
        WHERE status = 'active' AND next_at IS NOT NULL AND next_at <= ?
        ORDER BY next_at ASC LIMIT ?`,
    )
    .all(now.toISOString(), limit) as CodexManualBatchRow[];
}

/**
 * Atomically claim one fire slot of a batch BEFORE the inline fire (mirrors
 * claimDueCodexCronoton): a single conditional UPDATE increments `completed`,
 * advances `next_at` (+interval, or NULL on the final slot) and flips status to
 * 'completed' on the last slot. The WHERE clause re-asserts the due predicate so
 * two racing claimers see exactly one win. Returns true when this caller won the
 * slot (changes === 1) and should fire.
 */
export function claimManualBatchFire(
  batch: CodexManualBatchRow,
  now: Date,
  dep: DbDep,
): boolean {
  const db = dep.db;
  const nowIso = now.toISOString();
  const nextAtIso = new Date(
    now.getTime() + batch.interval_seconds * 1000,
  ).toISOString();
  const result = db
    .prepare(
      `UPDATE codex_cronoton_manual_batches
          SET completed = completed + 1,
              next_at = CASE WHEN completed + 1 < total THEN ? ELSE NULL END,
              status  = CASE WHEN completed + 1 < total THEN 'active' ELSE 'completed' END,
              modified_at = ?
        WHERE id = ? AND status = 'active' AND next_at IS NOT NULL
              AND next_at <= ? AND completed < total`,
    )
    .run(nextAtIso, nowIso, batch.id, nowIso);
  return result.changes === 1;
}

/** Operator (or auto) cancel of an active batch. Idempotent: ok=false if not active. */
export function cancelManualBatch(id: string, dep: DbDep): { ok: boolean } {
  const result = dep.db
    .prepare(
      `UPDATE codex_cronoton_manual_batches
          SET status = 'cancelled', next_at = NULL, modified_at = ?
        WHERE id = ? AND status = 'active'`,
    )
    .run(new Date().toISOString(), id);
  return { ok: result.changes === 1 };
}
