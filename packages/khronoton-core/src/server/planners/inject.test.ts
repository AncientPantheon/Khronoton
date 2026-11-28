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
import { normalizePlannerResult } from "./registry.js";
import { injectPlanner, InjectRequiresUnstallError } from "./inject.js";

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
      executor: "Ѻ.testexecutor",
      rewardDptfId: "dptf-1",
      amount: "12.345",
    }),
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

describe("injectPlanner", () => {
  it("returns exactly one leg (CC_InjectFinalize) when the finalize simulation succeeds, with amount flowing through payload unmodified", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 50000 });

    const { legs } = normalizePlannerResult(await injectPlanner(makeStepRow(), makeCtx()));

    expect(legs).toHaveLength(1);
    // The FULL pact code — routed through `ouronet-ns.TS02-C3` (Talos),
    // built from `ctx.runtime.namespace`, never a direct `ouronet-ns.AQP-FVT`
    // call (see inject.ts's own doc comment / docs/work/
    // aqp-planners-talos-routing/design.md) — with every value read back
    // from `payload` (env-data), never string-concatenated into the Pact
    // source itself.
    expect(legs[0].pactCode).toBe(
      '(ouronet-ns.TS02-C3.AQP-FVT|CC_InjectFinalize (read-string "patron") (read-string "executor") ' +
        '(read-string "fvt-id") (read-string "reward-dptf-id") (read-decimal "amount"))',
    );
    expect(legs[0].payload).toEqual({
      patron: "k:patron",
      executor: "Ѻ.testexecutor",
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

    const { legs } = normalizePlannerResult(await injectPlanner(makeStepRow(), makeCtx()));

    expect(legs).toHaveLength(1);
    // Exact match (not a `toContain("CC_Inject")` substring check, which
    // would also pass for "CC_InjectFinalize") plus the full payload, same
    // rigor as the finalize-success test above — this is a DIFFERENT
    // entrypoint with its own argument list that deserves its own exact
    // assertion, not just "not the other one."
    expect(legs[0].pactCode).toBe(
      '(ouronet-ns.TS02-C3.AQP-FVT|CC_Inject (read-string "patron") (read-string "executor") ' +
        '(read-string "fvt-id") (read-string "reward-dptf-id") (read-decimal "amount"))',
    );
    expect(legs[0].payload).toEqual({
      patron: "k:patron",
      executor: "Ѻ.testexecutor",
      "fvt-id": "fvt-1",
      "reward-dptf-id": "dptf-1",
      amount: "12.345",
    });
    expect(dirtyRead).toHaveBeenCalledTimes(2);
  });

  it("throws InjectRequiresUnstallError (not a plain Error) when CC_InjectFinalize fails AND CC_Inject is refused specifically for exceeding the gas ceiling", async () => {
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "failure", error: { message: "stale stakers remain" } } })
      // The executor's refuse-unmineable signal requires a SUCCESSFUL
      // simulate whose measured gas exceeds the ceiling (runSimulate only
      // reaches the gasUsed>ceiling check when `result.status !== "failure"`
      // — Pact itself only reports a real cost for a run that didn't abort)
      // — the distinguishable "insert an ouronet.aqp-unstall step first"
      // case design.md calls for, not a generic chain-level failure.
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 3_000_000 });

    let caught: unknown;
    try {
      await injectPlanner(makeStepRow(), makeCtx());
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(InjectRequiresUnstallError);
    expect((caught as Error).message).toMatch(/fvt-1/);
    expect((caught as Error).message).toMatch(/ouronet\.aqp-unstall/);
    expect(dirtyRead).toHaveBeenCalledTimes(2);
  });

  it("throws a plain Error (never InjectRequiresUnstallError) when CC_InjectFinalize fails AND CC_Inject fails for a genuine non-gas reason", async () => {
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "failure", error: { message: "stale stakers remain" } } })
      // No numeric gasUsed on the second failure — a genuine Pact error, not
      // a gas refusal, so this must never be treated as "needs an unstall
      // step first."
      .mockResolvedValueOnce({ result: { status: "failure", error: { message: "insufficient funds" } } });

    let caught: unknown;
    try {
      await injectPlanner(makeStepRow(), makeCtx());
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeInstanceOf(InjectRequiresUnstallError);
    expect((caught as Error).message).toMatch(/insufficient funds/);
    expect(dirtyRead).toHaveBeenCalledTimes(2);
  });

  it("rejects with a configuration-error message when planner_params_json is missing fvtId, never calling the chain", async () => {
    // Every OTHER required field is supplied (a review finding caught the
    // original fixture also omitting `executor`, which would have let this
    // test keep passing even if the `fvtId` check itself were accidentally
    // dropped from the combined guard, since `executor`'s own absence alone
    // still throws the same static message) — isolating fvtId as the ONLY
    // missing field, mirroring the "missing executor" test's own pattern.
    const step = makeStepRow({
      planner_params_json: JSON.stringify({
        patronAccount: "k:patron",
        executor: "Ѻ.testexecutor",
        rewardDptfId: "dptf-1",
        amount: "1.0",
      }),
    });

    await expect(injectPlanner(step, makeCtx())).rejects.toThrow(/fvtId/);
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it("rejects with a configuration-error message when planner_params_json is missing amount specifically, never calling the chain", async () => {
    // Every OTHER required field is supplied — see the "missing fvtId" test
    // immediately above for why this isolation matters.
    const step = makeStepRow({
      planner_params_json: JSON.stringify({
        fvtId: "fvt-1",
        patronAccount: "k:patron",
        executor: "Ѻ.testexecutor",
        rewardDptfId: "dptf-1",
      }),
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
          executor: "Ѻ.testexecutor",
          rewardDptfId: "dptf-1",
          amount: badAmount,
        }),
      });

      await expect(injectPlanner(step, makeCtx())).rejects.toThrow(/amount must be a non-negative decimal/);
      expect(dirtyRead).not.toHaveBeenCalled();
    },
  );

  it("rejects with a configuration-error message naming executor when planner_params_json is missing executor, never calling the chain", async () => {
    const step = makeStepRow({
      planner_params_json: JSON.stringify({
        fvtId: "fvt-1",
        patronAccount: "k:patron",
        rewardDptfId: "dptf-1",
        amount: "1.0",
      }),
    });

    await expect(injectPlanner(step, makeCtx())).rejects.toThrow(/executor/);
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it("rejects an empty-string executor before ever calling the chain", async () => {
    const step = makeStepRow({
      planner_params_json: JSON.stringify({
        fvtId: "fvt-1",
        patronAccount: "k:patron",
        executor: "",
        rewardDptfId: "dptf-1",
        amount: "1.0",
      }),
    });

    await expect(injectPlanner(step, makeCtx())).rejects.toThrow(/executor/);
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it("rejects a k:-prefixed executor before ever calling the chain — the exact bug class this fix closes (a k: account has no DPTF balance row)", async () => {
    const step = makeStepRow({
      planner_params_json: JSON.stringify({
        fvtId: "fvt-1",
        patronAccount: "k:patron",
        executor: `k:${PUB_A}`,
        rewardDptfId: "dptf-1",
        amount: "1.0",
      }),
    });

    await expect(injectPlanner(step, makeCtx())).rejects.toThrow(/executor/);
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it("both candidate legs route through Talos (TS02-C3), never the core AQP-FVT module directly", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success" } }); // finalize succeeds

    const { legs } = normalizePlannerResult(await injectPlanner(makeStepRow(), makeCtx()));

    expect(legs).toHaveLength(1);
    expect(legs[0].pactCode).toContain("ouronet-ns.TS02-C3.AQP-FVT|CC_InjectFinalize");
    expect(legs[0].pactCode).not.toContain("ouronet-ns.AQP-FVT.CC_InjectFinalize");
  });
});
