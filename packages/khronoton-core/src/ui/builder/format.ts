/**
 * Small display-formatting helpers shared across the Builder's tabs/meter,
 * so the same figure (e.g. a gas amount) can never render differently in
 * two places at once. `formatThousands` used to be copied verbatim into
 * `ConfigTab.tsx`, `ExecuteTab.tsx`, and `TxMeters.tsx` — three independent
 * copies of the exact locale-pinning logic the shared-figure guarantee
 * depends on, which is itself the drift risk a shared helper avoids.
 */

/** Thousands-grouped integer, e.g. 42000 → "42,000" (locale-pinned to en-US). */
export function formatThousands(n: number): string {
  return n.toLocaleString("en-US");
}
