import { useEffect, useState } from "react";
import type { ReactNode } from "react";

const SECOND = 1000;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Below this proximity the label ticks every second so "just now" flips live;
 *  beyond it a slow 30s cadence suffices since the visible label barely moves. */
const NEAR_WINDOW_MS = 60 * SECOND;
const FAST_CADENCE_MS = 1 * SECOND;
const SLOW_CADENCE_MS = 30 * SECOND;

/**
 * Pure relative-time formatter. `nowMs` is passed in (never read from
 * `Date.now()` here) so every output bucket is deterministically unit-testable.
 * Buckets: "just now" (<60s either side) · "{m}m" · "{h}h {m}m" · "{d}d {h}h",
 * prefixed "in " for future targets and suffixed " ago" for past ones.
 */
export function formatRelative(fromISO: string, nowMs: number): string {
  const targetMs = Date.parse(fromISO);
  if (!Number.isFinite(targetMs)) return "";

  const deltaMs = targetMs - nowMs;
  const future = deltaMs > 0;
  const absSec = Math.floor(Math.abs(deltaMs) / SECOND);

  if (absSec < MINUTE) return "just now";

  let magnitude: string;
  if (absSec < HOUR) {
    magnitude = `${Math.floor(absSec / MINUTE)}m`;
  } else if (absSec < DAY) {
    const hours = Math.floor(absSec / HOUR);
    const minutes = Math.floor((absSec % HOUR) / MINUTE);
    magnitude = `${hours}h ${minutes}m`;
  } else {
    const days = Math.floor(absSec / DAY);
    const hours = Math.floor((absSec % DAY) / HOUR);
    magnitude = `${days}d ${hours}h`;
  }

  return future ? `in ${magnitude}` : `${magnitude} ago`;
}

export interface RelativeTimeProps {
  /** ISO-8601 timestamp to render relative to the current instant. */
  iso: string;
  /** Extra classes merged after the component renders as a `<time>` element. */
  className?: string;
}

/**
 * Self-refreshing relative-time label. Re-renders on an interval whose cadence
 * tracks proximity (1s within a minute, 30s otherwise) and tears the interval
 * down on unmount. SSR-safe: no window/timer is touched during a server render —
 * the initial label is computed synchronously and the interval only arms in the
 * browser effect.
 */
export function RelativeTime({ iso, className }: RelativeTimeProps): ReactNode {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const targetMs = Date.parse(iso);
  const withinMinute = Number.isFinite(targetMs) && Math.abs(targetMs - nowMs) < NEAR_WINDOW_MS;

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const cadence = withinMinute ? FAST_CADENCE_MS : SLOW_CADENCE_MS;
    const id = setInterval(() => setNowMs(Date.now()), cadence);
    return () => clearInterval(id);
  }, [iso, withinMinute]);

  return (
    <time dateTime={iso} title={iso} className={className} style={{ color: "var(--khr-text-dim)" }}>
      {formatRelative(iso, nowMs)}
    </time>
  );
}
