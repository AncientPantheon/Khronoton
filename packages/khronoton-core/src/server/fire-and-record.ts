/**
 * The shared fire -> record -> finalize -> audit sequence for firing a
 * loaded cronoton row's own definition inline through the dispatcher — "fire
 * one transaction, write exactly one fire row, apply the one-time terminal
 * transition." `handlers/execute.ts`'s on-demand fire (`executeNow`/
 * `triggerCronoton`) and `single-tx.ts`'s single-tx-first attempt both need
 * this identically.
 *
 * A review finding caught the two independently re-deriving this exact
 * sequence by hand (`single-tx.ts`'s own module doc used to admit as much).
 * A third, pre-existing, MORE divergent inline copy already lived in
 * `tick.ts` before this feature (it also collects `txKeys` for the
 * scheduler's multi-tx dispatch path and carries a few extra audit-detail
 * fields) — deliberately left alone here: unifying that one too is a larger,
 * separate refactor the finding that prompted this extraction never asked
 * for.
 *
 * Split into two layers rather than one all-in-one function: `single-tx.ts`
 * needs to inspect the fire `FireResult` itself (specifically
 * `result.postponed` — see that field's own doc comment) BEFORE deciding
 * whether to record/finalize/audit anything at all, so it cannot call an
 * all-in-one "fire-then-record" helper. {@link recordAndFinalizeFire} is the
 * shared record+finalize+audit half, taking an ALREADY-obtained result;
 * {@link fireAndRecord} is the full convenience (fire, then delegate to
 * {@link recordAndFinalizeFire}) for the common case that needs no
 * interception between the two.
 */
import { fireByServerResolver } from "./resolvers.js";
import { recordFire } from "./store/fires.js";
import { applyTerminalIntent } from "./store/claim.js";
import { computeDefinitionFingerprint } from "./pure/fingerprint.js";
import type { ChainRuntime, Config, Database, KeyResolver, OnAudit, ResolveFireMode } from "./seams.js";
import type { CodexCronotonRow, CodexTxDefinition, FireResult } from "./types.js";

/**
 * The injected context this function runs against — a structural subset
 * `HandlerContext`/`RunsDriverCtx`/`SingleTxAttemptCtx` all already satisfy,
 * so every existing caller passes its own `ctx` straight through with no
 * adaptation.
 */
export interface FireAndRecordCtx {
  db: Database;
  runtime: ChainRuntime;
  resolver: KeyResolver;
  config?: Partial<Config>;
  resolveFireMode?: ResolveFireMode;
  onAudit?: OnAudit;
}

export interface FireAndRecordExtras {
  /** Audit action-name pair; defaults to the ordinary one-shot fire names
   *  (`codex_cronoton.fire`/`.fire_failed`) every pre-existing caller relies on. */
  auditAction?: { success: string; failure: string };
  /** Extra fields merged into the audit event's `detail` (e.g. `actor`). */
  auditDetailExtra?: Record<string, unknown>;
}

/**
 * Record exactly one fire row for an ALREADY-obtained `result`, apply the
 * one-time terminal transition, and audit — the record+finalize+audit half
 * of the sequence, shared by both {@link fireAndRecord} and any caller (like
 * `single-tx.ts`) that needs to inspect `result` itself before reaching
 * this point.
 */
export async function recordAndFinalizeFire(
  result: FireResult,
  ctx: FireAndRecordCtx,
  row: CodexCronotonRow,
  definition: CodexTxDefinition,
  extras: FireAndRecordExtras = {},
): Promise<{ result: FireResult; fireId: string }> {
  const fingerprint = computeDefinitionFingerprint(row);
  const fireId = recordFire(
    {
      codexCronotonId: row.id,
      jobId: null,
      firedAt: new Date().toISOString(),
      status: result.ok ? "success" : "failure",
      requestKey: result.requestKey,
      chainId: result.chainId,
      errorMessage: result.error,
      chainResponse: result.rawResult,
      definitionFingerprint: fingerprint,
    },
    { db: ctx.db, resolveFireMode: ctx.resolveFireMode },
  );

  if ((definition.scheduleKind ?? "recurring") === "one-time") {
    applyTerminalIntent(row.id, result.terminalIntent, { db: ctx.db });
  }

  const { success, failure } = extras.auditAction ?? {
    success: "codex_cronoton.fire",
    failure: "codex_cronoton.fire_failed",
  };
  await ctx.onAudit?.({
    action: result.ok ? success : failure,
    result: result.ok ? "success" : "failure",
    targetKind: "codex_cronoton",
    targetId: row.id,
    detail: {
      codexCronotonId: row.id,
      fireId,
      requestKey: result.requestKey,
      chainId: result.chainId,
      definitionFingerprint: fingerprint,
      errorMessage: result.error,
      ...extras.auditDetailExtra,
    },
  });

  return { result, fireId };
}

/**
 * Fire `definition` for `row` through the shared dispatcher, then record +
 * finalize + audit via {@link recordAndFinalizeFire}. The convenience
 * all-in-one entry point for every caller that doesn't need to inspect the
 * `FireResult` before deciding whether to record it.
 */
export async function fireAndRecord(
  ctx: FireAndRecordCtx,
  row: CodexCronotonRow,
  definition: CodexTxDefinition,
  extras: FireAndRecordExtras = {},
): Promise<{ result: FireResult; fireId: string }> {
  const result = await fireByServerResolver(definition, row, ctx);
  return recordAndFinalizeFire(result, ctx, row, definition, extras);
}
