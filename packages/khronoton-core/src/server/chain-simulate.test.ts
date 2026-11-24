/**
 * `chain-simulate` tests — `simulateChainBody`'s ORCHESTRATION, with the
 * executor MOCKED (`vi.spyOn(executorModule, "executeCodexTransaction")`, the
 * same seam `runs-driver.test.ts` already spies) so these assert the whole-chain
 * walk itself — yield threading, per-step aggregation, planner resolution, and
 * per-step error isolation — independently of the real build/sign/dirty-read
 * path (`executor.test.ts` already covers that). The executor calls happen in a
 * fully determined order (single-tx variant first, then each step in order, then
 * each planned leg in order), so `mockResolvedValueOnce` queues map 1:1 to steps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as executorModule from "./executor.js";
import { registerStepPlanner } from "./planners/registry.js";
import type { PlannedLeg } from "./planners/registry.js";
import type { ChainRuntime, KeyResolver } from "./seams.js";
import type { CodexTxConfig, SimulateResult } from "./types.js";
import { simulateChainBody, type SimulateChainInput } from "./chain-simulate.js";

// The executor is mocked wholesale, so the runtime/resolver are never actually
// exercised — `resolvePlannerFor` only reads `runtime`/`resolver`/`config` to
// build the `PlannerCtx`, and our test planner ignores them.
const runtime = { namespace: "ouronet-ns", networkId: "stoa" } as unknown as ChainRuntime;
const resolver = {} as unknown as KeyResolver;
const ctx = { runtime, resolver };

const CONFIG: CodexTxConfig = { chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 };

function okSim(data: unknown, gasUsed = 100): SimulateResult {
  return { ok: true, mode: "simulate", gasUsed, rawResult: { result: { data } }, terminalIntent: null };
}
function failSim(error: string, gasUsed?: number): SimulateResult {
  return {
    ok: false,
    mode: "simulate",
    error,
    ...(gasUsed !== undefined ? { gasUsed } : {}),
    terminalIntent: null,
  };
}

const leg: PlannedLeg = {
  pactCode: "(planner-leg)",
  config: CONFIG,
  payload: {},
  gasPayer: { type: "gas-station" },
  signers: [{ publicKey: "aa".repeat(32), capabilityMode: "pure", capabilities: "" }],
};

let simSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Default: every executor call succeeds with data "5.0" unless a test queues
  // a `...Once` override first (which is consumed before this default).
  simSpy = vi.spyOn(executorModule, "executeCodexTransaction");
  simSpy.mockResolvedValue(okSim("5.0") as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const single = (pactCode: string, yieldAs?: string, payload?: Record<string, unknown>): SimulateChainInput["steps"][number] => ({
  mode: "single",
  pactCode,
  config: CONFIG,
  ...(payload ? { payload } : {}),
  ...(yieldAs ? { yieldAs } : {}),
});

describe("simulateChainBody — the signed whole-chain dry run", () => {
  it("passes a 2-step single chain and threads the first step's result as a yield into the second", async () => {
    const input: SimulateChainInput = {
      steps: [
        single("(drain)", "amount"),
        single("(wrap)", undefined, { amt: { $yield: "amount" } }),
      ],
    };

    const res = await simulateChainBody(input, ctx);

    expect(res.ok).toBe(true);
    expect(res.steps).toHaveLength(2);
    expect(res.steps[0].ok).toBe(true);
    expect(res.steps[0].yieldAs).toBe("amount");
    expect(res.steps[0].yielded).toBe("5.0"); // extracted from rawResult.result.data
    expect(res.steps[1].ok).toBe(true);

    // The second step's payload `{"$yield":"amount"}` resolved to "5.0" before
    // it reached the (mocked) executor — assert on the definition it received.
    const secondCallDef = simSpy.mock.calls[1][0] as { payload: Record<string, unknown> };
    expect(secondCallDef.payload).toEqual({ amt: "5.0" });
  });

  it("reports a referenced-but-unproduced yield as THAT step's error and keeps walking", async () => {
    const input: SimulateChainInput = {
      steps: [
        single("(ok)"), // no yieldAs — produces nothing
        single("(needs-x)", undefined, { v: { $yield: "missing" } }),
        single("(also-ok)"),
      ],
    };

    const res = await simulateChainBody(input, ctx);

    expect(res.ok).toBe(false); // one step failed
    expect(res.steps[0].ok).toBe(true);
    expect(res.steps[1].ok).toBe(false);
    expect(res.steps[1].error).toMatch(/missing/); // YieldNotFoundError names it
    expect(res.steps[2].ok).toBe(true); // walk continued past the gap
  });

  it("marks a step failed when its simulate returns ok:false, failing the whole chain", async () => {
    simSpy.mockResolvedValueOnce(okSim("5.0") as never); // step 0 ok
    simSpy.mockResolvedValueOnce(failSim("boom: reverted") as never); // step 1 fails

    const res = await simulateChainBody(input2Steps(), ctx);

    expect(res.steps[0].ok).toBe(true);
    expect(res.steps[1].ok).toBe(false);
    expect(res.steps[1].error).toBe("boom: reverted");
    expect(res.ok).toBe(false);
  });

  it("resolves a planner step, simulates its legs, and threads the planner's own reported yield", async () => {
    registerStepPlanner("test.sim-yielder", async () => ({ legs: [leg, leg], yield: "42.0" }));
    const input: SimulateChainInput = {
      steps: [
        { mode: "planner", plannerName: "test.sim-yielder", plannerParams: {}, config: CONFIG, signers: leg.signers, gasPayer: leg.gasPayer, yieldAs: "reward" },
        single("(consume)", undefined, { r: { $yield: "reward" } }),
      ],
    };

    const res = await simulateChainBody(input, ctx);

    expect(res.ok).toBe(true);
    expect(res.steps[0].mode).toBe("planner");
    expect(res.steps[0].plannedCount).toBe(2);
    expect(res.steps[0].yielded).toBe("42.0");
    // the planner's yield (not an on-chain read) threaded into the consuming step
    const consumeDef = simSpy.mock.calls.at(-1)![0] as { payload: Record<string, unknown> };
    expect(consumeDef.payload).toEqual({ r: "42.0" });
  });

  it("reports an unregistered planner as that step's error without throwing", async () => {
    const input: SimulateChainInput = {
      steps: [{ mode: "planner", plannerName: "test.nope-not-registered", plannerParams: {}, config: CONFIG, signers: leg.signers, gasPayer: leg.gasPayer }],
    };

    const res = await simulateChainBody(input, ctx);

    expect(res.ok).toBe(false);
    expect(res.steps[0].error).toMatch(/not registered/);
  });

  it("converts a real synchronous throw from the executor into that step's error, not an unhandled rejection", async () => {
    // `executeCodexTransaction` genuinely throws (not rejects) in simulate mode
    // when a definition resolves to zero signers (executor.ts ~732-743). This
    // proves `simulateChainBody`'s per-step try/catch (chain-simulate.ts
    // ~305-314) actually converts that throw into the step's own `error`
    // field rather than letting it propagate out of `simulateChainBody`.
    simSpy.mockImplementationOnce(() => {
      throw new Error("At least one signer is required to build a codex transaction.");
    });

    // Awaiting directly (rather than wrapping in try/catch) proves the call
    // resolves rather than rejects/throws: a rejection would fail this test.
    const res = await simulateChainBody(input2Steps(), ctx);

    expect(res.steps[0].ok).toBe(false);
    expect(res.steps[0].error).toBe("At least one signer is required to build a codex transaction.");
    expect(res.steps[1].ok).toBe(true); // the walk continued past the throwing step
    expect(res.ok).toBe(false);
  });

  it("converts a real synchronous throw from the executor into the singleTxFirst variant's error, not an unhandled rejection", async () => {
    // Same guarantee as above, but for the singleTxFirst try/catch
    // (chain-simulate.ts ~268-293), which wraps a SEPARATE executor call from
    // the step loop's.
    simSpy.mockImplementationOnce(() => {
      throw new Error("At least one signer is required to build a codex transaction.");
    });
    simSpy.mockResolvedValueOnce(okSim("5.0") as never); // step 0, unaffected

    const res = await simulateChainBody(
      {
        singleTxFirst: { pactCode: "(all-in-one)", config: CONFIG, gasPayer: leg.gasPayer, signers: [] },
        steps: [single("(step)")],
      },
      ctx,
    );

    expect(res.singleTx).toBeDefined();
    expect(res.singleTx!.ok).toBe(false);
    expect(res.singleTx!.fits).toBe(false);
    expect(res.singleTx!.error).toBe("At least one signer is required to build a codex transaction.");
    expect(res.steps[0].ok).toBe(true); // the step chain is unaffected by the variant's throw
  });

  it("resolves a $yield reference inside a planner step's plannerParams before invoking the planner", async () => {
    // `resolvePlannerFor`'s own $yield-resolution logic is already proven by
    // `registry.test.ts`; this proves THIS file's thin wrapper —
    // `simulatePlannerStep`'s `syntheticStepRow` + pool-passing — actually
    // reaches it, so the planner receives the resolved value, not the
        // literal `{"$yield":"..."}` placeholder.
    let receivedParams: unknown;

    registerStepPlanner("test.sim-yield-consumer", async (step) => {
      receivedParams = JSON.parse(step.planner_params_json ?? "{}");
      return { legs: [] };
    });
    const input: SimulateChainInput = {
      steps: [
        single("(drain)", "amt"),
        {
          mode: "planner",
          plannerName: "test.sim-yield-consumer",
          plannerParams: { amt: { $yield: "amt" } },
          config: CONFIG,
          signers: leg.signers,
          gasPayer: leg.gasPayer,
        },
      ],
    };

    const res = await simulateChainBody(input, ctx);

    expect(res.ok).toBe(true);
    expect(receivedParams).toEqual({ amt: "5.0" }); // resolved, not the literal $yield object
  });

  it("falls back to a top-level `data` field when rawResult has no nested result.data", async () => {
    // Exercises `extractResultData`'s SECOND branch — a chain client shape
    // with a top-level `data` but no nested `result` object.
    simSpy.mockResolvedValueOnce({
      ok: true,
      mode: "simulate",
      gasUsed: 50,
      rawResult: { data: "top-level-x" },
      terminalIntent: null,
    } as SimulateResult as never);

    const res = await simulateChainBody({ steps: [single("(leg)", "out")] }, ctx);

    expect(res.steps[0].ok).toBe(true);
    expect(res.steps[0].yielded).toBe("top-level-x");
  });

  it("falls back to the raw value itself when rawResult has neither result nor data", async () => {
    // Exercises `extractResultData`'s THIRD (raw passthrough) branch — a
    // chain client shape that is a bare scalar.
    simSpy.mockResolvedValueOnce({
      ok: true,
      mode: "simulate",
      gasUsed: 50,
      rawResult: "bare-scalar",
      terminalIntent: null,
    } as SimulateResult as never);

    const res = await simulateChainBody({ steps: [single("(leg)", "out")] }, ctx);

    expect(res.steps[0].ok).toBe(true);
    expect(res.steps[0].yielded).toBe("bare-scalar");
  });

  it("simulates the single-tx-first variant separately; fits mirrors ok", async () => {
    simSpy.mockResolvedValueOnce(okSim(true, 420) as never); // the variant
    simSpy.mockResolvedValueOnce(okSim("5.0") as never); // step 0

    const res = await simulateChainBody(
      {
        singleTxFirst: { pactCode: "(all-in-one)", config: CONFIG, gasPayer: leg.gasPayer, signers: leg.signers },
        steps: [single("(step)")],
      },
      ctx,
    );

    expect(res.singleTx).toBeDefined();
    expect(res.singleTx!.ok).toBe(true);
    expect(res.singleTx!.fits).toBe(true);
    expect(res.singleTx!.gasUsed).toBe(420);
    expect(res.ok).toBe(true); // the step chain (the fallback path) also passed
  });

  it("marks the single-tx variant as not-fitting (but not a hard failure) when refused specifically for being over the gas ceiling", async () => {
    // Mirrors `single-tx.ts`'s `attemptSingleTxFirst`: a numeric `gasUsed` on
    // an `ok:false` simulate result is the executor's own refuse-unmineable
    // signal — at fire time this gracefully falls through to the step chain
    // rather than throwing, so it must NOT be reported as a hard failure.
    simSpy.mockResolvedValueOnce(
      failSim("Transaction needs 9000 gas, over the block limit of 1000", 9000) as never,
    );
    simSpy.mockResolvedValueOnce(okSim("5.0") as never); // step 0

    const res = await simulateChainBody(
      {
        singleTxFirst: { pactCode: "(all-in-one)", config: CONFIG, gasPayer: leg.gasPayer, signers: leg.signers },
        steps: [single("(step)")],
      },
      ctx,
    );

    expect(res.singleTx).toBeDefined();
    expect(res.singleTx!.ok).toBe(false);
    expect(res.singleTx!.fits).toBe(false);
    expect(res.singleTx!.hardFailure).toBeFalsy();
  });

  it("marks the single-tx variant as a hard failure when the simulate fails for a non-gas reason (would throw at fire time, never reaching the chained fallback)", async () => {
    // Mirrors `single-tx.ts`'s `attemptSingleTxFirst`: an `ok:false` simulate
    // result with NO numeric `gasUsed` (executor.ts's `status === "failure"`
    // branch — bad Pact code, missing capability, insufficient funds, bad
    // signer) is NOT the gas-refusal signal — at fire time this THROWS rather
    // than gracefully falling back to the step chain, so the dry run must
    // distinguish it from the gas-ceiling case.
    simSpy.mockResolvedValueOnce(failSim("insufficient funds") as never); // no gasUsed at all
    simSpy.mockResolvedValueOnce(okSim("5.0") as never); // step 0

    const res = await simulateChainBody(
      {
        singleTxFirst: { pactCode: "(all-in-one)", config: CONFIG, gasPayer: leg.gasPayer, signers: leg.signers },
        steps: [single("(step)")],
      },
      ctx,
    );

    expect(res.singleTx).toBeDefined();
    expect(res.singleTx!.ok).toBe(false);
    expect(res.singleTx!.fits).toBe(false);
    expect(res.singleTx!.hardFailure).toBe(true);
  });
});

function input2Steps(): SimulateChainInput {
  return { steps: [single("(a)"), single("(b)")] };
}
