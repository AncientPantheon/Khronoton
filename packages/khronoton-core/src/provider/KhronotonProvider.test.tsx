// @vitest-environment jsdom
//
// Provider + context suite. Opts into jsdom via the top-of-file docblock (the
// convention every `*.test.tsx` in this phase copies); the global vitest env
// stays `node` for the engine/handler suites. @testing-library/react's cleanup
// is registered explicitly because this repo runs without `globals: true`.

import { describe, it, expect, afterEach, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen, renderHook, waitFor, cleanup } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { KhronotonProvider } from "./KhronotonProvider.js";
import {
  useKhronoton,
  useKhronotonAdapter,
  useKhronotonConfig,
  DEFAULT_EXPLORER_BASE,
} from "./context.js";
import type { KhronotonAdapter } from "./adapter.js";

afterEach(() => {
  cleanup();
});

/** A complete 16-method fake adapter — every method a mock so `assertAdapter`
 *  passes and calls are observable. Values are not exercised here (that is the
 *  data-hook suites); this suite only pins the provider/context wiring. */
function makeAdapter(): KhronotonAdapter {
  const m = () => vi.fn(async () => ({ ok: true }));
  return {
    list: m(),
    get: m(),
    fires: m(),
    signers: m(),
    commit: m(),
    edit: m(),
    pause: m(),
    resume: m(),
    delete: m(),
    simulate: m(),
    executeNow: m(),
    trigger: m(),
    startBatch: m(),
    getBatch: m(),
    cancelBatch: m(),
    recover: m(),
  } as unknown as KhronotonAdapter;
}

function makeWrapper(adapter: KhronotonAdapter, extra: Record<string, unknown> = {}) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <KhronotonProvider adapter={adapter} {...extra}>
        {children}
      </KhronotonProvider>
    );
  };
}

describe("KhronotonProvider — render + context exposure", () => {
  it("renders its children", () => {
    render(
      <KhronotonProvider adapter={makeAdapter()}>
        <span data-testid="child">alive</span>
      </KhronotonProvider>,
    );
    expect(screen.getByTestId("child").textContent).toBe("alive");
  });

  it("exposes the injected adapter and default-resolved config, flipping ready true after mount", async () => {
    const adapter = makeAdapter();
    const { result } = renderHook(() => useKhronoton(), { wrapper: makeWrapper(adapter) });

    // The exact object passed in is what the hooks receive (per-mount identity).
    expect(result.current.adapter).toBe(adapter);
    // Unset config props fall to sensible defaults (StoaChain explorer, 50/page, mode column on).
    expect(result.current.config.explorerBase).toBe(DEFAULT_EXPLORER_BASE);
    expect(result.current.config.pageSize).toBe(50);
    expect(result.current.config.pollCadenceMs).toBe(5000);
    expect(result.current.config.showMode).toBe(true);
    expect(result.current.config.serverResolverOptions).toEqual([]);
    expect(result.current.error).toBeNull();
    // The browser-only init flips ready true once the client mount effect runs.
    await waitFor(() => expect(result.current.ready).toBe(true));
  });

  it("applies explicit config overrides over the defaults", () => {
    const adapter = makeAdapter();
    const onNeedConfirm = vi.fn(async () => true);
    const { result } = renderHook(() => useKhronotonConfig(), {
      wrapper: makeWrapper(adapter, {
        explorerBase: "https://scan.test/tx",
        pageSize: 10,
        pollCadenceMs: 1000,
        showMode: false,
        serverResolverOptions: [{ value: "sys", label: "System" }],
        onNeedConfirm,
      }),
    });

    expect(result.current.explorerBase).toBe("https://scan.test/tx");
    expect(result.current.pageSize).toBe(10);
    expect(result.current.pollCadenceMs).toBe(1000);
    expect(result.current.showMode).toBe(false);
    expect(result.current.serverResolverOptions).toEqual([{ value: "sys", label: "System" }]);
    // The host confirm-gate is carried on config so `runGated` callers can reach it.
    expect(result.current.onNeedConfirm).toBe(onNeedConfirm);
  });

  it("useKhronotonAdapter returns the injected adapter for the data hooks", () => {
    const adapter = makeAdapter();
    const { result } = renderHook(() => useKhronotonAdapter(), { wrapper: makeWrapper(adapter) });
    expect(result.current).toBe(adapter);
  });
});

describe("KhronotonProvider — fail-fast guards", () => {
  it("throws at mount when the adapter is missing a required method (recover — the wired-through-end op)", () => {
    const bad = { ...makeAdapter() } as Record<string, unknown>;
    delete bad.recover;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      render(
        <KhronotonProvider adapter={bad as unknown as KhronotonAdapter}>
          <span />
        </KhronotonProvider>,
      ),
    ).toThrow(/recover/);

    errSpy.mockRestore();
  });

  it("throws when useKhronoton is used outside a provider", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useKhronoton())).toThrow(/KhronotonProvider/);
    errSpy.mockRestore();
  });
});

describe("KhronotonProvider — SSR safety", () => {
  it("renders on the server with ready:false — the browser-only init never runs during SSR", () => {
    let ssrReady: boolean | undefined;
    function Probe() {
      ssrReady = useKhronoton().ready;
      return null;
    }
    const markup = renderToStaticMarkup(
      <KhronotonProvider adapter={makeAdapter()}>
        <Probe />
      </KhronotonProvider>,
    );
    // Effects don't fire during a server render, so a consumer sees ready:false —
    // no poller or adapter call is triggered by SSR.
    expect(ssrReady).toBe(false);
    expect(markup).toBe("");
  });

  it("fires no adapter method during a server render (SSR must not poison the backend)", () => {
    const adapter = makeAdapter();
    renderToStaticMarkup(
      <KhronotonProvider adapter={adapter}>
        <span />
      </KhronotonProvider>,
    );
    for (const method of Object.values(adapter as unknown as Record<string, ReturnType<typeof vi.fn>>)) {
      expect(method).not.toHaveBeenCalled();
    }
  });
});
