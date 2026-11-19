/**
 * Loop-driver tests — `startKhronotonLoop`.
 *
 * The loop is the single-instance `setInterval` driver whose handler runs ONE
 * tick pass (`codexCronotonTickOnce` then `processDueManualBatchesOnce` then
 * `advanceInFlightRunsOnce`) behind a single closure boolean that prevents a
 * slow, multi-minute inline fire from ever stacking a second overlapping
 * pass. These tests drive that guard with vitest fake timers and INJECTED
 * tick fns (no DB), pinning:
 *
 *   - cadence          → each `tickIntervalMs` advance runs the pass exactly once
 *   - RE-ENTRANCY      → a pass still in flight suppresses the next interval's
 *                        pass; once it settles, the following interval runs again
 *   - stop()           → clears the interval; no further passes; idempotent
 *   - error resilience → a rejecting pass does not kill the interval, and the
 *                        guard is cleared so the next interval still fires
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { startKhronotonLoop } from "./loop.js";
import type { TickCtx } from "./tick.js";
import type { CodexTickResult, CodexManualBatchTickResult } from "./tick.js";
import type { AdvanceRunsResult } from "./runs-driver.js";

const TICK_RESULT: CodexTickResult = {
  firedIds: [],
  failedIds: [],
  skippedIds: [],
  drivenRunIds: [],
};
const MANUAL_RESULT: CodexManualBatchTickResult = {
  firedIds: [],
  failedIds: [],
  skippedIds: [],
  cancelledIds: [],
};
const ADVANCE_RESULT: AdvanceRunsResult = {
  drivenIds: [],
  erroredIds: [],
};

/**
 * A minimal ctx: the injected tick fns ignore the ctx (they are `vi.fn()`s), so
 * only `config.tickIntervalMs` — which the loop reads to set the interval — is
 * load-bearing here. The seam members are irrelevant to the driver logic under
 * test and are cast in.
 */
function makeCtx(tickIntervalMs: number): TickCtx {
  return { config: { tickIntervalMs } } as unknown as TickCtx;
}

describe("startKhronotonLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs one pass per tickIntervalMs — each advance fires the pass exactly once", async () => {
    const ctx = makeCtx(1000);
    const runTick = vi.fn().mockResolvedValue(TICK_RESULT);
    const runManualBatch = vi.fn().mockResolvedValue(MANUAL_RESULT);
    const runAdvance = vi.fn().mockResolvedValue(ADVANCE_RESULT);

    const loop = startKhronotonLoop(ctx, { runTick, runManualBatch, runAdvance });

    await vi.advanceTimersByTimeAsync(1000);
    expect(runTick).toHaveBeenCalledTimes(1);
    expect(runManualBatch).toHaveBeenCalledTimes(1);
    expect(runAdvance).toHaveBeenCalledTimes(1);
    expect(runTick).toHaveBeenCalledWith(expect.any(Date), ctx);
    expect(runManualBatch).toHaveBeenCalledWith(expect.any(Date), ctx);
    expect(runAdvance).toHaveBeenCalledWith(expect.any(Date), ctx, expect.any(Set));

    await vi.advanceTimersByTimeAsync(1000);
    expect(runTick).toHaveBeenCalledTimes(2);
    expect(runManualBatch).toHaveBeenCalledTimes(2);
    expect(runAdvance).toHaveBeenCalledTimes(2);

    loop.stop();
  });

  it("passes the tick's drivenRunIds to runAdvance as an exclude set, so a run driven inline by the tick isn't driven again by the sweep", async () => {
    const ctx = makeCtx(1000);
    const runTick = vi.fn().mockResolvedValue({ ...TICK_RESULT, drivenRunIds: ["run-abc", "run-def"] });
    const runManualBatch = vi.fn().mockResolvedValue(MANUAL_RESULT);
    const runAdvance = vi.fn().mockResolvedValue(ADVANCE_RESULT);

    const loop = startKhronotonLoop(ctx, { runTick, runManualBatch, runAdvance });

    await vi.advanceTimersByTimeAsync(1000);
    expect(runAdvance).toHaveBeenCalledTimes(1);
    const excludeSet = runAdvance.mock.calls[0][2] as Set<string>;
    expect(excludeSet).toBeInstanceOf(Set);
    expect(excludeSet.has("run-abc")).toBe(true);
    expect(excludeSet.has("run-def")).toBe(true);
    expect(excludeSet.has("some-other-run")).toBe(false);

    loop.stop();
  });

  it("suppresses an overlapping pass while a prior pass is still in flight, then resumes once it settles", async () => {
    const ctx = makeCtx(1000);

    let resolvePending!: (r: CodexTickResult) => void;
    const pending = new Promise<CodexTickResult>((resolve) => {
      resolvePending = resolve;
    });
    // First pass never settles until we resolve it — modelling a multi-minute fire.
    const runTick = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValue(TICK_RESULT);
    const runManualBatch = vi.fn().mockResolvedValue(MANUAL_RESULT);
    const runAdvance = vi.fn().mockResolvedValue(ADVANCE_RESULT);

    const loop = startKhronotonLoop(ctx, { runTick, runManualBatch, runAdvance });

    // Interval fires → pass starts, `running` set, but the pass hangs on `pending`.
    await vi.advanceTimersByTimeAsync(1000);
    expect(runTick).toHaveBeenCalledTimes(1);

    // Interval fires AGAIN while the first pass is still in flight → the guard
    // returns early, so NO second pass launches — `runAdvance` never even gets
    // to run, since `runTick`'s hung promise blocks the whole sequential pass.
    await vi.advanceTimersByTimeAsync(1000);
    expect(runTick).toHaveBeenCalledTimes(1);
    expect(runAdvance).not.toHaveBeenCalled();

    // Settle the hung pass → `finally` clears the guard.
    resolvePending(TICK_RESULT);
    await vi.advanceTimersByTimeAsync(0);
    expect(runAdvance).toHaveBeenCalledTimes(1);

    // The NEXT interval now runs a fresh pass (guard was released).
    await vi.advanceTimersByTimeAsync(1000);
    expect(runTick).toHaveBeenCalledTimes(2);
    expect(runAdvance).toHaveBeenCalledTimes(2);

    loop.stop();
  });

  it("stop() clears the interval so no further passes run, and is idempotent", async () => {
    const ctx = makeCtx(1000);
    const runTick = vi.fn().mockResolvedValue(TICK_RESULT);
    const runManualBatch = vi.fn().mockResolvedValue(MANUAL_RESULT);
    const runAdvance = vi.fn().mockResolvedValue(ADVANCE_RESULT);

    const loop = startKhronotonLoop(ctx, { runTick, runManualBatch, runAdvance });

    await vi.advanceTimersByTimeAsync(1000);
    expect(runTick).toHaveBeenCalledTimes(1);

    loop.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(runTick).toHaveBeenCalledTimes(1);

    // Calling stop() again must not throw.
    expect(() => loop.stop()).not.toThrow();
  });

  it("survives a rejecting pass — the interval keeps ticking and the guard is cleared", async () => {
    const ctx = makeCtx(1000);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const runTick = vi
      .fn()
      .mockRejectedValueOnce(new Error("tick blew up"))
      .mockResolvedValue(TICK_RESULT);
    const runManualBatch = vi.fn().mockResolvedValue(MANUAL_RESULT);
    const runAdvance = vi.fn().mockResolvedValue(ADVANCE_RESULT);

    const loop = startKhronotonLoop(ctx, { runTick, runManualBatch, runAdvance });

    // First pass rejects — the loop must swallow it (no unhandled rejection).
    await vi.advanceTimersByTimeAsync(1000);
    expect(runTick).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();

    // The interval survived AND the guard was cleared in `finally` → next pass runs.
    await vi.advanceTimersByTimeAsync(1000);
    expect(runTick).toHaveBeenCalledTimes(2);

    loop.stop();
  });

  it("survives a rejecting runAdvance pass — the interval keeps ticking and the guard is cleared", async () => {
    const ctx = makeCtx(1000);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const runTick = vi.fn().mockResolvedValue(TICK_RESULT);
    const runManualBatch = vi.fn().mockResolvedValue(MANUAL_RESULT);
    const runAdvance = vi
      .fn()
      .mockRejectedValueOnce(new Error("advance blew up"))
      .mockResolvedValue(ADVANCE_RESULT);

    const loop = startKhronotonLoop(ctx, { runTick, runManualBatch, runAdvance });

    // First pass rejects — the loop must swallow it (no unhandled rejection).
    await vi.advanceTimersByTimeAsync(1000);
    expect(runAdvance).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();

    // The interval survived AND the guard was cleared in `finally` → next pass runs.
    await vi.advanceTimersByTimeAsync(1000);
    expect(runAdvance).toHaveBeenCalledTimes(2);

    loop.stop();
  });
});
