/**
 * The shared "try single-tx first" decision helper — see
 * `docs/work/khronoton-single-tx-custom/design.md`.
 *
 * At the exact point a chained row's work would normally begin (`tick.ts`'s
 * due-row branch, `handlers/execute.ts`'s `executeNow` manual-trigger
 * branch), the caller consults {@link attemptSingleTxFirst} ahead of its own
 * existing chained/plain decision. This module owns ONLY that decision —
 * never the chained/plain branch itself, which stays each caller's own.
 *
 * Decision shape (mirrors `ouronet.aqp-evict`'s own established
 * try-then-fan-out precedent — the identical "refuse unmineable" signal, one
 * level down):
 *   - `try_single_tx_first` off -> `{ fired: false }` immediately, no
 *     simulate call at all (the ONLY branch allowed to skip simulating).
 *   - simulate fits under the gas ceiling -> fire via `fireByServerResolver`,
 *     then record+finalize+audit via the SAME shared `recordAndFinalizeFire`
 *     helper (`./fire-and-record.js`) `handlers/execute.ts`'s own fire path
 *     uses — not a parallel reimplementation (a prior version of this
 *     module hand-copied that exact sequence; a review finding closed that
 *     drift risk by extracting the shared helper).
 *   - simulate refused SPECIFICALLY for being too expensive (a numeric
 *     `gasUsed` on an `{ ok: false }` simulate result — the executor's own
 *     refuse-unmineable signal) -> `{ fired: false }` with NO fire record
 *     written at all; the caller alone decides what happens next (fall
 *     through to its own chained/plain path).
 *   - any OTHER simulate failure (a genuine, non-gas Pact error) -> throws,
 *     never silently treated as "doesn't fit."
 *   - `row.server_resolver` registered as a MULTI-TX orchestrator ->
 *     `{ fired: false }` BEFORE simulating or firing at all, never reaching
 *     `fireByServerResolver` — that dispatcher awaits a multi-tx
 *     orchestrator's entire run inline, which is exactly what
 *     `handlers/execute.ts`'s own plain-fire branch refuses to do for every
 *     other row (REQ-H06: queued 202, never fired inline). A review finding
 *     caught that this function had no equivalent guard.
 *   - otherwise, `row.server_resolver` routes the fire through
 *     `fireByServerResolver`'s single-tx path, which runs its OWN
 *     safety-guard simulate (a different, merged payload) and postpones
 *     (never submits) on failure or an over-budget gas guard -> `{ fired:
 *     false }` with NO fire record written, exactly like the gas-refusal
 *     case above. Detected via `FireResult.postponed` (see that field's own
 *     doc comment) — a review finding caught that this result is otherwise
 *     structurally indistinguishable from a genuine on-chain fire failure,
 *     and recording it as one would permanently orphan a one-time row.
 *   - the single-tx variant is actually fired and then genuinely fails for
 *     real (a true on-chain revert, not a gas issue) -> recorded as a failed
 *     fire, same as any plain one-shot cronoton's fire failure; `fired: true`
 *     still, so the caller never falls back to the chain at this point (Pact
 *     transactions are atomic — no partial state to recover from).
 */
import { executeCodexTransaction } from "./executor.js";
import { fireByServerResolver, getServerResolver } from "./resolvers.js";
import { rowToDefinition } from "./store/mappers.js";
import { recordAndFinalizeFire, type FireAndRecordCtx, type FireAndRecordExtras } from "./fire-and-record.js";
import type { CodexCronotonRow, FireResult } from "./types.js";

/** Distinct from the ordinary one-shot fire path's own
 *  `codex_cronoton.fire`/`.fire_failed`, so an operator reading the audit
 *  log can tell a single-tx attempt apart from an ordinary one-shot fire or
 *  a chained run start. */
const SINGLE_TX_AUDIT_ACTION = {
  success: "codex_cronoton.single_tx.fire",
  failure: "codex_cronoton.single_tx.fire_failed",
};

/**
 * The injected context `attemptSingleTxFirst` runs against. Reuses
 * `fire-and-record.ts`'s own `FireAndRecordCtx` verbatim (same
 * `db`/`runtime`/`resolver`/`config`/`resolveFireMode`/`onAudit` shape this
 * function needs to pass straight through to `recordAndFinalizeFire`) rather
 * than re-declaring an identical interface — a review finding caught the two
 * independently drifting apart. A real `TickCtx` (or `executeNow`'s own ad
 * hoc ctx) satisfies this alias already, with no adaptation needed at either
 * call site.
 */
export type SingleTxAttemptCtx = FireAndRecordCtx;

/** The outcome of one single-tx-first attempt. */
export interface SingleTxAttemptResult {
  /**
   * `false` means "did not fire" — the flag is off, the simulate was
   * refused specifically for being too expensive, or a server-resolver
   * postponed the fire without ever submitting it (see `FireResult.
   * postponed`); in every case the caller falls through to its own
   * existing chained/plain decision. `true` means the single-tx variant
   * was actually fired (successfully or not) — the caller must NOT fall
   * back to the chain.
   */
  fired: boolean;
  result?: FireResult;
  fireId?: string;
}

/**
 * Decide — and, when it fits, fire — a row's single-tx-first variant. See the
 * module doc above for the full decision shape.
 *
 * `extras.auditDetailExtra` (e.g. `{ actor: "scheduler" }`/`{ actor:
 * "ancient" }`) is merged into the resulting `codex_cronoton.single_tx.fire`/
 * `.fire_failed` audit event's detail, exactly like `fire-and-record.ts`'s
 * own `fireAndRecord`/every other fire path's audit event already does. A
 * review finding caught this function silently dropping that attribution —
 * every OTHER fire path (`tick.ts`'s plain-fire/chained-run branches,
 * `handlers/execute.ts`'s `fireAndRecord` wrapper) tags its audit event with
 * `actor: "scheduler"` or `actor: "ancient"`, but a single-tx-first fire's
 * audit event carried no such field at all, regardless of which trigger
 * caused it.
 */
export async function attemptSingleTxFirst(
  row: CodexCronotonRow,
  ctx: SingleTxAttemptCtx,
  extras: Pick<FireAndRecordExtras, "auditDetailExtra"> = {},
): Promise<SingleTxAttemptResult> {
  if (!row.try_single_tx_first) return { fired: false };

  // A row's `server_resolver` can be registered as a multi-tx orchestrator
  // (fanning out to many on-chain transactions, dispatched asynchronously).
  // `fireByServerResolver` awaits that orchestrator's ENTIRE run inline —
  // exactly what `handlers/execute.ts`'s own plain-fire branch explicitly
  // refuses to do for every other row (REQ-H06: queued 202, never fired
  // inline). A review finding caught that this function had no equivalent
  // guard, so a `try_single_tx_first=1` row bound to a multi-tx resolver
  // would synchronously await the orchestrator on both the scheduler tick
  // and the manual-trigger endpoint, bypassing that invariant entirely and
  // losing the multi-tx `txKeys` breakdown `recordAndFinalizeFire` never
  // threads through. Treat this exactly like a gas-refusal: no fire record,
  // caller falls through to its own existing chained/plain/queued decision.
  if (row.server_resolver && getServerResolver(row.server_resolver)?.kind === "multi-tx") {
    return { fired: false };
  }

  const definition = rowToDefinition(row);
  const sim = await executeCodexTransaction(definition, "simulate", {
    runtime: ctx.runtime,
    resolver: ctx.resolver,
    config: ctx.config,
  });

  if (!sim.ok) {
    if (typeof sim.gasUsed === "number") {
      // Refused specifically for being too expensive — the executor's own
      // refuse-unmineable signal. No fire record written; the caller alone
      // decides what happens next (fall through to the chained path).
      return { fired: false };
    }
    // A genuine, non-gas simulate failure — propagate as a real error, never
    // silently treated as "doesn't fit."
    throw new Error(sim.error ?? "single-tx simulate failed");
  }

  // Fits — fire via the exact same plain one-shot dispatcher
  // `fire-and-record.ts`'s own `fireAndRecord` uses (`ctx` already carries
  // every field `fireByServerResolver`'s opts need structurally, so no
  // separate translation object here either).
  const result = await fireByServerResolver(definition, row, ctx);

  if (result.postponed) {
    // A review finding caught this: `row.server_resolver` can route a
    // single-tx-first row through `fireWithServerResolver`'s OWN
    // safety-guard simulate (a different, merged payload than the one this
    // function already simulated above) or its single-tx gas guard — either
    // can postpone (never submit to chain at all) with an `{ ok: false,
    // terminalIntent: null }` result that is otherwise indistinguishable
    // from a genuine on-chain fire failure. Recording that as a "failure"
    // fire (as the code below does for a REAL failure) would permanently
    // orphan a one-time row: the claim already cleared `next_fire_at`
    // before this attempt ran, `applyTerminalIntent(row.id, null, ...)` is
    // a documented no-op, and the row would never be reselected by the
    // scheduler again. Treat it exactly like this function's OWN
    // gas-refusal case instead — no fire record, caller falls through.
    return { fired: false };
  }

  // Record + finalize + audit via the SAME shared helper
  // `handlers/execute.ts`'s own fire path uses — not a parallel
  // reimplementation (a review finding caught this module hand-copying that
  // exact sequence).
  const { fireId } = await recordAndFinalizeFire(result, ctx, row, definition, {
    auditAction: SINGLE_TX_AUDIT_ACTION,
    auditDetailExtra: extras.auditDetailExtra,
  });

  return { fired: true, result, fireId };
}
