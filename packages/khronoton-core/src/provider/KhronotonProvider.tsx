/**
 * `<KhronotonProvider>` — the drop-in root the consumer mounts. It validates the
 * injected adapter, resolves the config defaults, and exposes both via React
 * context. SSR-safe by construction (blueprint §2, REQ-PH01): the guard is pure,
 * the per-mount value is built with `useRef`, and the only stateful init sits in
 * a browser-only effect that never runs during a server render — so no adapter
 * call or poller fires on the server.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { assertAdapter } from "./adapter.js";
import {
  KhronotonStaticContext,
  KhronotonStatusContext,
  resolveConfig,
  type KhronotonProviderProps,
  type KhronotonStaticContextValue,
  type KhronotonStatusContextValue,
} from "./context.js";

export function KhronotonProvider(props: KhronotonProviderProps): ReactNode {
  const { children } = props;

  // Build the static value ONCE per mount. `assertAdapter` runs synchronously
  // here so a host that passes an incomplete adapter fails loudly at mount — on
  // the server and the client alike (the guard touches no browser globals).
  const staticRef = useRef<KhronotonStaticContextValue | null>(null);
  if (staticRef.current === null) {
    assertAdapter(props.adapter);
    staticRef.current = { adapter: props.adapter, config: resolveConfig(props) };
  }

  const [status, setStatus] = useState<KhronotonStatusContextValue>({
    ready: false,
    error: null,
  });

  // Browser-only init: effects never run during SSR, so `ready` stays false
  // through a server render and flips true only after the client mounts.
  useEffect(() => {
    setStatus({ ready: true, error: null });
  }, []);

  return (
    <KhronotonStaticContext.Provider value={staticRef.current}>
      <KhronotonStatusContext.Provider value={status}>
        {children}
      </KhronotonStatusContext.Provider>
    </KhronotonStaticContext.Provider>
  );
}
