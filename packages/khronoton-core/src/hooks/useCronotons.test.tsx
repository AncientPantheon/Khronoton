// @vitest-environment jsdom
//
// `useCronotons()` data-hook suite. Opts into jsdom via the top-of-file docblock
// (the convention every `*.test.tsx` in this phase copies); the global vitest env
// stays `node` for the engine/handler suites. The hook reads the REAL provider
// context (`useKhronotonAdapter`), so these tests mount it under the real
// `<KhronotonProvider>` with an in-process `createMemoryAdapter` over a fresh
// in-memory `better-sqlite3` DB — the same backend `memory-adapter.test.ts` uses,
// driving the real Phase-C handlers with NO network.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import BetterSqlite3 from "better-sqlite3";

import { KhronotonProvider } from "../provider/KhronotonProvider.js";
import { createMemoryAdapter } from "../provider/memory-adapter.js";
import type { ListCronotonsView, KhronotonAdapter } from "../provider/adapter.js";
import type { CommitBody } from "../handlers/index.js";
import type { CodexCronotonRow, Database } from "../server/index.js";
import { useCronotons } from "./useCronotons.js";

/** A manually-settled promise so a test can drive out-of-order resolution. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A minimal row carrying just the name the assertions read. */
function fakeRow(name: string): CodexCronotonRow {
  return { name } as CodexCronotonRow;
}

/** A future one-time cronoton — commits a real row without a manual batch. */
function oneTimeBody(name: string): CommitBody {
  return {
    name,
    description: null,
    envelope: {
      pactCode: '(coin.transfer "a" "b" 1.0)',
      config: { chainId: "0", gasPrice: 1, gasLimit: 1500, autoGasLimit: false, ttl: 600 },
      payload: {},
      gasPayer: { type: "gas-station" },
      signers: [],
    },
    schedule: { mode: "one-time", config: { mode: "one-time", fireAt: "2099-01-01T00:00:00.000Z" } },
  };
}

let db: Database;
let adapter: KhronotonAdapter;

beforeEach(() => {
  db = new BetterSqlite3(":memory:") as unknown as Database;
  adapter = createMemoryAdapter({ db });
});

afterEach(() => {
  cleanup();
  (db as unknown as BetterSqlite3.Database).close();
});

function wrapper({ children }: { children: ReactNode }) {
  return <KhronotonProvider adapter={adapter}>{children}</KhronotonProvider>;
}

describe("useCronotons — initial load", () => {
  it("starts loading with no rows, then resolves the seeded list (loading true→false)", async () => {
    await adapter.commit(oneTimeBody("Alpha"), { confirmed: true });
    await adapter.commit(oneTimeBody("Beta"), { confirmed: true });

    const { result } = renderHook(() => useCronotons(), { wrapper });

    // Before the mount effect resolves the browser-only load, the hook is loading
    // with an empty list and no error — the SSR-safe pre-fetch state.
    expect(result.current.loading).toBe(true);
    expect(result.current.cronotons).toEqual([]);
    expect(result.current.error).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));

    // The resolved list carries the two committed rows the real handler returns.
    expect(result.current.cronotons).toHaveLength(2);
    expect(result.current.cronotons.map((c) => c.name).sort()).toEqual(["Alpha", "Beta"]);
    expect(result.current.error).toBeNull();
  });

  it("resolves an empty list (no error) when the backend has no cronotons", async () => {
    const { result } = renderHook(() => useCronotons(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.cronotons).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});

describe("useCronotons — refetch", () => {
  it("re-reads the adapter so a row committed after mount appears on refetch", async () => {
    await adapter.commit(oneTimeBody("First"), { confirmed: true });

    const { result } = renderHook(() => useCronotons(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.cronotons).toHaveLength(1);

    // A mutation lands out-of-band; the stale hook state still shows one row
    // until the caller re-runs the SSR-style refetch.
    await adapter.commit(oneTimeBody("Second"), { confirmed: true });
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.cronotons).toHaveLength(2);
    expect(result.current.cronotons.map((c) => c.name).sort()).toEqual(["First", "Second"]);
  });
});

describe("useCronotons — stale-response race on query change", () => {
  it("keeps the latest query's rows when a superseded slow load resolves after the fast one", async () => {
    // The first query (limit:1) is slow; the switched-to query (limit:2) is fast.
    // The latest query must win even though the first response lands LAST.
    const slowFirst = deferred<ListCronotonsView>();
    const fastSecond = deferred<ListCronotonsView>();
    const list = vi.fn((q?: { limit?: number }) =>
      q?.limit === 1 ? slowFirst.promise : fastSecond.promise,
    );
    adapter = { ...adapter, list } as KhronotonAdapter;

    const { result, rerender } = renderHook(
      ({ q }: { q: { limit: number } }) => useCronotons(q),
      { wrapper, initialProps: { q: { limit: 1 } } },
    );

    rerender({ q: { limit: 2 } });

    await act(async () => {
      fastSecond.resolve({ ok: true, codexCronotons: [fakeRow("Second")] });
    });
    await act(async () => {
      slowFirst.resolve({ ok: true, codexCronotons: [fakeRow("First")] });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.cronotons.map((c) => c.name)).toEqual(["Second"]);
  });
});

describe("useCronotons — error path", () => {
  it("surfaces a thrown load error in `error` and leaves the list empty (explicit load, not a swallowed poll)", async () => {
    // A load failure is user-visible here (unlike a poller): the adapter's list
    // rejects and the error must land in `error`, not be swallowed.
    adapter = {
      ...adapter,
      list: async () => {
        throw new Error("list unavailable");
      },
    } as KhronotonAdapter;

    const { result } = renderHook(() => useCronotons(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("list unavailable");
    expect(result.current.cronotons).toEqual([]);
  });
});
