/**
 * `useCronotons()` — the cronoton-LIST data hook (blueprint §3). It reads the
 * injected adapter from the provider context and loads `adapter.list(query)` in a
 * browser-only mount effect, exposing an SSR-style `refetch()` the action hooks
 * (Phase E) call after a mutation to re-read the server-ordered rows.
 *
 * ── SSR-safety (REQ-PH01) ─────────────────────────────────────────────────────
 * No adapter call fires during render: the load lives entirely in `useEffect`,
 * which never runs on the server. A server render therefore returns the empty
 * pre-fetch state (`loading:true`, `cronotons:[]`) without touching the backend.
 *
 * ── Error surfacing (REQ-PH04) + stale-response safety ────────────────────────
 * This is an EXPLICIT user load, not a poller, so a load failure is NOT swallowed
 * — a thrown adapter error lands in `error`. Each load effect owns a per-run
 * `active` token its cleanup flips false, so when the query changes a slow
 * in-flight `list(prevQuery)` that resolves AFTER the newer load is dropped
 * rather than overwriting the fresh rows. A mounted-flag additionally guards the
 * manual `refetch` against a post-unmount resolve.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useKhronotonAdapter } from "../provider/context.js";
import type { ListCronotonsQuery } from "../provider/adapter.js";
import type { CodexCronotonRow } from "../server/index.js";

/** The `useCronotons()` return shape — the list, its load state, and a refetch. */
export interface UseCronotonsView {
  cronotons: CodexCronotonRow[];
  loading: boolean;
  error: Error | null;
  /** Re-run the load (SSR-style refresh the action hooks call after a mutation). */
  refetch: () => Promise<void>;
}

export function useCronotons(query?: ListCronotonsQuery): UseCronotonsView {
  const adapter = useKhronotonAdapter();
  const [cronotons, setCronotons] = useState<CodexCronotonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Serialize the query so the load identity is stable across renders that pass
  // an equal-but-new query object (a fresh `{}` every render would otherwise loop).
  const queryKey = JSON.stringify(query ?? null);

  // `isActive` gates every setState: the load effect passes a per-run token its
  // cleanup flips false (dropping a superseded query's late resolve); the manual
  // refetch defaults to the mounted-flag (dropping only a post-unmount resolve).
  const load = useCallback(
    async (isActive: () => boolean = () => mountedRef.current) => {
      setLoading(true);
      setError(null);
      try {
        const view = await adapter.list(query);
        if (!isActive()) return;
        setCronotons(view.codexCronotons);
      } catch (err) {
        if (!isActive()) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (isActive()) setLoading(false);
      }
      // `query` is captured via the serialized `queryKey`; `adapter` is stable per mount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [adapter, queryKey],
  );

  useEffect(() => {
    let active = true;
    void load(() => active);
    return () => {
      active = false;
    };
  }, [load]);

  return { cronotons, loading, error, refetch: () => load() };
}
