/**
 * `handlers/steps.ts` — the per-step standalone fire/simulate route:
 * `simulateStep` addresses a stored step by index, builds the leg(s) it
 * currently resolves to (`stepRowToDefinition` for `mode:'single'`, the
 * registered `StepPlanner` for `mode:'planner'`), and fires or previews
 * them — DELIBERATELY never touching `codex_cronoton_runs`/
 * `codex_cronoton_run_legs` (design.md §C's standalone-preview posture).
 *
 * Mirrors `execute.test.ts`'s fixture/mock style: a real in-memory DB (via
 * the shared harness) + a mocked `ChainClient`.
 */
import { describe, it, expect, afterEach } from "vitest";

import {
  insertStep,
  listStepsForCronoton,
  stepRowToDefinition,
  registerStepPlanner,
  getStepPlanner,
  type CodexGasPayer,
  type CodexTxConfig,
} from "../server/index.js";
// Triggers evict.ts's own module-eval `registerStepPlanner("ouronet.aqp-evict",
// evictPlanner)` side effect — regression test for a confirmed HIGH
// cross-phase-review finding: this file previously never drove the
// standalone-fire route through any of the five REAL shipped planners, only
// hand-rolled test-only stand-ins.
import { evictPlanner } from "../server/planners/evict.js";
import {
  buildTestCtx,
  req,
  seedCronoton,
  type TestHarness,
} from "../../tests/handlers/harness.js";
import { simulateStep, fireStep } from "./steps.js";

// Self-heals to a signable pure signer (gasPayer pubkey auto-included by
// `effectiveSigners`), matching `execute.test.ts`'s own `CODEX_GAS_PAYER`.
const CODEX_GAS_PAYER: CodexGasPayer = { type: "codex", address: "k:abcdef0123456789" };

const CONFIG: CodexTxConfig = {
  chainId: "0",
  gasPrice: 1,
  gasLimit: 1500,
  autoGasLimit: false,
  ttl: 600,
};

function seedSingleStep(h: TestHarness, cronotonId: string, stepIndex: number, pactCode: string) {
  insertStep(
    {
      codexCronotonId: cronotonId,
      stepIndex,
      mode: "single",
      pactCode,
      config: CONFIG,
      payload: { leg: stepIndex },
      gasPayer: CODEX_GAS_PAYER,
      signers: [],
    },
    { db: h.db },
  );
}

function seedPlannerStep(h: TestHarness, cronotonId: string, stepIndex: number, plannerName: string) {
  insertStep(
    {
      codexCronotonId: cronotonId,
      stepIndex,
      mode: "planner",
      plannerName,
    },
    { db: h.db },
  );
}

function makePlannedLeg(pactCode: string) {
  return {
    pactCode,
    config: CONFIG,
    payload: {},
    gasPayer: CODEX_GAS_PAYER,
    signers: [],
  };
}

describe("simulateStep", () => {
  let h: TestHarness;
  afterEach(() => h?.close());

  it("on a mode:'single' step returns the exact same pactCode/payload stepRowToDefinition itself would produce", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    seedSingleStep(h, id, 0, '(coin.transfer "a" "b" 1.0)');
    const stepRow = listStepsForCronoton(id, { db: h.db })[0];
    const expected = stepRowToDefinition(stepRow);

    const res = await simulateStep(h.ctx, req({ confirmed: true, params: { id, index: "0" } }));

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; legs: Array<{ pactCode: string; payload: unknown }> };
    expect(body.legs).toHaveLength(1);
    expect(body.legs[0].pactCode).toBe(expected.pactCode);
    expect(body.legs[0].payload).toEqual(expected.payload);
  });

  it("on a mode:'planner' step that fans out to 3 legs returns exactly 3 entries, each with its own pactCode", async () => {
    h = buildTestCtx();
    registerStepPlanner("steps-test-fanout-3", async () => [
      makePlannedLeg("(+ 1 1)"),
      makePlannedLeg("(+ 2 2)"),
      makePlannedLeg("(+ 3 3)"),
    ]);
    const { id } = seedCronoton(h.db);
    seedPlannerStep(h, id, 0, "steps-test-fanout-3");

    const res = await simulateStep(h.ctx, req({ confirmed: true, params: { id, index: "0" } }));

    expect(res.status).toBe(200);
    const body = res.body as { legs: Array<{ pactCode: string }> };
    expect(body.legs).toHaveLength(3);
    const codes = body.legs.map((l) => l.pactCode);
    expect(new Set(codes).size).toBe(3);
  });

  it("on a mode:'planner' step wired to the REAL ouronet.aqp-evict planner, resolves to the EXACT leg evictPlanner would build directly — not a hand-rolled test stand-in", async () => {
    expect(getStepPlanner("ouronet.aqp-evict")).toBe(evictPlanner);

    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    const PUB_A = "aa".repeat(32);
    insertStep(
      {
        codexCronotonId: id,
        stepIndex: 0,
        mode: "planner",
        plannerName: "ouronet.aqp-evict",
        plannerParams: { fvtId: "fvt-standalone", patronAccount: "k:patron-standalone" },
        config: CONFIG,
        payload: {},
        gasPayer: { type: "gas-station", gasStationSignerKey: PUB_A },
        signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
      },
      { db: h.db },
    );
    // evictPlanner's own two-probe sequence: the plan-read (one entry),
    // then the full-evict probe, comfortably under the gas ceiling.
    h.runtime.dirtyRead
      .mockResolvedValueOnce({
        result: {
          status: "success",
          data: [{ beneficiary: "k:ben-standalone", scoreEntityType: 1, scoreEntityId: "se-1", rewardDptfId: "dptf-1" }],
        },
      })
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 50_000 });

    const res = await simulateStep(h.ctx, req({ confirmed: true, params: { id, index: "0" } }));

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; legs: Array<{ pactCode: string; payload: Record<string, unknown> }> };
    expect(body.ok).toBe(true);
    expect(body.legs).toHaveLength(1);
    expect(body.legs[0].pactCode).toContain("CC_FullEvictRewards");
    expect(body.legs[0].pactCode).not.toContain("fvt-standalone");
    expect(body.legs[0].payload).toEqual({
      patron: "k:patron-standalone",
      executor: `k:${PUB_A}`,
      "fvt-id": "fvt-standalone",
    });
  });

  it("on a mode:'planner' step whose planner_name has no registered StepPlanner returns 404, never throwing", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    seedPlannerStep(h, id, 0, "steps-test.nonexistent-planner");

    const res = await simulateStep(h.ctx, req({ confirmed: true, params: { id, index: "0" } }));

    expect(res.status).toBe(404);
  });

  it("and fireStep both return 404 for an out-of-range step index", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    seedSingleStep(h, id, 0, "(+ 1 1)");

    const simRes = await simulateStep(h.ctx, req({ confirmed: true, params: { id, index: "5" } }));
    const fireRes = await fireStep(h.ctx, req({ confirmed: true, params: { id, index: "5" } }));

    expect(simRes.status).toBe(404);
    expect(fireRes.status).toBe(404);
  });

  it("never calls submit — only fireStep actually submits", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    seedSingleStep(h, id, 0, "(+ 1 1)");

    await simulateStep(h.ctx, req({ confirmed: true, params: { id, index: "0" } }));

    expect(h.runtime.submit).not.toHaveBeenCalled();
  });
});

describe("fireStep", () => {
  let h: TestHarness;
  afterEach(() => h?.close());

  it("actually calls executeCodexTransaction in 'fire' mode, proven by the mock chain client's submit being called once per leg", async () => {
    h = buildTestCtx();
    registerStepPlanner("steps-test-fanout-2", async () => [
      makePlannedLeg("(+ 1 1)"),
      makePlannedLeg("(+ 2 2)"),
    ]);
    const { id } = seedCronoton(h.db);
    seedPlannerStep(h, id, 0, "steps-test-fanout-2");

    const res = await fireStep(h.ctx, req({ confirmed: true, params: { id, index: "0" } }));

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; legs: Array<{ requestKey?: string }> };
    expect(body.ok).toBe(true);
    expect(body.legs).toHaveLength(2);
    expect(h.runtime.submit).toHaveBeenCalledTimes(2);
  });

  it("returns 400 for a paused cronoton, never submitting its step's real Pact code — regression test: fireStep used to bypass this guard entirely, unlike executeNow/triggerCronoton", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    seedSingleStep(h, id, 0, "(+ 1 1)");
    h.db.prepare("UPDATE codex_cronotons SET status = 'paused' WHERE id = ?").run(id);

    const res = await fireStep(h.ctx, req({ confirmed: true, params: { id, index: "0" } }));

    expect(res.status).toBe(400);
    expect(h.runtime.submit).not.toHaveBeenCalled();
  });

  it("returns 400 for a terminal (completed/error) cronoton, never submitting its step's real Pact code", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    seedSingleStep(h, id, 0, "(+ 1 1)");
    h.db.prepare("UPDATE codex_cronotons SET status = 'completed' WHERE id = ?").run(id);

    const res = await fireStep(h.ctx, req({ confirmed: true, params: { id, index: "0" } }));

    expect(res.status).toBe(400);
    expect(h.runtime.submit).not.toHaveBeenCalled();
  });

  it("simulateStep remains unguarded for a paused cronoton — it never submits, so the pause control has nothing to protect against here", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    seedSingleStep(h, id, 0, "(+ 1 1)");
    h.db.prepare("UPDATE codex_cronotons SET status = 'paused' WHERE id = ?").run(id);

    const res = await simulateStep(h.ctx, req({ confirmed: true, params: { id, index: "0" } }));

    expect(res.status).toBe(200);
    expect(h.runtime.submit).not.toHaveBeenCalled();
  });

  it("never writes a codex_cronoton_runs or codex_cronoton_run_legs row (bypasses the run/leg-table lifecycle entirely)", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    seedSingleStep(h, id, 0, "(+ 1 1)");

    await simulateStep(h.ctx, req({ confirmed: true, params: { id, index: "0" } }));
    await fireStep(h.ctx, req({ confirmed: true, params: { id, index: "0" } }));

    const runs = h.db.prepare("SELECT COUNT(*) AS c FROM codex_cronoton_runs").get() as { c: number };
    const legs = h.db.prepare("SELECT COUNT(*) AS c FROM codex_cronoton_run_legs").get() as { c: number };
    expect(runs.c).toBe(0);
    expect(legs.c).toBe(0);
  });
});
