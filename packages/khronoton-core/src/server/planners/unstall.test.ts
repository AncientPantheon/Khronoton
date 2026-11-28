/**
 * `ouronet.aqp-unstall` planner tests — unit-tests `unstallPlanner` directly
 * (no DB, no `driveRunOnce`), with a hand-built `PlannerCtx` whose
 * `runtime`/`resolver` mocks mirror `evict.test.ts`'s own `makeRuntime`/
 * `makeResolver` fixture style, since this planner drives through the SAME
 * real `executeCodexTransaction` machinery those tests already exercise —
 * including the real `splitPlan` (`../pure/split-plan.js`), not a stand-in.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChainClient, ChainRuntime, KeyResolver } from "../seams.js";
import type { CodexCronotonStepRow } from "../store/steps.js";
import type { PlannerCtx } from "./registry.js";
import { normalizePlannerResult } from "./registry.js";
import { unstallPlanner } from "./unstall.js";

const PUB_A = "aa".repeat(32);

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

/** A `mode:'planner'` step row targeting `ouronet.aqp-unstall`. */
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
    planner_name: "ouronet.aqp-unstall",
    planner_params_json: JSON.stringify({ fvtId: "fvt-1", patronAccount: "k:patron", rewardDptfId: "dptf-1" }),
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

describe("unstallPlanner", () => {
  it("returns [] when URH_FvtStalePresentUsers reads zero stale users — step trivially satisfied, no further chain calls", async () => {
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: [] } });

    const { legs } = normalizePlannerResult(await unstallPlanner(makeStepRow(), makeCtx()));

    expect(legs).toEqual([]);
    expect(dirtyRead).toHaveBeenCalledTimes(1);
  });

  it("returns exactly one CCp_FvtFixSlice leg for a small stale-user list whose probes both succeed under the ceiling (splitPlan's own fitsInOne short-circuit)", async () => {
    const users = ["k:u1", "k:u2", "k:u3"];
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: users } }) // stale read
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 1_000 }) // probe(1 item)
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 3_000 }); // probe(all 3 items)

    const { legs } = normalizePlannerResult(await unstallPlanner(makeStepRow(), makeCtx()));

    expect(legs).toHaveLength(1);
    expect(legs[0].pactCode).toBe(
      '(ouronet-ns.TS02-C3.AQP-FVT|CCp_FvtFixSlice (read-string "patron") (read-string "fvt-id") (read-string "reward-dptf-id") (read-msg "users"))',
    );
    expect(legs[0].payload).toEqual({
      patron: "k:patron",
      "fvt-id": "fvt-1",
      "reward-dptf-id": "dptf-1",
      users,
    });
    expect(dirtyRead).toHaveBeenCalledTimes(3);
  });

  it("fans out into multiple CCp_FvtFixSlice legs, each a disjoint subset, when the single-batch probe is refused over the ceiling and splitPlan must shrink and retry", async () => {
    const users = Array.from({ length: 100 }, (_, i) => `k:u${i}`);
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: users } }) // stale read
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 1_000 }) // probe(1 item) — one.gas
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 2_000_000 }) // probe(64 items) — sample.gas (at ceiling, still ok)
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 3_000_000 }) // confirm probe at modeled capacity (50 items) — refused, over ceiling
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 1_500_000 }); // confirm probe at shrunk capacity (34 items) — succeeds

    const { legs } = normalizePlannerResult(await unstallPlanner(makeStepRow(), makeCtx()));

    // Pins the EXACT shape the shrink-and-retry loop must produce from these
    // mocked gas values (traced by hand against `pure/split-plan.ts`'s real
    // arithmetic): capacity 57 from the sizing model -> planAt(57) ->
    // evenSplit(100,2)=[50,50] -> the 50-item confirm probe is refused at
    // 3,000,000 gas -> capacity shrinks to floor(57*0.75)=42 ->
    // planAt(42) -> evenSplit(100,3)=[34,33,33] -> the 34-item confirm probe
    // succeeds at 1,500,000 gas -> the growth loop's own refit still rounds
    // to 3 batches, so it breaks without spending a further probe. A
    // looser `legs.length >= 2` assertion would also pass if the refused
    // 50/50 split were silently accepted (e.g. an inverted `got.ok` check),
    // so the exact 3-batch shape is asserted here, not just "at least 2".
    expect(legs).toHaveLength(3);
    expect(legs.map((l) => (l.payload.users as string[]).length)).toEqual([34, 33, 33]);
    const expectedPactCode =
      '(ouronet-ns.TS02-C3.AQP-FVT|CCp_FvtFixSlice (read-string "patron") (read-string "fvt-id") ' +
      '(read-string "reward-dptf-id") (read-msg "users"))';
    const seen = new Set<string>();
    for (const leg of legs) {
      expect(leg.pactCode).toBe(expectedPactCode);
      const batchUsers = leg.payload.users as string[];
      for (const u of batchUsers) {
        expect(seen.has(u)).toBe(false); // never duplicated across legs
        seen.add(u);
      }
    }
    // every original user appears in exactly one leg's payload.users
    expect(seen.size).toBe(users.length);
    for (const u of users) {
      expect(seen.has(u)).toBe(true);
    }
    // stale read (1) + probe(1 item) + probe(64-item sample) + confirm(50,
    // refused) + confirm(34, accepted) — the growth loop breaks before
    // spending a 6th call.
    expect(dirtyRead).toHaveBeenCalledTimes(5);
  });

  it("rejects when the stale-user read fails for a genuine reason, never silently returning []", async () => {
    dirtyRead.mockResolvedValueOnce({
      result: { status: "failure", error: { message: "some other real Pact error" } },
    });

    await expect(unstallPlanner(makeStepRow(), makeCtx())).rejects.toThrow(/some other real Pact error/);
  });

  it(
    "the stale-user plan read NEVER calls preflightRead, even when the step's own config is AUTO gas — regression for the bug where a plan read inherited the step's autoGasLimit and got routed through the full buy-gas pipeline, enforcing GAS_PAYER's payable-module whitelist on a pure read",
    async () => {
      dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: [] } });

      await unstallPlanner(
        makeStepRow({
          config_json: JSON.stringify({ chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: true, ttl: 600 }),
        }),
        makeCtx(),
      );

      expect(dirtyRead).toHaveBeenCalledTimes(1);
      expect(preflightRead).not.toHaveBeenCalled();
    },
  );

  it("the WRITE leg routes through Talos (TS02-C3), never the core AQP-FVT module directly", async () => {
    const users = ["k:u1"];
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: users } })
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 1_000 });

    const { legs } = normalizePlannerResult(await unstallPlanner(makeStepRow(), makeCtx()));

    expect(legs).toHaveLength(1);
    expect(legs[0].pactCode).toContain("ouronet-ns.TS02-C3.AQP-FVT|CCp_FvtFixSlice");
    expect(legs[0].pactCode).not.toContain("ouronet-ns.AQP-FVT.CCp_FvtFixSlice");
  });
});
