/**
 * gas-declaration — ported from OuroborosNetwork's OuronetUI
 * (`src/lib/gas/declareGasLimit.ts` + `src/lib/gas-limits.ts`, commits
 * `99df0c7d`/`78f9a24d`). These tests pin the ported formulas to the worked
 * examples in the real source's own header/doc comments and to values
 * independently recomputed against that source this session (see
 * `docs/work/ouronet-gas-declaration-port/design.md`).
 *
 * `legacyLadder` is always a hand-written `vi.fn` stub here, never the real
 * `@stoachain/stoa-core` ladder — the module under test takes it as a plain
 * injected function and must stay import-free of `@stoachain/*`, matching
 * this package's existing convention of faking `calculateAutoGasLimit` in
 * `executor.test.ts`/`runs-driver.test.ts` rather than importing it for real.
 */
import { describe, it, expect, vi } from "vitest";

import {
  SIG_BYTES,
  MIN_DECLARED_GAS,
  EVIDENCE_FLOOR,
  FIXED_OVERHEAD,
  DRIFT_FRACTION,
  DRIFT_FLOOR,
  SIZE_ALLOWANCE,
  estimateSizeChargeGas,
  declareGasLimit,
  declaredGasFor,
  maxSimulatedGasAtLimit,
  maxSimulatedGasFor,
} from "./gas-declaration.js";

const CEILING = 2_000_000;

describe("gas-declaration — named constants", () => {
  it("exports the exact ported values", () => {
    expect(SIG_BYTES).toBe(128);
    expect(MIN_DECLARED_GAS).toBe(1_000);
    expect(EVIDENCE_FLOOR).toBe(20_000);
    expect(FIXED_OVERHEAD).toBe(150);
    expect(DRIFT_FRACTION).toBe(0.005);
    expect(DRIFT_FLOOR).toBe(1_000);
    expect(SIZE_ALLOWANCE).toBe(500);
  });
});

describe("estimateSizeChargeGas", () => {
  it("returns 0 for an empty payload with no signers", () => {
    expect(estimateSizeChargeGas(0)).toBe(0);
  });

  it("charges 21 gas per ed25519 signer and 526 per webauthn signer, with no bytes", () => {
    expect(estimateSizeChargeGas(0, 1, 0)).toBe(21);
    expect(estimateSizeChargeGas(0, 0, 1)).toBe(526);
  });

  it("at a ~300KB payload, the 7th-power penalty term dominates the flat size-rate term — " +
    "the whole reason this function has two terms instead of one", () => {
    const bytes = 300 * 1024; // 307,200
    const sizeCost = 0.01 * bytes; // 3,072
    const penalty = Math.pow(sizeCost / 512, 7); // 279,936
    expect(penalty).toBeGreaterThan(sizeCost * 10);
    expect(estimateSizeChargeGas(bytes)).toBe(283_008);
  });

  it("negative payloadBytes clamps to 0 rather than going negative", () => {
    expect(estimateSizeChargeGas(-500)).toBe(0);
  });
});

describe("declareGasLimit — non-finite/zero/negative simulatedGas", () => {
  it("returns the all-zero sentinel and never calls legacyLadder, for NaN/0/-5", () => {
    for (const simulatedGas of [NaN, 0, -5, Infinity, -Infinity]) {
      const legacyLadder = vi.fn((g: number) => g * 100);
      const result = declareGasLimit(
        { simulatedGas, simIncludesSize: false, ceiling: CEILING },
        legacyLadder,
      );
      expect(result).toEqual({
        gasLimit: 0,
        executionGas: 0,
        sizeCharge: 0,
        drift: 0,
        clampedToCeiling: false,
      });
      expect(legacyLadder).not.toHaveBeenCalled();
    }
  });
});

describe("declareGasLimit — below EVIDENCE_FLOOR defers to legacyLadder unchanged", () => {
  it("simulatedGas=8: the stub's return value (1000) flows through untouched", () => {
    const legacyLadder = vi.fn((_gasUsed: number) => 1000);

    const result = declareGasLimit(
      { simulatedGas: 8, simIncludesSize: false, ceiling: CEILING },
      legacyLadder,
    );

    expect(legacyLadder).toHaveBeenCalledTimes(1);
    expect(legacyLadder).toHaveBeenCalledWith(8);
    expect(result).toEqual({
      gasLimit: 1000,
      executionGas: 8,
      sizeCharge: 0,
      drift: 992,
      clampedToCeiling: false,
    });
  });

  it("clamps the legacy ladder's output to ceiling when the ladder itself exceeds it, and reports clampedToCeiling: true", () => {
    const legacyLadder = vi.fn((_gasUsed: number) => 5_000_000);

    const result = declareGasLimit(
      { simulatedGas: 50, simIncludesSize: false, ceiling: CEILING },
      legacyLadder,
    );

    expect(result.gasLimit).toBe(CEILING);
    expect(result.drift).toBe(CEILING - 50);
    // Regression (review finding): this branch used to hardcode `false` here
    // even though the ladder's own output genuinely got clamped above —
    // contradicting the field's own documented contract ("true when the
    // result was cut down by the ceiling rather than by the model").
    expect(result.clampedToCeiling).toBe(true);
  });

  it("does NOT report clampedToCeiling when the ladder's own output already fits under ceiling", () => {
    const legacyLadder = vi.fn((_gasUsed: number) => 1000);

    const result = declareGasLimit(
      { simulatedGas: 8, simIncludesSize: false, ceiling: CEILING },
      legacyLadder,
    );

    expect(result.gasLimit).toBe(1000);
    expect(result.clampedToCeiling).toBe(false);
  });
});

describe("declareGasLimit — at/above EVIDENCE_FLOOR takes the NEW closed-form path", () => {
  it("simulatedGas=20000 (exactly the floor — guard is strict '<', so the NEW formula " +
    "governs here, not the ladder) never calls legacyLadder and does not match the " +
    "ladder's own 27,000", () => {
    const legacyLadder = vi.fn((_gasUsed: number) => 27_000);

    const result = declareGasLimit(
      { simulatedGas: 20_000, simIncludesSize: false, cmdBytes: 0, ed25519Signers: 0, ceiling: CEILING },
      legacyLadder,
    );

    expect(legacyLadder).not.toHaveBeenCalled();
    // 20000 (exec) + 0 (sizeCharge) + 150 (FIXED_OVERHEAD) + 1000 (drift floor, since
    // ceil(20000*0.005)=100 < DRIFT_FLOOR) = 21150.
    expect(result).toEqual({
      gasLimit: 21_150,
      executionGas: 20_000,
      sizeCharge: 0,
      drift: 1_000,
      clampedToCeiling: false,
    });
    expect(result.gasLimit).not.toBe(27_000);
  });

  it("simulatedGas=100000, same inputs — drift still floor-bound, same shape as 20000's case", () => {
    const legacyLadder = vi.fn();

    const result = declareGasLimit(
      { simulatedGas: 100_000, simIncludesSize: false, cmdBytes: 0, ed25519Signers: 0, ceiling: CEILING },
      legacyLadder,
    );

    expect(legacyLadder).not.toHaveBeenCalled();
    // 100000 + 0 + 150 + max(1000, ceil(100000*0.005)=500) = 101150.
    expect(result).toEqual({
      gasLimit: 101_150,
      executionGas: 100_000,
      sizeCharge: 0,
      drift: 1_000,
      clampedToCeiling: false,
    });
  });

  it("a realistic case near 1,751,061 with real cmdBytes/signers declares meaningfully " +
    "below what @stoachain/stoa-core's own calculateAutoGasLimit ladder would (1,858,615, " +
    "confirmed by direct inspection of its published 4.5.0 formula for this input)", () => {
    const legacyLadder = vi.fn();
    const LADDER_OUTPUT_FOR_THIS_INPUT = 1_858_615;

    const result = declareGasLimit(
      {
        simulatedGas: 1_751_061,
        simIncludesSize: false,
        cmdBytes: 1200,
        ed25519Signers: 2,
        ceiling: CEILING,
      },
      legacyLadder,
    );

    expect(legacyLadder).not.toHaveBeenCalled();
    // signedCharge = estimateSizeChargeGas(1200 + 128*2, 2, 0) = estimateSizeChargeGas(1456,2,0) = 57.
    // simIncludesSize:false => sizeCharge = signedCharge = 57.
    // drift = max(1000, ceil(1751061*0.005)) = 8756.
    // wanted = 1751061 + 57 + 150 + 8756 = 1760024.
    expect(result).toEqual({
      gasLimit: 1_760_024,
      executionGas: 1_751_061,
      sizeCharge: 57,
      drift: 8_756,
      clampedToCeiling: false,
    });
    expect(result.gasLimit).toBeLessThan(LADDER_OUTPUT_FOR_THIS_INPUT);
    // Not a token saving: ~98,591 gas recovered on this one transaction.
    expect(LADDER_OUTPUT_FOR_THIS_INPUT - result.gasLimit).toBeGreaterThan(90_000);
  });

  it("subtracts the unsigned-command's own size charge when simIncludesSize is true, " +
    "charging only the signature-byte DELTA rather than the whole size term twice", () => {
    const withoutSigFlag = declareGasLimit(
      {
        simulatedGas: 50_000,
        simIncludesSize: false,
        cmdBytes: 1000,
        ed25519Signers: 1,
        ceiling: CEILING,
      },
      vi.fn(),
    );
    const withSigFlag = declareGasLimit(
      {
        simulatedGas: 50_000,
        simIncludesSize: true,
        cmdBytes: 1000,
        ed25519Signers: 1,
        ceiling: CEILING,
      },
      vi.fn(),
    );

    // simIncludesSize:false charges the FULL estimateSizeChargeGas(1000+128,1,0).
    // simIncludesSize:true charges only the delta over estimateSizeChargeGas(1000,1,0) —
    // strictly smaller, since the unsigned command's own size charge is already counted
    // in the simulated reading.
    expect(withSigFlag.sizeCharge).toBeLessThan(withoutSigFlag.sizeCharge);
    expect(withSigFlag.gasLimit).toBeLessThan(withoutSigFlag.gasLimit);
  });

  it("clampedToCeiling is true exactly when the wanted figure exceeds the ceiling, and the " +
    "declared gasLimit is cut down to the ceiling rather than left over it", () => {
    const result = declareGasLimit(
      { simulatedGas: 1_999_000, simIncludesSize: false, cmdBytes: 0, ed25519Signers: 0, ceiling: CEILING },
      vi.fn(),
    );

    // wanted = 1999000 + 0 + 150 + max(1000, ceil(1999000*0.005)=9995) = 2009145 > ceiling.
    expect(result.gasLimit).toBe(CEILING);
    expect(result.clampedToCeiling).toBe(true);
  });
});

describe("declaredGasFor", () => {
  it("delegates to declareGasLimit with simIncludesSize:false, matching a direct call " +
    "with the same flag — for both the sub-floor ladder path and the new-formula path", () => {
    const legacyLadder = vi.fn((_gasUsed: number) => 1000);

    const viaShortcutSubFloor = declaredGasFor(8, CEILING, legacyLadder);
    const viaDirectSubFloor = declareGasLimit(
      { simulatedGas: 8, simIncludesSize: false, ceiling: CEILING },
      legacyLadder,
    ).gasLimit;
    expect(viaShortcutSubFloor).toBe(viaDirectSubFloor);

    const viaShortcutAboveFloor = declaredGasFor(50_000, CEILING, legacyLadder);
    const viaDirectAboveFloor = declareGasLimit(
      { simulatedGas: 50_000, simIncludesSize: false, ceiling: CEILING },
      legacyLadder,
    ).gasLimit;
    expect(viaShortcutAboveFloor).toBe(viaDirectAboveFloor);
  });
});

describe("maxSimulatedGasAtLimit", () => {
  it("at a 2,000,000 ceiling reserves only SIZE_ALLOWANCE + FIXED_OVERHEAD = 1,999,350", () => {
    expect(maxSimulatedGasAtLimit(2_000_000)).toBe(1_999_350);
  });

  it("never goes negative for a ceiling smaller than the reserved allowance", () => {
    expect(maxSimulatedGasAtLimit(100)).toBe(0);
  });
});

describe("maxSimulatedGasFor", () => {
  it("at a 2,000,000 ceiling reserves the full drift fraction, yielding 1,989,402 — " +
    "matching OuronetUI's own documented value for this exact ceiling", () => {
    expect(maxSimulatedGasFor(2_000_000)).toBe(1_989_402);
  });

  it("returns LESS capacity than maxSimulatedGasAtLimit for the same ceiling — the " +
    "extrapolated-model case reserves the full drift fraction, the measured-single-tx " +
    "case does not, which is the one behavioral property this port exists to preserve", () => {
    expect(maxSimulatedGasFor(2_000_000)).toBeLessThan(maxSimulatedGasAtLimit(2_000_000));
  });

  it("falls back to the flat DRIFT_FLOOR-derived room below the fraction/floor crossover", () => {
    // room = 2000-500-150 = 1350. byFraction = floor(1350/1.005) = 1343, whose own
    // drift (ceil(1343*0.005)=7) is under DRIFT_FLOOR — so the floor branch governs
    // instead: room - DRIFT_FLOOR = 1350 - 1000 = 350.
    expect(maxSimulatedGasFor(2_000)).toBe(350);
  });
});
