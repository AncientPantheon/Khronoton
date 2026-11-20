/**
 * `ouronet.stoa-wrap` — the "Wrap STOA" step planner, ported from OuronetUI's
 * own `tokenOpSpecs.tsx` (`TF_WRAP_STOA`, a different workspace entirely:
 * `OuroborosNetwork/daimons/OuronetUI`). See design.md's §A for the full port
 * rationale.
 *
 * Shape: always exactly ONE leg (never fans out — this built-in exists for
 * the capability-construction risk alone, see design.md's problem statement,
 * not for leg-count complexity). By default the amount is a LIVE
 * `coin.get-balance` read of the patron's current STOA balance — a
 * self-correcting choice: if a prior drain step landed and wrap hasn't run
 * yet (or failed and is re-planned), the patron's balance at read-time
 * already equals exactly what's eligible to wrap. `params.amountOverride`
 * (see `docs/work/khronoton-step-yield-carry/design.md`) lets a caller skip
 * that live probe entirely and supply the exact amount to wrap instead —
 * e.g. a prior step's carried yield, via `{"$yield": "..."}` resolution one
 * layer up. Either way, the function always reports the final amount it
 * actually used back out as `yield`, so a later step can carry it forward.
 *
 * `coin` is called WITHOUT a namespace prefix throughout this module —
 * unlike `ouronet-ns.AQP-EVCT`/`ouronet-ns.AQP-FVT`, `coin` is Kadena's
 * root/system module, confirmed against OuronetUI's own bare
 * `coin.get-balance`/`coin.TRANSFER` calls (`tokenOpSpecs.tsx`).
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

/** `stoaWrapPlanner`'s own `planner_params_json` shape. */
interface StoaWrapPlannerParams {
  patronAccount: string;
  /**
   * When set, use this EXACT decimal string as the wrap amount instead of
   * live-probing `coin.get-balance` — lets a later step (via the yield
   * mechanism, Wave 2's T4) hand this planner a specific carried amount
   * rather than always re-reading whatever the patron account happens to
   * hold at fire time. See design.md's "step-to-step yield carry" problem
   * statement.
   */
  amountOverride?: string;
}

/**
 * Fixed, public, non-secret StoaChain system account OuronetUI's own
 * `coin.TRANSFER` capability for `TF_WRAP_STOA` scopes its second arg to —
 * confirmed against `ouronet-core/src/constants/ouronet.ts:44`. A module-local
 * constant, not a dynamic value; duplicated in `stoa-unwrap.ts` too, per the
 * same per-module-duplication convention `parseJson` above already uses, to
 * keep the two planners independent.
 */
const STOA_AUTONOMIC_LIQUIDPOT = "c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI";

/** Shape guard for a Kadena `k:`/`c:` account string — see module doc + design.md §C. */
const ACCOUNT_SHAPE = /^[kc]:[A-Za-z0-9_-]+$/;

/**
 * Expand a JS exponential-notation number string (e.g. `"1e-7"`,
 * `"1.23e-12"`) into plain fixed-point decimal form (`"0.0000001"`,
 * `"0.00000000000123"`). Pact decimal literals have no exponent syntax, so
 * this is required whenever `Number.prototype.toString`'s own shortest-
 * round-trip representation falls back to exponential form — which it does
 * for any finite magnitude below `1e-6` (there is no upper-bound case to
 * handle here: `formatPactDecimal` below already rejects `n >= 1e21`
 * before this function is ever reached, and `toString` only switches to
 * exponential notation outside the `[1e-6, 1e21)` range).
 */
function expandExponentialNotation(s: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!match) {
    throw new Error(`ouronet.stoa-wrap: cannot expand unexpected numeric string: ${s}`);
  }
  const [, sign, intPart, fracPart = "", expStr] = match;
  const exponent = parseInt(expStr, 10);
  const digits = intPart + fracPart;
  const pointPos = intPart.length + exponent;
  if (pointPos <= 0) {
    return `${sign}0.${"0".repeat(-pointPos)}${digits}`;
  }
  if (pointPos >= digits.length) {
    return `${sign}${digits}${"0".repeat(pointPos - digits.length)}.0`;
  }
  return `${sign}${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
}

/**
 * Format a non-negative finite number as a Pact decimal literal: always has
 * a decimal point, never scientific notation. Throws on a negative/NaN/
 * Infinite input, or one `>= 1e21` — `coin.get-balance` returning such a
 * value is impossible in a correct chain state, so it is treated as a
 * genuine error, not formatted away.
 *
 * Built on `n.toString()` (JS's own SHORTEST round-trip representation),
 * not `n.toFixed(12)` — `toFixed` reintroduces binary-floating-point
 * representation noise for almost any real-world balance (e.g.
 * `(262613.4).toFixed(12) === "262613.400000000023"`, confirmed against the
 * handoff's own measured dispenser balance during this planner's
 * behavioral verification — `toString()` instead gives the clean
 * `"262613.4"`). `toString()` only falls back to exponential notation
 * outside `[1e-6, 1e21)`; `expandExponentialNotation` above handles the
 * small-magnitude side of that (the large side is already rejected by the
 * `n >= 1e21` guard before `toString` is ever called).
 */
function formatPactDecimal(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n >= 1e21) {
    throw new Error(`ouronet.stoa-wrap: coin.get-balance returned an invalid amount: ${n}`);
  }
  if (n === 0) return "0.0";
  let s = n.toString();
  if (s.includes("e") || s.includes("E")) {
    s = expandExponentialNotation(s);
  }
  return s.includes(".") ? s : `${s}.0`;
}

/**
 * Drives one `mode:'planner'` step registered under `ouronet.stoa-wrap`:
 *
 * 1. Parse `patronAccount` from `step.planner_params_json`; shape-guard it
 *    against `/^[kc]:[A-Za-z0-9_-]+$/` BEFORE it reaches either the payload
 *    or a signer's capability line (see design.md §C: capabilities have no
 *    `read-string`-equivalent safety net, so this value is guarded
 *    regardless of source).
 * 2. Parse `signers`/`config`/`gasPayer`; derive `executor`.
 * 3. If `params.amountOverride` is set, shape-guard it against
 *    `/^\d+\.\d+$/` and use it directly as the amount — skipping steps 4-5
 *    below entirely (no live probe at all). Otherwise, read the patron's
 *    live STOA balance via `coin.get-balance` (a `dirtyRead` simulate,
 *    never a signed tx) — a failed read is a genuine error, never "balance
 *    is zero".
 * 4. Validate the read result is numeric; `0` -> `[]` (the step is
 *    trivially satisfied — mirrors `unstallPlanner`'s own "zero stale
 *    users -> `[]`" convention).
 * 5. Format the balance as a decimal literal.
 * 6. Build the one `LQD|C_WrapStoa` leg, attaching a scoped `coin.TRANSFER`
 *    capability (appended to, never replacing, signer 0's original
 *    capabilities string), and report the final amount used back out as
 *    `{ legs: [leg], yield: amount }`.
 */
export const stoaWrapPlanner: StepPlanner = async (
  step: CodexCronotonStepRow,
  ctx: PlannerCtx,
): Promise<PlannedLeg[] | { legs: PlannedLeg[]; yield: string }> => {
  const params = parseJson<Partial<StoaWrapPlannerParams>>(step.planner_params_json, {});
  if (typeof params.patronAccount !== "string") {
    throw new Error(
      "ouronet.stoa-wrap: step.planner_params_json must have a patronAccount string",
    );
  }
  const { patronAccount } = params;

  if (!ACCOUNT_SHAPE.test(patronAccount)) {
    throw new Error(
      `ouronet.stoa-wrap: patronAccount is not a well-formed k:/c: account: ${JSON.stringify(patronAccount)}`,
    );
  }

  const signers = parseJson<CodexSigner[]>(step.signers_json, []);
  if (signers.length === 0) {
    throw new Error(
      "ouronet.stoa-wrap: step.signers_json must have at least one signer (used as the executor)",
    );
  }
  const executor = `k:${signers[0].publicKey}`;

  const config = parseJson<CodexTxConfig>(step.config_json, {} as CodexTxConfig);
  const gasPayer = parseJson<CodexGasPayer>(step.gas_payer_json, { type: "gas-station" });

  const executorCtx = { runtime: ctx.runtime, resolver: ctx.resolver, config: ctx.config };

  let amount: string;
  if (params.amountOverride !== undefined) {
    if (!/^\d+\.\d+$/.test(params.amountOverride)) {
      throw new Error(
        `ouronet.stoa-wrap: amountOverride must be a non-negative decimal string (e.g. "5.0"), got ${JSON.stringify(params.amountOverride)}`,
      );
    }
    // Mirror the live-probe branch's own `data === 0` short-circuit below:
    // a zero amount means there is nothing to wrap this pass (e.g. a
    // yield-carried drain amount of "0.0"), not a doomed zero-value
    // transfer — real review finding: without this check, "0.0" passed
    // the decimal-shape regex above and flowed straight into building a
    // real signed leg and a `coin.TRANSFER ... 0.0` capability line,
    // unlike the probed path which already refuses to build anything for
    // a zero balance.
    if (Number(params.amountOverride) === 0) {
      return [];
    }
    amount = params.amountOverride;
  } else {
    // Bare `coin.get-balance` — `coin` is Kadena's root/system module, never
    // namespaced under `ctx.runtime.namespace` (see module doc above).
    const probeDefinition: PlannedLeg = {
      pactCode: '(coin.get-balance (read-string "patron"))',
      config,
      payload: { patron: patronAccount },
      gasPayer,
      signers,
    };
    const result = await executeCodexTransaction(probeDefinition, "simulate", executorCtx);
    if (!result.ok) {
      throw new Error(result.error ?? "coin.get-balance read failed");
    }

    const data = (result.rawResult as { data?: unknown } | undefined)?.data;
    if (typeof data !== "number") {
      throw new Error("ouronet.stoa-wrap: coin.get-balance returned a non-numeric result");
    }

    if (data === 0) {
      return [];
    }

    amount = formatPactDecimal(data);
  }

  // `ouronet-ns.TS01-C2` — the module's REAL, deployed, namespaced path
  // (confirmed against `03_TS01-C2.pact:1838`/`12_LIQUID.pact:612`); built
  // from `ctx.runtime.namespace`, never hardcoded, so a consumer on a
  // different namespace isn't silently wrong.
  const ts01c2 = `${ctx.runtime.namespace}.TS01-C2`;

  // Every value below flows through `payload` (env-data) and is read back
  // with `read-string`/`read-decimal` in `pactCode` — zero interpolated
  // values in the EXECUTED code, matching `evict.ts`'s own discipline. The
  // ONE deliberate exception is the signer's `capabilities` line below —
  // Pact's signed `clist` has no env-data equivalent, so capabilities must
  // be literal in the signed command (see design.md §C). It is made safe by
  // `patronAccount` already being shape-guarded above and `amount` being a
  // self-formatted decimal literal from a trusted live numeric chain read —
  // never a raw pass-through of untrusted text.
  const leg: PlannedLeg = {
    pactCode: `(${ts01c2}.LQD|C_WrapStoa (read-string "patron") (read-string "executor") (read-decimal "amount"))`,
    config,
    payload: { patron: patronAccount, executor, amount },
    gasPayer,
    signers: signers.map((signer, index): CodexSigner => {
      if (index !== 0) return signer;
      const capLine = `(coin.TRANSFER "${patronAccount}" "${STOA_AUTONOMIC_LIQUIDPOT}" ${amount})`;
      // If signer 0's own key is ALSO the gas-station's signing key,
      // `effectiveSigners` (executor-signers.ts) sees that pubkey "already
      // present" among `signers` and skips synthesizing its own
      // DALOS.GAS_PAYER-scoped entry for it (it only checks presence by
      // pubkey, never capability content) — so narrowing this signer to
      // `capabilityMode:'scoped'` with ONLY `coin.TRANSFER` would silently
      // drop the gas-sponsorship grant that SAME key needs, surfacing as an
      // opaque failure at submit time, not at plan time. Append the
      // identical capability line `effectiveSigners` would otherwise have
      // synthesized, so the narrowed signer still carries it.
      const gasPayerCapLine =
        gasPayer.type === "gas-station" && gasPayer.gasStationSignerKey === signer.publicKey
          ? `(${ctx.runtime.namespace}.DALOS.GAS_PAYER "" 0 0.0)`
          : null;
      return {
        ...signer,
        capabilityMode: "scoped",
        capabilities: [signer.capabilities, capLine, gasPayerCapLine].filter(Boolean).join("\n"),
      };
    }),
  };

  return { legs: [leg], yield: amount };
};

registerStepPlanner("ouronet.stoa-wrap", stoaWrapPlanner);
