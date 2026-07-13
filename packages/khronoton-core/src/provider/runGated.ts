/**
 * `runGated` — the SHARED confirm-retry helper every mutating action hook reuses.
 *
 * The backend confirm gate passes only when a call carries a fresh admin-confirm
 * (`req.confirmed === true`). A stale/absent confirm surfaces as a thrown
 * {@link NeedsConfirmError}. This helper is the single place that reacts to that
 * signal: it runs the adapter method with `confirmed:true`, and if the gate
 * refuses, asks the host to re-confirm and retries EXACTLY ONCE. It normalizes
 * the Hub's detail-page no-retry inconsistency — one behaviour everywhere.
 *
 * Contract:
 *  - success  → resolves with the method's body untouched (callers branch on
 *    `result.ok`; a 200-on-`ok:false` body is a success here, not a throw).
 *  - expired  → on `NeedsConfirmError`, call `onNeedConfirm()`; if it resolves
 *    true, retry once; if false (or absent), surface the error.
 *  - a second expiry after the retry, or any non-confirm error, surfaces
 *    immediately (the retry is a single step, never a loop).
 */
import { NeedsConfirmError } from "./adapter.js";

/** The confirm-gated call: the provider threads the fresh-confirm signal in. */
export type GatedFn<T> = (opts: { confirmed: boolean }) => Promise<T>;

export interface RunGatedOptions {
  /**
   * The host re-confirm gate. Resolves `true` when the user re-confirms after an
   * expiry (triggering the single retry) and `false` on cancel. When omitted, an
   * expired confirm surfaces without a retry.
   */
  onNeedConfirm?: () => Promise<boolean>;
}

export async function runGated<T>(
  fn: GatedFn<T>,
  options: RunGatedOptions = {},
): Promise<T> {
  const { onNeedConfirm } = options;
  try {
    return await fn({ confirmed: true });
  } catch (err) {
    if (err instanceof NeedsConfirmError && onNeedConfirm) {
      const reconfirmed = await onNeedConfirm();
      if (reconfirmed) {
        return await fn({ confirmed: true });
      }
    }
    throw err;
  }
}
