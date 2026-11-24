/**
 * Pure, browser-safe validation for a chained codex-cronoton's step list.
 *
 * Zero imports (no node, no server, no React) so BOTH sides share one rule set:
 * the package's chained-commit path and the chained builder UI (live inline
 * feedback as the operator edits). Returns a result object instead of throwing so
 * the UI can render the reason without a try/catch; the commit handler maps
 * `!ok` to its typed validation error.
 *
 * Ported verbatim (logic-for-logic) from the AncientHoldings Hub's own
 * `lib/codex-cronoton/chain-validation.ts`, which this package now subsumes so
 * every khronoton consumer shares one chained rule set.
 *
 * The checks turn a run-time failure into an author-time reject:
 *   1. mode / pact-vs-planner coherence (the DB CHECK, but with a clear message).
 *   2. yield graph: every `yieldAs` unique; every `{"$yield":"n"}` resolves to an
 *      EARLIER step — a forward/self/dangling ref is a guaranteed failure at fire.
 *   3. decimal-amount tripwire: a bare-integer string under an `*amount*` key
 *      (Pact needs `/^\d+\.\d+$/` — "50.0", not "50").
 */

/** One step of a chained cronoton, as the author supplies it (pre-insert). */
export interface ChainedStepInput {
  mode: "single" | "planner";
  /** Required when mode='single'. The step's own Pact code. */
  pactCode?: string;
  /** Per-step tx config (chainId, gas, ttl). */
  config?: unknown;
  /** Per-step payload (env-data); may contain `{"$yield":"name"}` references. */
  payload?: unknown;
  gasPayer?: unknown;
  signers?: unknown;
  /** Required when mode='planner'. A registered planner name (e.g. 'ouronet.stoa-wrap'). */
  plannerName?: string;
  /** Planner params; may contain `{"$yield":"name"}` references. */
  plannerParams?: unknown;
  idempotent?: boolean;
  /** Names what this step's confirmed return value (single) / planner yield
   *  (planner) is stored as, for a LATER step to reference via `$yield`. */
  yieldAs?: string;
}

export type ChainValidation = { ok: true } | { ok: false; reason: string };

/**
 * The operator-composed single-tx variant of the whole chain (khronoton-core
 * `try_single_tx_first` / `single_tx_mode:'custom'`). When single-tx-first is
 * enabled, the parent row's OWN top-level pact/config/payload/gasPayer/signers
 * ARE this variant — the engine simulates it first and falls back to the step
 * chain only when that one tx is too expensive to mine. So the variant is a
 * complete one-shot cronoton definition, not a fragment.
 */
export interface SingleTxVariantInput {
  /** Required. The whole chain expressed as one Pact transaction (e.g. a `let`
   *  bundling every step), gas-station-payable. */
  pactCode?: string;
  config?: unknown;
  /** A single tx has no run, no yields — a flat one-shot payload. */
  payload?: unknown;
  gasPayer?: unknown;
  signers?: unknown;
}

/**
 * True for a plain object whose OWN keys are exactly `["$yield"]` and whose
 * `$yield` value is a string — the one shape the engine's own
 * `yields.ts#isYieldPlaceholder` treats as a resolvable reference rather than
 * an ordinary object. Kept in sync with (but not imported from — this module
 * is deliberately zero-import) that function so a sibling key can never make
 * validation vouch for a reference the engine will never substitute.
 */
function isYieldRefShape(value: unknown): value is { $yield: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return (
    keys.length === 1 &&
    keys[0] === "$yield" &&
    typeof (value as Record<string, unknown>).$yield === "string"
  );
}

/**
 * Walk any value and collect every `{"$yield":"<name>"}` reference's name. A
 * `$yield` object is a ref leaf — not recursed into.
 */
export function collectYieldRefs(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) collectYieldRefs(v, acc);
    return acc;
  }
  if (isYieldRefShape(value)) {
    acc.add(value.$yield);
    return acc;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj)) collectYieldRefs(obj[k], acc);
  }
  return acc;
}

/**
 * The first bare-integer string found under an `*amount*` key (case-insensitive)
 * that is NOT a `$yield` ref, or null. "50" is flagged, "50.0" passes, and
 * `{"$yield":"drained"}` is left to the engine to resolve.
 */
export function findBadDecimalAmount(
  value: unknown,
  keyName: string | null = null,
): string | null {
  if (Array.isArray(value)) {
    for (const v of value) {
      const bad = findBadDecimalAmount(v, keyName);
      if (bad) return bad;
    }
    return null;
  }
  if (isYieldRefShape(value)) return null; // a yield ref — not a literal
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const bad = findBadDecimalAmount(obj[k], k);
      if (bad) return bad;
    }
    return null;
  }
  if (
    typeof value === "string" &&
    keyName !== null &&
    /amount/i.test(keyName) &&
    /^\d+$/.test(value)
  ) {
    return `${keyName}="${value}"`;
  }
  return null;
}

/**
 * Validate the chain's structure. Returns `{ok:true}` or `{ok:false, reason}`
 * (the first problem found). See the module header for the checks.
 */
export function validateChain(steps: ChainedStepInput[]): ChainValidation {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, reason: "a chained cronoton needs at least one step" };
  }

  const declaredByIndex: Array<string | undefined> = [];
  const seenYieldNames = new Set<string>();

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    // 1. mode / pact-vs-planner coherence.
    if (step.mode === "single") {
      if (typeof step.pactCode !== "string" || step.pactCode.trim() === "") {
        return { ok: false, reason: `step ${i}: a 'single' step requires a non-empty pactCode` };
      }
    } else if (step.mode === "planner") {
      if (typeof step.plannerName !== "string" || step.plannerName.trim() === "") {
        return { ok: false, reason: `step ${i}: a 'planner' step requires a plannerName` };
      }
    } else {
      return { ok: false, reason: `step ${i}: mode must be 'single' or 'planner'` };
    }

    // 2a. yieldAs uniqueness.
    if (step.yieldAs !== undefined) {
      if (typeof step.yieldAs !== "string" || step.yieldAs.trim() === "") {
        return { ok: false, reason: `step ${i}: yieldAs must be a non-empty string` };
      }
      if (seenYieldNames.has(step.yieldAs)) {
        return {
          ok: false,
          reason: `step ${i}: yieldAs '${step.yieldAs}' is already declared by an earlier step`,
        };
      }
      seenYieldNames.add(step.yieldAs);
    }
    declaredByIndex[i] = step.yieldAs;

    // 3. decimal-amount tripwire (payload + planner params).
    const bad = findBadDecimalAmount(step.payload) ?? findBadDecimalAmount(step.plannerParams);
    if (bad) {
      return {
        ok: false,
        reason: `step ${i}: ${bad} must be a Pact decimal string (e.g. "50.0", not "50")`,
      };
    }
  }

  // 2b. every `$yield` reference resolves to a name declared by an EARLIER step.
  for (let i = 0; i < steps.length; i += 1) {
    const refs = new Set<string>();
    collectYieldRefs(steps[i].payload, refs);
    collectYieldRefs(steps[i].plannerParams, refs);
    for (const name of refs) {
      const declaredAt = declaredByIndex.findIndex((y) => y === name);
      if (declaredAt === -1) {
        return { ok: false, reason: `step ${i}: references $yield '${name}' which no step declares` };
      }
      if (declaredAt >= i) {
        return {
          ok: false,
          reason: `step ${i}: references $yield '${name}' declared at step ${declaredAt} — a step may only reference an EARLIER step's yield`,
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Validate the optional single-tx-first variant. The engine requires the row to
 * carry a real one-shot definition in its own top-level fields, so the ONE thing
 * we guarantee at author time is a non-empty Pact body. A `$yield` placeholder
 * here is a mistake (a single tx has no run/yield pool), so it is NOT resolved; a
 * bare decimal-amount string is still caught by the shared tripwire.
 */
export function validateSingleTxVariant(v: SingleTxVariantInput): ChainValidation {
  if (typeof v.pactCode !== "string" || v.pactCode.trim() === "") {
    return {
      ok: false,
      reason:
        "single-tx-first requires a non-empty single-tx Pact body (the whole chain expressed as one transaction)",
    };
  }
  const refs = collectYieldRefs(v.payload);
  if (refs.size > 0) {
    return {
      ok: false,
      reason: `single-tx variant: $yield reference '${[...refs][0]}' is not allowed — a single transaction has no run to carry yields`,
    };
  }
  const bad = findBadDecimalAmount(v.payload);
  if (bad) {
    return {
      ok: false,
      reason: `single-tx variant: ${bad} must be a Pact decimal string (e.g. "50.0", not "50")`,
    };
  }
  return { ok: true };
}
