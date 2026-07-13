// @vitest-environment jsdom
//
// `useCronotonFires` — offset-paged fire history + the fires-while-running 5s
// poller (poller #1). Driven under jsdom with fake timers exactly like the
// engine loop tests (`src/server/loop.test.ts`): advance by cadence, assert the
// per-cadence poll count, assert the interval tears down on stop/unmount.
//
// The hook reads the injected adapter + resolved config from the REAL provider
// context (`KhronotonStaticContext`). We mount it against that context directly
// (not the Wave-1 `renderHookWithProvider` stub, whose `FakeAdapter` lacks
// `fires` and still wraps the pre-swap `HarnessContext`) with a fake adapter
// whose `fires` we drive between timer advances. `advanceTimersInAct` is reused
// from the shared harness — it is provider-agnostic.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

/** A manually-settled promise so a test can drive out-of-order resolution. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

import { advanceTimersInAct } from "../../tests/hooks/harness.js";
import {
  KhronotonStaticContext,
  resolveConfig,
  type KhronotonProviderProps,
} from "../provider/context.js";
import type { KhronotonAdapter, FiresView } from "../provider/adapter.js";
import type { CodexCronotonFireRow } from "../server/index.js";
import { useCronotonFires } from "./useCronotonFires.js";

// @testing-library/react's auto-cleanup needs a framework global afterEach,
// which this repo does not expose (no `globals: true`). Register it explicitly.
afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function makeFire(
  id: string,
  status: CodexCronotonFireRow["status"],
): CodexCronotonFireRow {
  return {
    id,
    firedAt: "2026-07-13T00:00:00.000Z",
    status,
    requestKey: null,
    chainId: null,
    errorMessage: null,
    chainResponse: null,
    definitionFingerprint: null,
    mode: "test",
    recoveredAt: null,
    txKeys: [],
  };
}

/** A fake adapter whose `fires` slices a live source of rows by offset/limit. */
function makeAdapter(getAll: () => CodexCronotonFireRow[]) {
  const fires = vi.fn(
    async (q: { id: string; limit?: number; offset?: number }): Promise<FiresView> => {
      const all = getAll();
      const start = q.offset ?? 0;
      const lim = q.limit ?? 50;
      return { ok: true, fires: all.slice(start, start + lim), total: all.length, limit: lim, offset: start };
    },
  );
  return { fires } as unknown as KhronotonAdapter & { fires: typeof fires };
}

function renderFires(
  id: string,
  hookOpts: { pageSize?: number } | undefined,
  cfg: { adapter: KhronotonAdapter; pageSize?: number; pollCadenceMs?: number },
) {
  const config = resolveConfig({
    adapter: cfg.adapter,
    pageSize: cfg.pageSize,
    pollCadenceMs: cfg.pollCadenceMs,
  } as KhronotonProviderProps);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <KhronotonStaticContext.Provider value={{ adapter: cfg.adapter, config }}>
      {children}
    </KhronotonStaticContext.Provider>
  );
  return renderHook(() => useCronotonFires(id, hookOpts), { wrapper });
}

/** Flush the pending mount/refetch promise chain (no fake time is advanced). */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useCronotonFires — offset paging", () => {
  it("loads the first page at the default page size of 50", async () => {
    const all = Array.from({ length: 120 }, (_, i) => makeFire(`f${i}`, "success"));
    const adapter = makeAdapter(() => all);

    const { result } = renderFires("c1", undefined, { adapter });
    await settle();

    // 50-default page size means the first request windows offset 0, limit 50.
    expect(adapter.fires).toHaveBeenCalledWith({ id: "c1", limit: 50, offset: 0 });
    expect(result.current.fires).toHaveLength(50);
    expect(result.current.total).toBe(120);
    expect(result.current.page).toBe(0);
    // pageCount is ceil(total/pageSize) so every one of 120 rows is reachable.
    expect(result.current.pageCount).toBe(3);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("setPage windows the offset to page*pageSize and refetches that page", async () => {
    const all = Array.from({ length: 120 }, (_, i) => makeFire(`f${i}`, "success"));
    const adapter = makeAdapter(() => all);

    const { result } = renderFires("c1", undefined, { adapter });
    await settle();
    adapter.fires.mockClear();

    act(() => result.current.setPage(2));
    await settle();

    // Page 2 (0-based) → offset 2*50 = 100; the tail page holds the last 20 rows.
    expect(adapter.fires).toHaveBeenCalledWith({ id: "c1", limit: 50, offset: 100 });
    expect(result.current.page).toBe(2);
    expect(result.current.fires).toHaveLength(20);
    expect(result.current.fires[0].id).toBe("f100");
  });
});

describe("useCronotonFires — stale-response race on id change", () => {
  it("keeps the latest id's fires when a superseded slow load resolves after the fast one", async () => {
    // A (first id) is slow; B (switched-to id) is fast. B must win even though
    // A's response lands LAST — the separate mountedRef effect never flips on an
    // id change, so a pure token per load is what drops the superseded response.
    const slowA = deferred<FiresView>();
    const fastB = deferred<FiresView>();
    const fires = vi.fn((q: { id: string }) =>
      q.id === "A" ? slowA.promise : fastB.promise,
    );
    const adapter = { fires } as unknown as KhronotonAdapter;

    const config = resolveConfig({ adapter } as KhronotonProviderProps);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <KhronotonStaticContext.Provider value={{ adapter, config }}>
        {children}
      </KhronotonStaticContext.Provider>
    );

    const { result, rerender } = renderHook(({ id }: { id: string }) => useCronotonFires(id), {
      wrapper,
      initialProps: { id: "A" },
    });

    rerender({ id: "B" });

    await act(async () => {
      fastB.resolve({ ok: true, fires: [makeFire("b1", "success")], total: 1, limit: 50, offset: 0 });
    });
    await act(async () => {
      slowA.resolve({ ok: true, fires: [makeFire("a1", "success")], total: 1, limit: 50, offset: 0 });
    });
    await settle();

    expect(result.current.fires.map((f) => f.id)).toEqual(["b1"]);
    expect(result.current.loading).toBe(false);
  });
});

describe("useCronotonFires — poller #1 (fires while running)", () => {
  it("re-fetches the current page every cadence while a fire is running", async () => {
    const rows = [makeFire("r1", "running")];
    const adapter = makeAdapter(() => rows);

    const { result } = renderFires("c1", undefined, { adapter });
    await settle();
    expect(result.current.fires[0].status).toBe("running");
    const afterMount = adapter.fires.mock.calls.length;

    // Each 5s cadence with a running fire on the page triggers exactly one poll.
    await advanceTimersInAct(5000);
    expect(adapter.fires.mock.calls.length).toBe(afterMount + 1);

    await advanceTimersInAct(5000);
    expect(adapter.fires.mock.calls.length).toBe(afterMount + 2);
  });

  it("stops polling once the running fire settles to success", async () => {
    const rows = [makeFire("r1", "running")];
    const adapter = makeAdapter(() => rows);

    const { result } = renderFires("c1", undefined, { adapter });
    await settle();

    // The fire settles before the next cadence; the next poll pulls the success
    // row, so `anyRunning` flips false and the interval is torn down.
    rows[0] = makeFire("r1", "success");
    await advanceTimersInAct(5000);
    expect(result.current.fires[0].status).toBe("success");
    const afterSettle = adapter.fires.mock.calls.length;

    await advanceTimersInAct(15000);
    expect(adapter.fires.mock.calls.length).toBe(afterSettle);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("swallows a poll error without surfacing it or killing the interval", async () => {
    const rows = [makeFire("r1", "running")];
    let failNextPoll = false;
    const fires = vi.fn(async (): Promise<FiresView> => {
      if (failNextPoll) {
        failNextPoll = false;
        throw new Error("transient network blip");
      }
      return { ok: true, fires: rows, total: rows.length, limit: 50, offset: 0 };
    });
    const adapter = { fires } as unknown as KhronotonAdapter;

    const { result } = renderFires("c1", undefined, { adapter });
    await settle();
    expect(result.current.error).toBeNull();

    failNextPoll = true;
    await advanceTimersInAct(5000); // this poll rejects
    expect(result.current.error).toBeNull(); // swallowed — never surfaced
    const afterError = fires.mock.calls.length;

    await advanceTimersInAct(5000); // interval survived the rejection → polls again
    expect(fires.mock.calls.length).toBe(afterError + 1);
  });

  it("clears the poll interval on unmount so no further polls run", async () => {
    const rows = [makeFire("r1", "running")];
    const adapter = makeAdapter(() => rows);

    const { unmount } = renderFires("c1", undefined, { adapter });
    await settle();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const afterMount = adapter.fires.mock.calls.length;

    unmount();
    expect(vi.getTimerCount()).toBe(0);

    await advanceTimersInAct(15000);
    expect(adapter.fires.mock.calls.length).toBe(afterMount);
  });
});
