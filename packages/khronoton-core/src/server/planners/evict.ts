/**
 * `ouronet.aqp-evict` — the "Evict Rewards" step planner, ported from
 * OuronetUI's `EvictSection.tsx`/`evictSpecs.tsx`/`fvtChain.ts` (a different
 * workspace entirely: `OuroborosNetwork/daimons/OuronetUI`). See design.md's
 * §D for the full port rationale.
 *
 * Shape: one Pact *read* (`URHC_BuildEvictPlans`) computes the plan ON-CHAIN,
 * so this planner never decides leg count itself — it tries one transaction
 * (`CC_FullEvictRewards`) first and only fans out to one leg per plan entry
 * (`CC_EvictSingleReward`) when that one transaction genuinely cannot fit the
 * block's gas ceiling (never on any OTHER simulate failure, which propagates
 * as a real error instead — see step 9 below).
 *
 * Talos routing + read-vs-write split (docs/work/aqp-planners-talos-routing/
 * design.md): a direct `AQP-EVCT.*` exec fails BOTH of Ouronet's client-call
 * gates (no calling module on a direct exec, and the exec code's prefix is
 * absent from `GAS_PAYER`'s payable-module whitelist) — `TS02-C3` (Talos) is
 * the only client-reachable path, so both WRITE legs route through it. The
 * plan READ stays on `AQP-EVCT` directly (Talos has no reader), but executes
 * via `dirtyReadPlan` — an unsigned, zero-signer `dirtyRead`, never the
 * step's own AUTO-gas-eligible `executeCodexTransaction`/`preflightRead`
 * path, which would otherwise run the full buy-gas pipeline on a pure read.
 */
import { executeCodexTransaction, dirtyReadPlan } from "../executor.js";
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

/** `evictPlanner`'s own `planner_params_json` shape. */
interface EvictPlannerParams {
  fvtId: string;
  patronAccount: string;
}

/**
 * ONE EVICTABLE REWARD LEG, as `URHC_BuildEvictPlans` emits it (decoded to
 * camelCase, field-for-field ported from `fvtChain.ts`'s own decoder — no
 * on-chain schema exists to typecheck against, matching the source's own
 * caveat). Only the fields `CC_EvictSingleReward`'s args actually consume are
 * carried here; `poolId`/`claimable` are not args to either entrypoint.
 */
interface EvictLeg {
  beneficiary: string;
  scoreEntityType: number;
  scoreEntityId: string;
  rewardDptfId: string;
}

/**
 * Validate one chain-read plan entry's shape before it is trusted enough to
 * become part of a signed transaction's `payload` (env-data). This is a
 * live chain-read response, not operator-configured `planner_params_json` —
 * nothing in this codebase (or, per the ported source's own caveat, the
 * `AQP-EVCT` contract) guarantees these fields are well-formed, so a bare
 * type assertion over `unknown` is not enough here.
 */
function isWellFormedEvictLeg(value: unknown): value is EvictLeg {
  if (typeof value !== "object" || value === null) return false;
  const leg = value as Record<string, unknown>;
  return (
    typeof leg.beneficiary === "string" &&
    typeof leg.scoreEntityType === "number" &&
    Number.isInteger(leg.scoreEntityType) &&
    typeof leg.scoreEntityId === "string" &&
    typeof leg.rewardDptfId === "string"
  );
}

/**
 * Drives one `mode:'planner'` step registered under `ouronet.aqp-evict`:
 *
 * 1. Parse `fvtId`/`patronAccount` from `step.planner_params_json`.
 * 2. Derive `executor = k:<the step's own first signer's publicKey>`.
 * 3-4. Read the plan (`URHC_BuildEvictPlans`) via a simulate; a failed READ
 *      is never "needs splitting" — there is no plan to split.
 * 5-6. Zero plan entries → `[]` (handleReplanStep treats this as a cleared
 *      barrier — see design.md §C).
 * 7-8. Probe `CC_FullEvictRewards` as one candidate leg; a successful
 *      simulate → exactly that one leg.
 * 9. A failed probe is "needs splitting" ONLY when `runSimulate`'s own
 *    `gasUsed > ceiling` refuse-unmineable branch produced it (signaled by a
 *    numeric `gasUsed` on the `ok:false` result) — any OTHER failure
 *    rethrows as a genuine error, never silently treated as "needs
 *    splitting".
 * 10. Fan out: one `CC_EvictSingleReward` leg per plan entry.
 */
export const evictPlanner: StepPlanner = async (
  step: CodexCronotonStepRow,
  ctx: PlannerCtx,
): Promise<PlannedLeg[]> => {
  const params = parseJson<Partial<EvictPlannerParams>>(step.planner_params_json, {});
  if (typeof params.fvtId !== "string" || typeof params.patronAccount !== "string") {
    throw new Error(
      "ouronet.aqp-evict: step.planner_params_json must have fvtId and patronAccount strings",
    );
  }
  const { fvtId, patronAccount } = params;

  const signers = parseJson<CodexSigner[]>(step.signers_json, []);
  if (signers.length === 0) {
    throw new Error(
      "ouronet.aqp-evict: step.signers_json must have at least one signer (used as the executor)",
    );
  }
  const executor = `k:${signers[0].publicKey}`;

  const config = parseJson<CodexTxConfig>(step.config_json, {} as CodexTxConfig);
  const gasPayer = parseJson<CodexGasPayer>(step.gas_payer_json, { type: "gas-station" });

  const executorCtx = { runtime: ctx.runtime, resolver: ctx.resolver, config: ctx.config };

  // `ouronet-ns.AQP-EVCT` — the CORE module's REAL, deployed, namespaced path
  // (confirmed against the ported source's own `fvtChain.ts` NS/EVCT
  // constants and its `(namespace "ouronet-ns")` on-chain declaration). Used
  // ONLY for the plan READ below (`URHC_BuildEvictPlans`) — Talos has no
  // reader to route a read through (see docs/work/aqp-planners-talos-routing/
  // design.md).
  const evct = `${ctx.runtime.namespace}.AQP-EVCT`;

  // The two WRITE legs below do NOT call `AQP-EVCT` directly — same two gates
  // `unstall.ts`'s own doc comment explains: no calling module on a direct
  // exec, and the exec code's prefix is absent from `GAS_PAYER`'s payable-
  // module whitelist (which only matches `"(ouronet-ns.TS"`, never
  // `"(ouronet-ns.AQP-EVCT."`). `TS02-C3` is Talos, the one client-reachable
  // path. The `|` in `AQP-EVCT|CC_FullEvictRewards`/`AQP-EVCT|CC_EvictSingleReward`
  // is part of the literal function name, NOT a namespace separator.
  // Signatures are identical; this is a path change only.
  const talos = `${ctx.runtime.namespace}.TS02-C3`;

  // Every value below flows through `payload` (env-data, `addData` per
  // `executor.ts`'s `buildTransaction`) and is read back with
  // `read-string`/`read-integer` in `pactCode` — NEVER string-concatenated
  // into the Pact source itself, mirroring `pure/runtime-args.ts`'s own
  // "no code-injection surface" guarantee. This matters most for
  // `beneficiary`/`scoreEntityId`/`rewardDptfId`/`scoreEntityType` below,
  // which come from a LIVE CHAIN READ (`URHC_BuildEvictPlans`'s response),
  // not from operator-configured `planner_params_json` — nothing in this
  // codebase or (per the ported source's own caveat) the `AQP-EVCT`
  // contract guarantees those fields can't contain `"`/`(`/`)`.

  // A PURE read, never through `executeCodexTransaction`/`preflightRead` —
  // see `dirtyReadPlan`'s own doc for why a plan read must never inherit the
  // step's AUTO-gas config.
  const result = await dirtyReadPlan(
    ctx.runtime,
    config.chainId,
    `(${evct}.URHC_BuildEvictPlans (read-string "fvt-id"))`,
    { "fvt-id": fvtId },
  );
  if (!result.ok) {
    throw new Error(result.error ?? "evict plan read failed");
  }

  const data = result.data;
  if (!Array.isArray(data)) {
    throw new Error("ouronet.aqp-evict: URHC_BuildEvictPlans returned a non-array result");
  }
  if (!data.every(isWellFormedEvictLeg)) {
    throw new Error(
      "ouronet.aqp-evict: URHC_BuildEvictPlans returned a malformed plan entry (expected string beneficiary/scoreEntityId/rewardDptfId and an integer scoreEntityType)",
    );
  }
  const legs = data;

  if (legs.length === 0) {
    return [];
  }

  const fullLeg: PlannedLeg = {
    pactCode: `(${talos}.AQP-EVCT|CC_FullEvictRewards (read-string "patron") (read-string "executor") (read-string "fvt-id"))`,
    config,
    payload: { patron: patronAccount, executor, "fvt-id": fvtId },
    gasPayer,
    signers,
  };
  const fullResult = await executeCodexTransaction(fullLeg, "simulate", executorCtx);
  if (fullResult.ok) {
    return [fullLeg];
  }

  if (typeof fullResult.gasUsed !== "number") {
    // A genuine chain-level/Pact-execution failure — never interpreted as
    // "needs splitting" (see the module doc's step 9 above).
    throw new Error(fullResult.error ?? "CC_FullEvictRewards simulation failed");
  }

  return legs.map(
    (leg): PlannedLeg => ({
      pactCode: `(${talos}.AQP-EVCT|CC_EvictSingleReward (read-string "patron") (read-string "executor") (read-string "fvt-id") (read-string "beneficiary") (read-integer "score-entity-type") (read-string "score-entity-id") (read-string "reward-dptf-id"))`,
      config,
      payload: {
        patron: patronAccount,
        executor,
        "fvt-id": fvtId,
        beneficiary: leg.beneficiary,
        "score-entity-type": leg.scoreEntityType,
        "score-entity-id": leg.scoreEntityId,
        "reward-dptf-id": leg.rewardDptfId,
      },
      gasPayer,
      signers,
    }),
  );
};

registerStepPlanner("ouronet.aqp-evict", evictPlanner);
