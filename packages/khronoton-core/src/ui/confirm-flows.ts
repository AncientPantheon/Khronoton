/**
 * Confirm-flow UX helper — the native `window.confirm`/`alert` layer the screens
 * wrap around a mutation, sitting ONE step before the confirm-gate the action
 * hooks already own.
 *
 * Two responsibilities the Hub couples into every mutation handler, split out here
 * so the generic package reproduces them byte-for-byte:
 *
 *  1. The verbatim confirm/alert copy (delete, pause/resume, execute, trigger,
 *     batch start/cancel, and the normalized re-confirm line). These are the exact
 *     strings from the parity inventory §1/§2 — a consumer must not paraphrase them.
 *  2. A thin `withConfirm` orchestrator: prompt with the native confirm, run the
 *     mutation only on accept, surface a failure via `window.alert` (the Hub has no
 *     toasts — REQ-L07/§6), and fire the host's SSR-style refresh on success.
 *
 * The confirm-gate itself (fresh-confirm → `NeedsConfirmError` → re-prompt + retry)
 * lives in `runGated` and the action hooks — this helper NEVER re-implements it. It
 * only adds the UI prompt, the alert, and the refresh callback.
 *
 * SSR-safe: the browser `confirm`/`alert` are read lazily and only touched inside a
 * real browser. Tests inject the seams so nothing depends on jsdom.
 */

/** A cronoton lifecycle verb for the shared pause/resume prompt. */
export type PauseResumeVerb = "pause" | "resume";

/**
 * Delete's native `window.confirm` — shown BEFORE the gated password step. Warns
 * that the fire history is destroyed alongside the cronoton.
 */
export function deleteConfirm(name: string): string {
  return `Delete codex cronoton "${name}"? Fire history is removed too.`;
}

/** Delete's gated password-confirm message (the second, in-gate prompt). */
export function deletePasswordConfirm(name: string): string {
  return `Confirm to delete codex cronoton "${name}".`;
}

/** Pause/resume confirm — one message, the verb interpolated (never blended). */
export function pauseResumeConfirm(verb: PauseResumeVerb): string {
  return `Confirm to ${verb} this codex cronoton.`;
}

/** List-screen "Execute Now" confirm — flags the immediate on-chain fire. */
export function listExecuteConfirm(name: string): string {
  return `Confirm to execute "${name}" now (fires immediately on-chain).`;
}

/** Detail-screen "Execute Now" confirm — flags firing outside the schedule. */
export function detailExecuteConfirm(name: string): string {
  return `Confirm to fire "${name}" now, outside its schedule.`;
}

/** Runtime-arg "Trigger" confirm — fires now with the supplied args. */
export function triggerConfirm(name: string): string {
  return `Confirm to trigger "${name}" now with the supplied runtime args.`;
}

/**
 * Manual-batch "Execute ×N" start confirm.
 *
 * NOTE: the parity inventory truncates this line as `…{n} times, once per minute…`;
 * the full Hub string is not captured in the recon. Reconstructed here to match the
 * "Confirm to …" family and the idle copy ("Fire N times, once per minute (2–60)").
 * T5.10 owns the batch card and can pin the exact wording if it differs.
 */
export function startBatchConfirm(count: number): string {
  return `Confirm to execute this codex cronoton ${count} times, once per minute.`;
}

/** Manual-batch cancel — the native `window.confirm` (the cancel path is confirm-free at the gate). */
export const cancelBatchConfirm =
  "Cancel the running batch? Fires already done remain; no further fires happen.";

/**
 * The re-confirm line when a stale confirm expires. The Hub's detail page showed a
 * different, no-retry message ("Confirmation expired. Please try again.") — this is
 * the NORMALIZED list wording used everywhere (REQ-D03).
 */
export const reConfirmExpired = "Your confirmation expired. Please re-confirm.";

/** The native `window.confirm`, or `undefined` outside a browser (SSR-safe). */
function browserConfirm(): ((message: string) => boolean) | undefined {
  return typeof window !== "undefined" ? window.confirm.bind(window) : undefined;
}

/** The native `window.alert`, or `undefined` outside a browser (SSR-safe). */
function browserAlert(): ((message: string) => void) | undefined {
  return typeof window !== "undefined" ? window.alert.bind(window) : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A lifecycle `ActionFail`: `{ ok:false, error:Error }`. Distinguished from a
 * 200-on-`ok:false` execution view (whose `error` is a STRING) by the `Error`
 * instance — only the lifecycle failure is alerted; the execution view is a normal
 * result the screen renders itself.
 */
function isActionFail(value: unknown): value is { ok: false; error: Error } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    (value as { error?: unknown }).error instanceof Error
  );
}

/** Injectable seams + the SSR-refresh callback for {@link withConfirm}. */
export interface WithConfirmOptions {
  /** The confirm prompt (defaults to `window.confirm`; inject in tests / to skip). */
  confirm?: (message: string) => boolean;
  /** The failure alert (defaults to `window.alert`; the Hub's no-toast pattern). */
  alert?: (message: string) => void;
  /** The host's SSR-style refresh, fired once on a successful run. */
  onSuccess?: () => void;
}

/**
 * Wrap a mutation in the native confirm → run → alert-on-failure → refresh-on-success
 * flow. `run` is an action-hook `run` (never throws — it resolves an `ActionResult`
 * or a 200-on-`ok:false` view), but a thrown error is still handled defensively.
 *
 *  - decline           → resolves `undefined`; `run` is never called.
 *  - thrown error      → `alert(err.message)`; resolves `undefined`; no refresh.
 *  - lifecycle failure → `{ ok:false, error:Error }` → `alert(error.message)`; no
 *                        refresh; the envelope is returned so the caller can branch.
 *  - success           → fires `onSuccess`; resolves the run's value (including a
 *                        200-on-`ok:false` execution view, which is a normal result).
 *
 * SSR-safe: with no injected `confirm` and no browser `window`, it declines silently
 * rather than prompt (a mutation only runs from a real user click in the browser).
 */
export async function withConfirm<T>(
  message: string,
  run: () => Promise<T>,
  options: WithConfirmOptions = {},
): Promise<T | undefined> {
  const confirmFn = options.confirm ?? browserConfirm();
  const alertFn = options.alert ?? browserAlert();

  if (!confirmFn || !confirmFn(message)) return undefined;

  let result: T;
  try {
    result = await run();
  } catch (err) {
    alertFn?.(errorMessage(err));
    return undefined;
  }

  if (isActionFail(result)) {
    alertFn?.(result.error.message);
    return result;
  }

  options.onSuccess?.();
  return result;
}
