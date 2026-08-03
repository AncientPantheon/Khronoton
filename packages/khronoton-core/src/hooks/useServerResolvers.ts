/**
 * `useServerResolvers()` — the server-resolver-REGISTRY data hook. It reads the
 * injected adapter from the provider context and loads the registered server
 * resolvers (with their authoritative `evented` flag) from `GET /resolvers`
 * exactly once on mount, mirroring `useCronotons`'s once-fetch/`active`-token
 * pattern. The Builder consumes it to make event-driven-ness server-authoritative.
 *
 * ── OPTIONAL adapter method (0.7.0) ───────────────────────────────────────────
 * `adapter.resolvers` is OPTIONAL — an adapter predating 0.7.0 (or one whose
 * backend can't serve `/resolvers`) simply omits it. A missing method, a failed
 * fetch, and the pre-load state ALL surface as an empty `resolvers` array without
 * throwing or blocking the Builder: the caller degrades to its other signal (the
 * 0.6.0 `serverResolverOptions.eventDriven`).
 *
 * ── SSR-safety + stale-response safety ────────────────────────────────────────
 * No adapter call fires during render — the load lives entirely in `useEffect`
 * (never runs on the server). A per-run `active` token its cleanup flips false
 * drops a resolve that lands after unmount.
 */
import { useEffect, useState } from "react";

import { useKhronotonAdapter } from "../provider/context.js";
import type { ResolversView } from "../provider/adapter.js";

/** The `useServerResolvers()` return shape — the registry, its load state. */
export interface UseServerResolversView {
  /** The registered resolvers + their `evented` flag; `[]` before load / on error / when unsupported. */
  resolvers: ResolversView["resolvers"];
  loading: boolean;
  error: Error | null;
}

export function useServerResolvers(): UseServerResolversView {
  const adapter = useKhronotonAdapter();
  const [resolvers, setResolvers] = useState<ResolversView["resolvers"]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // `resolvers` is OPTIONAL: an adapter that lacks it degrades to an empty list
    // (no throw, no blocked Builder). Capture the method after the guard so its
    // narrowing survives into the async closure.
    const fetchResolvers = adapter.resolvers;
    if (typeof fetchResolvers !== "function") {
      setResolvers([]);
      setError(null);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const view = await fetchResolvers();
        if (!active) return;
        setResolvers(view.ok ? view.resolvers : []);
      } catch (err) {
        if (!active) return;
        setResolvers([]);
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [adapter]);

  return { resolvers, loading, error };
}
