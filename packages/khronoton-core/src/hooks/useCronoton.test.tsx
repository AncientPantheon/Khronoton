// @vitest-environment jsdom
//
// `useCronoton(id)` data-hook suite. Opts into jsdom via the top-of-file docblock
// (the convention every `*.test.tsx` in this phase copies). The hook reads the
// REAL provider context, so these tests mount it under `<KhronotonProvider>` with
// an in-process `createMemoryAdapter` over a fresh in-memory `better-sqlite3` DB —
// the same backend `memory-adapter.test.ts` uses, driving the real Phase-C
// handlers with NO network.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import BetterSqlite3 from "better-sqlite3";

import { KhronotonProvider } from "../provider/KhronotonProvider.js";
import { createMemoryAdapter } from "../provider/memory-adapter.js";
import type { GetCronotonView, KhronotonAdapter } from "../provider/adapter.js";
import type { CommitBody } from "../handlers/index.js";
import type { CodexCronotonRow, Database } from "../server/index.js";
import { useCronoton } from "./useCronoton.js";

/** A manually-settled promise so a test can drive out-of-order resolution. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A minimal row carrying just the id/name the hook and assertions read. */
function fakeRow(id: string, name: string): CodexCronotonRow {
  return { id, name } as CodexCronotonRow;
}

/** A future one-time cronoton — commits a real row by name. */
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

describe("useCronoton — single-row load", () => {
  it("starts loading with no row, then resolves the requested cronoton (loading true→false)", async () => {
    const { codexCronotonId } = await adapter.commit(oneTimeBody("Solo"), { confirmed: true });

    const { result } = renderHook(() => useCronoton(codexCronotonId), { wrapper });

    expect(result.current.loading).toBe(true);
    expect(result.current.cronoton).toBeNull();
    expect(result.current.error).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.cronoton?.id).toBe(codexCronotonId);
    expect(result.current.cronoton?.name).toBe("Solo");
    expect(result.current.error).toBeNull();
  });
});

describe("useCronoton — re-fetch on id change", () => {
  it("loads the new row when the id argument changes (live detail switch)", async () => {
    const first = await adapter.commit(oneTimeBody("One"), { confirmed: true });
    const second = await adapter.commit(oneTimeBody("Two"), { confirmed: true });

    const { result, rerender } = renderHook(({ id }: { id: string }) => useCronoton(id), {
      wrapper,
      initialProps: { id: first.codexCronotonId },
    });

    await waitFor(() => expect(result.current.cronoton?.name).toBe("One"));

    // Switching the id must drive a fresh load for the new row, not keep the old.
    rerender({ id: second.codexCronotonId });
    await waitFor(() => expect(result.current.cronoton?.name).toBe("Two"));
    expect(result.current.cronoton?.id).toBe(second.codexCronotonId);
  });
});

describe("useCronoton — refetch", () => {
  it("re-reads the same row on refetch", async () => {
    const { codexCronotonId } = await adapter.commit(oneTimeBody("Reload me"), { confirmed: true });

    const { result } = renderHook(() => useCronoton(codexCronotonId), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.cronoton?.name).toBe("Reload me");

    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.cronoton?.id).toBe(codexCronotonId);
    expect(result.current.error).toBeNull();
  });
});

describe("useCronoton — stale-response race on id change", () => {
  it("keeps the latest id's row when a superseded slow load resolves after the fast one", async () => {
    // A (the first id) is slow; B (the switched-to id) is fast. B must win even
    // though A's response lands LAST — a superseded key must not overwrite fresh.
    const slowA = deferred<GetCronotonView>();
    const fastB = deferred<GetCronotonView>();
    const get = vi.fn((id: string) =>
      id === "A" ? slowA.promise : fastB.promise,
    );
    adapter = { ...adapter, get } as KhronotonAdapter;

    const { result, rerender } = renderHook(({ id }: { id: string }) => useCronoton(id), {
      wrapper,
      initialProps: { id: "A" },
    });

    rerender({ id: "B" });

    // B resolves first (the current key), then A resolves late (the stale key).
    await act(async () => {
      fastB.resolve({ ok: true, codexCronoton: fakeRow("B", "Bee") });
    });
    await act(async () => {
      slowA.resolve({ ok: true, codexCronoton: fakeRow("A", "Ay") });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.cronoton?.id).toBe("B");
    expect(result.current.cronoton?.name).toBe("Bee");
  });
});

describe("useCronoton — not-found", () => {
  it("surfaces the handler's 404 as an error and leaves the row null", async () => {
    // An unknown id maps to the read handler's 404, which the shared status map
    // turns into a thrown Error — the hook exposes it rather than a phantom row.
    const { result } = renderHook(() => useCronoton("missing-id"), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.cronoton).toBeNull();
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("not found");
  });
});
