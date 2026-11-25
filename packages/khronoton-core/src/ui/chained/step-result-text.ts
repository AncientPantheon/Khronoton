/**
 * formatStepResult — a PURE, deterministic one-line rendering of a chained
 * step's outcome, built FROM the already-structured yield the engine captures
 * (a single step's on-chain `result.data`, a planner step's reported `yield`),
 * NEVER parsed back out of a formatted string.
 *
 * This is the presentation layer the owner asked for ("a deterministic Result
 * Text per step"): the value is kept structured end-to-end; this helper only
 * renders it for a log / the dry-run panel. Same inputs → byte-identical line.
 *
 * Grammar (compact, log-friendly):
 *   <Name> · Step <k>/<N> · ok · yields <name> = <json>
 *   <Name> · Step <k>/<N> · ok                              (no yield)
 *   <Name> · Step <k>/<N> · FAILED · <error>                (failed)
 *
 * The JSON uses stable (sorted) keys so two equal objects render identically
 * regardless of how each was built — the determinism the owner wants.
 *
 * Zero imports (browser-safe, leaf): it takes only the fields it needs, not any
 * engine/server type, so it is trivially testable and reusable from either the
 * UI (dry-run outcomes) or a server-side fire log (real captured yields).
 */

export interface StepResultInput {
  /** The cronoton's name; falls back to "Cronoton" when blank. */
  cronotonName?: string;
  /** 0-based index of this step (so step 0 renders as "Step 1/N"). */
  stepIndex: number;
  /** Total steps in the chain (the N in "k/N"). */
  totalSteps: number;
  /** Did the step succeed? */
  ok: boolean;
  /** The name this step's yield was captured under (its `yield_as`), if any. */
  yieldAs?: string;
  /** The structured value captured as this step's yield (undefined = none). */
  yielded?: unknown;
  /** The failure reason, when `ok` is false. */
  error?: string;
}

/** Deterministic JSON: object keys sorted, so equal values stringify identically. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function formatStepResult(input: StepResultInput): string {
  const name = (input.cronotonName ?? "").trim() || "Cronoton";
  const k = input.stepIndex + 1;
  const head = `${name} · Step ${k}/${input.totalSteps}`;

  if (!input.ok) {
    const why = (input.error ?? "").trim();
    return why ? `${head} · FAILED · ${why}` : `${head} · FAILED`;
  }

  const yields =
    input.yieldAs && input.yielded !== undefined
      ? ` · yields ${input.yieldAs} = ${stableStringify(input.yielded)}`
      : "";
  return `${head} · ok${yields}`;
}
