// @vitest-environment jsdom
//
// `useLiveGasFloor` — the single polled source of the live StoaChain gas floor
// for the Builder UI (`Builder.tsx` calls it once, threads it to `ConfigTab`/
// `ExecuteTab`). Dynamic-imports `@stoachain/stoa-core/gas` exactly like
// `tx-size.ts`'s established optional-peer precedent, so it degrades to `null`
// rather than throwing when the peer isn't resolvable. Mocking style mirrors
// `blockchain/stoachain.test.ts`: a `mock`-prefixed fn declared before the
// hoisted `vi.mock` factory, referenced by name inside it.
//
// `mockShouldThrow` simulates a rejecting/unresolvable peer by having the
// mocked `minGasPriceAnu` throw when called, rather than trying to force the
// `await import(...)` call itself to reject per-test. `tx-size.ts`'s own
// comment documents why: this repo's Vitest setup does not reliably let a
// `vi.mock` factory reject on some calls and resolve on others for the SAME
// already-resolved dynamic import across a single test file. The hook's own
// `try`/`catch` wraps both the import and the call in one block, so a thrown
// `minGasPriceAnu` exercises the identical catch path an import rejection
// would — proving the behavior under test (never throws into render, stays
// `null`) without fighting that limitation.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";

let mockFloor = 10000;
let mockShouldThrow = false;
const mockMinGasPriceAnu = vi.fn((_nowS: number) => {
  if (mockShouldThrow) throw new Error("optional peer not installed");
  return mockFloor;
});

vi.mock("@stoachain/stoa-core/gas", () => ({
  minGasPriceAnu: (nowS: number) => mockMinGasPriceAnu(nowS),
}));

import { useLiveGasFloor } from "./live-gas-floor.js";

afterEach(() => {
  cleanup();
});

describe("useLiveGasFloor", () => {
  beforeEach(() => {
    mockFloor = 10000;
    mockShouldThrow = false;
    mockMinGasPriceAnu.mockClear();
  });

  it("starts null, then resolves to the live floor after mount", async () => {
    const { result } = renderHook(() => useLiveGasFloor());

    expect(result.current).toBeNull();

    await waitFor(() => {
      expect(result.current).toBe(10000);
    });
  });

  it("refreshes again on the 30s interval", async () => {
    vi.useFakeTimers();
    try {
      mockMinGasPriceAnu.mockImplementationOnce(() => 10000);
      mockMinGasPriceAnu.mockImplementationOnce(() => 20000);

      const { result } = renderHook(() => useLiveGasFloor());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current).toBe(10000);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(result.current).toBe(20000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes on document visibilitychange -> visible", async () => {
    const { result } = renderHook(() => useLiveGasFloor());
    await waitFor(() => expect(result.current).toBe(10000));

    mockFloor = 30000;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current).toBe(30000));
  });

  it("refreshes on window focus", async () => {
    const { result } = renderHook(() => useLiveGasFloor());
    await waitFor(() => expect(result.current).toBe(10000));

    mockFloor = 40000;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current).toBe(40000));
  });

  it("stays null and never throws when the optional peer import rejects", async () => {
    mockShouldThrow = true;

    let result!: ReturnType<typeof renderHook<number | null, unknown>>["result"];
    expect(() => {
      ({ result } = renderHook(() => useLiveGasFloor()));
    }).not.toThrow();

    await waitFor(() => {
      expect(mockMinGasPriceAnu).toHaveBeenCalled();
    });

    expect(result.current).toBeNull();
  });
});
