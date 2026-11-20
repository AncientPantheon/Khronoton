/**
 * `ouronet.aqp-evict` planner tests — unit-tests `evictPlanner` directly (no
 * DB, no `driveRunOnce`), with a hand-built `PlannerCtx` whose `runtime`/
 * `resolver` mocks mirror `runs-driver.test.ts`'s own `makeRuntime`/
 * `makeResolver` fixture style, since this planner drives through the SAME
 * real `executeCodexTransaction` machinery those tests already exercise.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChainClient, ChainRuntime, KeyResolver } from "../seams.js";
import type { CodexCronotonStepRow } from "../store/steps.js";
import type { PlannerCtx } from "./registry.js";
import { normalizePlannerResult } from "./registry.js";
import { evictPlanner } from "./evict.js";

const PUB_A = "aa".repeat(32);

// ── mock ChainRuntime (modeled on runs-driver.test.ts's own fixtures) ───────
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

/** A `mode:'planner'` step row targeting `ouronet.aqp-evict`. */
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
    planner_name: "ouronet.aqp-evict",
    planner_params_json: JSON.stringify({ fvtId: "fvt-1", patronAccount: "k:patron" }),
    yield_as: null,
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

describe("evictPlanner", () => {
  it("returns [] when URHC_BuildEvictPlans reads zero outstanding legs — nothing owed, no leg built", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: [] } });

    const { legs } = normalizePlannerResult(await evictPlanner(makeStepRow(), makeCtx()));

    expect(legs).toEqual([]);
    expect(dirtyRead).toHaveBeenCalledTimes(1);
  });

  it("returns exactly one leg (CC_FullEvictRewards) when the full-evict simulation succeeds under the gas ceiling", async () => {
    dirtyRead
      .mockResolvedValueOnce({
        result: { status: "success", data: [{ beneficiary: "k:ben-1", scoreEntityType: 1, scoreEntityId: "se-1", rewardDptfId: "dptf-1" }] },
      })
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 50000 });

    const { legs } = normalizePlannerResult(await evictPlanner(makeStepRow(), makeCtx()));

    expect(legs).toHaveLength(1);
    // The FULL namespaced pact code — `ouronet-ns.AQP-EVCT`, the module's
    // real deployed path, never a bare `AQP-EVCT` reference — with every
    // value read back from `payload` (env-data), never string-concatenated
    // into the Pact source itself.
    expect(legs[0].pactCode).toBe(
      '(ouronet-ns.AQP-EVCT.CC_FullEvictRewards (read-string "patron") (read-string "executor") (read-string "fvt-id"))',
    );
    expect(legs[0].payload).toEqual({
      patron: "k:patron",
      executor: `k:${PUB_A}`,
      "fvt-id": "fvt-1",
    });
  });

  it("fans out to one CC_EvictSingleReward leg per plan entry when the full-evict probe refuses as unmineable (gasUsed over the ceiling)", async () => {
    const plan = [
      { beneficiary: "k:ben-1", scoreEntityType: 1, scoreEntityId: "se-1", rewardDptfId: "dptf-1" },
      { beneficiary: "k:ben-2", scoreEntityType: 3, scoreEntityId: "se-2", rewardDptfId: "dptf-2" },
      { beneficiary: "k:ben-3", scoreEntityType: 1, scoreEntityId: "se-3", rewardDptfId: "dptf-3" },
    ];
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: plan } })
      // Over AUTO_GAS_CEILING (2_000_000) — triggers runSimulate's own
      // gasUsed > ceiling "refuse unmineable" branch, which sets a numeric
      // gasUsed on an otherwise ok:false result.
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 3_000_000 });

    const { legs } = normalizePlannerResult(await evictPlanner(makeStepRow(), makeCtx()));

    expect(legs).toHaveLength(3);
    const expectedPactCode =
      '(ouronet-ns.AQP-EVCT.CC_EvictSingleReward (read-string "patron") (read-string "executor") ' +
      '(read-string "fvt-id") (read-string "beneficiary") (read-integer "score-entity-type") ' +
      '(read-string "score-entity-id") (read-string "reward-dptf-id"))';
    legs.forEach((leg, i) => {
      // Every leg shares the identical namespaced pact code — only the
      // payload (env-data) differs per leg, never the Pact source string.
      expect(leg.pactCode).toBe(expectedPactCode);
      expect(leg.payload).toEqual({
        patron: "k:patron",
        executor: `k:${PUB_A}`,
        "fvt-id": "fvt-1",
        beneficiary: plan[i].beneficiary,
        "score-entity-type": plan[i].scoreEntityType,
        "score-entity-id": plan[i].scoreEntityId,
        "reward-dptf-id": plan[i].rewardDptfId,
      });
    });
  });

  it("rejects when the full-evict probe fails for a genuine (non-gas) chain reason, never treating it as 'needs splitting'", async () => {
    dirtyRead
      .mockResolvedValueOnce({
        result: { status: "success", data: [{ beneficiary: "k:ben-1", scoreEntityType: 1, scoreEntityId: "se-1", rewardDptfId: "dptf-1" }] },
      })
      .mockResolvedValueOnce({ result: { status: "failure", error: { message: "some other real Pact error" } } });

    await expect(evictPlanner(makeStepRow(), makeCtx())).rejects.toThrow(/some other real Pact error/);
  });

  it("rejects with a configuration-error message when planner_params_json is missing fvtId, never calling the chain", async () => {
    const step = makeStepRow({ planner_params_json: JSON.stringify({ patronAccount: "k:patron" }) });

    await expect(evictPlanner(step, makeCtx())).rejects.toThrow(/fvtId/);
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it("a beneficiary containing Pact-breaking characters (a live chain read, not trusted config) flows safely into payload as literal data, never into pactCode", async () => {
    // Proves the actual safety property: `beneficiary` reaches `pactCode`
    // only as a `(read-string "beneficiary")` placeholder — the dangerous
    // string itself travels through `payload` (env-data), where Pact reads
    // it as a STRING VALUE, never as source text. Unlike the old
    // string-concatenation approach, this means a hostile value is simply
    // inert data, not something that needs to be character-filtered to be
    // safe — `isWellFormedEvictLeg` only needs to guard TYPES (string vs.
    // number), not content, which is exactly what it does.
    const hostile = '") (coin.transfer "vault" "attacker" 999999.0) ("';
    dirtyRead
      .mockResolvedValueOnce({
        result: {
          status: "success",
          data: [{ beneficiary: hostile, scoreEntityType: 1, scoreEntityId: "se-1", rewardDptfId: "dptf-1" }],
        },
      })
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 3_000_000 }); // over ceiling -> fan out

    const { legs } = normalizePlannerResult(await evictPlanner(makeStepRow(), makeCtx()));

    expect(legs).toHaveLength(1);
    expect(legs[0].pactCode).not.toContain(hostile);
    expect(legs[0].pactCode).not.toContain("coin.transfer");
    expect(legs[0].pactCode).toContain('(read-string "beneficiary")');
    expect(legs[0].payload.beneficiary).toBe(hostile);
  });

  it("rejects a plan entry whose scoreEntityType is not typeof number", async () => {
    dirtyRead.mockResolvedValueOnce({
      result: {
        status: "success",
        data: [{ beneficiary: "k:ben-1", scoreEntityType: "1", scoreEntityId: "se-1", rewardDptfId: "dptf-1" }],
      },
    });

    await expect(evictPlanner(makeStepRow(), makeCtx())).rejects.toThrow(/malformed plan entry/);
  });

  it("rejects a plan entry whose scoreEntityType is typeof number but not an integer, forcing evaluation past the typeof check into Number.isInteger", async () => {
    dirtyRead.mockResolvedValueOnce({
      result: {
        status: "success",
        data: [{ beneficiary: "k:ben-1", scoreEntityType: 1.5, scoreEntityId: "se-1", rewardDptfId: "dptf-1" }],
      },
    });

    await expect(evictPlanner(makeStepRow(), makeCtx())).rejects.toThrow(/malformed plan entry/);
  });

  it("rejects a plan entry with a wrong-type beneficiary (not a string)", async () => {
    dirtyRead.mockResolvedValueOnce({
      result: {
        status: "success",
        data: [{ beneficiary: 12345, scoreEntityType: 1, scoreEntityId: "se-1", rewardDptfId: "dptf-1" }],
      },
    });

    await expect(evictPlanner(makeStepRow(), makeCtx())).rejects.toThrow(/malformed plan entry/);
  });
});
