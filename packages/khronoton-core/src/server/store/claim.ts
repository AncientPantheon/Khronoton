/**
 * claim — due selection, the atomic claim-before-fire, and the terminal/advance
 * writes for `codex_cronotons`.
 *
 * The CENTERPIECE is {@link claimDueCodexCronoton}: a single conditional UPDATE
 * that advances (recurring) or clears (one-time) `next_fire_at` BEFORE the
 * caller fires, so the row is no longer due/re-selectable the instant the claim
 * commits. The WHERE clause re-asserts the due predicate so two racing claimers
 * see exactly one win — this is where the exactly-once guarantee lives.
 *
 * Schedule math is imported, never reimplemented: {@link computeNextFire} is
 * called at a FRESH `now` inside the recurring branch, wrapped so a corrupt
 * `schedule_config_json` clears `next_fire_at` (stopping re-selection) rather
 * than throwing uncaught.
 */
import type { CodexCronotonRow, TerminalIntent } from "../types.js";
import type { DbDep } from "../seams.js";
import { TICK_BATCH_LIMIT } from "../seams.js";
import {
  computeNextFire,
  type ScheduleConfig,
} from "../../schedule.js";

// ── Terminal / advance writes ────────────────────────────────────────────────

/**
 * Write the computed terminal intent: non-null → status + clear next_fire_at;
 * null → no-op (recurring). The executor owns the COMPUTE; the store owns the
 * WRITE.
 */
export function applyTerminalIntent(
  id: string,
  terminalIntent: TerminalIntent | null,
  dep: DbDep,
): void {
  if (terminalIntent == null) return;
  dep.db
    .prepare(
      `UPDATE codex_cronotons SET status = ?, next_fire_at = NULL, modified_at = ? WHERE id = ?`,
    )
    .run(terminalIntent.status, new Date().toISOString(), id);
}

/** Recurring counterpart of applyTerminalIntent — advance next_fire_at + last_fire_at. */
export function advanceRecurring(
  id: string,
  nextDate: Date,
  firedAt: Date,
  dep: DbDep,
): void {
  const now = new Date().toISOString();
  dep.db
    .prepare(
      `UPDATE codex_cronotons SET next_fire_at = ?, last_fire_at = ?, modified_at = ? WHERE id = ?`,
    )
    .run(nextDate.toISOString(), firedAt.toISOString(), now, id);
}

// ── Due selection + atomic claim ─────────────────────────────────────────────

/**
 * Candidate due rows for the tick: active, with a non-null next_fire_at at or
 * before `now`, oldest-first, capped at the batch limit. Each candidate must
 * still be CLAIMED (claimDueCodexCronoton) before firing.
 *
 * EXCLUDES runtime-arg cronotons (`runtime_arg_keys IS NOT NULL`): their tx
 * needs trigger-supplied string args, so the scheduler must never auto-fire
 * them (a fire without the args would fail). They stay `active` so an external
 * trigger endpoint can fire them WITH args; the scheduler simply skips them.
 */
export function fetchDueCodexCronotons(
  now: Date,
  limit: number = TICK_BATCH_LIMIT,
  dep: DbDep,
): CodexCronotonRow[] {
  return dep.db
    .prepare(
      `SELECT * FROM codex_cronotons
        WHERE status = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ?
          AND runtime_arg_keys IS NULL
        ORDER BY next_fire_at ASC LIMIT ?`,
    )
    .all(now.toISOString(), limit) as CodexCronotonRow[];
}

/**
 * The atomic claim that closes the double-fire window. A single conditional
 * UPDATE advances (recurring) or clears (one-time) `next_fire_at` BEFORE the
 * caller's inline fire, so the row is no longer due/re-selectable the instant
 * the claim commits. The caller fires ONLY when this returns `true`
 * (changes === 1); `false` means another overlapping tick or a manual
 * Execute-Now already claimed the row — skip it (no fire).
 *
 * Branch selection:
 *   - RECURRING → SET next_fire_at = computeNextFire(mode, config, now) at the
 *     FRESH `now` (avoids stale-now drift). The recurring row stays active with
 *     its advanced next-fire.
 *   - ONE-TIME → SET next_fire_at = NULL (un-re-selectable); the caller applies
 *     the terminal intent after the fire.
 *   - RECURRING whose computeNextFire returns null or throws mid-life (corrupt
 *     schedule_config_json) → SET next_fire_at = NULL so it stops re-selecting.
 *     A corrupt-config row cannot both stay-active AND not-fire-storm.
 *
 * The WHERE clause re-asserts the due predicate (status='active' AND
 * next_fire_at IS NOT NULL AND next_fire_at <= now) so two racing claimers see
 * exactly one win.
 */
export function claimDueCodexCronoton(
  row: CodexCronotonRow,
  now: Date,
  dep: DbDep,
): boolean {
  const db = dep.db;
  const nowIso = now.toISOString();

  let computedNextIso: string | null;
  if (row.schedule_mode === "one-time") {
    computedNextIso = null;
  } else {
    // Recurring: compute the next fire at the fresh `now`. A null (or a corrupt
    // config that throws JSON.parse/computeNextFire) means clear next_fire_at so
    // the row stops re-selecting. The parse MUST stay inside the try so a corrupt
    // config is routed to the NULL branch, never thrown uncaught.
    let next: Date | null = null;
    try {
      next = computeNextFire(
        row.schedule_mode,
        JSON.parse(row.schedule_config_json) as ScheduleConfig,
        now,
      );
    } catch {
      next = null;
    }
    computedNextIso = next ? next.toISOString() : null;
  }

  // Literal `next_fire_at = NULL` for one-time + corrupt-recurring so the issued
  // SQL self-documents the clear; a parameterized `= ?` for the recurring
  // advance. The WHERE clause re-asserts the due predicate either way.
  const whereDue =
    `WHERE id = ? AND status = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ?`;
  const result =
    computedNextIso === null
      ? db
          .prepare(
            `UPDATE codex_cronotons SET next_fire_at = NULL, last_fire_at = ?, modified_at = ? ${whereDue}`,
          )
          .run(nowIso, nowIso, row.id, nowIso)
      : db
          .prepare(
            `UPDATE codex_cronotons SET next_fire_at = ?, last_fire_at = ?, modified_at = ? ${whereDue}`,
          )
          .run(computedNextIso, nowIso, nowIso, row.id, nowIso);

  return result.changes === 1;
}
