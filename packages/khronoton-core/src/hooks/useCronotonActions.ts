/**
 * Lifecycle action hooks — create / edit / pause / resume / delete.
 *
 * Every mutation runs through the shared {@link runGated} confirm-retry helper
 * (the single re-prompt implementation, T4.5): it calls the adapter method with
 * the fresh-confirm signal, and if the backend's confirm gate has expired it asks
 * the host to re-confirm (`config.onNeedConfirm`) and retries EXACTLY once. This
 * normalizes the Hub's detail-page no-retry inconsistency — one behaviour
 * everywhere.
 *
 * Each action exposes a `{ run, pending, error, result }` surface:
 *  - `run(args)` resolves to `{ ok:true, result }` on success or
 *    `{ ok:false, error }` on failure (a cancelled re-confirm, a second expiry,
 *    or a plain transport error). It never throws — the host reads the returned
 *    envelope and surfaces the error itself (no hardcoded `alert`).
 *  - `pending` is true only while the call is in flight.
 *  - a successful mutation fires the optional `onSuccess` callback so the host
 *    can run its SSR-style refetch; a failure does not.
 *
 * SSR-safe by construction: no adapter call fires on mount — every call is
 * user-triggered — so nothing touches the network or `window` during a server
 * render.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useKhronotonAdapter, useKhronotonConfig } from "../provider/context.js";
import { runGated, type GatedFn } from "../provider/runGated.js";
import type {
  CommitView,
  EditView,
  ToggleView,
  DeleteView,
  EditPatch,
} from "../provider/adapter.js";
import type { CommitBody } from "../handlers/index.js";

/** A successful action: the adapter body, untouched. */
export interface ActionOk<T> {
  ok: true;
  result: T;
}

/** A failed action: a cancelled re-confirm, a second expiry, or a transport error. */
export interface ActionFail {
  ok: false;
  error: Error;
}

/** The envelope every `run` resolves to — the host branches on `ok`. */
export type ActionResult<T> = ActionOk<T> | ActionFail;

/** One lifecycle action's public surface. */
export interface GatedAction<Args extends unknown[], T> {
  run: (...args: Args) => Promise<ActionResult<T>>;
  pending: boolean;
  error: Error | null;
  result: T | null;
}

export type CreateAction = GatedAction<[CommitBody], CommitView>;
export type EditAction = GatedAction<[EditPatch], EditView>;
export type ToggleAction = GatedAction<[], ToggleView>;
export type DeleteAction = GatedAction<[], DeleteView>;

/** The bundle `useCronotonActions` returns. */
export interface CronotonActions {
  create: CreateAction;
  edit: EditAction;
  pause: ToggleAction;
  resume: ToggleAction;
  remove: DeleteAction;
}

export interface UseCronotonActionsOptions {
  /** Fired after any successful mutation — the host's SSR-style refetch hook. */
  onSuccess?: () => void;
}

/**
 * Drive one gated action: bracket the call with `pending`, route it through
 * `runGated`, and expose the settled `result`/`error`. `makeCall` builds the
 * confirm-gated function from the run args; it may throw synchronously (e.g. a
 * missing bound id) — that surfaces as a clean failure, never an adapter call.
 */
function useGatedAction<Args extends unknown[], T>(
  makeCall: (...args: Args) => GatedFn<T>,
  onNeedConfirm: (() => Promise<boolean>) | undefined,
  onSuccess: (() => void) | undefined,
): GatedAction<Args, T> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<T | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (...args: Args): Promise<ActionResult<T>> => {
      setPending(true);
      setError(null);
      try {
        const body = await runGated(makeCall(...args), { onNeedConfirm });
        if (mounted.current) {
          setResult(body);
          setPending(false);
        }
        onSuccess?.();
        return { ok: true, result: body };
      } catch (err) {
        const surfaced = err instanceof Error ? err : new Error(String(err));
        if (mounted.current) {
          setError(surfaced);
          setPending(false);
        }
        return { ok: false, error: surfaced };
      }
    },
    [makeCall, onNeedConfirm, onSuccess],
  );

  return { run, pending, error, result };
}

/** Guard an id-scoped action: fail loudly rather than call the adapter with `undefined`. */
function requireId(id: string | undefined, action: string): string {
  if (id == null) {
    throw new Error(`useCronotonActions: an id is required to ${action} a cronoton`);
  }
  return id;
}

/**
 * The lifecycle action bundle. Pass the detail-page `id` to scope
 * edit/pause/resume/remove to that cronoton; `create` needs no id. Every action
 * is confirm-gated with the shared retry-once re-prompt.
 */
export function useCronotonActions(
  id?: string,
  options: UseCronotonActionsOptions = {},
): CronotonActions {
  const adapter = useKhronotonAdapter();
  const config = useKhronotonConfig();
  const { onNeedConfirm } = config;
  const { onSuccess } = options;

  const create = useGatedAction<[CommitBody], CommitView>(
    useCallback((body: CommitBody) => (opts) => adapter.commit(body, opts), [adapter]),
    onNeedConfirm,
    onSuccess,
  );

  const edit = useGatedAction<[EditPatch], EditView>(
    useCallback(
      (patch: EditPatch) => {
        const target = requireId(id, "edit");
        return (opts) => adapter.edit(target, patch, opts);
      },
      [adapter, id],
    ),
    onNeedConfirm,
    onSuccess,
  );

  const pause = useGatedAction<[], ToggleView>(
    useCallback(() => {
      const target = requireId(id, "pause");
      return (opts) => adapter.pause(target, opts);
    }, [adapter, id]),
    onNeedConfirm,
    onSuccess,
  );

  const resume = useGatedAction<[], ToggleView>(
    useCallback(() => {
      const target = requireId(id, "resume");
      return (opts) => adapter.resume(target, opts);
    }, [adapter, id]),
    onNeedConfirm,
    onSuccess,
  );

  const remove = useGatedAction<[], DeleteView>(
    useCallback(() => {
      const target = requireId(id, "delete");
      return (opts) => adapter.delete(target, opts);
    }, [adapter, id]),
    onNeedConfirm,
    onSuccess,
  );

  return { create, edit, pause, resume, remove };
}
