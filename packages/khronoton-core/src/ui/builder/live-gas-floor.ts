/**
 * `useLiveGasFloor()` — the single polled source of the live StoaChain gas
 * floor for the Builder UI. `Builder.tsx` calls this once and threads the
 * result to `ConfigTab`/`ExecuteTab` (both display the floor to the operator)
 * as a `liveFloorAnu` prop, rather than three independent polling components
 * drifting against each other.
 *
 * Dynamically imports `{ minGasPriceAnu }` from `@stoachain/stoa-core/gas` —
 * an optional peer (see `package.json`), same pattern already established by
 * `../tx-size.ts` — and calls it with the current Unix-seconds clock. Returns
 * `null` until the first resolution, and degrades gracefully (stays `null`,
 * never throws into render) if the optional peer isn't resolvable or the call
 * otherwise fails.
 *
 * Refreshes on: a 30s `setInterval` (the floor rises roughly every 3h, so this
 * cadence is a wide margin), a `visibilitychange` listener that re-fetches
 * when the tab becomes visible again, and a `focus` listener on `window`. The
 * interval/visibilitychange/focus backstop exists because `setInterval` is
 * throttled or fully suspended in backgrounded tabs by most browsers, and this
 * screen is routinely left open for hours.
 */
import { useEffect, useState } from "react";

const POLL_INTERVAL_MS = 30_000;

export function useLiveGasFloor(): number | null {
  const [floorAnu, setFloorAnu] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let active = true;

    const refresh = async () => {
      try {
        const { minGasPriceAnu } = await import("@stoachain/stoa-core/gas");
        const value = minGasPriceAnu(Math.floor(Date.now() / 1000));
        if (active) setFloorAnu(value);
      } catch {
        // Optional peer not installed (or the call otherwise failed) — stay
        // whatever the last known-good value was (null on first mount), never
        // throw into render.
      }
    };

    void refresh();

    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onFocus = () => void refresh();

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);

    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return floorAnu;
}
