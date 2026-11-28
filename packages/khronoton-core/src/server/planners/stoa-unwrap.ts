/**
 * `ouronet.stoa-unwrap` — the "Unwrap STOA" step planner, ported from
 * OuronetUI's `ouroWrapFunctions.ts`/`ouroPriceFunctions.ts`/
 * `tokenOpSpecs.tsx` (a different workspace entirely:
 * `OuroborosNetwork/daimons/OuronetUI`). See design.md's §B for the full
 * port rationale, and §C for the capability-line interpolation exception
 * both this module and its sibling `stoa-wrap.ts` rely on.
 *
 * Shape: always exactly one leg. Unlike `stoa-wrap.ts` (whose `amount` is a
 * LIVE balance read), this planner's `amount` is an explicit, validated
 * `planner_params_json` param — no confirmed "unwrap the full balance"
 * semantic exists yet (design.md §B). Two {@link dirtyReadPlan} calls (an
 * unsigned, zero-signer `dirtyRead` — see that helper's own doc,
 * docs/work/aqp-planners-talos-routing/design.md, for why a pure read must
 * never go through `executeCodexTransaction`'s AUTO-gas-eligible
 * `preflightRead` path) resolve whether the target StoaChain account needs
 * creating before the real `LQD|C_UnwrapStoa` call is built:
 * `DALOS.UR_AccountKadena` resolves the target address, then
 * `coin.get-balance` (wrapped in `try false`, bare `coin`, no namespace
 * prefix — `coin` is Kadena's own root/system module, confirmed against
 * OuronetUI's own bare `coin.get-balance`/`coin.TRANSFER` calls, unlike
 * `ouronet-ns`-namespaced modules such as `TS01-C2`/`DALOS`) probes whether
 * it already exists. When it doesn't, `coin.C_CreateAccount` is composed as
 * a second top-level form ahead of the unwrap call in one `pactCode` string
 * (two env-data-only forms joined by a newline — a real, independently-
 * rendered-forms mechanism per OuronetUI's own registry, not
 * string-splicing of untrusted text).
 */
import { dirtyReadPlan } from "../executor.js";
import { stripPrefix } from "../executor-signers.js";
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
 * The protocol's STOA-autonomic liquidity pot — a fixed, public, non-secret
 * system account (confirmed against `ouronet-core/src/constants/
 * ouronet.ts:44`). A module-local constant, duplicated from `stoa-wrap.ts`
 * per that module's own per-module-duplication convention, to keep the two
 * planners independent.
 */
const STOA_AUTONOMIC_LIQUIDPOT = "c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI";

/** Shape guard for a `k:`/`c:` Kadena account string — see the module doc comment's "chain reads are not trusted" note for why this matters for `targetAccount` specifically. */
const ACCOUNT_SHAPE = /^[kc]:[A-Za-z0-9_-]+$/;

/** `stoaUnwrapPlanner`'s own `planner_params_json` shape. */
interface StoaUnwrapPlannerParams {
  patronAccount: string;
  /**
   * A STRING, not a JS `number` — same precision-preserving posture as
   * `inject.ts`'s own `amount` field. Unlike `stoa-wrap.ts`, this is NOT a
   * live balance read: no confirmed "unwrap the full balance" semantic
   * exists yet (design.md §B), so it is an explicit, validated param.
   */
  amount: string;
}

/**
 * Drives one `mode:'planner'` step registered under `ouronet.stoa-unwrap`:
 *
 * 1. Parse + validate `patronAccount`/`amount` from `step.planner_params_json`.
 * 2. Derive `executor = k:<the step's own first signer's publicKey>`.
 * 3. Resolve the target StoaChain account via `DALOS.UR_AccountKadena` — a
 *    chain-read-sourced value, so it is shape-guarded (unlike `patronAccount`,
 *    which is operator-configured) before it is trusted anywhere downstream.
 * 4. Probe whether the target already exists via `coin.get-balance` wrapped
 *    in `try false`.
 * 5. If it doesn't exist, require a `k:`-prefixed target (account creation
 *    assumes a single-key account, matching OuronetUI's own unconditional
 *    key-stripping) and strip its prefix for the `read-keyset` payload.
 * 6. Build the one leg: a single-form `pactCode` when the target already
 *    exists, or a two-form `coin.C_CreateAccount` + `LQD|C_UnwrapStoa`
 *    composite (in that order) when it doesn't — with a `coin.TRANSFER`
 *    capability from `STOA_AUTONOMIC_LIQUIDPOT` to the target attached to
 *    signer 0 (the REVERSE account order from `stoa-wrap.ts`'s own
 *    capability — a real asymmetry per design.md §B, not a copy-paste of
 *    wrap's capability with names swapped).
 */
export const stoaUnwrapPlanner: StepPlanner = async (
  step: CodexCronotonStepRow,
  ctx: PlannerCtx,
): Promise<PlannedLeg[]> => {
  const params = parseJson<Partial<StoaUnwrapPlannerParams>>(step.planner_params_json, {});
  if (typeof params.patronAccount !== "string" || typeof params.amount !== "string") {
    throw new Error(
      "ouronet.stoa-unwrap: step.planner_params_json must have patronAccount and amount strings",
    );
  }
  const { patronAccount, amount } = params;

  if (!ACCOUNT_SHAPE.test(patronAccount)) {
    throw new Error(
      `ouronet.stoa-unwrap: patronAccount is not a well-formed k:/c: account: ${JSON.stringify(patronAccount)}`,
    );
  }

  // Non-negative decimal format only — this rejects a malformed/negative
  // amount BEFORE it reaches a signed transaction (or a capability line),
  // the identical shape `inject.ts`'s own amount guard already establishes
  // elsewhere in this codebase.
  if (!/^\d+\.\d+$/.test(amount)) {
    throw new Error(
      `ouronet.stoa-unwrap: amount must be a non-negative decimal string (e.g. "5.0"), got ${JSON.stringify(amount)}`,
    );
  }

  const signers = parseJson<CodexSigner[]>(step.signers_json, []);
  if (signers.length === 0) {
    throw new Error(
      "ouronet.stoa-unwrap: step.signers_json must have at least one signer (used as the executor)",
    );
  }
  const executor = `k:${signers[0].publicKey}`;

  const config = parseJson<CodexTxConfig>(step.config_json, {} as CodexTxConfig);
  const gasPayer = parseJson<CodexGasPayer>(step.gas_payer_json, { type: "gas-station" });

  // `ouronet-ns.DALOS` — the module's REAL, deployed, namespaced path, built
  // from `ctx.runtime.namespace`, never hardcoded (same discipline as every
  // other planner's own namespaced module reference).
  const dalos = `${ctx.runtime.namespace}.DALOS`;

  // Both probes below are PURE reads, never through
  // `executeCodexTransaction`/`preflightRead` — see `dirtyReadPlan`'s own doc
  // (docs/work/aqp-planners-talos-routing/design.md) for why a plan read must
  // never inherit the step's own AUTO-gas config (it would otherwise run the
  // full buy-gas pipeline, enforcing `GAS_PAYER`'s payable-module whitelist
  // on a read that needs no sponsorship at all).
  const resolveResult = await dirtyReadPlan(
    ctx.runtime,
    config.chainId,
    `(${dalos}.UR_AccountKadena (read-string "patron"))`,
    { patron: patronAccount },
  );
  if (!resolveResult.ok) {
    throw new Error(resolveResult.error ?? "UR_AccountKadena read failed");
  }

  const targetData = resolveResult.data;
  // This value IS chain-read-sourced, unlike `patronAccount` above — the
  // same "chain reads are not trusted" posture as `evict.ts`'s own
  // `isWellFormedEvictLeg` guard — so it is shape-guarded before it reaches
  // either `payload` or a capability line.
  if (typeof targetData !== "string" || !ACCOUNT_SHAPE.test(targetData)) {
    throw new Error(
      `ouronet.stoa-unwrap: UR_AccountKadena returned a malformed target account: ${JSON.stringify(targetData)}`,
    );
  }
  const targetAccount = targetData;

  const existenceResult = await dirtyReadPlan(
    ctx.runtime,
    config.chainId,
    '(try false (coin.get-balance (read-string "target")))',
    { target: targetAccount },
  );
  if (!existenceResult.ok) {
    throw new Error(existenceResult.error ?? "coin.get-balance existence probe failed");
  }

  const existenceData = existenceResult.data;
  let needsCreate: boolean;
  if (existenceData === false) {
    needsCreate = true;
  } else if (typeof existenceData === "number") {
    needsCreate = false;
  } else {
    throw new Error(
      `ouronet.stoa-unwrap: coin.get-balance existence probe returned an unexpected shape: ${JSON.stringify(existenceData)}`,
    );
  }

  let strippedPubkey: string | undefined;
  if (needsCreate) {
    // Account CREATION assumes a single-key `k:` account, matching
    // OuronetUI's own unconditional `target.slice(2)` key-stripping — a
    // `c:`-prefixed target here is a shape the real UI never handles
    // either, so it is a genuine error rather than a guessed guard.
    if (!/^k:[A-Za-z0-9_-]+$/.test(targetAccount)) {
      throw new Error(
        `ouronet.stoa-unwrap: cannot auto-create a non-k: target account: ${targetAccount}`,
      );
    }
    strippedPubkey = stripPrefix(targetAccount);
  }

  // Every value below flows through `payload` (env-data) and is read back
  // with `read-string`/`read-decimal`/`read-keyset` in `pactCode` — NEVER
  // string-concatenated into the Pact source itself, mirroring
  // `evict.ts`'s/`inject.ts`'s own "no code-injection surface" guarantee.

  const unwrapForm = `(${ctx.runtime.namespace}.TS01-C2.LQD|C_UnwrapStoa (read-string "patron") (read-string "executor") (read-decimal "amount"))`;

  const pactCode = needsCreate
    ? `(coin.C_CreateAccount (read-string "target") (read-keyset "ks"))\n${unwrapForm}`
    : unwrapForm;

  const payload: Record<string, unknown> = needsCreate
    ? {
        patron: patronAccount,
        executor,
        amount,
        target: targetAccount,
        ks: { keys: [strippedPubkey], pred: "keys-all" },
      }
    : { patron: patronAccount, executor, amount };

  // The one deliberate exception to the "never interpolate into executed
  // code" rule (design.md §C) — Pact's signed `clist` has no `read-string`
  // equivalent, so capabilities must be literal in the signed command. Made
  // safe here because `targetAccount` is shape-guarded above and `amount`
  // is already regex-validated, never a raw pass-through of untrusted text.
  // LIQUIDPOT -> target is the REVERSE account order from `stoa-wrap.ts`'s
  // own patron -> LIQUIDPOT capability (confirmed asymmetric per
  // design.md §B).
  const capabilityLine = `(coin.TRANSFER "${STOA_AUTONOMIC_LIQUIDPOT}" "${targetAccount}" ${amount})`;

  const newSigners: CodexSigner[] = signers.map((signer, index): CodexSigner => {
    if (index !== 0) return signer;
    // If signer 0's own key is ALSO the gas-station's signing key,
    // `effectiveSigners` (executor-signers.ts) sees that pubkey "already
    // present" among `signers` and skips synthesizing its own
    // DALOS.GAS_PAYER-scoped entry for it (presence is checked by pubkey
    // only, never capability content) — so narrowing this signer to
    // `capabilityMode:'scoped'` with ONLY `coin.TRANSFER` would silently
    // drop the gas-sponsorship grant that SAME key needs, surfacing as an
    // opaque failure at submit time, not at plan time (identical risk to
    // `stoa-wrap.ts`'s own fix for this). Append the identical capability
    // line `effectiveSigners` would otherwise have synthesized.
    const gasPayerCapLine =
      gasPayer.type === "gas-station" && gasPayer.gasStationSignerKey === signer.publicKey
        ? `(${ctx.runtime.namespace}.DALOS.GAS_PAYER "" 0 0.0)`
        : null;
    return {
      ...signer,
      capabilityMode: "scoped",
      capabilities: [signer.capabilities, capabilityLine, gasPayerCapLine].filter(Boolean).join("\n"),
    };
  });

  return [
    {
      pactCode,
      config,
      payload,
      gasPayer,
      signers: newSigners,
    },
  ];
};

registerStepPlanner("ouronet.stoa-unwrap", stoaUnwrapPlanner);
