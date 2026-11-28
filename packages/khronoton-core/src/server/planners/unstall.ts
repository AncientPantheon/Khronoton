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
 *
 * Talos routing + read-vs-write split (docs/work/aqp-planners-talos-routing/
 * design.md): a direct `AQP-FVT.CCp_FvtFixSlice` exec fails BOTH of Ouronet's
 * client-call gates (no calling module, and the exec code's prefix is absent
 * from `GAS_PAYER`'s payable-module whitelist) — Talos (`TS02-C3`) is the
 * only client-reachable path, so every WRITE leg routes through it. The plan
 * READ stays on `AQP-FVT` directly (Talos has no reader), but executes via
 * `dirtyReadPlan` — an unsigned, zero-signer `dirtyRead`, never the step's own
 * AUTO-gas-eligible `executeCodexTransaction`/`preflightRead` path, which
 * would otherwise run the full buy-gas pipeline on a pure read for no reason.
 */
import { executeCodexTransaction, dirtyReadPlan } from "../executor.js";
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

  // `ouronet-ns.AQP-FVT` — the CORE module's REAL, deployed, namespaced path
  // (confirmed against the ported source's own `fvtOwnerSpecs.tsx`
  // `FVT_FIX_SLICE`/`URH_FvtStalePresentUsers` entrypoint strings and
  // `05_FVT.pact`'s own `(namespace "ouronet-ns")` declaration). Used ONLY for
  // the plan READ below (`URH_FvtStalePresentUsers`) — Talos exposes client
  // WRITE entrypoints only, by design, so there is no reader to route a read
  // through (see docs/work/aqp-planners-talos-routing/design.md). The SAME
  // module `injectPlanner` reads/writes — the two planners are a two-step
  // sequence against one contract.
  const fvt = `${ctx.runtime.namespace}.AQP-FVT`;

  // The WRITE leg below (`CCp_FvtFixSlice`) does NOT call `AQP-FVT` directly —
  // Ouronet's architecture refuses that two separate ways: the core entrypoint
  // opens with `(P|UEV_IMC)` (an inter-module call gate with no calling module
  // on a direct exec), and even if that passed, `DALOS.GAS_PAYER`'s payable-
  // module whitelist only matches a `"(ouronet-ns.TS"` prefix, never
  // `"(ouronet-ns.AQP-FVT."` — `AQP-FVT.*` can only ever fail to buy gas.
  // `TS02-C3` is Talos, the one client-reachable path OuronetUI's own
  // `fvtOwnerSpecs.tsx:328` already uses (`"TS02-C3.AQP-FVT|CCp_FvtFixSlice"`).
  // The `|` is part of the literal function name, NOT a namespace separator —
  // `AQP-FVT|CCp_FvtFixSlice` is one identifier on `TS02-C3`, not qualified
  // access into `AQP-FVT`. Signatures are identical; this is a path change only.
  const talos = `${ctx.runtime.namespace}.TS02-C3`;

  // A PURE read, never through `executeCodexTransaction`/`preflightRead` — see
  // `dirtyReadPlan`'s own doc for why a plan read must never inherit the
  // step's AUTO-gas config (it would otherwise run the full buy-gas pipeline,
  // enforcing `GAS_PAYER`'s whitelist on a read that needs no sponsorship).
  const staleReadResult = await dirtyReadPlan(
    ctx.runtime,
    config.chainId,
    `(${fvt}.URH_FvtStalePresentUsers (read-string "fvt-id"))`,
    { "fvt-id": fvtId },
  );
  if (!staleReadResult.ok) {
    throw new Error(staleReadResult.error ?? "URH_FvtStalePresentUsers read failed");
  }

  const data = staleReadResult.data;
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
  const fixSlicePactCode = `(${talos}.AQP-FVT|CCp_FvtFixSlice (read-string "patron") (read-string "fvt-id") (read-string "reward-dptf-id") (read-msg "users"))`;

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
