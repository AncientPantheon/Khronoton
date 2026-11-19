/**
 * `ouronet.aqp-inject` — the "Inject Reward" step planner, ported from
 * OuronetUI's `fvtOwnerSpecs.tsx` (`INJECT_FINALIZE`) and `aqpConsumerSpecs.tsx`
 * (`INJECT_FVT`, the real `CC_Inject`/inline-repair entrypoint — it does NOT
 * live in `fvtOwnerSpecs.tsx` despite the similar naming) — a different
 * workspace entirely: `OuroborosNetwork/daimons/OuronetUI`. See design.md's
 * §D for the full port rationale.
 *
 * Shape: unlike `evictPlanner`, this planner has no on-chain plan read and no
 * fan-out leg shape at all — it tries the cheap `CC_InjectFinalize` path
 * first (correct once a preceding `ouronet.aqp-unstall` step has already
 * repaired every stale member in slices), falls back to the heavier
 * inline-repair `CC_Inject` when that fails, and reports a genuine failure
 * when BOTH fail rather than inventing any further recovery.
 */
import { executeCodexTransaction } from "../executor.js";
import type { CodexCronotonStepRow } from "../store/steps.js";
import type { CodexGasPayer, CodexSigner, CodexTxConfig } from "../types.js";
import {
  registerStepPlanner,
  type PlannedLeg,
  type PlannerCtx,
  type StepPlanner,
} from "./registry.js";

/** Mirrors `store/mappers.ts`'s own one-line helper — duplicated locally per the plan rather than importing a private function from another module. */
function parseJson<T>(json: string | null, fallback: T): T {
  if (json == null) return fallback;
  return JSON.parse(json) as T;
}

/** `injectPlanner`'s own `planner_params_json` shape. */
interface InjectPlannerParams {
  fvtId: string;
  patronAccount: string;
  rewardDptfId: string;
  /**
   * A STRING, not a JS `number` — real money moved out of `patronAccount`'s
   * custody (`XI_FvtInjectCore`/`XE_FvtInjectCore` debit exactly `amount`
   * tokens). Kept as a string specifically to avoid floating-point precision
   * loss before Pact's own `read-decimal` interprets it on-chain.
   */
  amount: string;
}

/**
 * Drives one `mode:'planner'` step registered under `ouronet.aqp-inject`:
 *
 * 1. Parse `fvtId`/`patronAccount`/`rewardDptfId`/`amount` from
 *    `step.planner_params_json`. Derive `executor = k:<the step's own first
 *    signer's publicKey>` — identical validation shape to `evictPlanner`'s
 *    own.
 * 2. Probe `CC_InjectFinalize` as one candidate leg; a successful simulate
 *    → exactly that one leg.
 * 3. Else probe `CC_Inject` (same five env-data fields); a successful
 *    simulate → exactly that one leg.
 * 4. Else — never fans out, never silently succeeds — rethrow regardless
 *    of whether the second failure's `gasUsed` is a number (unlike
 *    `evictPlanner`, which fans out on a numeric `gasUsed`; `injectPlanner`
 *    has no fan-out leg shape to produce at all — a too-expensive
 *    `CC_Inject` here means staleness reappeared after the preceding
 *    `ouronet.aqp-unstall` step already ran, a narrow race this planner
 *    reports as a genuine failure rather than inventing recovery logic the
 *    real ported source itself never needed).
 */
export const injectPlanner: StepPlanner = async (
  step: CodexCronotonStepRow,
  ctx: PlannerCtx,
): Promise<PlannedLeg[]> => {
  const params = parseJson<Partial<InjectPlannerParams>>(step.planner_params_json, {});
  if (
    typeof params.fvtId !== "string" ||
    typeof params.patronAccount !== "string" ||
    typeof params.rewardDptfId !== "string" ||
    typeof params.amount !== "string"
  ) {
    throw new Error(
      "ouronet.aqp-inject: step.planner_params_json must have fvtId, patronAccount, rewardDptfId, and amount strings",
    );
  }
  const { fvtId, patronAccount, rewardDptfId, amount } = params;

  // Non-negative decimal format only — this rejects a malformed/negative
  // amount BEFORE it reaches a signed transaction, as cheap defense-in-depth
  // on top of the contract's own business-rule enforcement (which this
  // planner still trusts for anything beyond shape, same as `evictPlanner`'s
  // own "trust the contract" posture). Pact's `read-decimal` itself requires
  // a decimal literal (at least one digit on each side of a mandatory `.`),
  // so a bare integer string like "5" is intentionally also rejected here.
  if (!/^\d+\.\d+$/.test(amount)) {
    throw new Error(
      `ouronet.aqp-inject: amount must be a non-negative decimal string (e.g. "5.0"), got ${JSON.stringify(amount)}`,
    );
  }

  const signers = parseJson<CodexSigner[]>(step.signers_json, []);
  if (signers.length === 0) {
    throw new Error(
      "ouronet.aqp-inject: step.signers_json must have at least one signer (used as the executor)",
    );
  }
  const executor = `k:${signers[0].publicKey}`;

  const config = parseJson<CodexTxConfig>(step.config_json, {} as CodexTxConfig);
  const gasPayer = parseJson<CodexGasPayer>(step.gas_payer_json, { type: "gas-station" });

  const executorCtx = { runtime: ctx.runtime, resolver: ctx.resolver, config: ctx.config };

  // `ouronet-ns.AQP-FVT` — the module's REAL, deployed, namespaced path
  // (confirmed against the ported source's own `fvtOwnerSpecs.tsx`/
  // `aqpConsumerSpecs.tsx` entrypoint strings and `05_FVT.pact`'s own
  // `(namespace "ouronet-ns")` declaration; a bare `AQP-FVT.*` reference is
  // unresolvable by Pact's namespace mechanism). Built from
  // `ctx.runtime.namespace`, never hardcoded, so a consumer on a different
  // namespace isn't silently wrong. NOTE: this is a DIFFERENT module than
  // `evictPlanner`'s own `AQP-EVCT`.
  const fvt = `${ctx.runtime.namespace}.AQP-FVT`;

  // Every value below flows through `payload` (env-data, `addData` per
  // `executor.ts`'s `buildTransaction`) and is read back with
  // `read-string`/`read-decimal` in `pactCode` — NEVER string-concatenated
  // into the Pact source itself, mirroring `evictPlanner`'s own
  // "no code-injection surface" guarantee (see that module's doc comment for
  // the vulnerability this closes).

  const payload = {
    patron: patronAccount,
    executor,
    "fvt-id": fvtId,
    "reward-dptf-id": rewardDptfId,
    amount,
  };

  const finalizeLeg: PlannedLeg = {
    pactCode: `(${fvt}.CC_InjectFinalize (read-string "patron") (read-string "executor") (read-string "fvt-id") (read-string "reward-dptf-id") (read-decimal "amount"))`,
    config,
    payload,
    gasPayer,
    signers,
  };
  const finalizeResult = await executeCodexTransaction(finalizeLeg, "simulate", executorCtx);
  if (finalizeResult.ok) {
    return [finalizeLeg];
  }

  const injectLeg: PlannedLeg = {
    pactCode: `(${fvt}.CC_Inject (read-string "patron") (read-string "executor") (read-string "fvt-id") (read-string "reward-dptf-id") (read-decimal "amount"))`,
    config,
    payload,
    gasPayer,
    signers,
  };
  const injectResult = await executeCodexTransaction(injectLeg, "simulate", executorCtx);
  if (injectResult.ok) {
    return [injectLeg];
  }

  // Never fans out, never silently succeeds — rethrow regardless of
  // whether `injectResult.gasUsed` happens to be a number (see the module
  // doc's step 4 above).
  throw new Error(injectResult.error ?? "CC_Inject simulation failed");
};

registerStepPlanner("ouronet.aqp-inject", injectPlanner);
