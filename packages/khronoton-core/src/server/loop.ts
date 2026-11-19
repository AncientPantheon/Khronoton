/**
 * The single-instance loop driver — `startKhronotonLoop`.
 *
 * A `setInterval` at `config.tickIntervalMs` whose handler runs ONE tick pass
 * ({@link codexCronotonTickOnce} then {@link processDueManualBatchesOnce} then
 * {@link advanceInFlightRunsOnce}), guarded by a single closure boolean so a
 * slow, multi-minute inline fire can NEVER have a second overlapping pass
 * launched on top of it. This is the in-process re-entrancy guard (REQ-32);
 * it is NOT leader election and NOT a multi-worker lease — the per-row atomic
 * claim inside the tick remains the primary double-fire guard, and
 * coordinating multiple hosts is the consumer's concern.
 *
 * The three pass fns are injectable via `opts` purely for unit-testing the
 * driver without a real DB; production callers pass only `ctx` and get the
 * real Phase-4 tick fns. A pass that throws is surfaced (not rethrown) so one
 * bad tick cannot kill the interval, and the `finally` always releases the
 * guard.
 */

import {
  codexCronotonTickOnce,
  processDueManualBatchesOnce,
} from "./tick.js";
import type { TickCtx } from "./tick.js";
import { advanceInFlightRunsOnce } from "./runs-driver.js";

/** Fallback cadence when `ctx.config.tickIntervalMs` is absent (30s). */
const DEFAULT_TICK_INTERVAL_MS = 30_000;

/**
 * Test/override seam: inject stand-ins for the three pass fns. All three
 * default to the real Phase-4/Phase-3 exports, so a production caller
 * supplies none.
 */
export interface KhronotonLoopOpts {
  runTick?: typeof codexCronotonTickOnce;
  runManualBatch?: typeof processDueManualBatchesOnce;
  runAdvance?: typeof advanceInFlightRunsOnce;
}

/** The started-loop handle: `stop()` clears the interval and is idempotent. */
export interface KhronotonLoopHandle {
  stop(): void;
}

/**
 * Start the automaton loop against `ctx`. Returns a handle whose `stop()` clears
 * the interval.
 */
export function startKhronotonLoop(
  ctx: TickCtx,
  opts?: KhronotonLoopOpts,
): KhronotonLoopHandle {
  const runTick = opts?.runTick ?? codexCronotonTickOnce;
  const runManualBatch = opts?.runManualBatch ?? processDueManualBatchesOnce;
  const runAdvance = opts?.runAdvance ?? advanceInFlightRunsOnce;

  let running = false;

  const handle = setInterval(async () => {
    // A prior pass is still in flight — do NOT stack an overlapping pass.
    if (running) return;
    running = true;
    try {
      const tickResult = await runTick(new Date(), ctx);
      await runManualBatch(new Date(), ctx);
      // Exclude any run codexCronotonTickOnce already drove inline this same
      // pass (design.md §B) — without this, a freshly created run would be
      // driven (and its submitted leg polled) TWICE in one loop callback.
      await runAdvance(new Date(), ctx, new Set(tickResult.drivenRunIds));
    } catch (err) {
      // A bad pass must not kill the interval — surface and keep ticking.
      console.error("[khronoton] loop pass failed:", err);
    } finally {
      running = false;
    }
  }, ctx.config?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);

  return {
    stop() {
      clearInterval(handle);
    },
  };
}
