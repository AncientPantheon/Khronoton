/**
 * `ouronet.stoa-wrap` planner tests — unit-tests `stoaWrapPlanner` directly (no
 * DB, no `driveRunOnce`), with a hand-built `PlannerCtx` whose `runtime`/
 * `resolver` mocks mirror `evict.test.ts`'s own `makeRuntime`/`makeResolver`
 * fixture style, since this planner drives through the SAME real
 * `executeCodexTransaction` machinery those tests already exercise.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChainClient, ChainRuntime, KeyResolver } from "../seams.js";
import type { CodexCronotonStepRow } from "../store/steps.js";
import type { PlannerCtx } from "./registry.js";
import { normalizePlannerResult } from "./registry.js";
import { stoaWrapPlanner } from "./stoa-wrap.js";

const PUB_A = "aa".repeat(32);
// Deliberately DIFFERENT from PUB_A — makeStepRow's default gas-station
// signing key must NOT collide with signer 0's own key by default, so the
// ordinary capability-line assertions below stay a clean single
// `coin.TRANSFER` line. The one dedicated test below that DOES configure
// this collision (`gasStationSignerKey: PUB_A`) is what proves the
// gas-sponsorship-capability fix actually works.
const PUB_GASSTATION = "bb".repeat(32);

// ── mock ChainRuntime (modeled on evict.test.ts's own fixtures) ────────────
const dirtyRead = vi.fn();
const preflightRead = vi.fn();
let currentClient: ChainClient;
const createClient = vi.fn((..._a: unknown[]) => currentClient);
const universalSignTransaction = vi.fn();
const isSignedTransaction = vi.fn(() => true);
const getPactUrl = vi.fn((c: string) => `https://node/${c}`);
const calculateAutoGasLimit = vi.fn((g: number) => g * 2);
const anuToStoa = vi.fn((a: number) => a / 1e12);
const gasMeta = vi.fn(() => ({ creationTime: 1000, gasPrice: 0.001 }));

function makeFakeBuilder() {
  const builder: Record<string, unknown> = {};
  builder.setMeta = () => builder;
  builder.setNetworkId = () => builder;
  builder.addData = () => builder;
  builder.addSigner = () => builder;
  builder.createTransaction = () => ({ cmd: "{}", hash: "SIGNED-HASH", sigs: [] });
  return builder;
}
const fakePactBuilder = {
  get builder() {
    return { execution: () => makeFakeBuilder() };
  },
};

function makeRuntime(): ChainRuntime {
  return {
    Pact: fakePactBuilder,
    createClient,
    isSignedTransaction,
    universalSignTransaction,
    calculateAutoGasLimit,
    anuToStoa,
    gasMeta,
    getPactUrl,
    networkId: "stoa",
    namespace: "ouronet-ns",
    gasStationAccount: "c:GASSTATION",
  };
}

const getKeyPairByPublicKey = vi.fn();
const listCodexPubs = vi.fn(async () => new Set<string>());
function makeResolver(): KeyResolver {
  return { getKeyPairByPublicKey, listCodexPubs };
}

function makeCtx(): PlannerCtx {
  return { runtime: makeRuntime(), resolver: makeResolver() };
}

/** A `mode:'planner'` step row targeting `ouronet.stoa-wrap`. */
function makeStepRow(over: Partial<CodexCronotonStepRow> = {}): CodexCronotonStepRow {
  return {
    id: "step-1",
    codex_cronoton_id: "cc-1",
    step_index: 0,
    mode: "planner",
    pact_code: null,
    config_json: JSON.stringify({ chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 }),
    payload_json: null,
    gas_payer_json: JSON.stringify({ type: "gas-station", gasStationSignerKey: PUB_GASSTATION }),
    signers_json: JSON.stringify([{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }]),
    planner_name: "ouronet.stoa-wrap",
    planner_params_json: JSON.stringify({ patronAccount: "k:patron" }),
    yield_as: null,
    idempotent: 0,
    created_at: "t0",
    modified_at: "t0",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentClient = { dirtyRead, preflightRead, submit: vi.fn(), listen: vi.fn() };
  universalSignTransaction.mockResolvedValue({ cmd: "{}", hash: "SIGNED-HASH", sigs: [{ sig: "x" }] });
  isSignedTransaction.mockReturnValue(true);
  getKeyPairByPublicKey.mockResolvedValue({ publicKey: PUB_A, privateKey: "deadbeef", seedType: "koala" });
});

describe("stoaWrapPlanner", () => {
  it("reads the live balance via coin.get-balance (no namespace prefix) and builds exactly one LQD|C_WrapStoa leg with the exact namespaced pact code and payload, amount formatted as a decimal with a '.'", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: 5 } });

    const result = await stoaWrapPlanner(makeStepRow(), makeCtx());
    const { legs, yield: y } = normalizePlannerResult(result);

    expect(legs).toHaveLength(1);
    expect(legs[0].pactCode).toBe(
      '(ouronet-ns.TS01-C2.LQD|C_WrapStoa (read-string "patron") (read-string "executor") (read-decimal "amount"))',
    );
    expect(legs[0].payload).toEqual({
      patron: "k:patron",
      executor: `k:${PUB_A}`,
      amount: "5.0",
    });
    // The parsed config/gasPayer must thread through unchanged into the
    // produced leg — a dropped/mis-threaded value here would silently
    // mis-price or mis-route the real transaction at fire time.
    expect(legs[0].config).toEqual({
      chainId: "0",
      gasPrice: 0,
      gasLimit: 1000,
      autoGasLimit: false,
      ttl: 600,
    });
    expect(legs[0].gasPayer).toEqual({ type: "gas-station", gasStationSignerKey: PUB_GASSTATION });
    expect(y).toBe("5.0");
  });

  it("returns a bare [] (no yield field) without building any leg when the live balance is 0, and never calls dirtyRead a second time", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: 0 } });

    const result = await stoaWrapPlanner(makeStepRow(), makeCtx());

    expect(result).toEqual([]);
    expect(dirtyRead).toHaveBeenCalledTimes(1);
  });

  it("ALSO appends a DALOS.GAS_PAYER capability when signer 0's own key is the SAME key as the gas-station's signing key — regression test for a real bug found on behavioral/final review: effectiveSigners (executor-signers.ts) only synthesizes its own GAS_PAYER signer when the gas-station key is NOT already present among `signers`; narrowing signer 0 to scoped+coin.TRANSFER-only when it's ALSO the gas-station key would otherwise silently drop gas sponsorship", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: 5 } });
    const step = makeStepRow({
      // Signer 0's key IS the gas-station signing key — the exact collision
      // every OTHER test in this file deliberately avoids via PUB_GASSTATION.
      gas_payer_json: JSON.stringify({ type: "gas-station", gasStationSignerKey: PUB_A }),
    });

    const { legs } = normalizePlannerResult(await stoaWrapPlanner(step, makeCtx()));

    expect(legs[0].signers[0].capabilities).toBe(
      '(coin.TRANSFER "k:patron" "c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI" 5.0)\n' +
        '(ouronet-ns.DALOS.GAS_PAYER "" 0 0.0)',
    );
    expect(legs[0].signers[0].capabilityMode).toBe("scoped");
  });

  it("does NOT append a GAS_PAYER capability when signer 0's key differs from the gas-station's signing key (the ordinary, non-colliding case)", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: 5 } });

    const { legs } = normalizePlannerResult(await stoaWrapPlanner(makeStepRow(), makeCtx()));

    expect(legs[0].signers[0].capabilities).toBe(
      '(coin.TRANSFER "k:patron" "c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI" 5.0)',
    );
  });

  it("attaches a coin.TRANSFER capability to signer 0, scoped to [patronAccount, STOA_AUTONOMIC_LIQUIDPOT, amount], preserving signer 0's ORIGINAL capabilities string by appending rather than replacing", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: 5 } });
    const step = makeStepRow({
      signers_json: JSON.stringify([
        { publicKey: PUB_A, capabilityMode: "scoped", capabilities: '(some.OTHER-CAP "x")' },
      ]),
    });

    const { legs } = normalizePlannerResult(await stoaWrapPlanner(step, makeCtx()));

    expect(legs[0].signers[0].capabilities).toBe(
      '(some.OTHER-CAP "x")\n(coin.TRANSFER "k:patron" "c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI" 5.0)',
    );
    expect(legs[0].signers[0].capabilityMode).toBe("scoped");
  });

  it('formats an integer balance (5) as "5.0", not "5", so Pact\'s read-decimal accepts it', async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: 5 } });

    const { legs } = normalizePlannerResult(await stoaWrapPlanner(makeStepRow(), makeCtx()));

    expect(legs[0].payload.amount).toBe("5.0");
  });

  it("rejects a malformed patronAccount (fails the k:/c: shape guard) before ever calling the chain", async () => {
    const step = makeStepRow({
      planner_params_json: JSON.stringify({ patronAccount: "not-an-account" }),
    });

    await expect(stoaWrapPlanner(step, makeCtx())).rejects.toThrow(/not a well-formed k:\/c: account/);
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it("rejects when coin.get-balance returns a non-numeric result, never silently treating it as zero", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: "oops" } });

    await expect(stoaWrapPlanner(makeStepRow(), makeCtx())).rejects.toThrow(/non-numeric/);
  });

  it("rejects when coin.get-balance itself fails (account doesn't exist), never silently returning []", async () => {
    dirtyRead.mockResolvedValueOnce({
      result: { status: "failure", error: { message: "row not found" } },
    });

    await expect(stoaWrapPlanner(makeStepRow(), makeCtx())).rejects.toThrow(/row not found/);
  });

  it("rejects when planner_params_json is missing patronAccount entirely (the typeof guard, not the shape guard), never calling the chain", async () => {
    const step = makeStepRow({ planner_params_json: "{}" });

    await expect(stoaWrapPlanner(step, makeCtx())).rejects.toThrow(/must have a patronAccount string/);
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it("rejects when step.signers_json is an empty array, never reading signers[0].publicKey on an empty array", async () => {
    const step = makeStepRow({ signers_json: "[]" });

    await expect(stoaWrapPlanner(step, makeCtx())).rejects.toThrow(
      /must have at least one signer/,
    );
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it("formats a fractional balance with trailing zeros stripped down to at least one digit after the decimal point", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: 5.100000000000 } });

    const { legs } = normalizePlannerResult(await stoaWrapPlanner(makeStepRow(), makeCtx()));

    expect(legs[0].payload.amount).toBe("5.1");
  });

  it("formats a balance that already has a clean fractional part unchanged", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: 5.25 } });

    const { legs } = normalizePlannerResult(await stoaWrapPlanner(makeStepRow(), makeCtx()));

    expect(legs[0].payload.amount).toBe("5.25");
  });

  it("rejects a negative balance from coin.get-balance as a genuine error, never formatting it into a transfer amount", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: -1 } });

    await expect(stoaWrapPlanner(makeStepRow(), makeCtx())).rejects.toThrow(/invalid amount/);
  });

  it("formats a realistic measured balance (262613.4, from the source handoff's own measurement) WITHOUT binary-floating-point representation noise — regression test for a real bug a behavioral smoke test against the built artifact found: toFixed(12) on this exact value produces \"262613.400000000023\"", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: 262613.4 } });

    const { legs } = normalizePlannerResult(await stoaWrapPlanner(makeStepRow(), makeCtx()));

    expect(legs[0].payload.amount).toBe("262613.4");
    expect(legs[0].signers[0].capabilities).toBe(
      '(coin.TRANSFER "k:patron" "c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI" 262613.4)',
    );
  });

  it("expands a sub-1e-6-magnitude dust balance to plain decimal form, never scientific notation, since Pact decimal literals have no exponent syntax", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: 1e-7 } });

    const { legs } = normalizePlannerResult(await stoaWrapPlanner(makeStepRow(), makeCtx()));

    expect(legs[0].payload.amount).toBe("0.0000001");
  });

  it("rejects a balance of 1e21 or more as a genuine error, never emitting scientific notation into a signed capability line", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: 1e21 } });

    await expect(stoaWrapPlanner(makeStepRow(), makeCtx())).rejects.toThrow(/invalid amount/);
  });

  it("leaves every signer OTHER than index 0 completely untouched when multiple signers are configured", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: 5 } });
    const otherSigner = { publicKey: "bb".repeat(32), capabilityMode: "pure" as const, capabilities: "" };
    const step = makeStepRow({
      signers_json: JSON.stringify([
        { publicKey: PUB_A, capabilityMode: "pure", capabilities: "" },
        otherSigner,
      ]),
    });

    const { legs } = normalizePlannerResult(await stoaWrapPlanner(step, makeCtx()));

    expect(legs[0].signers).toHaveLength(2);
    expect(legs[0].signers[1]).toEqual(otherSigner);
  });

  it("builds the leg using amountOverride directly WITHOUT calling coin.get-balance (dirtyRead) at all, proving the probe is genuinely skipped", async () => {
    const step = makeStepRow({
      planner_params_json: JSON.stringify({ patronAccount: "k:patron", amountOverride: "50.0" }),
    });

    const { legs, yield: y } = normalizePlannerResult(await stoaWrapPlanner(step, makeCtx()));

    expect(dirtyRead).not.toHaveBeenCalled();
    expect(legs).toHaveLength(1);
    expect(legs[0].payload.amount).toBe("50.0");
    expect(y).toBe("50.0");
  });

  it("returns a bare [] (no leg, no yield) for a zero amountOverride, mirroring the live-probe path's own zero-balance short-circuit — regression: previously built a real zero-value wrap leg instead", async () => {
    const step = makeStepRow({
      planner_params_json: JSON.stringify({ patronAccount: "k:patron", amountOverride: "0.0" }),
    });

    const result = await stoaWrapPlanner(step, makeCtx());

    expect(result).toEqual([]);
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it("rejects an amountOverride that is not a non-negative decimal string (bare integer '5'), before building any leg or probing the chain", async () => {
    const step = makeStepRow({
      planner_params_json: JSON.stringify({ patronAccount: "k:patron", amountOverride: "5" }),
    });

    await expect(stoaWrapPlanner(step, makeCtx())).rejects.toThrow(
      /amountOverride must be a non-negative decimal string/,
    );
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it("rejects an amountOverride that isn't numeric at all ('abc'), before building any leg or probing the chain", async () => {
    const step = makeStepRow({
      planner_params_json: JSON.stringify({ patronAccount: "k:patron", amountOverride: "abc" }),
    });

    await expect(stoaWrapPlanner(step, makeCtx())).rejects.toThrow(
      /amountOverride must be a non-negative decimal string/,
    );
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it("returns { legs, yield } — not a bare PlannedLeg[] — in the live-probe path too, with yield equal to the exact amount string used to build the leg", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: 5 } });

    const result = await stoaWrapPlanner(makeStepRow(), makeCtx());

    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) {
      throw new Error("unreachable — asserted above that result is not an array");
    }
    expect(result).toHaveProperty("legs");
    expect(result).toHaveProperty("yield", "5.0");
    expect(result.legs[0].payload.amount).toBe(result.yield);
  });

  it(
    "the coin.get-balance plan read NEVER calls preflightRead, even when the step's own config is AUTO gas — regression for the bug where a plan read inherited the step's autoGasLimit and got routed through the full buy-gas pipeline, enforcing GAS_PAYER's payable-module whitelist on a pure read",
    async () => {
      dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: 5 } });

      await stoaWrapPlanner(
        makeStepRow({
          config_json: JSON.stringify({ chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: true, ttl: 600 }),
        }),
        makeCtx(),
      );

      expect(dirtyRead).toHaveBeenCalledTimes(1);
      expect(preflightRead).not.toHaveBeenCalled();
    },
  );
});
