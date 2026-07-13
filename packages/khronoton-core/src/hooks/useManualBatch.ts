/**
 * `useManualBatch(id)` — the manual-execute-batch read hook plus **poller #2**
 * (REQ-PH06): while a batch is `active`, it re-reads `adapter.getBatch(id)` every
 * `config.pollCadenceMs` so the Phase-E detail view shows live `completed/total`
 * progress without a manual refresh. The second of the layer's two independent 5s
 * pollers (poller #1 is fires-while-running in `useCronotonFires`).
 *
 * Two fetch paths, deliberately different in error handling:
 *  - `refetch` / mount load  — an EXPLICIT read: a failure surfaces in `error`.
 *  - the poll tick           — a BACKGROUND read: failures are SWALLOWED (a public
 *    viewer's gated poll 401s silently — no user-facing error), so the interval
 *    keeps ticking through a transient reject and never flips `error`.
 *
 * SSR-safe (REQ-PH01): the load and the interval both live in `useEffect`, which
 * never runs during a server render — so no adapter call fires and no poller
 * starts on the server.
 *
 * Stale-response safety: the mount-load effect owns a per-run `active` token its
 * cleanup flips false, so when `id` changes a slow in-flight `getBatch(prevId)`
 * that resolves AFTER the newer load is dropped rather than overwriting the fresh
 * batch. (The `mountedRef` only flips on unmount, so it alone cannot supersede a
 * key change — the token is what does; `mountedRef` still guards the manual
 * `refetch` against a post-unmount resolve.)
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useKhronotonAdapter, useKhronotonConfig } from "../provider/context.js";
import type { ManualBatchView } from "../server/index.js";

/** The `useManualBatch` return surface the Phase-E detail view consumes. */
export interface UseManualBatchResult {
  /** The current batch projection, or `null` when the cronoton has no active batch. */
  batch: ManualBatchView | null;
  /** `true` while a batch is running — the poller-live / show-progress flag. */
  active: boolean;
  /** `true` from mount until the first explicit load settles. */
  loading: boolean;
  /** An explicit-load failure (mount or `refetch`); poll failures never set this. */
  error: Error | null;
  /** Re-read the batch on demand (e.g. after a start/cancel action elsewhere). */
  refetch: () => Promise<void>;
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function useManualBatch(id: string): UseManualBatchResult {
  const adapter = useKhronotonAdapter();
  const config = useKhronotonConfig();

  const [batch, setBatch] = useState<ManualBatchView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Explicit read: mount + `refetch`. A failure IS surfaced (unlike the poll).
  // `isActive` gates every setState: the mount effect passes a per-run token its
  // cleanup flips false (dropping a superseded id's late resolve); the manual
  // refetch defaults to the mounted-flag (dropping only a post-unmount resolve).
  const read = useCallback(
    async (isActive: () => boolean = () => mountedRef.current) => {
      setLoading(true);
      try {
        const res = await adapter.getBatch(id);
        if (!isActive()) return;
        setBatch(res.batch);
        setError(null);
      } catch (cause) {
        if (!isActive()) return;
        setError(toError(cause));
      } finally {
        if (isActive()) setLoading(false);
      }
    },
    [adapter, id],
  );

  const refetch = useCallback(() => read(), [read]);

  useEffect(() => {
    let active = true;
    void read(() => active);
    return () => {
      active = false;
    };
  }, [read]);

  const active = batch?.status === "active";

  // Poller #2: only runs while active. Keyed on `active` so the status flip to
  // completed/cancelled (or null) tears the interval down via the cleanup return;
  // keyed on `id`/cadence so it restarts cleanly if either changes. Poll errors
  // are swallowed so a transient reject neither sets `error` nor stops the poll.
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      void adapter
        .getBatch(id)
        .then((res) => {
          if (mountedRef.current) setBatch(res.batch);
        })
        .catch(() => {
          // Background poll — swallow (a gated public poll 401s silently).
        });
    }, config.pollCadenceMs);
    return () => clearInterval(interval);
  }, [active, adapter, id, config.pollCadenceMs]);

  return { batch, active, loading, error, refetch };
}
