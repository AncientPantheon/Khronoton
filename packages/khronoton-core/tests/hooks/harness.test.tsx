// @vitest-environment jsdom
//
// End-to-end proof of the T4.2 hook harness: jsdom env + @testing-library/react
// render + fake-timer poller advance all work together BEFORE any real hook,
// provider, or adapter exists. If this file goes red, the Phase-D hook suites
// (T4.6–T4.10) cannot run — it is the harness contract, not a feature test.
//
// The top-of-file `// @vitest-environment jsdom` docblock is the convention
// every `*.test.tsx` in this phase copies; the global vitest env stays `node`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useEffect, useState } from "react";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";

import {
  renderHookWithProvider,
  advanceTimersInAct,
  createFakeAdapter,
  useHarnessContext,
  type FakeCronotonRecord,
} from "./harness.js";

// Without `globals: true` @testing-library/react cannot auto-register its
// per-test cleanup (it hooks the framework's global afterEach, which this repo
// does not expose), so mounted trees would leak across tests. Register cleanup
// explicitly — every `*.test.tsx` in this phase copies this line.
afterEach(() => {
  cleanup();
});

/** A probe with only `useState` — the simplest thing renderHook must drive. */
function useProbe(initial: number) {
  const [n, setN] = useState(initial);
  return { n, inc: () => setN((v) => v + 1) };
}

/** A probe that loads through the INJECTED adapter — the exact shape the real
 *  data hooks (T4.6) use: read the adapter from context, load on mount. */
function useAdapterList() {
  const { adapter } = useHarnessContext();
  const [rows, setRows] = useState<FakeCronotonRecord[]>([]);
  useEffect(() => {
    let mounted = true;
    void adapter.list().then((r) => {
      if (mounted && r.ok) setRows(r.codexCronotons);
    });
    return () => {
      mounted = false;
    };
  }, [adapter]);
  return rows;
}

/** A trivial component whose `useEffect` starts a `setInterval` counter — the
 *  React-state-in-interval shape the two 5s pollers (T4.7/T4.8) will have. */
function IntervalCounter({ intervalMs }: { intervalMs: number }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setCount((c) => c + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return <div data-testid="count">{count}</div>;
}

describe("hook harness — jsdom render + injected adapter", () => {
  it("runs under the jsdom environment (window/document exist)", () => {
    // A node-env run would leave these undefined; this pins the docblock effect.
    expect(typeof window).not.toBe("undefined");
    expect(typeof document).not.toBe("undefined");
  });

  it("renders a component into the jsdom DOM", () => {
    render(<div data-testid="probe">alive</div>);
    expect(screen.getByTestId("probe").textContent).toBe("alive");
  });

  it("mounts a useState probe hook inside the provider wrapper and drives its state", () => {
    const { result, adapter } = renderHookWithProvider(() => useProbe(7));
    expect(result.current.n).toBe(7);
    act(() => result.current.inc());
    expect(result.current.n).toBe(8);
    // The wrapper always supplies an adapter (defaulted when not passed).
    expect(adapter).toBeDefined();
  });

  it("injects the fake adapter through the wrapper so a hook can load from it", async () => {
    const adapter = createFakeAdapter([
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ]);
    const { result } = renderHookWithProvider(() => useAdapterList(), { adapter });
    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(result.current.map((r) => r.name)).toEqual(["Alpha", "Beta"]);
  });
});

describe("hook harness — fake-timer poller convention (mirrors src/server/loop.test.ts)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances a setInterval counter by cadence with act-wrapped timer advances", async () => {
    render(<IntervalCounter intervalMs={5000} />);
    expect(screen.getByTestId("count").textContent).toBe("0");

    // One 5s cadence → exactly one tick. Without the `act` wrapper the React
    // state set inside the interval would not flush before the assertion —
    // the precise gotcha T4.7/T4.8 hit.
    await advanceTimersInAct(5000);
    expect(screen.getByTestId("count").textContent).toBe("1");

    // Two more cadences → two more ticks (drives the count from the advance).
    await advanceTimersInAct(10000);
    expect(screen.getByTestId("count").textContent).toBe("3");
  });

  it("stops ticking after unmount clears the interval", async () => {
    const { unmount } = render(<IntervalCounter intervalMs={5000} />);
    await advanceTimersInAct(5000);
    expect(screen.getByTestId("count").textContent).toBe("1");

    unmount();
    // Advancing past several cadences after unmount must produce no further
    // work — the cleanup return from `useEffect` cleared the interval.
    await advanceTimersInAct(20000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
