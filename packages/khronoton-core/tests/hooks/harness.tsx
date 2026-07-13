/**
 * React hook test harness for the Phase-D `/provider` + `/hooks` suites.
 *
 * This file lives under `tests/` (never `src/`) so nothing here ships in `dist`.
 * It gives T4.6–T4.10 three shared things so they don't each re-solve them:
 *
 *  1. THE jsdom ENVIRONMENT CONVENTION.
 *     The global vitest env stays `node` (see `vitest.config.ts`) so the engine
 *     (`src/server/**`) and handler (`src/handlers/**`) suites keep their
 *     byte-stable node runs and `better-sqlite3` loads natively. React hook and
 *     poller tests are `*.test.tsx` files, and each opts into jsdom by placing
 *     this exact line as the FIRST line of the file:
 *
 *         // @vitest-environment jsdom
 *
 *     Do NOT flip the global env in `vitest.config.ts` — the per-file docblock
 *     is the only switch. The `.tsx` globs in `vitest.config.ts` widen test
 *     DISCOVERY only; they do not change the default env.
 *
 *  2. A `renderHookWithProvider(hook, { adapter, ...config })` HELPER.
 *     It mounts the hook under test inside a provider wrapper with an injected
 *     in-memory adapter, then returns @testing-library/react's renderHook result
 *     plus the resolved `adapter`/`config` so tests can assert against them.
 *
 *     SEAM NOTE (Wave 1): the real `<KhronotonProvider>` (T4.5) and the real
 *     `MemoryAdapter` (T4.4) do not exist yet. This file provides the harness
 *     SHAPE — a minimal `HarnessProvider` stub + a lightweight `FakeAdapter` —
 *     so the pattern compiles and is exercised end-to-end today. When W2 lands,
 *     swap `HarnessProvider` for `<KhronotonProvider>` and `createFakeAdapter`
 *     for `MemoryAdapter`; the `renderHookWithProvider` SIGNATURE is fixed here
 *     and stays stable for the W3 hook suites.
 *
 *  3. THE FAKE-TIMER POLLER CONVENTION (`advanceTimersInAct`).
 *     The two 5s pollers (T4.7 fires-while-running, T4.8 batch-while-active)
 *     are driven exactly like the engine loop tests
 *     (`src/server/loop.test.ts`: `vi.useFakeTimers()` in `beforeEach`,
 *     `vi.useRealTimers()` in `afterEach`, advance by cadence with
 *     `vi.advanceTimersByTimeAsync`, assert call counts, assert cleanup on
 *     stop/unmount). The one React-specific delta: a `setState` fired inside a
 *     `setInterval` must be flushed inside `act`, so timer advances go through
 *     `advanceTimersInAct(ms)` rather than a bare `advanceTimersByTimeAsync`.
 *     A bare advance leaves the React state update un-flushed and the assertion
 *     races the render — the precise gotcha this helper removes.
 */
import { createContext, useContext, type ReactNode } from "react";
import { renderHook, act, type RenderHookOptions } from "@testing-library/react";
import { vi } from "vitest";

/**
 * A minimal cronoton row for the Wave-1 fake adapter. The real seam (T4.1)
 * returns the full handler body shapes; this thin record is only what the
 * harness self-tests and early hook demos need.
 */
export interface FakeCronotonRecord {
  id: string;
  name: string;
}

/**
 * A lightweight in-memory stand-in for the real `MemoryAdapter` (T4.4). It
 * exposes just enough of the seam to demonstrate the injected-adapter pattern;
 * it is deliberately NOT the full 16-method `KhronotonAdapter` (that is T4.1).
 * Replace with `MemoryAdapter` once W2 lands.
 */
export interface FakeAdapter {
  list(): Promise<{ ok: true; codexCronotons: FakeCronotonRecord[] }>;
  get(
    id: string,
  ): Promise<
    { ok: true; codexCronoton: FakeCronotonRecord } | { ok: false; error: string }
  >;
}

/** Build a fresh in-memory fake adapter, optionally seeded with rows. */
export function createFakeAdapter(seed: FakeCronotonRecord[] = []): FakeAdapter {
  const rows: FakeCronotonRecord[] = seed.map((r) => ({ ...r }));
  return {
    async list() {
      return { ok: true, codexCronotons: rows.map((r) => ({ ...r })) };
    },
    async get(id: string) {
      const row = rows.find((r) => r.id === id);
      return row
        ? { ok: true, codexCronoton: { ...row } }
        : { ok: false, error: "not_found" };
    },
  };
}

/**
 * Harness config knobs mirroring the real provider defaults (page size 50,
 * poll cadence 5000ms — REQ-PH04/REQ-PH06). Kept as a plain shape so W3 tests
 * can override cadence to drive the pollers.
 */
export interface HarnessConfig {
  pageSize: number;
  pollCadenceMs: number;
}

export interface HarnessContextValue {
  adapter: FakeAdapter;
  config: HarnessConfig;
}

const HarnessContext = createContext<HarnessContextValue | null>(null);

/**
 * Read the injected adapter/config inside a hook under test. Throws if used
 * outside the harness provider — the same fail-fast contract the real
 * `useKhronoton()` (T4.5) will enforce against `<KhronotonProvider>`.
 */
export function useHarnessContext(): HarnessContextValue {
  const value = useContext(HarnessContext);
  if (value === null) {
    throw new Error("useHarnessContext must be used within a HarnessProvider");
  }
  return value;
}

/**
 * Wave-1 stand-in for `<KhronotonProvider>` (T4.5). It only carries the
 * `{ adapter, config }` context the hooks read — no SSR init, no pollers of its
 * own. Swap for the real provider in W2 without changing test call sites.
 */
export function HarnessProvider({
  adapter,
  config,
  children,
}: {
  adapter: FakeAdapter;
  config: HarnessConfig;
  children: ReactNode;
}): ReactNode {
  return (
    <HarnessContext.Provider value={{ adapter, config }}>
      {children}
    </HarnessContext.Provider>
  );
}

export interface RenderHookWithProviderOptions<TProps>
  extends Omit<RenderHookOptions<TProps>, "wrapper"> {
  /** Injected adapter; defaults to an empty fake adapter when omitted. */
  adapter?: FakeAdapter;
  /** Page size override; defaults to 50 (REQ-PH04/REQ-G08). */
  pageSize?: number;
  /** Poll cadence override in ms; defaults to 5000 (REQ-PH06). */
  pollCadenceMs?: number;
}

/**
 * Mount `hook` inside the harness provider with an injected adapter and return
 * @testing-library/react's renderHook result plus the resolved `adapter` and
 * `config`. The return shape is the fixed contract the W3 hook suites rely on.
 */
export function renderHookWithProvider<TResult, TProps = undefined>(
  hook: (props: TProps) => TResult,
  options: RenderHookWithProviderOptions<TProps> = {},
) {
  const { adapter: injected, pageSize, pollCadenceMs, ...renderHookOptions } = options;
  const adapter = injected ?? createFakeAdapter();
  const config: HarnessConfig = {
    pageSize: pageSize ?? 50,
    pollCadenceMs: pollCadenceMs ?? 5000,
  };

  const wrapper = ({ children }: { children: ReactNode }) => (
    <HarnessProvider adapter={adapter} config={config}>
      {children}
    </HarnessProvider>
  );

  const result = renderHook(hook, { wrapper, ...renderHookOptions });
  return { ...result, adapter, config };
}

/**
 * Advance fake timers by `ms`, wrapped in `act` so React state updates that
 * fire inside a `setInterval` poller flush before the next assertion. This is
 * the React-specific companion to `src/server/loop.test.ts`'s bare
 * `vi.advanceTimersByTimeAsync(cadence)` — same cadence-driven idiom, plus the
 * `act` wrap the DOM render requires.
 *
 * Poller test skeleton (T4.7/T4.8 copy this):
 *
 * ```tsx
 * // @vitest-environment jsdom
 * beforeEach(() => vi.useFakeTimers());
 * afterEach(() => vi.useRealTimers());
 *
 * it("polls every cadence while running, stops when idle", async () => {
 *   const { result } = renderHookWithProvider(() => useCronotonFires("id"));
 *   await advanceTimersInAct(5000); // one cadence → one poll
 *   expect(...).toBe(...);
 * });
 * ```
 */
export async function advanceTimersInAct(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
