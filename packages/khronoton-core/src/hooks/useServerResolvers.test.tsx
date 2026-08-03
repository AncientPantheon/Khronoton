// @vitest-environment jsdom
//
// `useServerResolvers()` data-hook suite. Opts into jsdom via the top-of-file
// docblock (the convention every `*.test.tsx` in this phase copies); the global
// vitest env stays `node` for the engine/handler suites. The hook reads the REAL
// provider context (`useKhronotonAdapter`), so these tests mount it under the
// real `<KhronotonProvider>` over an in-process `createMemoryAdapter` (the real
// Phase-C handlers, no network) — plus adapter overrides that exercise the
// OPTIONAL-method degradation the Builder relies on.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import BetterSqlite3 from "better-sqlite3";

import { KhronotonProvider } from "../provider/KhronotonProvider.js";
import { createMemoryAdapter } from "../provider/memory-adapter.js";
import type { KhronotonAdapter, ResolversView } from "../provider/adapter.js";
import type { Database } from "../server/index.js";
import { registerServerResolver } from "../server/index.js";
import { useServerResolvers } from "./useServerResolvers.js";

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

function wrapperFor(a: KhronotonAdapter) {
  return function wrapper({ children }: { children: ReactNode }) {
    return <KhronotonProvider adapter={a}>{children}</KhronotonProvider>;
  };
}

describe("useServerResolvers — registry load", () => {
  it("starts loading empty, then resolves the registered resolvers with their evented flag", async () => {
    // Register one evented + one plain resolver so the memory adapter's real
    // /resolvers handler enumerates a non-trivial registry.
    registerServerResolver("use-resolvers-test-evented", {
      kind: "single-tx",
      evented: true,
      resolve: async () => ({ ok: true as const }),
      settle: async () => ({ ok: true as const }),
    } as unknown as Parameters<typeof registerServerResolver>[1]);
    registerServerResolver("use-resolvers-test-plain", {
      kind: "single-tx",
      resolve: async () => ({ ok: true as const }),
      settle: async () => ({ ok: true as const }),
    } as unknown as Parameters<typeof registerServerResolver>[1]);

    const { result } = renderHook(() => useServerResolvers(), {
      wrapper: wrapperFor(adapter),
    });

    // SSR-safe pre-fetch state: loading, empty, no error (no adapter call during render).
    expect(result.current.loading).toBe(true);
    expect(result.current.resolvers).toEqual([]);
    expect(result.current.error).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));

    const byName = new Map(result.current.resolvers.map((r) => [r.name, r]));
    expect(byName.get("use-resolvers-test-evented")?.evented).toBe(true);
    expect(byName.get("use-resolvers-test-plain")?.evented).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

describe("useServerResolvers — graceful degradation (OPTIONAL adapter method)", () => {
  it("resolves an empty list (no error, no throw) when the adapter omits resolvers() — an older pre-0.7.0 adapter", async () => {
    // Strip the OPTIONAL method to model an adapter predating 0.7.0. The hook
    // must degrade to [] without throwing so the Builder falls back to the 0.6.0
    // serverResolverOptions.eventDriven signal instead of crashing.
    const { resolvers: _drop, ...rest } = adapter;
    const legacyAdapter = rest as unknown as KhronotonAdapter;
    expect(typeof legacyAdapter.resolvers).toBe("undefined");

    const { result } = renderHook(() => useServerResolvers(), {
      wrapper: wrapperFor(legacyAdapter),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.resolvers).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("surfaces a thrown fetch error in `error` and leaves the list empty (does not block the Builder)", async () => {
    const failing = {
      ...adapter,
      resolvers: vi.fn(async (): Promise<ResolversView> => {
        throw new Error("resolvers unavailable");
      }),
    } as unknown as KhronotonAdapter;

    const { result } = renderHook(() => useServerResolvers(), {
      wrapper: wrapperFor(failing),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("resolvers unavailable");
    expect(result.current.resolvers).toEqual([]);
  });
});
