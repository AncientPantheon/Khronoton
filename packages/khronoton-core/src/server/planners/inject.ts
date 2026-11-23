/**
 * `ouronet.aqp-inject` — the "Inject Reward" step planner, ported from
 * OuronetUI's `fvtOwnerSpecs.tsx` (`INJECT_FINALIZE`) and `aqpConsumerSpecs.tsx`
 * (`INJECT_FVT`, the real `CC_Inject`/inline-repair entrypoint — it does NOT
 * live in `fvtOwnerSpecs.tsx` despite the similar naming) — a different
 * workspace entirely: `OuroborosNetwork/daimons/OuronetUI`. See design.md's
 * §D for the full port rationale.
 *
 * Shape: unlike `evictPlanner`, this planner has no on-chain plan read and no
 * same-step fan-out leg shape at all (see `InjectRequiresUnstallError`'s own
 * doc for why `evictPlanner`'s fan-out shape does not transfer here) — it
 * tries the cheap `CC_InjectFinalize` path first (correct once a preceding
 * `ouronet.aqp-unstall` step has already repaired every stale member in
 * slices), falls back to the heavier inline-repair `CC_Inject` when that
 * fails, and reports a genuine failure when BOTH fail — distinguishably,
 * when the second failure is specifically a gas refusal, so a caller can
 * react by inserting an `ouronet.aqp-unstall` step (see
 * `docs/work/inject-executor-fix/design.md`).
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

/**
 * Thrown when `CC_InjectFinalize` fails (stale present users remain) AND the
 * heavier `CC_Inject` fallback is ALSO refused specifically for exceeding the
 * gas ceiling (a numeric `gasUsed` on an `{ok:false}` simulate result — the
 * executor's existing refuse-unmineable signal, the same one `evictPlanner`
 * reads to decide "fan out instead").
 *
 * `evictPlanner`'s fan-out shape does not transfer to inject: `CC_Inject`'s
 * cost is driven by an inline stale-user-fix loop that runs INSIDE one
 * atomic Pact transaction (confirmed against `05_FVT.pact`'s `CC_Inject`
 * body) — there is no on-chain entrypoint that splits `CC_Inject` itself
 * into independent legs the way `URHC_BuildEvictPlans` hands evict a
 * ready-made array of independent per-beneficiary legs. The real splitting
 * primitive (`CCp_FvtFixSlice`) is already used by `ouronet.aqp-unstall`,
 * but this package's chained-run engine submits every leg of ONE
 * `mode:'planner'` step in parallel with no serial-then-parallel mixing
 * within a single step (`run-advance.ts`'s `stepMode: 'parallel'` for every
 * planner step) — a single `injectPlanner` invocation cannot safely return
 * "N fix-slice legs, then one finalize leg": the finalize would race the
 * fix-slices and revert against stale state that has not yet landed. So
 * this error is a distinguishable SIGNAL for the caller to react to (insert
 * an `ouronet.aqp-unstall` step before this one in the chain), never a
 * same-step fan-out `injectPlanner` attempts itself.
 */
export class InjectRequiresUnstallError extends Error {
  constructor(fvtId: string) {
    super(
      `ouronet.aqp-inject: CC_InjectFinalize failed and CC_Inject was refused for exceeding the gas ceiling for fvt-id ${JSON.stringify(fvtId)} — insert an ouronet.aqp-unstall step before this one in the chain to repair staleness in slices first`,
    );
    this.name = "InjectRequiresUnstallError";
  }
}

/** `injectPlanner`'s own `planner_params_json` shape. */
interface InjectPlannerParams {
  fvtId: string;
  patronAccount: string;
  /**
   * A glyph Ouronet account (`Ѻ.…`/`Σ.…`), NEVER a native `k:` account — this
   * is the DPTF-debited token source `CC_Inject`/`CC_InjectFinalize` name
   * `executor` (confirmed against `04_RPS.pact`'s `XI_FvtInjectCore`:
   * `(ref-TFT::C_Transfer patron injector AQP|SC_NAME reward-dptf-id amount
   * true)`, where `injector` is the inject's own `executor`). DPTF balances
   * are keyed by `(token-id, Ouronet glyph account)`, so a `k:` account has
   * no DPTF balance row and the transfer always reverts. Previously derived
   * (incorrectly) from the step's own first signer's public key — the
   * signer still proves ownership/guard of this glyph account at sign time,
   * but is never the SOURCE of the account string itself.
   */
  executor: string;
  rewardDptfId: string;
  /**
   * A STRING, not a JS `number` — real money moved out of `executor`'s
   * custody (`XI_FvtInjectCore`/`XE_FvtInjectCore` debit exactly `amount`
   * tokens). Kept as a string specifically to avoid floating-point precision
   * loss before Pact's own `read-decimal` interprets it on-chain.
   */
  amount: string;
}

/**
 * Drives one `mode:'planner'` step registered under `ouronet.aqp-inject`:
 *
 * 1. Parse `fvtId`/`patronAccount`/`executor`/`rewardDptfId`/`amount` from
 *    `step.planner_params_json`. `executor` is a required glyph Ouronet
 *    account, rejected if empty or `k:`-prefixed (see
 *    `InjectPlannerParams.executor`'s own doc for why).
 * 2. Probe `CC_InjectFinalize` as one candidate leg; a successful simulate
 *    → exactly that one leg.
 * 3. Else probe `CC_Inject` (same five env-data fields); a successful
 *    simulate → exactly that one leg.
 * 4. Else — never fans out within this one step, never silently succeeds:
 *    a numeric `gasUsed` on the second failure throws the distinguishable
 *    `InjectRequiresUnstallError` (see that class's own doc for why); any
 *    OTHER second-failure reason rethrows the existing generic error,
 *    unchanged.
 */
export const injectPlanner: StepPlanner = async (
  step: CodexCronotonStepRow,
  ctx: PlannerCtx,
): Promise<PlannedLeg[]> => {
  const params = parseJson<Partial<InjectPlannerParams>>(step.planner_params_json, {});
  if (
    typeof params.fvtId !== "string" ||
    typeof params.patronAccount !== "string" ||
    typeof params.executor !== "string" ||
    typeof params.rewardDptfId !== "string" ||
    typeof params.amount !== "string"
  ) {
    throw new Error(
      "ouronet.aqp-inject: step.planner_params_json must have fvtId, patronAccount, executor, rewardDptfId, and amount strings",
    );
  }
  const { fvtId, patronAccount, executor, rewardDptfId, amount } = params;

  // `executor` must be a glyph Ouronet account, never a native `k:` account
  // — see `InjectPlannerParams.executor`'s own doc for the on-chain evidence.
  // Shape-only (non-empty, not `k:`-prefixed): this planner trusts the
  // contract for anything beyond that, same as every sibling planner's
  // "trust the contract" posture — there is no established glyph-account
  // format validator anywhere in this codebase to reuse, and inventing one
  // risks being wrong about the real charset.
  if (executor.length === 0 || executor.startsWith("k:")) {
    throw new Error(
      `ouronet.aqp-inject: executor must be a glyph Ouronet account (e.g. "Ѻ.…"/"Σ.…"), never empty or a native "k:" account (a "k:" account has no DPTF balance row and the inject would always revert) — got ${JSON.stringify(executor)}`,
    );
  }

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
      "ouronet.aqp-inject: step.signers_json must have at least one signer (needed to build/sign a leg, and to prove ownership/guard of the executor glyph account at sign time — but no longer the source of the executor account string itself)",
    );
  }

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

  // Never fans out within this one step, never silently succeeds. A numeric
  // `gasUsed` is the executor's own refuse-unmineable signal — the
  // distinguishable case a caller can react to (see
  // `InjectRequiresUnstallError`'s own doc for why this planner cannot fan
  // out itself). Any OTHER second-failure reason rethrows the existing
  // generic error, unchanged.
  if (typeof injectResult.gasUsed === "number") {
    throw new InjectRequiresUnstallError(fvtId);
  }
  throw new Error(injectResult.error ?? "CC_Inject simulation failed");
};

registerStepPlanner("ouronet.aqp-inject", injectPlanner);
