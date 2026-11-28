/**
 * `ouronet.stoa-unwrap` planner tests — unit-tests `stoaUnwrapPlanner`
 * directly (no DB, no `driveRunOnce`), with a hand-built `PlannerCtx` whose
 * `runtime`/`resolver` mocks mirror `evict.test.ts`'s/`stoa-wrap.test.ts`'s
 * own `makeRuntime`/`makeResolver` fixture style, since this planner drives
 * through the SAME real `executeCodexTransaction` machinery those tests
 * already exercise.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChainClient, ChainRuntime, KeyResolver } from "../seams.js";
import type { CodexCronotonStepRow } from "../store/steps.js";
import type { PlannerCtx } from "./registry.js";
import { normalizePlannerResult } from "./registry.js";
import { stoaUnwrapPlanner } from "./stoa-unwrap.js";

const PUB_A = "aa".repeat(32);
// Deliberately DIFFERENT from PUB_A — see stoa-wrap.test.ts's own identical
// constant for the rationale: makeStepRow's default gas-station signing key
// must NOT collide with signer 0's own key by default, so the ordinary
// capability-line assertions below stay a clean single `coin.TRANSFER` line.
const PUB_GASSTATION = "bb".repeat(32);

// ── mock ChainRuntime (modeled on evict.test.ts's/stoa-wrap.test.ts's own fixtures) ──
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

/** A `mode:'planner'` step row targeting `ouronet.stoa-unwrap`. */
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
    planner_name: "ouronet.stoa-unwrap",
    planner_params_json: JSON.stringify({ patronAccount: "k:patron", amount: "5.0" }),
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

describe("stoaUnwrapPlanner", () => {
  it("target account already exists -> exactly one leg with the SINGLE-form pact code (no coin.C_CreateAccount), and no target/ks payload keys", async () => {
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: "k:target123abc" } })
      .mockResolvedValueOnce({ result: { status: "success", data: 50 } });

    const { legs } = normalizePlannerResult(await stoaUnwrapPlanner(makeStepRow(), makeCtx()));

    expect(legs).toHaveLength(1);
    expect(legs[0].pactCode).toBe(
      '(ouronet-ns.TS01-C2.LQD|C_UnwrapStoa (read-string "patron") (read-string "executor") (read-decimal "amount"))',
    );
    expect(legs[0].payload).toEqual({
      patron: "k:patron",
      executor: `k:${PUB_A}`,
      amount: "5.0",
    });
    expect(legs[0].payload).not.toHaveProperty("target");
    expect(legs[0].payload).not.toHaveProperty("ks");
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
  });

  it("target account does not exist -> exactly one leg with the TWO-FORM composite pact code, in order (create THEN unwrap), with a correctly shaped read-keyset payload entry", async () => {
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: "k:target123abc" } })
      .mockResolvedValueOnce({ result: { status: "success", data: false } });

    const { legs } = normalizePlannerResult(await stoaUnwrapPlanner(makeStepRow(), makeCtx()));

    expect(legs).toHaveLength(1);
    expect(legs[0].pactCode).toBe(
      '(coin.C_CreateAccount (read-string "target") (read-keyset "ks"))\n' +
        '(ouronet-ns.TS01-C2.LQD|C_UnwrapStoa (read-string "patron") (read-string "executor") (read-decimal "amount"))',
    );
    expect(legs[0].payload.ks).toEqual({ keys: ["target123abc"], pred: "keys-all" });
    expect(legs[0].payload).toEqual({
      patron: "k:patron",
      executor: `k:${PUB_A}`,
      amount: "5.0",
      target: "k:target123abc",
      ks: { keys: ["target123abc"], pred: "keys-all" },
    });
  });

  it("ALSO appends a DALOS.GAS_PAYER capability when signer 0's own key is the SAME key as the gas-station's signing key — regression test mirroring stoa-wrap.test.ts's identical fix: effectiveSigners (executor-signers.ts) only synthesizes its own GAS_PAYER signer when the gas-station key is NOT already present among `signers`", async () => {
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: "k:target123abc" } })
      .mockResolvedValueOnce({ result: { status: "success", data: 50 } });
    const step = makeStepRow({
      gas_payer_json: JSON.stringify({ type: "gas-station", gasStationSignerKey: PUB_A }),
    });

    const { legs } = normalizePlannerResult(await stoaUnwrapPlanner(step, makeCtx()));

    expect(legs[0].signers[0].capabilities).toBe(
      '(coin.TRANSFER "c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI" "k:target123abc" 5.0)\n' +
        '(ouronet-ns.DALOS.GAS_PAYER "" 0 0.0)',
    );
    expect(legs[0].signers[0].capabilityMode).toBe("scoped");
  });

  it("does NOT append a GAS_PAYER capability when signer 0's key differs from the gas-station's signing key (the ordinary, non-colliding case)", async () => {
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: "k:target123abc" } })
      .mockResolvedValueOnce({ result: { status: "success", data: 50 } });

    const { legs } = normalizePlannerResult(await stoaUnwrapPlanner(makeStepRow(), makeCtx()));

    expect(legs[0].signers[0].capabilities).toBe(
      '(coin.TRANSFER "c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI" "k:target123abc" 5.0)',
    );
  });

  it("attaches a coin.TRANSFER capability scoped to [STOA_AUTONOMIC_LIQUIDPOT, targetAccount, amount] -- LIQUIDPOT first, target second, the REVERSE order from wrap's capability", async () => {
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: "k:target123abc" } })
      .mockResolvedValueOnce({ result: { status: "success", data: 50 } });
    const step = makeStepRow({
      signers_json: JSON.stringify([
        { publicKey: PUB_A, capabilityMode: "scoped", capabilities: '(some.OTHER-CAP "x")' },
      ]),
    });

    const { legs } = normalizePlannerResult(await stoaUnwrapPlanner(step, makeCtx()));

    expect(legs[0].signers[0].capabilities).toBe(
      '(some.OTHER-CAP "x")\n(coin.TRANSFER "c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI" "k:target123abc" 5.0)',
    );
    expect(legs[0].signers[0].capabilityMode).toBe("scoped");
  });

  it("rejects a malformed amount before ever calling the chain", async () => {
    const step = makeStepRow({
      planner_params_json: JSON.stringify({ patronAccount: "k:res", amount: "-5.0" }),
    });

    await expect(stoaUnwrapPlanner(step, makeCtx())).rejects.toThrow(
      /amount must be a non-negative decimal/,
    );
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it("rejects when UR_AccountKadena returns a malformed (non k:/c:) target account", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: "garbage" } });

    await expect(stoaUnwrapPlanner(makeStepRow(), makeCtx())).rejects.toThrow(
      /malformed target account/,
    );
  });

  it("rejects rather than guessing a guard when the resolved target is a c:-prefixed account and the account doesn't exist", async () => {
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: "c:someModuleGuardAccount" } })
      .mockResolvedValueOnce({ result: { status: "success", data: false } });

    await expect(stoaUnwrapPlanner(makeStepRow(), makeCtx())).rejects.toThrow(
      /cannot auto-create a non-k: target account/,
    );
  });

  it("rejects when the existence probe returns a shape that is neither false nor a number", async () => {
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: "k:target123abc" } })
      .mockResolvedValueOnce({ result: { status: "success", data: "unexpected-string" } });

    await expect(stoaUnwrapPlanner(makeStepRow(), makeCtx())).rejects.toThrow(/unexpected shape/);
  });

  it("rejects a malformed patronAccount (fails the k:/c: shape guard) before ever calling the chain", async () => {
    const step = makeStepRow({
      planner_params_json: JSON.stringify({ patronAccount: "not-an-account", amount: "5.0" }),
    });

    await expect(stoaUnwrapPlanner(step, makeCtx())).rejects.toThrow(/not a well-formed k:\/c: account/);
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it("rejects when planner_params_json is missing patronAccount/amount entirely (the typeof guard, not the shape/format guards), never calling the chain", async () => {
    const step = makeStepRow({ planner_params_json: "{}" });

    await expect(stoaUnwrapPlanner(step, makeCtx())).rejects.toThrow(
      /must have patronAccount and amount strings/,
    );
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it("rejects when step.signers_json is an empty array, never reading signers[0].publicKey on an empty array", async () => {
    const step = makeStepRow({ signers_json: "[]" });

    await expect(stoaUnwrapPlanner(step, makeCtx())).rejects.toThrow(
      /must have at least one signer/,
    );
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it("rejects when the UR_AccountKadena resolve read itself fails, never silently defaulting the target account", async () => {
    dirtyRead.mockResolvedValueOnce({
      result: { status: "failure", error: { message: "resolve read exploded" } },
    });

    await expect(stoaUnwrapPlanner(makeStepRow(), makeCtx())).rejects.toThrow(/resolve read exploded/);
  });

  it("rejects when the coin.get-balance existence probe itself fails, never silently assuming the account exists or needs creating", async () => {
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: "k:target123abc" } })
      .mockResolvedValueOnce({
        result: { status: "failure", error: { message: "existence probe exploded" } },
      });

    await expect(stoaUnwrapPlanner(makeStepRow(), makeCtx())).rejects.toThrow(
      /existence probe exploded/,
    );
  });

  it("leaves every signer OTHER than index 0 completely untouched when multiple signers are configured", async () => {
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: "k:target123abc" } })
      .mockResolvedValueOnce({ result: { status: "success", data: 50 } });
    const otherSigner = { publicKey: "bb".repeat(32), capabilityMode: "pure" as const, capabilities: "" };
    const step = makeStepRow({
      signers_json: JSON.stringify([
        { publicKey: PUB_A, capabilityMode: "pure", capabilities: "" },
        otherSigner,
      ]),
    });

    const { legs } = normalizePlannerResult(await stoaUnwrapPlanner(step, makeCtx()));

    expect(legs[0].signers).toHaveLength(2);
    expect(legs[0].signers[1]).toEqual(otherSigner);
  });

  it(
    "both plan reads (UR_AccountKadena, coin.get-balance) NEVER call preflightRead, even when the step's own config is AUTO gas — regression for the bug where a plan read inherited the step's autoGasLimit and got routed through the full buy-gas pipeline, enforcing GAS_PAYER's payable-module whitelist on a pure read",
    async () => {
      dirtyRead
        .mockResolvedValueOnce({ result: { status: "success", data: "k:target" } })
        .mockResolvedValueOnce({ result: { status: "success", data: 50 } });

      await stoaUnwrapPlanner(
        makeStepRow({
          config_json: JSON.stringify({ chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: true, ttl: 600 }),
        }),
        makeCtx(),
      );

      expect(dirtyRead).toHaveBeenCalledTimes(2);
      expect(preflightRead).not.toHaveBeenCalled();
    },
  );
});
