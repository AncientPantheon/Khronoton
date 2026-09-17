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

/**
 * `"Simulation postponed"` + the optional planned-transaction-count detail,
 * e.g. `"Simulation postponed — 3 planned transactions."`. `ExecuteTab.tsx`
 * and `SaveBar.tsx` both surface a `SimulateView.postponed` result and used
 * to each carry their own byte-identical copy of this pluralization — the
 * same drift risk `formatThousands`'s own history (see the file doc above)
 * already burned this package on once.
 */
export function postponedMessage(plannedCount?: number): string {
  const detail =
    typeof plannedCount === "number"
      ? ` — ${plannedCount} planned transaction${plannedCount === 1 ? "" : "s"}`
      : "";
  return `Simulation postponed${detail}.`;
}
