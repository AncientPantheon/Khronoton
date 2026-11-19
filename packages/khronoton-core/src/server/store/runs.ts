/**
 * runs — the decision-free CRUD layer for `codex_cronoton_runs` +
 * `codex_cronoton_run_legs` (the RUNTIME state of a chained run, per
 * `docs/work/khronoton-chained-runs/design.md`'s Phase 1). No "is the
 * barrier met," "which legs are missing," or "has the deadline passed"
 * logic lives here — that's Phase 2's pure `advanceRun`, explicitly out of
 * scope for this layer.
 *
 * The self-blocking invariant (design §5.6) — a non-terminal run blocks a
 * NEW run of the SAME cronoton, but never a different one — is enforced by
 * `schema.ts`'s partial unique index
 * (`idx_codex_cronoton_runs_self_block ON codex_cronoton_runs(codex_cronoton_id)
 * WHERE status IN ('planning', 'awaiting', 'advancing')`), not by a
 * check-then-insert here. {@link createRun} lets the INSERT hit that index
 * directly — the racing-callers window is closed by the index itself, the
 * same posture `claim.ts`'s conditional UPDATE establishes for fires — and
 * catches the resulting UNIQUE-constraint `SqliteError` by code, re-throwing
 * the typed {@link RunAlreadyInFlightError} so no raw driver error escapes
 * the store layer.
 *
 * `markLegSubmitted`'s "never re-submit, only poll" invariant (design §5.3)
 * is enforced by a single conditional UPDATE (`WHERE status = 'pending'`)
 * that only a genuinely-pending leg can satisfy. A second attempt on an
 * already-submitted (or otherwise non-pending) leg matches zero rows and
 * throws {@link LegAlreadySubmittedError} instead of silently overwriting the
 * existing `request_key`.
 *
 * {@link claimLegForSubmit}/{@link releaseLegClaim} (Phase 5): a true
 * claim-BEFORE-submit step, now shared with `claim.ts`'s idiom — closing a
 * gap `markLegSubmitted` alone could not: `markLegSubmitted`'s guard runs
 * AFTER the real chain submission, so it only ever protected against a
 * SEQUENTIAL re-submission of a leg that already has a request key; it
 * could not stop two CONCURRENT callers from both reading the same
 * `pending` leg and both submitting to chain before either wrote
 * `markLegSubmitted`. `runs-driver.ts`'s `handleSubmitLeg` now calls
 * `claimLegForSubmit` immediately before the real network submit — exactly
 * one of any two concurrent callers racing the same leg can win that
 * conditional UPDATE, so at most one ever reaches the network call. This
 * was deferred during Phase 3 ("no such caller exists yet") until Phase 5's
 * `executeNow` fix made a genuine concurrent caller (an HTTP-triggered
 * `driveRunOnce` racing the background loop's own sweep) real.
 */
import { randomUUID } from "node:crypto";

import type { DbDep } from "../seams.js";
import {
  isUniqueConstraintError,
  LegAlreadySubmittedError,
  LegNotSubmittedError,
  RunAlreadyInFlightError,
  RunAlreadyTerminalError,
  RunLegAlreadyExistsError,
  RunStepMismatchError,
} from "./errors.js";

export interface CreateRunInput {
  codexCronotonId: string;
  stepCount: number;
  deadlineAt?: string;
  contextJson?: unknown;
}

export interface CodexCronotonRunRow {
  id: string;
  codex_cronoton_id: string;
  fire_id: string | null;
  status: "planning" | "awaiting" | "advancing" | "succeeded" | "failed" | "abandoned";
  step_index: number;
  step_count: number;
  started_at: string;
  modified_at: string;
  deadline_at: string | null;
  attempt: number;
  context_json: string | null;
}

export interface CodexCronotonRunLegRow {
  id: string;
  run_id: string;
  step_index: number;
  leg_index: number;
  status: "pending" | "submitted" | "confirmed" | "failed";
  request_key: string | null;
  chain_id: string | null;
  definition_json: string;
  error_message: string | null;
  submitted_at: string | null;
  confirmed_at: string | null;
  attempt: number;
  /** Set by {@link claimLegForSubmit} while a submit attempt is in flight;
   * cleared by {@link releaseLegClaim} on a failed submit so a later pass
   * can retry. `null` whenever no submit is currently in flight for this
   * leg (the common case). */
  claimed_at: string | null;
}


/**
 * Insert a new run row. Lets the partial unique self-block index
 * (`schema.ts`) be the actual enforcement: a racing/overlapping INSERT for a
 * cronoton that already has a non-terminal run throws a UNIQUE-constraint
 * `SqliteError`, caught here and re-thrown as the typed
 * {@link RunAlreadyInFlightError} — never a raw driver error.
 */
export function createRun(input: CreateRunInput, dep: DbDep): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    dep.db
      .prepare(
        `INSERT INTO codex_cronoton_runs
           (id, codex_cronoton_id, step_count, started_at, modified_at, deadline_at, context_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.codexCronotonId,
        input.stepCount,
        now,
        now,
        input.deadlineAt ?? null,
        input.contextJson !== undefined ? JSON.stringify(input.contextJson) : null,
      );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new RunAlreadyInFlightError(input.codexCronotonId);
    }
    throw error;
  }
  return id;
}

/** Read back one run row by id, or null if it doesn't exist. */
export function getRun(runId: string, dep: DbDep): CodexCronotonRunRow | null {
  const row = dep.db
    .prepare(`SELECT * FROM codex_cronoton_runs WHERE id = ?`)
    .get(runId) as CodexCronotonRunRow | undefined;
  return row ?? null;
}

/**
 * Every non-terminal run (`planning`/`awaiting`/`advancing`), ordered by
 * `modified_at` ascending — the read `advanceInFlightRunsOnce` polls every
 * pass to find which runs need driving forward. Uses the existing
 * `idx_codex_cronoton_runs_due` index (`schema.ts`), previously unused by
 * any store function.
 */
export function listInFlightRuns(dep: DbDep): CodexCronotonRunRow[] {
  return dep.db
    .prepare(
      `SELECT * FROM codex_cronoton_runs
        WHERE status IN ('planning', 'awaiting', 'advancing')
        ORDER BY modified_at ASC`,
    )
    .all() as CodexCronotonRunRow[];
}

/**
 * Paginated run history for a cronoton, newest-first by `started_at` —
 * mirrors `fires.ts`'s {@link listFires} exact pagination shape (`limit`
 * clamped to `[1,100]`, default `20`; `offset` clamped to `>=0`, default
 * `0`; a separate `COUNT(*)` query; `{rows, total}`-shaped return).
 */
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

/** Every leg for a run, ordered by (step_index, leg_index) ascending. */
export function listRunLegs(runId: string, dep: DbDep): CodexCronotonRunLegRow[] {
  return dep.db
    .prepare(
      `SELECT * FROM codex_cronoton_run_legs
        WHERE run_id = ?
        ORDER BY step_index ASC, leg_index ASC`,
    )
    .all(runId) as CodexCronotonRunLegRow[];
}

/**
 * Write a leg row in `status='pending'` with no `request_key` — the
 * write-before-submit discipline (design, mirroring `tick.ts`'s
 * claim-before-fire one level down): a leg must exist before its
 * transaction is ever submitted, never after.
 *
 * Lets the unique index on `(run_id, step_index, leg_index)` (`schema.ts`)
 * be the actual enforcement, mirroring `createRun`/`insertStep`: a duplicate
 * slot insert throws a UNIQUE-constraint `SqliteError`, caught here and
 * re-thrown as the typed {@link RunLegAlreadyExistsError} — never a raw
 * driver error escaping the store layer.
 */
export function insertRunLeg(
  input: {
    runId: string;
    stepIndex: number;
    legIndex: number;
    definitionJson: string;
    attempt?: number;
  },
  dep: DbDep,
): string {
  const id = randomUUID();
  try {
    dep.db
      .prepare(
        `INSERT INTO codex_cronoton_run_legs (id, run_id, step_index, leg_index, definition_json, attempt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.stepIndex,
        input.legIndex,
        input.definitionJson,
        input.attempt ?? 0,
      );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new RunLegAlreadyExistsError(input.runId, input.stepIndex, input.legIndex);
    }
    throw error;
  }
  return id;
}

/**
 * Claim a `pending` leg for submission, BEFORE the real chain call —
 * closing the concurrency gap `runs-driver.ts`'s `handleSubmitLeg` used to
 * defer (see its own doc comment history): the conditional `WHERE status =
 * 'pending' AND claimed_at IS NULL` is a true claim-before-submit step,
 * mirroring `claim.ts`'s `claimDueCodexCronoton` idiom one level down —
 * two concurrent callers racing the same `pending` leg can never BOTH win
 * this UPDATE, so at most one proceeds to the real network submit. Returns
 * `true` iff THIS call won the claim.
 *
 * KNOWN, ACCEPTED LIMITATION (not the same shape as `claimDueCodexCronoton`'s
 * one-shot claim — reviewed and deliberately left as a bounded tradeoff
 * rather than built out further here): this claim is a TWO-PHASE lease —
 * something must later call {@link markLegSubmitted} or
 * {@link releaseLegClaim} to make the leg claimable again. If the process
 * crashes (OOM-kill, hard restart) strictly between a won claim and either
 * of those two calls, the leg is stuck `pending` with `claimed_at` set
 * forever — `executeCodexTransaction`'s own documented "submit never
 * throws" contract (`executor.ts`) means no in-process `try`/`finally`
 * here could ever help (there is no exception to catch), and only a
 * genuine process-level crash reaches this window at all. The run still
 * recovers, just more slowly than before this fix: `advanceRun`'s
 * deadline-exceeded branch (`pure/run-advance.ts`) eventually re-plans
 * (bumping `attempt`, which excludes the orphaned leg from all future
 * barrier checks) or fails the run outright — bounded by
 * `RUN_STEP_DEADLINE_MS` (10 minutes by default) rather than "retry on the
 * very next pass" as it was before. The orphaned leg row itself is
 * permanently inert (never re-selected, never blocks anything else) —
 * harmless DB clutter, not a stuck run. A reconciliation sweep that frees
 * an expired claim before the full step deadline is a legitimate future
 * improvement, but is new recovery machinery deserving its own scoped
 * design, not a drive-by addition here (matching this file's own existing
 * "no retry-cap mechanism... an operator noticing is the backstop today"
 * posture for a different, pre-existing limitation).
 */
export function claimLegForSubmit(legId: string, claimedAt: string, dep: DbDep): boolean {
  const result = dep.db
    .prepare(
      `UPDATE codex_cronoton_run_legs
          SET claimed_at = ?
        WHERE id = ? AND status = 'pending' AND claimed_at IS NULL`,
    )
    .run(claimedAt, legId);
  return result.changes === 1;
}

/**
 * Release a claim taken by {@link claimLegForSubmit} after a submit attempt
 * that did NOT land (so the leg stays `pending` for a later pass to retry —
 * the existing "no retry-cap mechanism" posture, unchanged). Unconditional:
 * the caller already knows it won the claim it's releasing, so there is no
 * race to guard against here (only the claim ACQUISITION needs the
 * conditional guard above). See {@link claimLegForSubmit}'s own doc for the
 * one known gap this does NOT cover: a process crash between the claim and
 * this call (or `markLegSubmitted`) leaves exactly one permanently-orphaned
 * `pending`+`claimed_at`-set leg row per occurrence — harmless, never
 * cleaned up by this function, by design (nothing calls this except the
 * normal submit-failure path).
 */
export function releaseLegClaim(legId: string, dep: DbDep): void {
  dep.db.prepare(`UPDATE codex_cronoton_run_legs SET claimed_at = NULL WHERE id = ?`).run(legId);
}

/**
 * Flip a `pending` leg to `submitted`, stamping `request_key`/`chain_id`/
 * `submitted_at`. The conditional `WHERE status = 'pending'` is the
 * enforcement for "never re-submit, only poll": a leg that's already
 * `submitted` (or further along) matches zero rows, so a second call throws
 * {@link LegAlreadySubmittedError} instead of overwriting the existing key.
 * Does NOT clear `claimed_at` — once `status` leaves `'pending'`,
 * `claimLegForSubmit`'s own `WHERE status = 'pending'` guard already makes
 * `claimed_at` irrelevant for this leg forever (a non-pending leg can never
 * be claimed again), so there is nothing left to clean up.
 */
export function markLegSubmitted(
  legId: string,
  input: { requestKey: string; chainId: string },
  dep: DbDep,
): void {
  const result = dep.db
    .prepare(
      `UPDATE codex_cronoton_run_legs
          SET status = 'submitted', request_key = ?, chain_id = ?, submitted_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(input.requestKey, input.chainId, new Date().toISOString(), legId);
  if (result.changes !== 1) {
    throw new LegAlreadySubmittedError(legId);
  }
}

/**
 * Flip a `submitted` leg to its `confirmed` terminal status, stamping
 * `confirmed_at`. The conditional `WHERE status = 'submitted'` is the
 * enforcement, mirroring `markLegSubmitted`'s own guard one level up: a leg
 * that was never submitted (still `pending`) or is already terminal
 * (`confirmed`/`failed`) cannot be silently flipped — a leg that never
 * reached the chain must never be treated as "funds moved," and an
 * already-terminal leg must never be overwritten.
 */
export function markLegConfirmed(legId: string, dep: DbDep): void {
  const result = dep.db
    .prepare(
      `UPDATE codex_cronoton_run_legs
          SET status = 'confirmed', confirmed_at = ?
        WHERE id = ? AND status = 'submitted'`,
    )
    .run(new Date().toISOString(), legId);
  if (result.changes !== 1) {
    throw new LegNotSubmittedError(legId);
  }
}

/**
 * Flip a `submitted` leg to its `failed` terminal status, stamping
 * `error_message`. Same guard as {@link markLegConfirmed} — a leg that was
 * never submitted or is already terminal cannot be silently flipped (in
 * particular, an already-`confirmed` leg can never be overwritten back to
 * `failed`, which would otherwise invite a caller to re-submit a leg whose
 * first attempt already landed on-chain).
 */
export function markLegFailed(
  legId: string,
  input: { errorMessage: string },
  dep: DbDep,
): void {
  const result = dep.db
    .prepare(
      `UPDATE codex_cronoton_run_legs
          SET status = 'failed', error_message = ?
        WHERE id = ? AND status = 'submitted'`,
    )
    .run(input.errorMessage, legId);
  if (result.changes !== 1) {
    throw new LegNotSubmittedError(legId);
  }
}

/**
 * Move a run from `fromStepIndex` to `toStepIndex`, resetting `attempt` to 0
 * and stamping a new `deadline_at`/`modified_at`. The trailing `WHERE ... AND
 * step_index = ?` is an optimistic-concurrency guard, mirroring
 * `markLegSubmitted`'s conditional-UPDATE-as-the-guard idiom one level up: if
 * another process already moved this run's step, this call's precondition is
 * stale and must fail loudly rather than overwrite it.
 *
 * Doubles as both "really advance to the next step" (`toStepIndex ===
 * fromStepIndex + 1`) and "stamp this step's first deadline without moving
 * it" (`toStepIndex === fromStepIndex`, used when a step's leg is first
 * planned) — one function, two callers, same guard.
 */
export function advanceRunStep(
  runId: string,
  input: { fromStepIndex: number; toStepIndex: number; deadlineAt: string | null },
  dep: DbDep,
): void {
  const result = dep.db
    .prepare(
      `UPDATE codex_cronoton_runs
          SET step_index = ?, attempt = 0, deadline_at = ?, modified_at = ?
        WHERE id = ? AND step_index = ?`,
    )
    .run(
      input.toStepIndex,
      input.deadlineAt,
      new Date().toISOString(),
      runId,
      input.fromStepIndex,
    );
  if (result.changes !== 1) {
    throw new RunStepMismatchError(runId, input.fromStepIndex);
  }
}

/**
 * Increment a run's `attempt` by one, stamping `modified_at`. Unconditional —
 * no precondition — incrementing is commutative regardless of caller
 * ordering, so there is no stale-view case to guard against the way
 * {@link advanceRunStep}'s `WHERE step_index = ?` must. This is the Phase-3
 * design anticipated (and correctly deferred, since nothing exercised it
 * yet — see `docs/work/khronoton-chained-runs-phase-3/design.md`'s §G): a
 * genuine re-plan (a `canReplan:true` step whose leg actually fails) bumps
 * `attempt` here INSTEAD OF going through `advanceRunStep`, specifically to
 * avoid `advanceRunStep`'s own unconditional `attempt = 0` reset undoing the
 * bump on every single re-plan.
 */
export function bumpRunAttempt(runId: string, dep: DbDep): void {
  dep.db
    .prepare(
      `UPDATE codex_cronoton_runs SET attempt = attempt + 1, modified_at = ? WHERE id = ?`,
    )
    .run(new Date().toISOString(), runId);
}

/**
 * Stamp a fresh `deadline_at`/`modified_at`, touching NOTHING else — in
 * particular, never `attempt` or `step_index`. Narrower than
 * {@link advanceRunStep} on purpose: `advanceRunStep` unconditionally resets
 * `attempt` to `0` as part of its contract, which is correct for a real
 * step-advance or a step's very first deadline stamp (`attempt` is already
 * `0` in both those cases) but WRONG immediately after {@link bumpRunAttempt}
 * has just incremented `attempt` for a genuine re-plan — calling
 * `advanceRunStep` there would silently reset the bump back to `0` on every
 * re-plan, making `replanOrFail`'s `attempt < maxReplanAttempts` check
 * permanently true and turning `maxReplanAttempts` into dead config (an
 * infinite retry loop with no error ever surfacing). No optimistic-
 * concurrency guard is needed here (unlike `advanceRunStep`'s
 * `WHERE step_index = ?`): this function never touches `step_index`, so
 * there is no stale-precondition case to guard against.
 */
export function touchRunDeadline(runId: string, deadlineAt: string | null, dep: DbDep): void {
  dep.db
    .prepare(
      `UPDATE codex_cronoton_runs SET deadline_at = ?, modified_at = ? WHERE id = ?`,
    )
    .run(deadlineAt, new Date().toISOString(), runId);
}

/**
 * Flip a non-terminal run to one of its terminal statuses
 * (`succeeded`/`failed`/`abandoned`), stamping `modified_at`. The conditional
 * `WHERE status NOT IN (...)` is the enforcement, mirroring
 * `markLegConfirmed`/`markLegFailed`'s own terminal guard one level down: a
 * run that's already terminal cannot be silently overwritten.
 */
export function markRunTerminal(
  runId: string,
  status: "succeeded" | "failed" | "abandoned",
  dep: DbDep,
): void {
  const result = dep.db
    .prepare(
      `UPDATE codex_cronoton_runs
          SET status = ?, modified_at = ?
        WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'abandoned')`,
    )
    .run(status, new Date().toISOString(), runId);
  if (result.changes !== 1) {
    throw new RunAlreadyTerminalError(runId);
  }
}
