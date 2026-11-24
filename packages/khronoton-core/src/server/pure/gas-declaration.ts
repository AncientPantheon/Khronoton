/**
 * gas-declaration — ported, verbatim in formula, from OuroborosNetwork's
 * OuronetUI (`src/lib/gas/declareGasLimit.ts` + `src/lib/gas-limits.ts`,
 * commits `99df0c7d`/`78f9a24d`, 2026-11-03/04). Full rationale in
 * `docs/work/ouronet-gas-declaration-port/design.md`.
 *
 * THE PROBLEM THIS REPLACES: `@stoachain/stoa-core/gas`'s
 * `calculateAutoGasLimit` is a nine-band MULTIPLICATIVE ladder, buffering
 * against an unknown gap between a dirty-read simulation and the real
 * on-chain cost. That gap turned out to be ADDITIVE, not multiplicative —
 * a roughly flat per-transaction overhead plus a transaction-SIZE charge the
 * node levies on bytes that a plain `dirtyRead` never sees:
 *
 *     total  =  execution gas   (asked of the node — only execution needs it)
 *            +  size charge     (computed offline, exactly — `estimateSizeChargeGas`)
 *            +  drift           (the one thing left that is genuinely judgement)
 *
 * This module is pure arithmetic — no DB, no chain client, no
 * `@stoachain/*` import. The old ladder it defers to below `EVIDENCE_FLOOR`
 * (where nothing has been measured) is injected by the caller as a plain
 * function (`legacyLadder`), never imported directly, matching every other
 * file under `server/pure/`.
 *
 * Below `EVIDENCE_FLOOR` the formula is NOT applied even though it would run
 * — OuronetUI's own first draft tried that and its own test disproved it: at
 * 20,000 gas the ladder and the formula disagree (and both are legitimate
 * answers to different questions), but nothing below that magnitude has
 * actually been measured, so tightening there is guessing, not computing.
 */

/**
 * Bytes a real ed25519 signature adds to the submitted transaction, per
 * signer. A `/local` (dirty-read) command carries empty-string sigs; the
 * submitted one carries 128 hex characters each. A prediction made from the
 * simulated command must add them back, or it under-predicts the real
 * transaction-size charge by this many bytes per signer.
 */
export const SIG_BYTES = 128;

/**
 * Absolute floor for a declared gas limit, carried over from
 * `MIN_AUTO_GAS_LIMIT` unchanged: at the bottom of the range the fixed
 * overhead dwarfs execution, so no proportional term can reach a workable
 * number from an 8-gas reading. Since the fee is charged on gas USED, not
 * the limit, a generous floor costs nothing.
 */
export const MIN_DECLARED_GAS = 1_000;

/**
 * Below this reading the LEGACY LADDER governs, unchanged — the boundary of
 * the evidence this formula is measured against, not a safety fudge.
 */
export const EVIDENCE_FLOOR = 20_000;

/**
 * The flat per-transaction overhead a dirty-read does not charge (gas buy,
 * redeem, signature verification) — measured over 30 mined transactions as a
 * near-constant +96/+97 gas, regardless of signer count or command size.
 */
export const FIXED_OVERHEAD = 150;

/** Drift as a fraction of execution gas — the one judgement-call constant
 *  here, covering another transaction mining between simulation and submission
 *  and sending the same code down a dearer branch. */
export const DRIFT_FRACTION = 0.005;

/** Drift never falls below this flat amount. */
export const DRIFT_FLOOR = 1_000;

/**
 * Headroom reserved for the size term when the command does not exist yet
 * (used by {@link maxSimulatedGasFor}, which has to answer "how much
 * execution gas may a transaction carry" before anything has been built).
 */
export const SIZE_ALLOWANCE = 500;

/**
 * Estimate the transaction-size gas charge (`initialGasOf`), rounded UP:
 *
 *     sizeCost        = 0.01 * payloadBytes   // 1 gas per 100 bytes
 *     sizePenaltyCost = (sizeCost / 512) ^ 7   // ~1 gas at 50 KiB; explodes after
 *     sigsCost        = 21 per ed25519 signer, 526 per webauthn signer
 *     total           = ceil(sizeCost + sizePenaltyCost + sigsCost)
 *
 * Khronoton has no WebAuthn/passkey signer concept (server-side automation,
 * not a browser) — `webauthnSigners` stays, for fidelity to the real
 * formula, but every Khronoton call site always passes `0`.
 */
export function estimateSizeChargeGas(
  payloadBytes: number,
  ed25519Signers = 0,
  webauthnSigners = 0,
): number {
  const p = Math.max(0, payloadBytes);
  const sizeCost = 0.01 * p;
  const sizePenaltyCost = Math.pow(sizeCost / 512, 7);
  const sigsCost = 21 * ed25519Signers + 526 * webauthnSigners;
  return Math.ceil(sizeCost + sizePenaltyCost + sigsCost);
}

/** What to put in `meta.gasLimit`, and the components that produced it. */
export interface GasDeclaration {
  /** What to put in `meta.gasLimit`. */
  gasLimit: number;
  /** The `/local` reading used. */
  executionGas: number;
  /** The size charge, computed offline. Zero when the reading already contained it. */
  sizeCharge: number;
  /** The drift allowance. Does NOT include `FIXED_OVERHEAD`, which is a measured cost. */
  drift: number;
  /** True when the result was cut down by the ceiling rather than by the model. */
  clampedToCeiling: boolean;
}

export interface GasDeclarationInput {
  /** The gas figure returned by `/local`. */
  simulatedGas: number;
  /**
   * Whether that figure ALREADY includes the transaction-size charge.
   *
   * `true` for a `preflight=true` reading, which ran the whole pipeline;
   * `false` for a dirty read, which ran the Pact code and nothing else.
   * There is no default — the caller knows which call it made, and a
   * default would let a new call site be wrong silently.
   */
  simIncludesSize: boolean;
  /** Byte length of the `cmd` string that will be submitted. Omit only if genuinely unknown. */
  cmdBytes?: number;
  ed25519Signers?: number;
  webauthnSigners?: number;
  /** The node or block gas limit. The result is never above this. */
  ceiling: number;
}

/**
 * Compute the gas limit to declare.
 *
 * Returns `gasLimit: 0` for a non-positive/non-finite reading — the "no sim
 * data" sentinel the old function used, preserved so callers that branch on
 * it keep working — and never calls `legacyLadder` for that case.
 *
 * Below `EVIDENCE_FLOOR`, defers entirely to `legacyLadder` (clamped to
 * `ceiling`), since nothing has been measured down there. At or above it,
 * uses the closed-form model: `gasLimit = min(ceiling, max(MIN_DECLARED_GAS,
 * simulatedGas + sizeCharge + FIXED_OVERHEAD + drift))`, where `drift =
 * max(DRIFT_FLOOR, ceil(simulatedGas * DRIFT_FRACTION))`.
 *
 * `sizeCharge` reads differently depending on `simIncludesSize`: a dirty
 * read (`false`) contains no size charge, so the whole thing is added; a
 * preflight read (`true`) already contains the size charge OF THE UNSIGNED
 * command, so only the DELTA the real signatures introduce is added (the
 * per-signer verification term appears in both readings and cancels).
 */
export function declareGasLimit(
  input: GasDeclarationInput,
  legacyLadder: (gasUsed: number) => number,
): GasDeclaration {
  const {
    simulatedGas,
    simIncludesSize,
    cmdBytes = 0,
    ed25519Signers = 0,
    webauthnSigners = 0,
    ceiling,
  } = input;

  if (!Number.isFinite(simulatedGas) || simulatedGas <= 0) {
    return { gasLimit: 0, executionGas: 0, sizeCharge: 0, drift: 0, clampedToCeiling: false };
  }

  // BELOW THE EVIDENCE, DEFER. The ladder stays in charge of the band nothing has measured.
  if (simulatedGas < EVIDENCE_FLOOR) {
    const ladderOutput = legacyLadder(simulatedGas);
    const legacy = Math.min(ladderOutput, ceiling);
    return {
      gasLimit: legacy,
      executionGas: simulatedGas,
      sizeCharge: 0,
      drift: Math.max(0, legacy - simulatedGas),
      // A review finding caught this hardcoded `false`: the ladder's own
      // output CAN exceed `ceiling` (the test two cases below already
      // proves the clamp fires), so the field must report it here too —
      // the same contract the above-floor branch already honors.
      clampedToCeiling: ladderOutput > ceiling,
    };
  }

  const bytes = Math.max(0, cmdBytes);
  const signed = estimateSizeChargeGas(
    bytes + SIG_BYTES * ed25519Signers,
    ed25519Signers,
    webauthnSigners,
  );
  const sizeCharge = simIncludesSize
    ? Math.max(0, signed - estimateSizeChargeGas(bytes, ed25519Signers, webauthnSigners))
    : signed;

  const drift = Math.max(DRIFT_FLOOR, Math.ceil(simulatedGas * DRIFT_FRACTION));
  const wanted = Math.max(MIN_DECLARED_GAS, simulatedGas + sizeCharge + FIXED_OVERHEAD + drift);
  const gasLimit = Math.min(wanted, ceiling);

  return {
    gasLimit,
    executionGas: simulatedGas,
    sizeCharge,
    drift,
    // A clamped declaration is a transaction planned right at the edge of what a block
    // will take — not an error, but the case where the drift allowance has been
    // silently removed, so a caller that can react (e.g. the split planner) is told.
    clampedToCeiling: wanted > ceiling,
  };
}

/**
 * The limit a dirty-read-measured transaction will declare, when the
 * command does not exist yet — a drop-in `(number) => number` shortcut for
 * call sites with no bytes/signers to measure. Ported for completeness and
 * fidelity to the real algorithm; every current Khronoton AUTO-gas call
 * site has real byte/signer data available and calls `declareGasLimit`
 * directly instead.
 */
export function declaredGasFor(
  simulatedGas: number,
  ceiling: number,
  legacyLadder: (gasUsed: number) => number,
): number {
  return declareGasLimit({ simulatedGas, simIncludesSize: false, ceiling }, legacyLadder).gasLimit;
}

/**
 * The most execution gas ONE TRANSACTION may use and still declare under
 * `ceiling` — the limit for a MEASURED single call. Reserves only the terms
 * a simulation genuinely cannot contain (the size charge and the flat
 * overhead); the drift allowance becomes whatever room is left over, since
 * a single transaction has been simulated exactly as it will be sent, not
 * extrapolated from a smaller sample.
 */
export function maxSimulatedGasAtLimit(ceiling: number): number {
  return Math.max(0, ceiling - SIZE_ALLOWANCE - FIXED_OVERHEAD);
}

/**
 * The most execution gas a transaction may be BUDGETED for — the batch-size
 * ceiling for a split planner solving its capacity from an extrapolated
 * model, before anything has been built to measure. Unlike
 * {@link maxSimulatedGasAtLimit}, this reserves the FULL drift allowance,
 * since there is no real measurement yet to narrow it.
 */
export function maxSimulatedGasFor(ceiling: number): number {
  const room = ceiling - SIZE_ALLOWANCE - FIXED_OVERHEAD;
  if (room <= MIN_DECLARED_GAS) return 0;
  const byFraction = Math.floor(room / (1 + DRIFT_FRACTION));
  // Below the crossover the flat floor is the larger allowance, so solve against
  // that instead. Both branches are needed: a node with a small limit lands here.
  return Math.ceil(byFraction * DRIFT_FRACTION) < DRIFT_FLOOR
    ? Math.max(0, room - DRIFT_FLOOR)
    : byFraction;
}
