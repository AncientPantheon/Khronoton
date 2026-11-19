/**
 * `ouronet.aqp-unstall` — the "Unstale FVT" step planner, ported from
 * OuronetUI's `FvtUnstaleFlow.tsx`/`fvtOwnerSpecs.tsx` (`FVT_FIX_SLICE`) — a
 * different workspace entirely: `OuroborosNetwork/daimons/OuronetUI`. See
 * design.md's §C for the full port rationale.
 *
 * Shape: unlike `evictPlanner`, the plan READ here (`URH_FvtStalePresentUsers`)
 * returns the raw item list to split, not a pre-built on-chain plan — the
 * actual leg-count decision is this planner's own, delegated whole to the
 * generic gas-probe-and-pack algorithm (`../pure/split-plan.js`, ported
 * separately). `CCp_FvtFixSlice` is the parallel-safe, order-independent
 * repair entrypoint `FVT_FIX_SLICE` names — disjoint slices of stale users can
 * be sent together, which is exactly what `splitPlan`'s batches are.
 */
import { executeCodexTransaction } from "../executor.js";
import { AUTO_GAS_CEILING } from "../seams.js";
import { splitPlan, type ProbeOutcome } from "../pure/split-plan.js";
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

/** `unstallPlanner`'s own `planner_params_json` shape. */
interface UnstallPlannerParams {
  fvtId: string;
  patronAccount: string;
  rewardDptfId: string;
}

/**
 * Drives one `mode:'planner'` step registered under `ouronet.aqp-unstall`:
 *
 * 1. Parse `fvtId`/`patronAccount`/`rewardDptfId` from
 *    `step.planner_params_json`. Derive `executor = k:<the step's own first
 *    signer's publicKey>` — identical validation shape to `evictPlanner`'s
 *    own (`executor` itself is unused by `CCp_FvtFixSlice`'s signature —
 *    `(patron, fvt-id, reward-dptf-id, users)`, no credited caller — but the
 *    signer-presence check stays, since a step with zero signers can never
 *    build or sign ANY leg this planner might produce).
 * 2. Read `URH_FvtStalePresentUsers(fvtId)` via a `"simulate"` call (same
 *    pattern as `evictPlanner`'s own plan-read probe) — a LIVE CHAIN READ, so
 *    its result is validated at runtime (`Array.isArray` + every element a
 *    string) before being trusted as part of a signed transaction's payload.
 *    A failed read rethrows — never "needs splitting", since there is no
 *    list to split.
 * 3. Zero stale users → `[]` (step trivially satisfied).
 * 4. Else `splitPlan(staleUsers, probe, ceiling)` (`../pure/split-plan.js`),
 *    where `probe` builds a `CCp_FvtFixSlice` leg for the candidate batch and
 *    simulates it; a `SplitResult.ok:false` rethrows as a genuine error,
 *    never silently treated as "nothing to do".
 * 5. Return one `PlannedLeg` per batch in the result.
 */
export const unstallPlanner: StepPlanner = async (
  step: CodexCronotonStepRow,
  ctx: PlannerCtx,
): Promise<PlannedLeg[]> => {
  const params = parseJson<Partial<UnstallPlannerParams>>(step.planner_params_json, {});
  if (
    typeof params.fvtId !== "string" ||
    typeof params.patronAccount !== "string" ||
    typeof params.rewardDptfId !== "string"
  ) {
    throw new Error(
      "ouronet.aqp-unstall: step.planner_params_json must have fvtId, patronAccount, and rewardDptfId strings",
    );
  }
  const { fvtId, patronAccount, rewardDptfId } = params;

  const signers = parseJson<CodexSigner[]>(step.signers_json, []);
  if (signers.length === 0) {
    throw new Error(
      "ouronet.aqp-unstall: step.signers_json must have at least one signer (needed to build/sign a leg, even though CCp_FvtFixSlice itself takes no executor arg)",
    );
  }

  const config = parseJson<CodexTxConfig>(step.config_json, {} as CodexTxConfig);
  const gasPayer = parseJson<CodexGasPayer>(step.gas_payer_json, { type: "gas-station" });

  const executorCtx = { runtime: ctx.runtime, resolver: ctx.resolver, config: ctx.config };

  // `ouronet-ns.AQP-FVT` — the module's REAL, deployed, namespaced path
  // (confirmed against the ported source's own `fvtOwnerSpecs.tsx`
  // `FVT_FIX_SLICE`/`URH_FvtStalePresentUsers` entrypoint strings and
  // `05_FVT.pact`'s own `(namespace "ouronet-ns")` declaration; a bare
  // `AQP-FVT.*` reference is unresolvable by Pact's namespace mechanism).
  // Built from `ctx.runtime.namespace`, never hardcoded, so a consumer on a
  // different namespace isn't silently wrong. The SAME module `injectPlanner`
  // targets — the two planners are a two-step sequence against one contract.
  const fvt = `${ctx.runtime.namespace}.AQP-FVT`;

  const staleReadDefinition: PlannedLeg = {
    pactCode: `(${fvt}.URH_FvtStalePresentUsers (read-string "fvt-id"))`,
    config,
    payload: { "fvt-id": fvtId },
    gasPayer,
    signers,
  };
  const staleReadResult = await executeCodexTransaction(staleReadDefinition, "simulate", executorCtx);
  if (!staleReadResult.ok) {
    throw new Error(staleReadResult.error ?? "URH_FvtStalePresentUsers read failed");
  }

  const data = (staleReadResult.rawResult as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data) || !data.every((s) => typeof s === "string")) {
    throw new Error(
      "ouronet.aqp-unstall: URH_FvtStalePresentUsers returned a non-array-of-strings result",
    );
  }
  const staleUsers = data;

  if (staleUsers.length === 0) {
    return [];
  }

  // Every value below flows through `payload` (env-data, `addData` per
  // `executor.ts`'s `buildTransaction`) and is read back with
  // `read-string`/`read-msg` in `pactCode` — NEVER string-concatenated into
  // the Pact source itself, mirroring `evictPlanner`'s own "no code-injection
  // surface" guarantee. `users` (a LIST, not a scalar) goes through
  // `(read-msg "users")` — env-data's generic JSON-value reader, since
  // `read-string`/`read-integer` are scalar-only; `addData` already
  // serializes array values as-is per `executor.ts`'s `buildTransaction`.
  const fixSlicePactCode = `(${fvt}.CCp_FvtFixSlice (read-string "patron") (read-string "fvt-id") (read-string "reward-dptf-id") (read-msg "users"))`;

  const probe = async (batch: readonly string[]): Promise<ProbeOutcome> => {
    const leg: PlannedLeg = {
      pactCode: fixSlicePactCode,
      config,
      payload: { patron: patronAccount, "fvt-id": fvtId, "reward-dptf-id": rewardDptfId, users: [...batch] },
      gasPayer,
      signers,
    };
    const result = await executeCodexTransaction(leg, "simulate", executorCtx);
    if (result.ok) {
      return { ok: true, gas: result.gasUsed ?? 0 };
    }
    if (typeof result.gasUsed === "number") {
      return { ok: false, floor: result.gasUsed };
    }
    // A genuine chain-level/Pact-execution failure — never swallowed into a
    // `ProbeOutcome`. `splitPlan` never calls `probe` in a context where a
    // genuine error should be treated as "infeasible," so letting it
    // propagate out of this callback and up through `splitPlan` unchanged is
    // correct.
    throw new Error(result.error ?? "CCp_FvtFixSlice simulation failed");
  };

  const ceiling = ctx.config?.autoGasCeiling ?? AUTO_GAS_CEILING;
  const result = await splitPlan(staleUsers, probe, ceiling);
  if (!result.ok) {
    throw new Error(result.reason);
  }

  return result.batches.map(
    (batch): PlannedLeg => ({
      pactCode: fixSlicePactCode,
      config,
      payload: { patron: patronAccount, "fvt-id": fvtId, "reward-dptf-id": rewardDptfId, users: batch },
      gasPayer,
      signers,
    }),
  );
};

registerStepPlanner("ouronet.aqp-unstall", unstallPlanner);
