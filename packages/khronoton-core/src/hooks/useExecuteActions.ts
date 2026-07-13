/**
 * Execution action hooks — the mutating "fire" tier of the Khronoton hook API
 * (`executeNow`, `trigger`, `simulate`, `startBatch`, `cancelBatch`, `recover`).
 *
 * Every hook returns the same `{ run, pending, error, result? }` shape and reads
 * the adapter + confirm-gate from the provider context. Two contracts define this
 * tier:
 *
 *  1. CONFIRM-GATED vs CONFIRM-FREE. executeNow / trigger / simulate / startBatch /
 *     recover run their adapter method THROUGH `runGated` — the confirm-gate fires
 *     first, and a stale-confirm `NeedsConfirmError` re-prompts + retries once.
 *     `cancelBatch` is the deliberate exception: a runaway manual batch must stop
 *     in a single click, so cancel calls the adapter DIRECTLY, never through the
 *     gate (REQ-H09).
 *
 *  2. 200-on-`ok:false` IS A RESULT, NOT AN ERROR. executeNow / trigger / simulate
 *     resolve at HTTP 200 even when the body's own `ok` is false (a chain/build
 *     failure rides in `body.error`, or `queued:true` marks the 202 multi-tx path).
 *     The adapter returns that body untouched; these hooks surface it as `result`
 *     so the UI can render "Fired · requestKey {rk}" or the error line. Only a real
 *     transport error or a declined confirm surfaces via `error` (a thrown path).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useKhronotonAdapter, useKhronotonConfig } from "../provider/context.js";
import { runGated } from "../provider/runGated.js";
import type { KhronotonAdapter } from "../provider/adapter.js";
import type {
  ExecuteView,
  SimulateView,
  StartBatchView,
  CancelBatchView,
  RecoverView,
  SimulateEnvelope,
} from "../provider/adapter.js";
import type { RuntimeArgs } from "../server/index.js";

/**
 * The shared execution-action result. `run` performs the action and returns the
 * adapter body on success (or `undefined` when the call threw), while `pending`,
 * `error`, and `result` mirror the last invocation for render.
 */
export interface UseExecuteActionResult<TArgs extends unknown[], TView> {
  /** Perform the action; resolves the adapter body, or `undefined` on a thrown error. */
  run: (...args: TArgs) => Promise<TView | undefined>;
  /** True while `run` is in flight. */
  pending: boolean;
  /** A transport/confirm failure (a thrown path). Never set for a 200-on-`ok:false` body. */
  error: Error | null;
  /** The last successful adapter body — including a fire-level `{ ok:false }`. */
  result?: TView;
}

interface ActionState<TView> {
  pending: boolean;
  error: Error | null;
  result?: TView;
}

const IDLE: ActionState<never> = { pending: false, error: null };

/**
 * The engine behind every execution hook: run `invoke`, track pending/error/result,
 * and guard against a state update after unmount. `invoke` receives the resolved
 * adapter so callers thread the specific method (gated or confirm-free).
 */
function useExecuteAction<TArgs extends unknown[], TView>(
  invoke: (adapter: KhronotonAdapter, ...args: TArgs) => Promise<TView>,
): UseExecuteActionResult<TArgs, TView> {
  const adapter = useKhronotonAdapter();
  const [state, setState] = useState<ActionState<TView>>(IDLE);

  // A mounted flag keeps a late-resolving action from setting state on an
  // unmounted tree (the user may navigate away mid-fire).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (...args: TArgs): Promise<TView | undefined> => {
      setState({ pending: true, error: null });
      try {
        const result = await invoke(adapter, ...args);
        if (mounted.current) setState({ pending: false, error: null, result });
        return result;
      } catch (err) {
        if (mounted.current) {
          setState({ pending: false, error: err as Error });
        }
        return undefined;
      }
    },
    // `invoke` is a stable module-level function per hook; the adapter identity is
    // stable per mount — so `run` only re-creates if the mounted adapter changes.
    [adapter, invoke],
  );

  return { run, pending: state.pending, error: state.error, result: state.result };
}

/** Fire a cronoton once, right now, outside its schedule (confirm-gated). */
export function useExecuteNow(): UseExecuteActionResult<[id: string], ExecuteView> {
  const { onNeedConfirm } = useKhronotonConfig();
  return useExecuteAction(
    useCallback(
      (adapter: KhronotonAdapter, id: string) =>
        runGated((opts) => adapter.executeNow(id, opts), { onNeedConfirm }),
      [onNeedConfirm],
    ),
  );
}

/** Fire a cronoton now with supplied runtime args (confirm-gated). */
export function useTrigger(): UseExecuteActionResult<
  [id: string, args: RuntimeArgs],
  ExecuteView
> {
  const { onNeedConfirm } = useKhronotonConfig();
  return useExecuteAction(
    useCallback(
      (adapter: KhronotonAdapter, id: string, args: RuntimeArgs) =>
        runGated((opts) => adapter.trigger(id, args, opts), { onNeedConfirm }),
      [onNeedConfirm],
    ),
  );
}

/** Preview a tx build/gas without firing it (confirm-gated; full union returned). */
export function useSimulate(): UseExecuteActionResult<
  [envelope: SimulateEnvelope],
  SimulateView
> {
  const { onNeedConfirm } = useKhronotonConfig();
  return useExecuteAction(
    useCallback(
      (adapter: KhronotonAdapter, envelope: SimulateEnvelope) =>
        runGated((opts) => adapter.simulate(envelope, opts), { onNeedConfirm }),
      [onNeedConfirm],
    ),
  );
}

/** Start a manual execute-batch of `count` fires (confirm-gated). */
export function useStartBatch(): UseExecuteActionResult<
  [id: string, count: number],
  StartBatchView
> {
  const { onNeedConfirm } = useKhronotonConfig();
  return useExecuteAction(
    useCallback(
      (adapter: KhronotonAdapter, id: string, count: number) =>
        runGated((opts) => adapter.startBatch(id, count, opts), { onNeedConfirm }),
      [onNeedConfirm],
    ),
  );
}

/**
 * Cancel the active manual batch — CONFIRM-FREE (REQ-H09). Deliberately bypasses
 * `runGated`: a runaway batch must halt in one click, never blocked on a
 * confirm-gate expiry.
 */
export function useCancelBatch(): UseExecuteActionResult<[id: string], CancelBatchView> {
  return useExecuteAction(
    useCallback((adapter: KhronotonAdapter, id: string) => adapter.cancelBatch(id), []),
  );
}

/** Reconcile a stale failed fire against the chain (confirm-gated; REQ-G09). */
export function useRecoverFire(): UseExecuteActionResult<
  [id: string, fireId: string, requestKey: string],
  RecoverView
> {
  const { onNeedConfirm } = useKhronotonConfig();
  return useExecuteAction(
    useCallback(
      (adapter: KhronotonAdapter, id: string, fireId: string, requestKey: string) =>
        runGated((opts) => adapter.recover(id, fireId, requestKey, opts), {
          onNeedConfirm,
        }),
      [onNeedConfirm],
    ),
  );
}
