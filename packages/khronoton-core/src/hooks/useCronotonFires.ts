/**
 * `useCronotonFires(id, opts?)` — the offset-paged fire history for one cronoton,
 * plus **poller #1** (REQ-PH06): a cadence-driven silent refetch that runs only
 * while a fire on the current page is still `running`.
 *
 * Paging is by OFFSET (`offset = page * pageSize`) so every page is reachable
 * (REQ-G08); the page size defaults to the provider's config (50) and an
 * `opts.pageSize` overrides it. The explicit load (mount / page change / manual
 * `refetch`) owns `loading` + `error`; the poller does NOT — a gated public poll
 * that 401s is a transient blip, so its errors are swallowed and never surface.
 *
 * SSR-safe: the fetch + the interval live in browser-only effects behind a
 * `typeof window` guard, so no adapter call and no poller starts during a server
 * render. The interval tears down on unmount, when nothing is `running`, and on
 * `id`/page change.
 *
 * Stale-response safety: the explicit load effect owns a per-run `active` token
 * its cleanup flips false, so when `id`/page changes a slow in-flight
 * `fires(prevKey)` that resolves AFTER the newer load is dropped rather than
 * overwriting the fresh page. (The `mountedRef` below only flips on unmount, so
 * it alone cannot supersede a key change — the token is what does.)
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useKhronotonAdapter, useKhronotonConfig } from "../provider/context.js";
import type { CodexCronotonFireRow } from "../server/index.js";

export interface UseCronotonFiresOptions {
  /** Overrides the provider's page size (default 50) for this history view. */
  pageSize?: number;
}

export interface UseCronotonFiresResult {
  fires: CodexCronotonFireRow[];
  total: number;
  page: number;
  pageCount: number;
  loading: boolean;
  error: Error | null;
  setPage: (page: number) => void;
  refetch: () => void;
}

export function useCronotonFires(
  id: string,
  opts: UseCronotonFiresOptions = {},
): UseCronotonFiresResult {
  const adapter = useKhronotonAdapter();
  const config = useKhronotonConfig();
  const pageSize = opts.pageSize ?? config.pageSize;
  const cadence = config.pollCadenceMs;

  const [fires, setFires] = useState<CodexCronotonFireRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPageState] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const offset = page * pageSize;

  // Latest total, read by `setPage`'s clamp without adding `total` as a dep.
  const totalRef = useRef(0);
  totalRef.current = total;

  const setPage = useCallback(
    (next: number) => {
      const maxPage = Math.max(0, Math.ceil(totalRef.current / pageSize) - 1);
      setPageState(Math.min(Math.max(0, Math.floor(next)), maxPage));
    },
    [pageSize],
  );

  // Guard state writes against a fetch that resolves after unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Explicit page load — mount, id/page/pageSize change, manual refetch. This
  // path owns `loading`/`error`; the poller deliberately does not. `isActive`
  // gates every setState: the load effect passes a per-run token its cleanup
  // flips false (dropping a superseded id/page's late resolve); the manual
  // refetch defaults to the mounted-flag (dropping only a post-unmount resolve).
  const load = useCallback(
    async (isActive: () => boolean = () => mountedRef.current) => {
      setLoading(true);
      setError(null);
      try {
        const res = await adapter.fires({ id, limit: pageSize, offset });
        if (!isActive()) return;
        setFires(res.fires);
        setTotal(res.total);
      } catch (err) {
        if (!isActive()) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (isActive()) setLoading(false);
      }
    },
    [adapter, id, pageSize, offset],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    let active = true;
    void load(() => active);
    return () => {
      active = false;
    };
  }, [load]);

  const anyRunning = fires.some((f) => f.status === "running");

  // Poller #1: while a fire on the current page is `running`, silently refetch
  // the page every cadence. Poll errors are swallowed (a transient gated 401 must
  // not surface) and never touch `loading`/`error`. When the page no longer holds
  // a running fire, `anyRunning` flips false and this effect's cleanup clears the
  // interval — the same teardown as unmount and id/page change.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!anyRunning) return;

    const timer = setInterval(() => {
      adapter
        .fires({ id, limit: pageSize, offset })
        .then((res) => {
          if (!mountedRef.current) return;
          setFires(res.fires);
          setTotal(res.total);
        })
        .catch(() => {
          // Swallowed: a poll blip is transient and never a user-facing error.
        });
    }, cadence);

    return () => clearInterval(timer);
  }, [anyRunning, adapter, id, pageSize, offset, cadence]);

  return { fires, total, page, pageCount, loading, error, setPage, refetch: () => void load() };
}
