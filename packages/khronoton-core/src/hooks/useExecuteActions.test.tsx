// @vitest-environment jsdom
//
// Execution action-hook suite. Opts into jsdom via the top-of-file docblock (the
// convention every `*.test.tsx` in this phase copies); the global vitest env
// stays `node` for the engine/handler suites. @testing-library/react's cleanup
// is registered explicitly because this repo runs without `globals: true`.
//
// These hooks are the execution tier of the action layer: executeNow / trigger /
// simulate / startBatch / recover run the adapter method BEHIND the shared
// `runGated` confirm helper, while cancelBatch is the deliberate confirm-FREE
// one-click stop (a runaway batch must halt in a single click). The suite pins
// two contracts a Phase-E consumer relies on: the 200-on-`ok:false` bodies are a
// NORMAL result (never a thrown error), and cancelBatch skips the gate entirely.

import { describe, it, expect, afterEach, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook, act, cleanup } from "@testing-library/react";

import { KhronotonProvider } from "../provider/KhronotonProvider.js";
import { NeedsConfirmError } from "../provider/adapter.js";
import type { KhronotonAdapter, StartBatchView } from "../provider/adapter.js";
import {
  useExecuteNow,
  useTrigger,
  useSimulate,
  useStartBatch,
  useCancelBatch,
  useRecoverFire,
} from "./useExecuteActions.js";

afterEach(() => {
  cleanup();
});

/**
 * A complete 16-method fake adapter whose execution methods are overridable. The
 * read/lifecycle methods are inert mocks (never exercised here) so `assertAdapter`
 * passes at mount; the caller replaces just the execution method under test.
 */
function makeAdapter(overrides: Partial<KhronotonAdapter> = {}): KhronotonAdapter {
  const inert = () => vi.fn(async () => ({ ok: true }));
  return {
    list: inert(),
    get: inert(),
    fires: inert(),
    signers: inert(),
    commit: inert(),
    edit: inert(),
    pause: inert(),
    resume: inert(),
    delete: inert(),
    simulate: inert(),
    executeNow: inert(),
    trigger: inert(),
    startBatch: inert(),
    getBatch: inert(),
    cancelBatch: inert(),
    recover: inert(),
    ...overrides,
  } as unknown as KhronotonAdapter;
}

function makeWrapper(
  adapter: KhronotonAdapter,
  onNeedConfirm?: () => Promise<boolean>,
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <KhronotonProvider adapter={adapter} onNeedConfirm={onNeedConfirm}>
        {children}
      </KhronotonProvider>
    );
  };
}

describe("useExecuteNow — fire outside schedule (confirm-gated)", () => {
  it("resolves a successful fire as result.ok true with the requestKey, threading a fresh confirm", async () => {
    const executeNow = vi.fn(async () => ({
      ok: true as const,
      fireId: "fire_1",
      requestKey: "rk_success",
    }));
    const adapter = makeAdapter({ executeNow });
    const { result } = renderHook(() => useExecuteNow(), {
      wrapper: makeWrapper(adapter),
    });

    await act(async () => {
      await result.current.run("cron_1");
    });

    // The gate threads confirmed:true so the backend confirm check passes.
    expect(executeNow).toHaveBeenCalledWith("cron_1", { confirmed: true });
    expect(result.current.result?.ok).toBe(true);
    expect(result.current.result?.requestKey).toBe("rk_success");
    // A 200 success is never an error.
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBe(false);
  });

  it("surfaces a fire-level {ok:false,error} as a NORMAL result — not a thrown error (200-on-ok:false)", async () => {
    const executeNow = vi.fn(async () => ({
      ok: false as const,
      error: "chain rejected the tx",
    }));
    const adapter = makeAdapter({ executeNow });
    const { result } = renderHook(() => useExecuteNow(), {
      wrapper: makeWrapper(adapter),
    });

    let returned: unknown;
    await act(async () => {
      returned = await result.current.run("cron_1");
    });

    // A fire-level failure rides in the body: it is a result, NOT error.
    expect(result.current.result?.ok).toBe(false);
    expect(result.current.result?.error).toBe("chain rejected the tx");
    expect(result.current.error).toBeNull();
    // run returns the body so the caller can branch on ok without re-reading state.
    expect((returned as { ok: boolean }).ok).toBe(false);
  });

  it("surfaces the 202 multi-tx queued path as result.queued", async () => {
    const executeNow = vi.fn(async () => ({
      ok: true as const,
      fireId: "fire_q",
      queued: true,
    }));
    const adapter = makeAdapter({ executeNow });
    const { result } = renderHook(() => useExecuteNow(), {
      wrapper: makeWrapper(adapter),
    });

    await act(async () => {
      await result.current.run("cron_1");
    });

    expect(result.current.result?.queued).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("re-prompts and retries exactly once when the confirm gate expired and the host re-confirms", async () => {
    const executeNow = vi
      .fn()
      .mockRejectedValueOnce(new NeedsConfirmError())
      .mockResolvedValueOnce({ ok: true, fireId: "fire_retry", requestKey: "rk_retry" });
    const onNeedConfirm = vi.fn(async () => true);
    const adapter = makeAdapter({ executeNow });
    const { result } = renderHook(() => useExecuteNow(), {
      wrapper: makeWrapper(adapter, onNeedConfirm),
    });

    await act(async () => {
      await result.current.run("cron_1");
    });

    // Initial call + exactly one retry, both carrying the fresh confirm.
    expect(executeNow).toHaveBeenCalledTimes(2);
    expect(onNeedConfirm).toHaveBeenCalledTimes(1);
    expect(result.current.result?.requestKey).toBe("rk_retry");
    expect(result.current.error).toBeNull();
  });

  it("surfaces a transport error as error (not a result) and leaves result undefined", async () => {
    const executeNow = vi.fn().mockRejectedValue(new Error("HTTP 500"));
    const adapter = makeAdapter({ executeNow });
    const { result } = renderHook(() => useExecuteNow(), {
      wrapper: makeWrapper(adapter),
    });

    await act(async () => {
      await result.current.run("cron_1");
    });

    expect(result.current.error?.message).toBe("HTTP 500");
    expect(result.current.result).toBeUndefined();
  });
});

describe("useTrigger — fire with runtime args (confirm-gated)", () => {
  it("passes the id and runtime args through the gate to the adapter", async () => {
    const trigger = vi.fn(async () => ({
      ok: true as const,
      fireId: "fire_t",
      requestKey: "rk_t",
    }));
    const adapter = makeAdapter({ trigger });
    const { result } = renderHook(() => useTrigger(), {
      wrapper: makeWrapper(adapter),
    });

    await act(async () => {
      await result.current.run("cron_1", { amount: "10", to: "k:abc" });
    });

    expect(trigger).toHaveBeenCalledWith(
      "cron_1",
      { amount: "10", to: "k:abc" },
      { confirmed: true },
    );
    expect(result.current.result?.requestKey).toBe("rk_t");
  });
});

describe("useSimulate — preview the tx (confirm-gated)", () => {
  it("returns the full simulate union unchanged for the Phase-E builder to read", async () => {
    const simulate = vi.fn(async () => ({
      ok: true as const,
      calibratedGasLimit: 1200,
      gasUsed: 900,
      postponed: false,
      plannedCount: 3,
    }));
    const adapter = makeAdapter({ simulate });
    const { result } = renderHook(() => useSimulate(), {
      wrapper: makeWrapper(adapter),
    });

    const envelope = { pactCode: "(coin.transfer ...)" };
    await act(async () => {
      await result.current.run(envelope);
    });

    expect(simulate).toHaveBeenCalledWith(envelope, { confirmed: true });
    expect(result.current.result?.calibratedGasLimit).toBe(1200);
    expect(result.current.result?.plannedCount).toBe(3);
    expect(result.current.result?.postponed).toBe(false);
  });

  it("surfaces a simulate {ok:false} as a result, not a thrown error (200-on-ok:false)", async () => {
    const simulate = vi.fn(async () => ({
      ok: false as const,
      error: "gas estimation failed",
    }));
    const adapter = makeAdapter({ simulate });
    const { result } = renderHook(() => useSimulate(), {
      wrapper: makeWrapper(adapter),
    });

    await act(async () => {
      await result.current.run({ pactCode: "(bad)" });
    });

    expect(result.current.result?.ok).toBe(false);
    expect(result.current.result?.error).toBe("gas estimation failed");
    expect(result.current.error).toBeNull();
  });
});

describe("useStartBatch — begin a manual batch (confirm-gated)", () => {
  it("passes the id and count through the gate and returns the started batch", async () => {
    const startBatch = vi.fn(async () => ({
      ok: true as const,
      // Intentionally a partial batch projection — the test asserts only the id
      // round-trips; cast so the fixture satisfies the StartBatchView return type.
      batch: { id: "batch_1" } as unknown as StartBatchView["batch"],
    }));
    const adapter = makeAdapter({ startBatch });
    const { result } = renderHook(() => useStartBatch(), {
      wrapper: makeWrapper(adapter),
    });

    await act(async () => {
      await result.current.run("cron_1", 10);
    });

    expect(startBatch).toHaveBeenCalledWith("cron_1", 10, { confirmed: true });
    expect(result.current.result?.batch).toEqual({ id: "batch_1" });
  });
});

describe("useCancelBatch — one-click stop (confirm-FREE)", () => {
  it("cancels WITHOUT the confirm gate — works even when the host would deny a re-confirm", async () => {
    const cancelBatch = vi.fn(async () => ({ ok: true as const, cancelled: true }));
    // A gate that DENIES: if cancel routed through runGated it would be blocked
    // on an expiry. cancel must never touch the gate — a runaway batch stops in
    // one click.
    const onNeedConfirm = vi.fn(async () => false);
    const adapter = makeAdapter({ cancelBatch });
    const { result } = renderHook(() => useCancelBatch(), {
      wrapper: makeWrapper(adapter, onNeedConfirm),
    });

    await act(async () => {
      await result.current.run("cron_1");
    });

    // Called directly with only the id — no confirm opts, no runGated.
    expect(cancelBatch).toHaveBeenCalledWith("cron_1");
    // The confirm gate is never consulted for a cancel.
    expect(onNeedConfirm).not.toHaveBeenCalled();
    expect(result.current.result?.cancelled).toBe(true);
    expect(result.current.error).toBeNull();
  });
});

describe("useRecoverFire — reconcile a stale failed fire (confirm-gated)", () => {
  it("passes (id, fireId, requestKey) through the gate to the adapter", async () => {
    const requestKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"; // 42 chars, matches the handler shape
    const recover = vi.fn(async () => ({
      ok: true as const,
      fireId: "fire_r",
      requestKey,
    }));
    const adapter = makeAdapter({ recover });
    const { result } = renderHook(() => useRecoverFire(), {
      wrapper: makeWrapper(adapter),
    });

    await act(async () => {
      await result.current.run("cron_1", "fire_r", requestKey);
    });

    expect(recover).toHaveBeenCalledWith("cron_1", "fire_r", requestKey, {
      confirmed: true,
    });
    expect(result.current.result?.requestKey).toBe(requestKey);
  });

  it("surfaces a 404 'No failed fire to recover' as error (not a result)", async () => {
    const recover = vi.fn().mockRejectedValue(new Error("No failed fire to recover"));
    const adapter = makeAdapter({ recover });
    const { result } = renderHook(() => useRecoverFire(), {
      wrapper: makeWrapper(adapter),
    });

    await act(async () => {
      await result.current.run("cron_1", "fire_missing", "rk");
    });

    expect(result.current.error?.message).toBe("No failed fire to recover");
    expect(result.current.result).toBeUndefined();
  });
});
