// @vitest-environment jsdom
//
// `useManualBatch(id)` — the read hook + poller #2 (poll the active manual batch
// every cadence while it runs). jsdom + fake timers, mirroring the engine loop
// test (`src/server/loop.test.ts`) cadence/cleanup idiom with the React `act`
// wrap the harness (`advanceTimersInAct`) supplies for state-in-interval flushes.
//
// The production hook reads the REAL `<KhronotonProvider>` context
// (`useKhronotonAdapter`/`useKhronotonConfig`), so these tests mount the real
// provider with a full fake `KhronotonAdapter` whose `getBatch` is the only live
// method — the harness `FakeAdapter` (list/get only) cannot carry `getBatch`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

import { advanceTimersInAct } from "./harness.js";
import { KhronotonProvider } from "../../src/provider/KhronotonProvider.js";
import type { KhronotonAdapter } from "../../src/provider/adapter.js";
import type { ManualBatchView } from "../../src/server/index.js";
import { useManualBatch } from "../../src/hooks/useManualBatch.js";

// @testing-library/react cannot auto-register cleanup without vitest globals
// (this repo runs with `globals:false`), so mounted trees would leak between
// tests. Register it explicitly — the convention every `*.test.tsx` copies.
afterEach(() => {
  cleanup();
});

/** Build a batch projection in a given lifecycle state (active = still polling). */
function makeBatch(
  status: ManualBatchView["status"],
  completed = 0,
): ManualBatchView {
  return {
    id: "batch-1",
    codexCronotonId: "c1",
    total: 10,
    completed,
    remaining: 10 - completed,
    intervalSeconds: 60,
    status,
    nextAt: status === "active" ? "2026-07-13T00:01:00Z" : null,
    createdBy: "tester",
    createdAt: "2026-07-13T00:00:00Z",
  };
}

/**
 * A full `KhronotonAdapter` whose only live method is `getBatch` — every other
 * method throws if the hook touches it (it must not). `assertAdapter` in the
 * real provider requires all 16 methods to be functions, so the stubs are real
 * callables, not `undefined`.
 */
function fakeAdapter(getBatch: KhronotonAdapter["getBatch"]): KhronotonAdapter {
  const unused = async () => {
    throw new Error("adapter method must not be called by useManualBatch");
  };
  return {
    list: unused,
    get: unused,
    fires: unused,
    signers: unused,
    commit: unused,
    edit: unused,
    pause: unused,
    resume: unused,
    delete: unused,
    simulate: unused,
    executeNow: unused,
    trigger: unused,
    startBatch: unused,
    getBatch,
    cancelBatch: unused,
    recover: unused,
  } as unknown as KhronotonAdapter;
}

function renderBatch(getBatch: KhronotonAdapter["getBatch"], id = "c1") {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <KhronotonProvider adapter={fakeAdapter(getBatch)}>{children}</KhronotonProvider>
  );
  return renderHook(() => useManualBatch(id), { wrapper });
}

/** A manually-settled promise so a test can drive out-of-order resolution. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useManualBatch — stale-response race on id change", () => {
  it("keeps the latest id's batch when a superseded slow load resolves after the fast one", async () => {
    // A (first id) is slow; B (switched-to id) is fast. B must win even though
    // A's response lands LAST. useManualBatch's mountedRef lives in a separate
    // [] effect that never flips on an id change, so only a per-load token drops
    // the superseded response.
    const slowA = deferred<{ ok: true; batch: ManualBatchView }>();
    const fastB = deferred<{ ok: true; batch: ManualBatchView }>();
    const getBatch = vi.fn((id: string) =>
      id === "A" ? slowA.promise : fastB.promise,
    ) as unknown as KhronotonAdapter["getBatch"];

    const adapter = fakeAdapter(getBatch);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <KhronotonProvider adapter={adapter}>{children}</KhronotonProvider>
    );

    const { result, rerender } = renderHook(({ id }: { id: string }) => useManualBatch(id), {
      wrapper,
      initialProps: { id: "A" },
    });

    rerender({ id: "B" });

    await act(async () => {
      fastB.resolve({ ok: true, batch: makeBatch("active", 5) });
    });
    await act(async () => {
      slowA.resolve({ ok: true, batch: makeBatch("completed", 10) });
    });

    // B (active, completed 5) is the current key; A's late completed/10 must NOT
    // overwrite it.
    expect(result.current.batch?.status).toBe("active");
    expect(result.current.batch?.completed).toBe(5);
    expect(result.current.active).toBe(true);
  });
});

describe("useManualBatch — mount load", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads the active batch from adapter.getBatch(id) on mount", async () => {
    const getBatch = vi.fn(async () => ({ ok: true as const, batch: makeBatch("active") }));
    const { result } = renderBatch(getBatch, "c1");

    await advanceTimersInAct(0);

    // The hook fetches the SPECIFIC id it was given, not a hardcoded one.
    expect(getBatch).toHaveBeenCalledWith("c1");
    expect(result.current.batch?.status).toBe("active");
    expect(result.current.active).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("refetch re-reads the batch so a caller can pull the latest state on demand", async () => {
    let current: ManualBatchView | null = makeBatch("active");
    const getBatch = vi.fn(async () => ({ ok: true as const, batch: current }));
    const { result } = renderBatch(getBatch);
    await advanceTimersInAct(0);
    expect(result.current.batch?.status).toBe("active");

    // Backend now reports the batch went idle; refetch must surface that.
    current = null;
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.batch).toBeNull();
    expect(result.current.active).toBe(false);
  });
});

describe("useManualBatch — poller #2 (poll while active)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls every cadence while active, then stops once the batch completes", async () => {
    let current: ManualBatchView = makeBatch("active");
    const getBatch = vi.fn(async () => ({ ok: true as const, batch: current }));
    const { result } = renderBatch(getBatch);

    await advanceTimersInAct(0);
    expect(getBatch).toHaveBeenCalledTimes(1); // mount load only

    // Each 5s cadence (the default pollCadenceMs) drives exactly one poll.
    await advanceTimersInAct(5000);
    expect(getBatch).toHaveBeenCalledTimes(2);

    await advanceTimersInAct(5000);
    expect(getBatch).toHaveBeenCalledTimes(3);

    // Batch completes → the next poll observes the flip and the poller must stop.
    current = makeBatch("completed", 10);
    await advanceTimersInAct(5000);
    expect(getBatch).toHaveBeenCalledTimes(4);
    expect(result.current.active).toBe(false);
    expect(result.current.batch?.status).toBe("completed");

    // Interval cleared on the status flip → a further advance does NOT poll.
    await advanceTimersInAct(5000);
    expect(getBatch).toHaveBeenCalledTimes(4);
  });

  it("stops polling when the batch becomes null (idle)", async () => {
    let current: ManualBatchView | null = makeBatch("active");
    const getBatch = vi.fn(async () => ({ ok: true as const, batch: current }));
    const { result } = renderBatch(getBatch);

    await advanceTimersInAct(0);
    current = null;
    await advanceTimersInAct(5000); // poll observes null → stop
    expect(result.current.batch).toBeNull();
    expect(result.current.active).toBe(false);

    const callsAfterStop = getBatch.mock.calls.length;
    await advanceTimersInAct(5000);
    expect(getBatch.mock.calls.length).toBe(callsAfterStop);
  });

  it("swallows poll errors — a rejected poll leaves error null and keeps polling", async () => {
    let mode: "ok" | "reject" = "ok";
    const getBatch = vi.fn(async () => {
      if (mode === "reject") throw new Error("gated poll 401");
      return { ok: true as const, batch: makeBatch("active") };
    });
    const { result } = renderBatch(getBatch);

    await advanceTimersInAct(0);
    expect(result.current.active).toBe(true);

    mode = "reject";
    await advanceTimersInAct(5000); // poll rejects — must be swallowed
    expect(result.current.error).toBeNull();
    expect(result.current.active).toBe(true); // still active → interval survives
    const callsAfterFirstReject = getBatch.mock.calls.length;

    await advanceTimersInAct(5000); // interval kept ticking despite the rejection
    expect(getBatch.mock.calls.length).toBeGreaterThan(callsAfterFirstReject);
  });

  it("clears the poll interval on unmount so no timers leak", async () => {
    const getBatch = vi.fn(async () => ({ ok: true as const, batch: makeBatch("active") }));
    const { unmount } = renderBatch(getBatch);

    await advanceTimersInAct(0);
    await advanceTimersInAct(5000);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // interval is live while active

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
