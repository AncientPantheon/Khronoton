/**
 * `ouronet.aqp-inject` planner tests — unit-tests `injectPlanner` directly (no
 * DB, no `driveRunOnce`), with a hand-built `PlannerCtx` whose `runtime`/
 * `resolver` mocks mirror `evict.test.ts`'s own `makeRuntime`/`makeResolver`
 * fixture style, since this planner drives through the SAME real
 * `executeCodexTransaction` machinery those tests already exercise.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChainClient, ChainRuntime, KeyResolver } from "../seams.js";
import type { CodexCronotonStepRow } from "../store/steps.js";
import type { PlannerCtx } from "./registry.js";
import { injectPlanner } from "./inject.js";

const PUB_A = "aa".repeat(32);

// ── mock ChainRuntime (modeled on evict.test.ts's own fixtures) ────────────
const dirtyRead = vi.fn();
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

/** A `mode:'planner'` step row targeting `ouronet.aqp-inject`. */
function makeStepRow(over: Partial<CodexCronotonStepRow> = {}): CodexCronotonStepRow {
  return {
    id: "step-1",
    codex_cronoton_id: "cc-1",
    step_index: 0,
    mode: "planner",
    pact_code: null,
    config_json: JSON.stringify({ chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 }),
    payload_json: null,
    gas_payer_json: JSON.stringify({ type: "gas-station", gasStationSignerKey: PUB_A }),
    signers_json: JSON.stringify([{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }]),
    planner_name: "ouronet.aqp-inject",
    planner_params_json: JSON.stringify({
      fvtId: "fvt-1",
      patronAccount: "k:patron",
      rewardDptfId: "dptf-1",
      amount: "12.345",
    }),
    idempotent: 0,
    created_at: "t0",
    modified_at: "t0",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentClient = { dirtyRead, submit: vi.fn(), listen: vi.fn() };
  universalSignTransaction.mockResolvedValue({ cmd: "{}", hash: "SIGNED-HASH", sigs: [{ sig: "x" }] });
  isSignedTransaction.mockReturnValue(true);
  getKeyPairByPublicKey.mockResolvedValue({ publicKey: PUB_A, privateKey: "deadbeef", seedType: "koala" });
});

describe("injectPlanner", () => {
  it("returns exactly one leg (CC_InjectFinalize) when the finalize simulation succeeds, with amount flowing through payload unmodified", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 50000 });

    const legs = await injectPlanner(makeStepRow(), makeCtx());

    expect(legs).toHaveLength(1);
    // The FULL namespaced pact code — `ouronet-ns.AQP-FVT`, built from
    // `ctx.runtime.namespace`, never hardcoded — with every value read back
    // from `payload` (env-data), never string-concatenated into the Pact
    // source itself.
    expect(legs[0].pactCode).toBe(
      '(ouronet-ns.AQP-FVT.CC_InjectFinalize (read-string "patron") (read-string "executor") ' +
        '(read-string "fvt-id") (read-string "reward-dptf-id") (read-decimal "amount"))',
    );
    expect(legs[0].payload).toEqual({
      patron: "k:patron",
      executor: `k:${PUB_A}`,
      "fvt-id": "fvt-1",
      "reward-dptf-id": "dptf-1",
      amount: "12.345",
    });
    expect(dirtyRead).toHaveBeenCalledTimes(1);
  });

  it("falls back to CC_Inject when CC_InjectFinalize fails for any reason, and CC_Inject succeeds", async () => {
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "failure", error: { message: "stale stakers remain" } } })
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 50000 });

    const legs = await injectPlanner(makeStepRow(), makeCtx());

    expect(legs).toHaveLength(1);
    // Exact match (not a `toContain("CC_Inject")` substring check, which
    // would also pass for "CC_InjectFinalize") plus the full payload, same
    // rigor as the finalize-success test above — this is a DIFFERENT
    // entrypoint with its own argument list that deserves its own exact
    // assertion, not just "not the other one."
    expect(legs[0].pactCode).toBe(
      '(ouronet-ns.AQP-FVT.CC_Inject (read-string "patron") (read-string "executor") ' +
        '(read-string "fvt-id") (read-string "reward-dptf-id") (read-decimal "amount"))',
    );
    expect(legs[0].payload).toEqual({
      patron: "k:patron",
      executor: `k:${PUB_A}`,
      "fvt-id": "fvt-1",
      "reward-dptf-id": "dptf-1",
      amount: "12.345",
    });
    expect(dirtyRead).toHaveBeenCalledTimes(2);
  });

  it("rejects when BOTH CC_InjectFinalize and CC_Inject fail — never fans out, even when the second failure carries a numeric gasUsed", async () => {
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "failure", error: { message: "stale stakers remain" } } })
      // A numeric gasUsed here would make evictPlanner fan out — injectPlanner
      // has no fan-out leg shape at all and must still reject.
      .mockResolvedValueOnce({ result: { status: "failure", error: { message: "exceeds block gas limit" } }, gas: 3_000_000 });

    await expect(injectPlanner(makeStepRow(), makeCtx())).rejects.toThrow(/exceeds block gas limit/);
    expect(dirtyRead).toHaveBeenCalledTimes(2);
  });

  it("rejects with a configuration-error message when planner_params_json is missing fvtId, never calling the chain", async () => {
    const step = makeStepRow({
      planner_params_json: JSON.stringify({ patronAccount: "k:patron", rewardDptfId: "dptf-1", amount: "1.0" }),
    });

    await expect(injectPlanner(step, makeCtx())).rejects.toThrow(/fvtId/);
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it("rejects with a configuration-error message when planner_params_json is missing amount specifically, never calling the chain", async () => {
    const step = makeStepRow({
      planner_params_json: JSON.stringify({ fvtId: "fvt-1", patronAccount: "k:patron", rewardDptfId: "dptf-1" }),
    });

    await expect(injectPlanner(step, makeCtx())).rejects.toThrow(/amount/);
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it.each(["-5.0", "abc", "5", "5.", ".5", "5.0e3", ""])(
    "rejects a malformed or negative amount %j before ever calling the chain",
    async (badAmount) => {
      const step = makeStepRow({
        planner_params_json: JSON.stringify({
          fvtId: "fvt-1",
          patronAccount: "k:patron",
          rewardDptfId: "dptf-1",
          amount: badAmount,
        }),
      });

      await expect(injectPlanner(step, makeCtx())).rejects.toThrow(/amount must be a non-negative decimal/);
      expect(dirtyRead).not.toHaveBeenCalled();
    },
  );
});
