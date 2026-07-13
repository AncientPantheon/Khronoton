// @vitest-environment jsdom
//
// Lifecycle action-hook suite (create/edit/pause/resume/delete). Opts into jsdom
// via the top-of-file docblock (the convention every `*.test.tsx` in this phase
// copies); the global vitest env stays `node` for the engine/handler suites.
// @testing-library/react's cleanup is registered explicitly because this repo
// runs without `globals: true`.
//
// These hooks route every mutation through the shared `runGated` confirm-retry
// helper, so the tests pin the seam that matters to Phase E: the RIGHT adapter
// method fires with the fresh-confirm signal, `pending` brackets the call, an
// expired confirm re-prompts and retries exactly once, a declined re-confirm
// surfaces the error with no second call, and a plain failure surfaces without a
// re-prompt.

import { describe, it, expect, afterEach, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";

import { KhronotonProvider } from "../provider/KhronotonProvider.js";
import { NeedsConfirmError } from "../provider/adapter.js";
import type { KhronotonAdapter } from "../provider/adapter.js";
import type { CommitBody } from "../handlers/index.js";

import { useCronotonActions } from "./useCronotonActions.js";

afterEach(() => {
  cleanup();
});

/** A complete 16-method fake adapter so `assertAdapter` passes at mount; the
 *  methods under test are overridden per case so their calls are observable. */
function makeAdapter(overrides: Partial<KhronotonAdapter> = {}): KhronotonAdapter {
  const stub = () => vi.fn(async () => ({ ok: true }));
  return {
    list: stub(),
    get: stub(),
    fires: stub(),
    signers: stub(),
    commit: stub(),
    edit: stub(),
    pause: stub(),
    resume: stub(),
    delete: stub(),
    simulate: stub(),
    executeNow: stub(),
    trigger: stub(),
    startBatch: stub(),
    getBatch: stub(),
    cancelBatch: stub(),
    recover: stub(),
    ...overrides,
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

/** A promise the test resolves by hand, to observe `pending` mid-call. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useCronotonActions — each action fires its adapter method behind the gate", () => {
  it("create.run(body) commits the body with the fresh-confirm signal and returns the new id/nextFireAt", async () => {
    const commit = vi.fn(async () => ({ ok: true, codexCronotonId: "new-1", nextFireAt: "2026-07-14T00:00:00Z" }));
    const adapter = makeAdapter({ commit: commit as unknown as KhronotonAdapter["commit"] });
    const { result } = renderHook(() => useCronotonActions(), { wrapper: makeWrapper(adapter) });

    const body = { name: "Daily" } as unknown as CommitBody;
    let res!: Awaited<ReturnType<typeof result.current.create.run>>;
    await act(async () => {
      res = await result.current.create.run(body);
    });

    expect(commit).toHaveBeenCalledTimes(1);
    // The gate threads `confirmed:true` so the backend confirm gate passes.
    expect(commit).toHaveBeenCalledWith(body, { confirmed: true });
    expect(res).toEqual({ ok: true, result: { ok: true, codexCronotonId: "new-1", nextFireAt: "2026-07-14T00:00:00Z" } });
    expect(result.current.create.result).toEqual({ ok: true, codexCronotonId: "new-1", nextFireAt: "2026-07-14T00:00:00Z" });
    expect(result.current.create.error).toBeNull();
  });

  it("edit.run(patch) edits the bound id with the patch behind the gate", async () => {
    const edit = vi.fn(async () => ({ ok: true, nextFireAt: null }));
    const adapter = makeAdapter({ edit: edit as unknown as KhronotonAdapter["edit"] });
    const { result } = renderHook(() => useCronotonActions("c1"), { wrapper: makeWrapper(adapter) });

    const patch = { name: "Renamed" } as unknown as Parameters<typeof result.current.edit.run>[0];
    await act(async () => {
      await result.current.edit.run(patch);
    });

    expect(edit).toHaveBeenCalledWith("c1", patch, { confirmed: true });
  });

  it("pause.run() and resume.run() toggle the bound id behind the gate", async () => {
    const pause = vi.fn(async () => ({ ok: true, status: "paused", nextFireAt: null }));
    const resume = vi.fn(async () => ({ ok: true, status: "active", nextFireAt: "later" }));
    const adapter = makeAdapter({
      pause: pause as unknown as KhronotonAdapter["pause"],
      resume: resume as unknown as KhronotonAdapter["resume"],
    });
    const { result } = renderHook(() => useCronotonActions("c1"), { wrapper: makeWrapper(adapter) });

    await act(async () => {
      await result.current.pause.run();
    });
    await act(async () => {
      await result.current.resume.run();
    });

    expect(pause).toHaveBeenCalledWith("c1", { confirmed: true });
    expect(resume).toHaveBeenCalledWith("c1", { confirmed: true });
  });

  it("remove.run() deletes the bound id behind the gate", async () => {
    const del = vi.fn(async () => ({ ok: true }));
    const adapter = makeAdapter({ delete: del as unknown as KhronotonAdapter["delete"] });
    const { result } = renderHook(() => useCronotonActions("c1"), { wrapper: makeWrapper(adapter) });

    await act(async () => {
      await result.current.remove.run();
    });

    expect(del).toHaveBeenCalledWith("c1", { confirmed: true });
  });

  it("returns a bound-id error WITHOUT calling the adapter when no id was supplied to an id-scoped action", async () => {
    const pause = vi.fn(async () => ({ ok: true, status: "paused", nextFireAt: null }));
    const adapter = makeAdapter({ pause: pause as unknown as KhronotonAdapter["pause"] });
    const { result } = renderHook(() => useCronotonActions(), { wrapper: makeWrapper(adapter) });

    let res!: Awaited<ReturnType<typeof result.current.pause.run>>;
    await act(async () => {
      res = await result.current.pause.run();
    });

    // An id-scoped action with no bound id must fail loudly, not fire the adapter with `undefined`.
    expect(pause).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeInstanceOf(Error);
  });
});

describe("useCronotonActions — pending brackets the in-flight call", () => {
  it("flips pending true while the adapter call is in flight and false once it settles", async () => {
    const d = deferred<{ ok: true; status: string; nextFireAt: null }>();
    const pause = vi.fn(() => d.promise);
    const adapter = makeAdapter({ pause: pause as unknown as KhronotonAdapter["pause"] });
    const { result } = renderHook(() => useCronotonActions("c1"), { wrapper: makeWrapper(adapter) });

    expect(result.current.pause.pending).toBe(false);

    let runPromise!: ReturnType<typeof result.current.pause.run>;
    act(() => {
      runPromise = result.current.pause.run();
    });

    await waitFor(() => expect(result.current.pause.pending).toBe(true));

    await act(async () => {
      d.resolve({ ok: true, status: "paused", nextFireAt: null });
      await runPromise;
    });

    expect(result.current.pause.pending).toBe(false);
  });
});

describe("useCronotonActions — confirm-gate re-prompt (normalizes the Hub retry-once)", () => {
  it("re-prompts and retries EXACTLY once when the confirm expired and the host re-confirms", async () => {
    const pause = vi
      .fn()
      .mockRejectedValueOnce(new NeedsConfirmError())
      .mockResolvedValueOnce({ ok: true, status: "paused", nextFireAt: null });
    const onNeedConfirm = vi.fn(async () => true);
    const adapter = makeAdapter({ pause: pause as unknown as KhronotonAdapter["pause"] });
    const { result } = renderHook(() => useCronotonActions("c1"), {
      wrapper: makeWrapper(adapter, { onNeedConfirm }),
    });

    let res!: Awaited<ReturnType<typeof result.current.pause.run>>;
    await act(async () => {
      res = await result.current.pause.run();
    });

    // Initial call + exactly one retry; the retry re-sends the fresh-confirm signal.
    expect(pause).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenNthCalledWith(2, "c1", { confirmed: true });
    expect(onNeedConfirm).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ ok: true, status: "paused", nextFireAt: null });
  });

  it("surfaces the expired-confirm error with NO retry when the host declines the re-confirm", async () => {
    const expired = new NeedsConfirmError();
    const pause = vi.fn().mockRejectedValue(expired);
    const onNeedConfirm = vi.fn(async () => false);
    const adapter = makeAdapter({ pause: pause as unknown as KhronotonAdapter["pause"] });
    const { result } = renderHook(() => useCronotonActions("c1"), {
      wrapper: makeWrapper(adapter, { onNeedConfirm }),
    });

    let res!: Awaited<ReturnType<typeof result.current.pause.run>>;
    await act(async () => {
      res = await result.current.pause.run();
    });

    // A declined re-confirm must not fire the adapter a second time.
    expect(pause).toHaveBeenCalledTimes(1);
    expect(onNeedConfirm).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(expired);
    await waitFor(() => expect(result.current.pause.error).toBe(expired));
  });

  it("surfaces a plain transport error immediately without re-prompting or retrying", async () => {
    const boom = new Error("HTTP 500");
    const del = vi.fn().mockRejectedValue(boom);
    const onNeedConfirm = vi.fn(async () => true);
    const adapter = makeAdapter({ delete: del as unknown as KhronotonAdapter["delete"] });
    const { result } = renderHook(() => useCronotonActions("c1"), {
      wrapper: makeWrapper(adapter, { onNeedConfirm }),
    });

    let res!: Awaited<ReturnType<typeof result.current.remove.run>>;
    await act(async () => {
      res = await result.current.remove.run();
    });

    // Only an expired-confirm signal triggers the re-prompt path; a plain error does not.
    expect(del).toHaveBeenCalledTimes(1);
    expect(onNeedConfirm).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(boom);
  });

  it("signals an SSR-style refetch via onSuccess after a successful mutation, but not after a failure", async () => {
    const onSuccess = vi.fn();
    const boom = new Error("HTTP 409");
    const pause = vi.fn(async () => ({ ok: true, status: "paused", nextFireAt: null }));
    const del = vi.fn().mockRejectedValue(boom);
    const adapter = makeAdapter({
      pause: pause as unknown as KhronotonAdapter["pause"],
      delete: del as unknown as KhronotonAdapter["delete"],
    });
    const { result } = renderHook(() => useCronotonActions("c1", { onSuccess }), {
      wrapper: makeWrapper(adapter),
    });

    await act(async () => {
      await result.current.pause.run();
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.remove.run();
    });
    // A failed mutation must not trigger the refetch.
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
