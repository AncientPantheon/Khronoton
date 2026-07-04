/**
 * tick — the pure, injectable single-tick engine for
 * @ancientpantheon/khronoton-core.
 *
 * Public surface:
 *   - TickRow / TickResult / TickDeps
 *   - tickOnce(now, deps): TickResult
 *
 * Contract (generalized from the AncientHoldings hub's lib/cronoton-tick.ts —
 * the three host couplings are inverted into injected hooks, every operational
 * invariant preserved):
 *   - THREE injected hooks carry all host coupling:
 *       loadDue(now)                       -> the due-rows read
 *       enqueueFire(row)                   -> the fire dispatch (queue/audit)
 *       persistNextFire(id, nextDate, at)  -> the durable next-fire advance
 *     The engine itself touches no storage, queue, clock, or framework.
 *   - ENQUEUE STRICTLY BEFORE PERSIST, and persist runs ONLY after enqueue
 *     succeeds: the fire is dispatched first, then the advance is durably
 *     recorded, so a crash between the two re-fires the row (never silently
 *     drops it).
 *   - firedIds = both-hooks-succeeded ONLY. A row lands in firedIds only when
 *     enqueueFire AND persistNextFire both returned without throwing; every
 *     other processed outcome lands in skippedIds. The two sets are disjoint
 *     and together cover exactly the processed rows.
 *   - PER-ROW ISOLATION: each row is processed inside its own try; a single
 *     bad row (unparseable config, computeNextFire rejection, a throwing
 *     hook) is logged and skipped, and the tick continues to the next row.
 *   - BATCH CAP: at most `maxBatch` rows (default 100) are processed per tick,
 *     regardless of how many loadDue returns. Overflow rows appear in NEITHER
 *     result set — they were never processed and stay due for the next tick.
 *   - SPENT ONE-TIME -> SKIPPED, NOT AN ERROR: when computeNextFire yields
 *     null (a terminal schedule with no future fire), the row is skipped
 *     without enqueue, persist, or a log — it is a valid terminal outcome.
 *   - firedAt IS THE TICK'S EXPLICIT `now`: persistNextFire's third argument
 *     is always the `now` passed to tickOnce, never a clock read — the engine
 *     performs no Date.now().
 *   - RESTART-SAFE: the engine holds no in-memory timers and carries no state
 *     across calls; the host re-reads due state (via loadDue) each tick.
 *
 * HOST PRECONDITIONS (the host, not the engine, must uphold these):
 *   1. The three hooks MUST be synchronous. TypeScript's `=> void` contextual
 *      typing silently accepts an `async` hook, but its returned Promise is
 *      neither awaited nor error-handled here — an async hook voids the
 *      enqueue-before-persist ordering and the per-row-isolation guarantees.
 *      Async hosts are a future, separate additive API, not this engine.
 *   2. loadDue MUST return at most one row per id. The fired/skipped
 *      disjoint-set semantics assume unique ids; behavior under duplicate ids
 *      is unspecified.
 */
import { computeNextFire, type ScheduleConfig, type ScheduleMode } from "./schedule.js";

export type TickRow = {
  id: string;
  mode: ScheduleMode;
  config: ScheduleConfig | string;
};

export type TickResult = {
  firedIds: string[];
  skippedIds: string[];
};

export type TickDeps<TRow extends TickRow = TickRow> = {
  loadDue: (now: Date) => TRow[];
  enqueueFire: (row: TRow) => void;
  persistNextFire: (id: string, nextDate: Date, firedAt: Date) => void;
  maxBatch?: number;
  logError?: (message: string) => void;
};

/** Cap the per-tick batch so a coincidence storm can't run forever. */
const DEFAULT_MAX_BATCH = 100;

export function tickOnce<TRow extends TickRow>(now: Date, deps: TickDeps<TRow>): TickResult {
  if (deps.maxBatch !== undefined && (!Number.isInteger(deps.maxBatch) || deps.maxBatch <= 0)) {
    throw new RangeError(
      `[khronoton] maxBatch must be a positive integer, got ${deps.maxBatch}`,
    );
  }

  const cap = deps.maxBatch ?? DEFAULT_MAX_BATCH;
  const logError = deps.logError ?? ((message: string) => console.error(message));

  const firedIds: string[] = [];
  const skippedIds: string[] = [];

  const due = deps.loadDue(now).slice(0, cap);

  for (const row of due) {
    try {
      const config: ScheduleConfig =
        typeof row.config === "string" ? (JSON.parse(row.config) as ScheduleConfig) : row.config;
      const nextDate = computeNextFire(row.mode, config, now);
      if (!nextDate) {
        skippedIds.push(row.id);
        continue;
      }
      deps.enqueueFire(row);
      deps.persistNextFire(row.id, nextDate, now);
      firedIds.push(row.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[khronoton] tick skipping ${row.id}: ${msg}`);
      skippedIds.push(row.id);
    }
  }

  return { firedIds, skippedIds };
}
