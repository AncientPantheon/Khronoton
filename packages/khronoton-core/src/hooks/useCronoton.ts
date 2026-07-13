/**
 * `useCronoton(id)` — the single-cronoton data hook (blueprint §3). It reads the
 * injected adapter from the provider context and loads `adapter.get(id)` in a
 * browser-only mount effect, re-fetching whenever `id` changes so a detail view
 * can switch rows live. It exposes the row's current state for the detail screen
 * but does NOT own the fires poller (that is `useCronotonFires`).
 *
 * ── Not-found (mirrors the handler 404) ───────────────────────────────────────
 * A missing row makes the read handler return 404, which the shared status map
 * throws as an `Error`; the hook surfaces that in `error` and keeps `cronoton`
 * null rather than showing a phantom row.
 *
 * ── SSR-safety (REQ-PH01) + stale-response safety ─────────────────────────────
 * The load lives entirely in `useEffect`, so no adapter call fires during a
 * server render. Each load effect owns a per-run `active` token that its cleanup
 * flips false, so when `id` changes a slow in-flight `get(prevId)` that resolves
 * AFTER the newer `get(id)` is dropped rather than overwriting the fresh row. A
 * mounted-flag additionally guards the manual `refetch` against a post-unmount
 * resolve.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useKhronotonAdapter } from "../provider/context.js";
import type { CodexCronotonRow } from "../server/index.js";

/** The `useCronoton()` return shape — the row, its load state, and a refetch. */
export interface UseCronotonView {
  cronoton: CodexCronotonRow | null;
  loading: boolean;
  error: Error | null;
  /** Re-run the load (SSR-style refresh the action hooks call after a mutation). */
  refetch: () => Promise<void>;
}

export function useCronoton(id: string): UseCronotonView {
  const adapter = useKhronotonAdapter();
  const [cronoton, setCronoton] = useState<CodexCronotonRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // `isActive` gates every setState: the load effect passes a per-run token that
  // its cleanup flips false (dropping a superseded id's late resolve); the manual
  // refetch defaults to the mounted-flag (dropping only a post-unmount resolve).
  const load = useCallback(
    async (isActive: () => boolean = () => mountedRef.current) => {
      setLoading(true);
      setError(null);
      try {
        const view = await adapter.get(id);
        if (!isActive()) return;
        setCronoton(view.codexCronoton);
      } catch (err) {
        if (!isActive()) return;
        setCronoton(null);
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (isActive()) setLoading(false);
      }
    },
    [adapter, id],
  );

  useEffect(() => {
    let active = true;
    void load(() => active);
    return () => {
      active = false;
    };
  }, [load]);

  return { cronoton, loading, error, refetch: () => load() };
}
