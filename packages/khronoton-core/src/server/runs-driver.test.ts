/**
 * `runs-driver` tests — `driveRunOnce` + `advanceInFlightRunsOnce`, exercised
 * against a REAL in-memory better-sqlite3 DB (never a SQL-string mock),
 * mirroring `store/runs.test.ts`/`store/steps.test.ts`'s own `seedCronoton`
 * convention, plus a hand-built `ChainRuntime`/`KeyResolver` mock modeled on
 * `executor.test.ts`'s own fixtures (so `driveRunOnce`'s `submit-leg`
 * handling drives the REAL `executeCodexTransaction`, not a replaced one —
 * the only way to assert on `universalSignTransaction`/`client.submit` call
 * counts, which several cases below need).
 *
 * `driveRunOnce` loops internally until a pass makes no further store write
 * (see the module doc in `runs-driver.ts`), so a single call can carry a
 * freshly-created run all the way from "no legs yet" through "leg
 * submitted" — several cases below pin that multi-step-in-one-call behavior
 * directly.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installSchema } from "./schema.js";
import { insertStep } from "./store/steps.js";
import {
  createRun,
  getRun,
  insertRunLeg,
  listRunLegs,
  markLegSubmitted,
  advanceRunStep,
  bumpRunAttempt,
} from "./store/runs.js";
import { RunLegAlreadyExistsError } from "./store/errors.js";
import { getYieldPool, upsertYield } from "./store/yields.js";
import { YieldNotFoundError } from "./pure/yields.js";
import * as executorModule from "./executor.js";
import * as runAdvanceModule from "./pure/run-advance.js";
import { RUN_STEP_DEADLINE_MS } from "./seams.js";
import type { ChainClient, ChainRuntime, KeyResolver, OnAudit } from "./seams.js";

import { advanceInFlightRunsOnce, driveRunOnce, PlannerNotRegisteredError } from "./runs-driver.js";
import type { RunsDriverCtx } from "./runs-driver.js";
import { getStepPlanner, registerStepPlanner } from "./planners/registry.js";
// Importing `evictPlanner` (rather than only `./planners/registry.js`)
// triggers evict.ts's own module-eval `registerStepPlanner("ouronet.aqp-evict",
// evictPlanner)` side effect for THIS test file — exactly as `server/index.ts`'s
// `export * from "./planners/evict.js"` line triggers it for a real consumer.
import { evictPlanner } from "./planners/evict.js";
// Same reasoning, same pattern, for `ouronet.aqp-unstall` — triggers
// unstall.ts's own `registerStepPlanner("ouronet.aqp-unstall", unstallPlanner)`
// side effect, so the end-to-end test below drives through the REAL planner,
// not a throwaway test stand-in.
import { unstallPlanner } from "./planners/unstall.js";
// Same reasoning, same pattern, for `ouronet.aqp-inject` — needed by the
// two-DIFFERENT-real-planners end-to-end test below (a confirmed HIGH
// cross-phase-review finding: no test anywhere drove a multi-step cronoton
// through two different real planners before).
import { injectPlanner } from "./planners/inject.js";
// Same reasoning, same pattern, for `ouronet.stoa-wrap` — needed by the
// real drain->wrap->inject yield-carry capstone test below (Wave 3's T5),
// so that test drives through the REAL registered planner, not a stand-in.
import { stoaWrapPlanner } from "./planners/stoa-wrap.js";

let db: Database.Database;

/** Raw-SQL-inserted `codex_cronotons` parent row, mirroring `store/runs.test.ts`'s own `seedCronoton` helper. */
function seedCronoton(id = "cc-1"): void {
  db.prepare(
    `INSERT INTO codex_cronotons
       (id, name, pact_code, config_json, gas_payer_json, signers_json,
        schedule_mode, schedule_config_json, status, next_fire_at, last_fire_at,
        created_at, modified_at, created_by, runtime_arg_keys)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "n",
    "(code)",
    "{}",
    "{}",
    "[]",
    "every-n-minutes",
    JSON.stringify({ mode: "every-n-minutes", startDate: "2026-01-01T00:00:00.000Z", intervalMinutes: 60 }),
    "active",
    null,
    null,
    "t0",
    "t0",
    "op",
    null,
  );
}

const PUB_A = "aa".repeat(32);

/** A `mode:'single'` step whose definition the real executor can build/sign/submit without throwing. */
function insertSingleStep(codexCronotonId: string, stepIndex: number): void {
  insertStep(
    {
      codexCronotonId,
      stepIndex,
      mode: "single",
      pactCode: "(+ 1 1)",
      config: { chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 },
      payload: {},
      gasPayer: { type: "gas-station", gasStationSignerKey: PUB_A },
      signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
    },
    { db },
  );
}

/** A `PlannedLeg`-shaped leg a registered test planner can return, mirroring `insertSingleStep`'s own leg shape. */
function makePlannedLeg(pactCode: string) {
  return {
    pactCode,
    config: { chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 },
    payload: {},
    gasPayer: { type: "gas-station" as const, gasStationSignerKey: PUB_A },
    signers: [{ publicKey: PUB_A, capabilityMode: "pure" as const, capabilities: "" }],
  };
}

// ── mock ChainRuntime (modeled on executor.test.ts's own fixtures) ─────────
const dirtyRead = vi.fn();
const submit = vi.fn();
const listen = vi.fn();
const pollRequestKeys = vi.fn();
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

function makeCtx(over: Partial<RunsDriverCtx> = {}): RunsDriverCtx {
  return {
    db,
    runtime: makeRuntime(),
    resolver: makeResolver(),
    onAudit: vi.fn() as OnAudit,
    ...over,
  };
}

const NOW = new Date("2026-06-08T12:00:00.000Z");

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  installSchema(db);
  seedCronoton();

  vi.clearAllMocks();
  executorModule.__clearCeilingCacheForTests();
  currentClient = { dirtyRead, submit, listen };
  universalSignTransaction.mockResolvedValue({ cmd: "{}", hash: "SIGNED-HASH", sigs: [{ sig: "x" }] });
  isSignedTransaction.mockReturnValue(true);
  getKeyPairByPublicKey.mockResolvedValue({ publicKey: PUB_A, privateKey: "deadbeef", seedType: "koala" });
  dirtyRead.mockResolvedValue({ result: { status: "success", data: "OK" }, gas: 100 });
  submit.mockResolvedValue({ requestKey: "RK-1" });
  listen.mockResolvedValue({ result: { status: "success" }, reqKey: "RK-1" });
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks(); // restores executeCodexTransaction when a test vi.spyOn's it
});

describe("driveRunOnce — a freshly created run's step 0 is planned AND submitted in one call", () => {
  it("builds leg 0 (replan-step) then submits it (submit-leg), ending with a submitted leg carrying a request_key", async () => {
    insertSingleStep("cc-1", 0);
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    await driveRunOnce(runId, NOW, makeCtx());

    const legs = listRunLegs(runId, { db });
    expect(legs).toHaveLength(1);
    expect(legs[0].status).toBe("submitted");
    expect(legs[0].request_key).toBe("RK-1");
    expect(legs[0].chain_id).toBe("0");

    expect(universalSignTransaction).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);

    const run = getRun(runId, { db });
    expect(run!.step_index).toBe(0);
    // `makeCtx()` passes no `runStepDeadlineMs` override, so the deadline is
    // fully determined: NOW + the default RUN_STEP_DEADLINE_MS, not just
    // "some non-null value" — pins the actual computeStepDeadline arithmetic.
    expect(run!.deadline_at).toBe(new Date(NOW.getTime() + RUN_STEP_DEADLINE_MS).toISOString());
  });
});

describe("driveRunOnce — concurrency fix (Phase 5): two callers racing the SAME pending leg never both submit", () => {
  it("only the first of two concurrent driveRunOnce calls on the same run actually calls submit — the second backs off via the lost claim", async () => {
    insertSingleStep("cc-1", 0);
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    // Pre-staged `pending` leg, bypassing the replan phase entirely — isolates
    // the SUBMIT race this fix closes (claimLegForSubmit, called synchronously
    // inside handleSubmitLeg before any `await`), not the (already-tested)
    // replan phase.
    insertRunLeg(
      {
        runId,
        stepIndex: 0,
        legIndex: 0,
        definitionJson: JSON.stringify({
          pactCode: "(+ 1 1)",
          config: { chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 },
          payload: {},
          gasPayer: { type: "gas-station", gasStationSignerKey: PUB_A },
          signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
        }),
      },
      { db },
    );

    // Two concurrent drives of the SAME run — previously (before this fix)
    // both would have reached `executeCodexTransaction(..., "submit", ...)`
    // for the identical leg; this deliberately mirrors `executeNow`'s new
    // chained-row branch racing the background loop's own
    // `advanceInFlightRunsOnce` sweep (the real-world scenario this fix
    // closes), simulated here as two direct `driveRunOnce` callers rather
    // than standing up the full HTTP handler + loop.
    //
    // JS's run-to-first-`await` semantics guarantee the FIRST call's
    // synchronous claim (inside `handleSubmitLeg`, before `driveRunOnce`
    // ever yields) completes before the SECOND call's own synchronous
    // prefix runs — proving the claim, not timing luck, is what prevents
    // the double-submit (there is no `await` anywhere between either call's
    // entry and its own claim attempt).
    const p1 = driveRunOnce(runId, NOW, makeCtx());
    const p2 = driveRunOnce(runId, NOW, makeCtx());
    await Promise.all([p1, p2]);

    // Exactly ONE real chain submission happened — never two.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(universalSignTransaction).toHaveBeenCalledTimes(1);

    const [leg] = listRunLegs(runId, { db });
    expect(leg.status).toBe("submitted");
    expect(leg.request_key).toBe("RK-1");
  });

  it("a losing claimant's driveRunOnce call still resolves cleanly (no thrown error, no double RunLegAlreadyExistsError-style exception)", async () => {
    insertSingleStep("cc-1", 0);
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    insertRunLeg(
      {
        runId,
        stepIndex: 0,
        legIndex: 0,
        definitionJson: JSON.stringify({
          pactCode: "(+ 1 1)",
          config: { chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 },
          payload: {},
          gasPayer: { type: "gas-station", gasStationSignerKey: PUB_A },
          signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
        }),
      },
      { db },
    );

    await expect(
      Promise.all([driveRunOnce(runId, NOW, makeCtx()), driveRunOnce(runId, NOW, makeCtx())]),
    ).resolves.toBeDefined();
  });
});

describe("driveRunOnce — poll landing a success advances the barrier in the same call", () => {
  it("flips a submitted leg to confirmed and, being the last step, marks the run succeeded", async () => {
    insertSingleStep("cc-1", 0);
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    const legId = insertRunLeg(
      { runId, stepIndex: 0, legIndex: 0, definitionJson: JSON.stringify({ pactCode: "(+ 1 1)" }) },
      { db },
    );
    markLegSubmitted(legId, { requestKey: "RK-SEED", chainId: "0" }, { db });

    pollRequestKeys.mockResolvedValue({ "RK-SEED": { result: { status: "success" } } });
    currentClient = { dirtyRead, submit, listen, pollRequestKeys };

    await driveRunOnce(runId, NOW, makeCtx());

    const [leg] = listRunLegs(runId, { db });
    expect(leg.status).toBe("confirmed");
    expect(getRun(runId, { db })!.status).toBe("succeeded");
    // The already-submitted leg must never be re-submitted.
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("driveRunOnce — poll landing a failure fails the run (single-mode has no re-plan)", () => {
  it("flips the leg to failed and, since canReplan is false for mode:'single', fails the run in the same call — no second leg inserted", async () => {
    insertSingleStep("cc-1", 0);
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    const legId = insertRunLeg(
      { runId, stepIndex: 0, legIndex: 0, definitionJson: JSON.stringify({ pactCode: "(+ 1 1)" }) },
      { db },
    );
    markLegSubmitted(legId, { requestKey: "RK-SEED", chainId: "0" }, { db });

    pollRequestKeys.mockResolvedValue({
      "RK-SEED": { result: { status: "failure", error: { message: "chain rejected" } } },
    });
    currentClient = { dirtyRead, submit, listen, pollRequestKeys };

    const onAudit = vi.fn();
    await driveRunOnce(runId, NOW, makeCtx({ onAudit }));

    const legs = listRunLegs(runId, { db });
    expect(legs).toHaveLength(1);
    expect(legs[0].status).toBe("failed");
    expect(getRun(runId, { db })!.status).toBe("failed");
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "codex_cronoton_run.failed", result: "failure" }),
    );
  });
});

describe("driveRunOnce — a submit failure leaves the leg pending and is retried on the NEXT pass, not this one", () => {
  it("first call: ok:false leaves the leg pending and audits a failure; second call: the same pending leg is re-submitted (executor called again)", async () => {
    insertSingleStep("cc-1", 0);
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    const executeSpy = vi
      .spyOn(executorModule, "executeCodexTransaction")
      .mockResolvedValue({ ok: false, mode: "submit", error: "preflight rejected" } as never);

    const onAudit = vi.fn();
    const ctx = makeCtx({ onAudit });

    await driveRunOnce(runId, NOW, ctx);

    let legs = listRunLegs(runId, { db });
    expect(legs).toHaveLength(1);
    expect(legs[0].status).toBe("pending");
    expect(legs[0].request_key).toBeNull();
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "codex_cronoton_run_leg.submit_failed", result: "failure" }),
    );
    expect(executeSpy).toHaveBeenCalledTimes(1);

    // Mock deliberately NOT reset — still returns ok:false, proving the
    // second pass genuinely retries rather than the test accidentally
    // observing a fresh success.
    await driveRunOnce(runId, NOW, ctx);

    legs = listRunLegs(runId, { db });
    expect(legs).toHaveLength(1); // still the same single leg, never duplicated
    expect(legs[0].status).toBe("pending");
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(executeSpy.mock.calls[1][0]).toEqual(executeSpy.mock.calls[0][0]); // same definition
  });
});

describe("driveRunOnce — a passed barrier deadline fails the run (independent of leg-failure)", () => {
  it("flips the run straight to failed when now is past deadline_at, even though the leg itself never failed", async () => {
    insertSingleStep("cc-1", 0);
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    const legId = insertRunLeg(
      { runId, stepIndex: 0, legIndex: 0, definitionJson: JSON.stringify({ pactCode: "(+ 1 1)" }) },
      { db },
    );
    markLegSubmitted(legId, { requestKey: "RK-SEED", chainId: "0" }, { db });
    advanceRunStep(runId, { fromStepIndex: 0, toStepIndex: 0, deadlineAt: "2020-01-01T00:00:00.000Z" }, { db });

    await driveRunOnce(runId, NOW, makeCtx());

    const legs = listRunLegs(runId, { db });
    expect(legs).toHaveLength(1);
    expect(legs[0].status).toBe("submitted"); // the leg itself was never touched
    expect(getRun(runId, { db })!.status).toBe("failed");
  });
});

describe("driveRunOnce — mode:'planner' routes through the real registry", () => {
  it("throws PlannerNotRegisteredError rather than building a leg from a step with no pact_code", async () => {
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 0, mode: "planner", plannerName: "test-planner" },
      { db },
    );
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    await expect(driveRunOnce(runId, NOW, makeCtx())).rejects.toThrow(PlannerNotRegisteredError);
  });

  it("a registered planner returning 2 legs ends with exactly 2 submitted legs, both signed and submitted", async () => {
    registerStepPlanner("rd-test-returns-n", async () => [
      makePlannedLeg("(+ 1 1)"),
      makePlannedLeg("(+ 2 2)"),
    ]);
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 0, mode: "planner", plannerName: "rd-test-returns-n" },
      { db },
    );
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    await driveRunOnce(runId, NOW, makeCtx());

    const legs = listRunLegs(runId, { db }).sort((a, b) => a.leg_index - b.leg_index);
    expect(legs).toHaveLength(2);
    expect(legs[0].leg_index).toBe(0);
    expect(legs[0].status).toBe("submitted");
    expect(legs[1].leg_index).toBe(1);
    expect(legs[1].status).toBe("submitted");
    expect(universalSignTransaction).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("a registered planner returning zero legs on the ONLY step is treated like a cleared barrier — run succeeds with no legs ever inserted", async () => {
    registerStepPlanner("rd-test-returns-zero", async () => []);
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 0, mode: "planner", plannerName: "rd-test-returns-zero" },
      { db },
    );
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    await driveRunOnce(runId, NOW, makeCtx());

    expect(getRun(runId, { db })!.status).toBe("succeeded");
    expect(listRunLegs(runId, { db })).toHaveLength(0);
  });

  it("the same zero-legs planner on a 2-step run advances step_index to 1 (not terminal), leaving zero legs for step 0", async () => {
    registerStepPlanner("rd-test-returns-zero", async () => []);
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 0, mode: "planner", plannerName: "rd-test-returns-zero" },
      { db },
    );
    insertSingleStep("cc-1", 1);
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 2 }, { db });

    await driveRunOnce(runId, NOW, makeCtx());

    const run = getRun(runId, { db });
    expect(run!.step_index).toBe(1);
    expect(run!.status).not.toBe("succeeded");
    expect(run!.status).not.toBe("failed");
    expect(listRunLegs(runId, { db }).filter((l) => l.step_index === 0)).toHaveLength(0);
  });

  it("the registered planner receives the exact step row and a ctx carrying runtime/resolver/config", async () => {
    const plannerSpy = vi.fn(async () => []);
    registerStepPlanner("rd-test-returns-n", plannerSpy);
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 0, mode: "planner", plannerName: "rd-test-returns-n" },
      { db },
    );
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    const configOverride = { maxReplanAttempts: 7 };
    await driveRunOnce(runId, NOW, makeCtx({ config: configOverride }));

    expect(plannerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ planner_name: "rd-test-returns-n" }),
      expect.objectContaining({
        runtime: expect.anything(),
        resolver: expect.anything(),
        config: configOverride,
      }),
    );
  });
});

describe("driveRunOnce — generation-scoped re-plan after a genuine leg failure", () => {
  it("a leg fails, genuinely re-plans into a NEW leg generation (different leg_index, attempt bumped), and the run still reaches succeeded despite the old failed leg remaining in the table", async () => {
    const plannerSpy = vi
      .fn()
      .mockResolvedValueOnce([makePlannedLeg("(+ 1 1)")])
      .mockResolvedValueOnce([makePlannedLeg("(+ 2 2)")]);
    registerStepPlanner("rd-test-replan-ok", plannerSpy);
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 0, mode: "planner", plannerName: "rd-test-replan-ok" },
      { db },
    );
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    const ctx = makeCtx({ config: { maxReplanAttempts: 3 } });

    // Pass 1: no pollRequestKeys wired on currentClient yet, so the internal
    // loop plans leg 0 (planner call #1) and submits it, then stops (a poll
    // that lands nothing new makes no progress).
    submit.mockResolvedValueOnce({ requestKey: "RK-1" }).mockResolvedValueOnce({ requestKey: "RK-2" });
    await driveRunOnce(runId, NOW, ctx);

    let legs = listRunLegs(runId, { db }).sort((a, b) => a.leg_index - b.leg_index);
    expect(legs).toHaveLength(1);
    expect(legs[0].leg_index).toBe(0);
    expect(legs[0].status).toBe("submitted");
    expect(plannerSpy).toHaveBeenCalledTimes(1);

    // Pass 2: wire pollRequestKeys to fail leg 0's request key but succeed
    // leg 1's (the NEW generation's) request key — keyed by request key
    // string, not call order, so this is robust regardless of how many
    // internal loop iterations each real pass takes.
    pollRequestKeys.mockImplementation(async (keys: string[]) => {
      const out: Record<string, { result: { status: string; error?: { message: string } } }> = {};
      for (const k of keys) {
        out[k] =
          k === "RK-1"
            ? { result: { status: "failure", error: { message: "chain rejected" } } }
            : { result: { status: "success" } };
      }
      return out;
    });
    currentClient = { dirtyRead, submit, listen, pollRequestKeys };

    await driveRunOnce(runId, NOW, ctx);

    legs = listRunLegs(runId, { db }).sort((a, b) => a.leg_index - b.leg_index);
    expect(legs).toHaveLength(2);
    expect(legs[0].leg_index).toBe(0);
    expect(legs[0].status).toBe("failed");
    expect(legs[0].attempt).toBe(0);
    expect(legs[1].leg_index).toBe(1);
    expect(legs[1].status).toBe("confirmed");
    expect(legs[1].attempt).toBe(1);
    expect(plannerSpy).toHaveBeenCalledTimes(2);

    const run = getRun(runId, { db });
    expect(run!.attempt).toBe(1);
    expect(run!.status).toBe("succeeded");
  });

  it("the same scenario repeated until maxReplanAttempts is exhausted ends in a real fail-run, not an infinite loop or a thrown RunLegAlreadyExistsError", async () => {
    let plannerCalls = 0;
    const plannerSpy = vi.fn(async () => {
      plannerCalls += 1;
      return [makePlannedLeg(`(+ ${plannerCalls} ${plannerCalls})`)];
    });
    registerStepPlanner("rd-test-replan-exhaust", plannerSpy);
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 0, mode: "planner", plannerName: "rd-test-replan-exhaust" },
      { db },
    );
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    const ctx = makeCtx({ config: { maxReplanAttempts: 1 } });

    // Every submitted leg's poll reports failure, no matter its request key —
    // every attempt genuinely fails, forcing maxReplanAttempts to exhaust.
    pollRequestKeys.mockResolvedValue({
      "RK-1": { result: { status: "failure", error: { message: "chain rejected" } } },
    });
    currentClient = { dirtyRead, submit, listen, pollRequestKeys };

    // Pass 1: plans + submits leg 0 (planner call #1), no poll progress yet
    // (pollRequestKeys IS wired this time, but nothing was submitted before
    // this pass's own submit — the internal loop still polls once more
    // within this same call, landing the failure and re-planning immediately).
    await expect(driveRunOnce(runId, NOW, ctx)).resolves.toBeUndefined();

    const legs = listRunLegs(runId, { db }).sort((a, b) => a.leg_index - b.leg_index);
    // Never a thrown RunLegAlreadyExistsError, and every generation landed at
    // a distinct leg_index.
    const legIndexes = legs.map((l) => l.leg_index);
    expect(new Set(legIndexes).size).toBe(legIndexes.length);

    const run = getRun(runId, { db });
    expect(run!.status).toBe("failed");
    expect(run!.attempt).toBe(1);
    // With maxReplanAttempts:1, replanOrFail's `run.attempt < policy.maxReplanAttempts`
    // guard permits exactly ONE replan (attempt 0 -> 1) before the second
    // failure exhausts it — exactly 2 planner calls, not "2 or more". A
    // guard off-by-one (e.g. `<=` instead of `<`) would let a 3rd planner
    // call through and still satisfy a looser `>= 2` assertion.
    expect(plannerSpy.mock.calls.length).toBe(2);
  });
});

describe("driveRunOnce — end-to-end with the real registered ouronet.aqp-evict planner", () => {
  /** A `mode:'planner'` step wired to the REAL `ouronet.aqp-evict` planner — mirrors `insertSingleStep`'s own leg-shape fixtures, since `evictPlanner` reads `signers_json`/`gas_payer_json`/`config_json` off this same step row. */
  function insertEvictStep(fvtId: string, patronAccount: string): void {
    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 0,
        mode: "planner",
        plannerName: "ouronet.aqp-evict",
        plannerParams: { fvtId, patronAccount },
        config: { chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 },
        payload: {},
        gasPayer: { type: "gas-station", gasStationSignerKey: PUB_A },
        signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
      },
      { db },
    );
  }

  it("the name 'ouronet.aqp-evict' resolves to the exact evictPlanner function imported above — proving this file's import triggered the real self-registration, not a test stand-in", () => {
    expect(getStepPlanner("ouronet.aqp-evict")).toBe(evictPlanner);
  });

  it("a single-entry plan under the gas ceiling drives through handleReplanStep -> submit-leg and ends with exactly one submitted leg built from CC_FullEvictRewards", async () => {
    insertEvictStep("fvt-e2e", "k:patron-e2e");
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    dirtyRead
      .mockResolvedValueOnce({
        result: {
          status: "success",
          data: [{ beneficiary: "k:ben-1", scoreEntityType: 1, scoreEntityId: "se-1", rewardDptfId: "dptf-1" }],
        },
      })
      // Under AUTO_GAS_CEILING (2_000_000) — the full-evict probe succeeds.
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 50_000 });

    await driveRunOnce(runId, NOW, makeCtx());

    const legs = listRunLegs(runId, { db });
    expect(legs).toHaveLength(1);
    expect(legs[0].status).toBe("submitted");
    const definition = JSON.parse(legs[0].definition_json) as {
      pactCode: string;
      payload: Record<string, unknown>;
    };
    // fvtId/patronAccount/executor flow through `payload` (env-data), never
    // string-concatenated into `pactCode` itself — see planners/evict.ts.
    expect(definition.pactCode).toContain("CC_FullEvictRewards");
    expect(definition.pactCode).not.toContain("fvt-e2e");
    expect(definition.payload).toEqual({
      patron: "k:patron-e2e",
      executor: `k:${PUB_A}`,
      "fvt-id": "fvt-e2e",
    });
  });

  it("a 3-entry plan whose full-evict probe reports gas over the ceiling fans out to 3 submitted legs, then confirms and clears the barrier once polled", async () => {
    insertEvictStep("fvt-e2e-3", "k:patron-e2e-3");
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    const plan = [
      { beneficiary: "k:ben-1", scoreEntityType: 1, scoreEntityId: "se-1", rewardDptfId: "dptf-1" },
      { beneficiary: "k:ben-2", scoreEntityType: 3, scoreEntityId: "se-2", rewardDptfId: "dptf-2" },
      { beneficiary: "k:ben-3", scoreEntityType: 1, scoreEntityId: "se-3", rewardDptfId: "dptf-3" },
    ];
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: plan } })
      // Over AUTO_GAS_CEILING (2_000_000) — triggers runSimulate's own
      // gasUsed > ceiling "refuse unmineable" branch, the fan-out signal.
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 3_000_000 });

    await driveRunOnce(runId, NOW, makeCtx());

    let legs = listRunLegs(runId, { db }).sort((a, b) => a.leg_index - b.leg_index);
    expect(legs).toHaveLength(3);
    legs.forEach((leg, i) => {
      expect(leg.status).toBe("submitted");
      const definition = JSON.parse(leg.definition_json) as {
        pactCode: string;
        payload: Record<string, unknown>;
      };
      // Per-leg values flow through `payload` (env-data), never
      // string-concatenated into `pactCode` — see planners/evict.ts.
      expect(definition.pactCode).toContain("CC_EvictSingleReward");
      expect(definition.pactCode).not.toContain(plan[i].beneficiary);
      expect(definition.payload).toEqual({
        patron: "k:patron-e2e-3",
        executor: `k:${PUB_A}`,
        "fvt-id": "fvt-e2e-3",
        beneficiary: plan[i].beneficiary,
        "score-entity-type": plan[i].scoreEntityType,
        "score-entity-id": plan[i].scoreEntityId,
        "reward-dptf-id": plan[i].rewardDptfId,
      });
    });
    // 4, not 3: the planner's own `full-evict` simulate probe signs too, on
    // top of the 3 real `submit`-mode signs — only `client.submit` itself
    // (the actual chain broadcast) is 3. The plan-read (`URHC_BuildEvictPlans`)
    // does NOT sign at all anymore: it goes through `dirtyReadPlan` (an
    // unsigned, zero-signer `dirtyRead`), not `executeCodexTransaction`/
    // `signTransaction` — see docs/work/aqp-planners-talos-routing/design.md.
    expect(universalSignTransaction).toHaveBeenCalledTimes(4);
    expect(submit).toHaveBeenCalledTimes(3);

    // Poll all three as landed, then one more pass clears the barrier —
    // matching this file's existing poll-then-advance test pattern.
    pollRequestKeys.mockResolvedValue({ "RK-1": { result: { status: "success" } } });
    currentClient = { dirtyRead, submit, listen, pollRequestKeys };

    await driveRunOnce(runId, NOW, makeCtx());

    legs = listRunLegs(runId, { db });
    expect(legs.every((l) => l.status === "confirmed")).toBe(true);
    expect(getRun(runId, { db })!.status).toBe("succeeded");
  });

  it("a genuine (non-gas) full-evict probe failure propagates through the REAL evictPlanner all the way to advanceInFlightRunsOnce's erroredIds, never silently treated as 'needs splitting'", async () => {
    insertEvictStep("fvt-e2e-fail", "k:patron-e2e-fail");
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    dirtyRead
      .mockResolvedValueOnce({
        result: {
          status: "success",
          data: [{ beneficiary: "k:ben-1", scoreEntityType: 1, scoreEntityId: "se-1", rewardDptfId: "dptf-1" }],
        },
      })
      // A genuine chain-level/Pact-execution failure — no numeric `gasUsed`
      // on this result, so `evictPlanner` must rethrow, not fan out.
      .mockResolvedValueOnce({ result: { status: "failure", error: { message: "some other real Pact error" } } });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await advanceInFlightRunsOnce(NOW, makeCtx());

    expect(result.erroredIds).toEqual([runId]);
    expect(result.drivenIds).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
    expect(listRunLegs(runId, { db })).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("driveRunOnce — a 2-step run chains TWO DIFFERENT real registered planners end-to-end (regression test for a confirmed HIGH tests-coverage finding: no test anywhere drove a multi-step cronoton through two different real planners before)", () => {
  it("step 0 (ouronet.aqp-evict) and step 1 (ouronet.aqp-inject) each plan/build/submit/confirm their own leg in the correct sequence, and the run only succeeds once BOTH steps' barriers clear", async () => {
    expect(getStepPlanner("ouronet.aqp-inject")).toBe(injectPlanner);

    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 0,
        mode: "planner",
        plannerName: "ouronet.aqp-evict",
        plannerParams: { fvtId: "fvt-chain", patronAccount: "k:patron-chain" },
        config: { chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 },
        payload: {},
        gasPayer: { type: "gas-station", gasStationSignerKey: PUB_A },
        signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
      },
      { db },
    );
    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 1,
        mode: "planner",
        plannerName: "ouronet.aqp-inject",
        plannerParams: { fvtId: "fvt-chain", patronAccount: "k:patron-chain", executor: "Ѻ.executor-chain", rewardDptfId: "dptf-chain", amount: "5.0" },
        config: { chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 },
        payload: {},
        gasPayer: { type: "gas-station", gasStationSignerKey: PUB_A },
        signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
      },
      { db },
    );
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 2 }, { db });

    // Pass 1 — step 0 (evict): plan-read (one entry) then the full-evict
    // probe succeeds comfortably under the gas ceiling -> exactly one leg,
    // submitted. Step 1 (inject) never starts: the barrier isn't cleared yet.
    dirtyRead
      .mockResolvedValueOnce({
        result: {
          status: "success",
          data: [{ beneficiary: "k:ben-chain", scoreEntityType: 1, scoreEntityId: "se-chain", rewardDptfId: "dptf-1" }],
        },
      })
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 50_000 });

    await driveRunOnce(runId, NOW, makeCtx());

    let legs = listRunLegs(runId, { db }).sort((a, b) => a.step_index - b.step_index);
    expect(legs).toHaveLength(1);
    expect(legs[0].step_index).toBe(0);
    expect(legs[0].status).toBe("submitted");
    expect(getRun(runId, { db })!.step_index).toBe(0);

    // Pass 2 — polling confirms step 0's leg, clearing its barrier and
    // advancing to step 1, whose planner (inject) runs its own
    // CC_InjectFinalize probe (succeeds) and submits its own leg — and
    // since `pollRequestKeys` is ALREADY mocked to report success before
    // this call starts, `driveRunOnce`'s own internal "drive as far as it
    // will synchronously go" loop keeps going: it polls step 1's
    // just-submitted leg too, confirms it, and — step 1 being the LAST
    // step — the run succeeds, ALL within this one call.
    pollRequestKeys.mockResolvedValue({ "RK-1": { result: { status: "success" } } });
    currentClient = { dirtyRead, submit, listen, pollRequestKeys };
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 50_000 });

    await driveRunOnce(runId, NOW, makeCtx());

    legs = listRunLegs(runId, { db }).sort((a, b) => a.step_index - b.step_index);
    expect(legs).toHaveLength(2);
    expect(legs[0].step_index).toBe(0);
    expect(legs[0].status).toBe("confirmed");
    expect(legs[1].step_index).toBe(1);
    expect(legs[1].status).toBe("confirmed");
    const injectDef = JSON.parse(legs[1].definition_json) as { pactCode: string; payload: Record<string, unknown> };
    expect(injectDef.pactCode).toContain("CC_InjectFinalize");
    expect(injectDef.payload).toEqual({
      patron: "k:patron-chain",
      executor: "Ѻ.executor-chain",
      "fvt-id": "fvt-chain",
      "reward-dptf-id": "dptf-chain",
      amount: "5.0",
    });
    expect(getRun(runId, { db })!.step_index).toBe(1);
    expect(getRun(runId, { db })!.status).toBe("succeeded");
  });
});

describe("driveRunOnce — end-to-end: ouronet.aqp-unstall fans out, one batch fails, and the REAL planner's re-plan uses a fresh leg generation", () => {
  /** A `mode:'planner'` step row wired to the REAL `ouronet.aqp-unstall` planner — mirrors `insertEvictStep`'s own leg-shape fixtures, since `unstallPlanner` reads `signers_json`/`gas_payer_json`/`config_json`/`planner_params_json` off this same step row. */
  function insertUnstallStep(fvtId: string, patronAccount: string, rewardDptfId: string): void {
    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 0,
        mode: "planner",
        plannerName: "ouronet.aqp-unstall",
        plannerParams: { fvtId, patronAccount, rewardDptfId },
        config: { chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 },
        payload: {},
        gasPayer: { type: "gas-station", gasStationSignerKey: PUB_A },
        signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
      },
      { db },
    );
  }

  it("a 4-user stale list fans out into 2 batches, one batch's leg fails, the REAL unstallPlanner re-plans with a fresh leg generation for just the failed batch's users, and the run succeeds", async () => {
    expect(getStepPlanner("ouronet.aqp-unstall")).toBe(unstallPlanner); // this file's import triggered the real self-registration, not a test stand-in

    insertUnstallStep("fvt-unstall-e2e", "k:patron-unstall-e2e", "dptf-unstall-e2e");
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    // `getBlockGasLimit`, NOT `ctx.config.autoGasCeiling`, is what decouples
    // the EXECUTOR's own per-probe refusal ceiling (`executor.ts`'s
    // `resolveCeiling`, which DOES consult it) from `unstallPlanner`'s own
    // split-sizing ceiling (`ctx.config?.autoGasCeiling ?? AUTO_GAS_CEILING` —
    // design.md §B's explicitly-scoped-down static ceiling, which never
    // consults it). Without this, a 4-item sample probed over
    // AUTO_GAS_CEILING would be REFUSED by the executor itself before
    // `measureSize` ever got to MODEL a multi-batch split (the whole 4-user
    // selection IS the sample when n <= split-plan.ts's SAMPLE_SIZE of 64 —
    // a refused sample is `measureSize`'s own "could not be simulated"
    // failure, not a split signal). A real, live chain client reporting a
    // high block gas limit while this planner still deliberately plans
    // against the lower static ceiling is exactly the asymmetry design.md
    // §B documents.
    const getBlockGasLimit = vi.fn(async () => 10_000_000);
    currentClient = { dirtyRead, submit, listen, getBlockGasLimit };

    // Stale read: 4 users. splitPlan's sizing probes: one item (400_000 gas),
    // then the WHOLE 4-item selection as the "sample" (SAMPLE_SIZE=64 > 4, so
    // sampleN === n) at 2_400_000 gas — over unstallPlanner's own 2_000_000
    // (AUTO_GAS_CEILING) ceiling (so NOT fitsInOne) but under the mocked
    // 10_000_000 executor ceiling (so the probe itself is not refused,
    // letting measureSize model a split instead of failing outright). The
    // modeled capacity lands on 2, confirmed by probing the first evenSplit
    // batch (2 users) at 1_800_000 gas — under both ceilings, confirmed
    // immediately, no shrink/growth probe needed.
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: ["k:u0", "k:u1", "k:u2", "k:u3"] } })
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 400_000 })
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 2_400_000 })
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 1_800_000 });
    submit.mockResolvedValueOnce({ requestKey: "RK-BATCH-1" }).mockResolvedValueOnce({ requestKey: "RK-BATCH-2" });

    await driveRunOnce(runId, NOW, makeCtx());

    let legs = listRunLegs(runId, { db }).sort((a, b) => a.leg_index - b.leg_index);
    expect(legs).toHaveLength(2);
    expect(legs[0].status).toBe("submitted");
    expect(legs[1].status).toBe("submitted");
    expect(legs[0].attempt).toBe(0);
    expect(legs[1].attempt).toBe(0);
    const firstBatchUsers = (JSON.parse(legs[0].definition_json) as { payload: { users: string[] } }).payload.users;
    const secondBatchUsers = (JSON.parse(legs[1].definition_json) as { payload: { users: string[] } }).payload.users;
    expect(firstBatchUsers).toEqual(["k:u0", "k:u1"]);
    expect(secondBatchUsers).toEqual(["k:u2", "k:u3"]);
    const originalFailedLegIndex = legs[0].leg_index;
    const failedRequestKey = legs[0].request_key!;

    // The first batch's leg fails; the second's succeeds — a genuine,
    // independent-slice failure (design.md §C: `CCp_FvtFixSlice` is
    // parallel-safe, order-independent), triggering `replanOrFail`'s
    // `canReplan:true` path once both legs resolve (`run-advance.ts` step 6).
    // Keyed by request-key string, not call order or count, so this is
    // robust regardless of how many internal loop iterations this pass takes
    // — mirrors the generation-scoped re-plan tests' own pollRequestKeys
    // fixture above.
    pollRequestKeys.mockImplementation(async (keys: string[]) => {
      const out: Record<string, { result: { status: string; error?: { message: string } } }> = {};
      for (const k of keys) {
        out[k] =
          k === failedRequestKey
            ? { result: { status: "failure", error: { message: "chain rejected" } } }
            : { result: { status: "success" } };
      }
      return out;
    });
    currentClient = { dirtyRead, submit, listen, pollRequestKeys, getBlockGasLimit };

    // The re-plan's own `URH_FvtStalePresentUsers` re-read: only the 2 users
    // from the FAILED batch are still stale (the other batch already
    // landed). n=2 now, so the sample probe covers the whole (new, smaller)
    // selection — both well under the ceiling — so `fitsInOne` short-
    // circuits to exactly ONE new leg, no confirm/growth probe needed.
    dirtyRead
      .mockResolvedValueOnce({ result: { status: "success", data: ["k:u0", "k:u1"] } })
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 500_000 })
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 900_000 });
    submit.mockResolvedValueOnce({ requestKey: "RK-REPLAN" });

    await driveRunOnce(runId, NOW, makeCtx());

    legs = listRunLegs(runId, { db }).sort((a, b) => a.leg_index - b.leg_index);
    expect(legs).toHaveLength(3);
    const newLeg = legs.find((l) => l.attempt === 1);
    expect(newLeg).toBeDefined();
    expect(newLeg!.status).toBe("confirmed");
    expect(newLeg!.leg_index).not.toBe(originalFailedLegIndex); // fresh generation, never collides on legIndex
    const newLegUsers = (JSON.parse(newLeg!.definition_json) as { payload: { users: string[] } }).payload.users;
    expect(newLegUsers).toEqual(["k:u0", "k:u1"]);

    const run = getRun(runId, { db });
    expect(run!.attempt).toBe(1); // exactly one bump
    expect(run!.status).toBe("succeeded"); // the only step — barrier cleared despite the old failed leg remaining in the table
  });
});

describe("driveRunOnce — defensive branches", () => {
  it("a run id that doesn't exist (vanished between listInFlightRuns and this call) is a pure no-op", async () => {
    const onAudit = vi.fn();
    await driveRunOnce("does-not-exist", NOW, makeCtx({ onAudit }));

    expect(onAudit).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("a run whose current step_index has no matching codex_cronoton_steps row fails loudly rather than looping forever", async () => {
    // Insert step 0 only, but create the run for a stepCount that implies a
    // step 1 exists — then advance the run to step_index 1, where no step
    // row was ever written, mirroring a steps-deleted-out-from-under-a-live-
    // run scenario.
    insertSingleStep("cc-1", 0);
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 2 }, { db });
    advanceRunStep(runId, { fromStepIndex: 0, toStepIndex: 1, deadlineAt: null }, { db });

    const onAudit = vi.fn();
    await driveRunOnce(runId, NOW, makeCtx({ onAudit }));

    expect(getRun(runId, { db })!.status).toBe("failed");
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "codex_cronoton_run.step_missing",
        result: "failure",
        targetKind: "codex_cronoton_run",
        targetId: runId,
      }),
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("a submit-leg action whose legIndex isn't present in stepLegs audits not_found and makes no progress, rather than throwing or submitting the wrong leg", async () => {
    // Force the "should never happen" branch: advanceRun's own decision
    // logic would never pick a legIndex absent from the legs array it was
    // given, so the only way to exercise this defensive guard is to stub
    // the pure decision function itself for one call (mirrors this file's
    // existing executorModule spy pattern for the submit-failure test).
    insertSingleStep("cc-1", 0);
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    insertRunLeg(
      {
        runId,
        stepIndex: 0,
        legIndex: 0,
        definitionJson: JSON.stringify({
          pactCode: "(+ 1 1)",
          config: { chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 },
          payload: {},
          gasPayer: { type: "gas-station", gasStationSignerKey: PUB_A },
          signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
        }),
      },
      { db },
    );

    const advanceRunSpy = vi
      .spyOn(runAdvanceModule, "advanceRun")
      .mockReturnValueOnce([{ kind: "submit-leg", legIndex: 99 }]);

    const onAudit = vi.fn();
    await driveRunOnce(runId, NOW, makeCtx({ onAudit }));

    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "codex_cronoton_run_leg.not_found",
        result: "failure",
        targetKind: "codex_cronoton_run",
        targetId: runId,
        detail: expect.objectContaining({ legIndex: 99 }),
      }),
    );
    expect(submit).not.toHaveBeenCalled();
    // The real leg at index 0 was never touched by the bogus action.
    expect(listRunLegs(runId, { db })[0]?.status).toBe("pending");
    advanceRunSpy.mockRestore();
  });
});

describe("driveRunOnce — parseLegDefinition rejects a malformed stored definition before it ever reaches the signer", () => {
  it("a pending leg with no pactCode is never submitted; stays pending and audits invalid_definition", async () => {
    insertSingleStep("cc-1", 0);
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    // Inserted directly (not via replan-step's stepRowToDefinition), so this
    // leg already exists and is 'pending' before driveRunOnce ever runs —
    // advanceRun's step 7 picks it for submit-leg exactly as it would any
    // other pending leg, routing it into handleSubmitLeg/parseLegDefinition.
    insertRunLeg(
      {
        runId,
        stepIndex: 0,
        legIndex: 0,
        definitionJson: JSON.stringify({ signers: [], gasPayer: {}, config: {} }), // no pactCode
      },
      { db },
    );

    const onAudit = vi.fn();
    await driveRunOnce(runId, NOW, makeCtx({ onAudit }));

    const legs = listRunLegs(runId, { db });
    expect(legs).toHaveLength(1);
    expect(legs[0].status).toBe("pending");
    expect(legs[0].request_key).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(universalSignTransaction).not.toHaveBeenCalled();
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "codex_cronoton_run_leg.invalid_definition",
        result: "failure",
        targetKind: "codex_cronoton_run_leg",
        targetId: legs[0].id,
      }),
    );
  });

  it("a non-array signers field is rejected the same way (one more shape violation, proving the gate isn't just checking pactCode)", async () => {
    insertSingleStep("cc-1", 0);
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    insertRunLeg(
      {
        runId,
        stepIndex: 0,
        legIndex: 0,
        definitionJson: JSON.stringify({ pactCode: "(+ 1 1)", signers: "not-an-array", gasPayer: {}, config: {} }),
      },
      { db },
    );

    const onAudit = vi.fn();
    await driveRunOnce(runId, NOW, makeCtx({ onAudit }));

    expect(listRunLegs(runId, { db })[0]?.status).toBe("pending");
    expect(submit).not.toHaveBeenCalled();
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "codex_cronoton_run_leg.invalid_definition", result: "failure" }),
    );
  });
});

describe("driveRunOnce — a genuine planner throw on a run's FIRST pass terminalizes the run instead of leaving it stuck forever", () => {
  it("marks the run 'failed', audits codex_cronoton_run.failed, and re-throws — matching the CRITICAL cross-phase-review fix in handleReplanStep", async () => {
    registerStepPlanner("rd-test-throws-on-first-pass", async () => {
      throw new Error("genuine planner failure, e.g. a malformed planner_params_json");
    });
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 0, mode: "planner", plannerName: "rd-test-throws-on-first-pass" },
      { db },
    );
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    const onAudit = vi.fn();

    // Before the fix: this run's deadline_at was NEVER stamped (the throw
    // happens before the success path that would stamp it), so it stayed
    // 'planning' forever — advanceRun's deadline-exceeded recovery branch
    // is gated on deadlineAt != null and could never engage.
    await expect(driveRunOnce(runId, NOW, makeCtx({ onAudit }))).rejects.toThrow(
      /genuine planner failure/,
    );

    const run = getRun(runId, { db });
    expect(run!.status).toBe("failed");
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "codex_cronoton_run.failed",
        result: "failure",
        targetId: runId,
      }),
    );
    // The self-block slot (schema.ts's partial unique index) is genuinely
    // freed — a new run for the SAME cronoton can be created immediately,
    // not just "errored" in a way that still blocks future runs.
    expect(() => createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db })).not.toThrow();
  });

  it("an unregistered planner_name (PlannerNotRegisteredError) on a run's first pass is terminalized the same way", async () => {
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 0, mode: "planner", plannerName: "rd-test-never-registered" },
      { db },
    );
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    await expect(driveRunOnce(runId, NOW, makeCtx())).rejects.toThrow(PlannerNotRegisteredError);

    expect(getRun(runId, { db })!.status).toBe("failed");
  });

  it("REGRESSION GUARD #1 (HIGH, found by this same review's own terminal pass): a throw during a GENUINE re-plan (this step already has a prior leg; the barrier-recovery machinery already decided this attempt was worth making) is NEVER terminalized here — it must propagate so the next pass's own deadline/maxReplanAttempts budget governs recovery, not this catch", async () => {
    let plannerCalls = 0;
    const plannerSpy = vi.fn(async () => {
      plannerCalls += 1;
      if (plannerCalls === 1) return [makePlannedLeg("(+ 1 1)")];
      throw new Error("transient chain hiccup during re-plan");
    });
    registerStepPlanner("rd-test-throws-on-replan", plannerSpy);
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 0, mode: "planner", plannerName: "rd-test-throws-on-replan" },
      { db },
    );
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    // Every poll reports failure, forcing a genuine re-plan attempt within
    // this SAME driveRunOnce call (parallel-mode, one failed leg, fully
    // resolved -> replanOrFail -> replan-step, since attempt 0 < the
    // default maxReplanAttempts).
    pollRequestKeys.mockResolvedValue({
      "RK-1": { result: { status: "failure", error: { message: "chain rejected" } } },
    });
    currentClient = { dirtyRead, submit, listen, pollRequestKeys };

    await expect(driveRunOnce(runId, NOW, makeCtx())).rejects.toThrow(/transient chain hiccup/);

    const run = getRun(runId, { db });
    // NOT terminalized, and attempt NOT bumped (the bump only happens
    // AFTER a successful re-plan, which never occurred here) — the retry
    // budget `maxReplanAttempts` grants is fully intact for the next pass.
    expect(run!.status).not.toBe("failed");
    expect(run!.attempt).toBe(0);
    expect(plannerCalls).toBe(2);
  });

  it("REGRESSION GUARD #2 (CRITICAL, found by this same review's own terminal pass): a RunLegAlreadyExistsError (a concurrent caller already won this exact leg-index race) is NEVER terminalized here, even on a step's first entry — the concurrent winner is making real progress and the run must not be incorrectly failed", async () => {
    let concurrentRunId = "";
    registerStepPlanner("rd-test-concurrent-race", async () => {
      // Simulates a DIFFERENT concurrent `driveRunOnce` caller's leg
      // landing for this exact run/step/attempt slot, between THIS call's
      // own (now-stale) `allRunLegs` read and its own `insertRunLeg`
      // write below — e.g. `executeNow`'s HTTP-triggered call racing the
      // background loop's own sweep, the exact scenario `store/runs.ts`'s
      // own module doc names.
      insertRunLeg({ runId: concurrentRunId, stepIndex: 0, legIndex: 0, definitionJson: "{}" }, { db });
      return [makePlannedLeg("(+ 1 1)")];
    });
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 0, mode: "planner", plannerName: "rd-test-concurrent-race" },
      { db },
    );
    concurrentRunId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    await expect(driveRunOnce(concurrentRunId, NOW, makeCtx())).rejects.toThrow(RunLegAlreadyExistsError);

    // NOT terminalized — the "concurrent winner" already landed a real
    // leg for this run; incorrectly failing it here would discard
    // progress that is genuinely happening.
    expect(getRun(concurrentRunId, { db })!.status).not.toBe("failed");
  });
});

describe("advanceInFlightRunsOnce — per-run isolation", () => {
  it("a planner-mode run's throw does not block a second, healthy run from driving to completion", async () => {
    seedCronoton("cc-2");

    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 0, mode: "planner", plannerName: "test-planner" },
      { db },
    );
    const firstRunId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    insertSingleStep("cc-2", 0);
    const secondRunId = createRun({ codexCronotonId: "cc-2", stepCount: 1 }, { db });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await advanceInFlightRunsOnce(NOW, makeCtx());

    expect(result).toEqual({ drivenIds: [secondRunId], erroredIds: [firstRunId] });
    expect(consoleError).toHaveBeenCalled();
    expect(listRunLegs(secondRunId, { db })[0]?.status).toBe("submitted");

    // Regression test for a CRITICAL cross-phase-review finding: the first
    // run's throw happened on its VERY FIRST pass (no legs yet, deadline_at
    // still null) — before this fix, nothing ever terminalized it, so it
    // sat in 'planning' forever, permanently occupying cc-1's self-block
    // slot (schema.ts's partial unique index). Confirm it's actually
    // terminal now, and that a NEW run can be created for the SAME
    // cronoton afterward (the self-block slot is genuinely freed, not just
    // "errored" in a way that still blocks future runs).
    expect(getRun(firstRunId, { db })!.status).toBe("failed");
    expect(() => createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db })).not.toThrow();
  });

  it("excludeRunIds skips the named run entirely — no store write, not counted in drivenIds or erroredIds", async () => {
    seedCronoton("cc-2");

    insertSingleStep("cc-1", 0);
    const excludedRunId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    insertSingleStep("cc-2", 0);
    const includedRunId = createRun({ codexCronotonId: "cc-2", stepCount: 1 }, { db });

    const result = await advanceInFlightRunsOnce(NOW, makeCtx(), new Set([excludedRunId]));

    expect(result).toEqual({ drivenIds: [includedRunId], erroredIds: [] });
    // The excluded run was never touched: still no legs, still 'planning'.
    expect(listRunLegs(excludedRunId, { db })).toHaveLength(0);
    expect(getRun(excludedRunId, { db })!.status).toBe("planning");
    // The included run WAS driven (this is the control, proving the skip is
    // specific to the excluded id, not a blanket no-op).
    expect(listRunLegs(includedRunId, { db })[0]?.status).toBe("submitted");
  });
});

describe("driveRunOnce — step-to-step yield carry (docs/work/khronoton-step-yield-carry)", () => {
  it("a mode:'planner' step with yield_as writes its planner's returned yield into the pool, and a LATER mode:'planner' step's {\"$yield\":...} placeholder resolves to that exact value before its own planner is invoked", async () => {
    registerStepPlanner("rd-yield-producer", async () => ({
      legs: [makePlannedLeg("(+ 1 1)")],
      yield: "123.45",
    }));
    registerStepPlanner("rd-yield-consumer", async (step) => {
      const params = JSON.parse(step.planner_params_json ?? "{}") as { amount?: unknown };
      return [{ ...makePlannedLeg("(+ 2 2)"), payload: { amount: params.amount } }];
    });
    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 0,
        mode: "planner",
        plannerName: "rd-yield-producer",
        yieldAs: "drainedAmount",
      },
      { db },
    );
    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 1,
        mode: "planner",
        plannerName: "rd-yield-consumer",
        plannerParams: { amount: { $yield: "drainedAmount" } },
      },
      { db },
    );
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 2 }, { db });

    submit.mockResolvedValue({ requestKey: "RK-1" });
    pollRequestKeys.mockResolvedValue({ "RK-1": { result: { status: "success" } } });
    currentClient = { dirtyRead, submit, listen, pollRequestKeys };

    await driveRunOnce(runId, NOW, makeCtx());

    expect(getRun(runId, { db })!.status).toBe("succeeded");
    const legs = listRunLegs(runId, { db }).sort((a, b) => a.step_index - b.step_index);
    expect(legs).toHaveLength(2);
    const step1Definition = JSON.parse(legs[1].definition_json) as { payload: { amount: unknown } };
    // The literal resolved value, never the placeholder text.
    expect(step1Definition.payload.amount).toBe("123.45");
    expect(legs[1].definition_json).not.toContain("$yield");
  });

  it("a mode:'single' step with yield_as captures the confirmed leg's real on-chain return value under that name, readable by a later step's {\"$yield\":...} placeholder", async () => {
    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 0,
        mode: "single",
        pactCode: "(+ 1 1)",
        config: { chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 },
        payload: {},
        gasPayer: { type: "gas-station", gasStationSignerKey: PUB_A },
        signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
        yieldAs: "collected",
      },
      { db },
    );
    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 1,
        mode: "single",
        pactCode: "(+ 1 1)",
        config: { chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 },
        payload: { amount: { $yield: "collected" } },
        gasPayer: { type: "gas-station", gasStationSignerKey: PUB_A },
        signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
      },
      { db },
    );
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 2 }, { db });

    submit.mockResolvedValue({ requestKey: "RK-1" });
    pollRequestKeys.mockResolvedValue({ "RK-1": { result: { status: "success", data: 77 } } });
    currentClient = { dirtyRead, submit, listen, pollRequestKeys };

    await driveRunOnce(runId, NOW, makeCtx());

    expect(getRun(runId, { db })!.status).toBe("succeeded");
    expect(getYieldPool(runId, { db })).toEqual({ collected: 77 });
    const legs = listRunLegs(runId, { db }).sort((a, b) => a.step_index - b.step_index);
    const step1Definition = JSON.parse(legs[1].definition_json) as { payload: { amount: unknown } };
    expect(step1Definition.payload.amount).toBe(77);
  });

  it("a step referencing a yield name no earlier step ever produced throws YieldNotFoundError, propagating through the existing handleReplanStep catch (same path PlannerNotRegisteredError already uses) and terminalizing the run", async () => {
    registerStepPlanner("rd-test-missing-yield", async () => []);
    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 0,
        mode: "planner",
        plannerName: "rd-test-missing-yield",
        plannerParams: { amount: { $yield: "neverProduced" } },
      },
      { db },
    );
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    await expect(driveRunOnce(runId, NOW, makeCtx())).rejects.toThrow(YieldNotFoundError);

    expect(getRun(runId, { db })!.status).toBe("failed");
  });

  it("a replanned step's second attempt overwrites the pool entry with its freshest value — nothing downstream ever observes the first, superseded attempt's value", async () => {
    const plannerSpy = vi
      .fn()
      .mockResolvedValueOnce({ legs: [makePlannedLeg("(+ 1 1)")], yield: "first" })
      .mockResolvedValueOnce({ legs: [makePlannedLeg("(+ 2 2)")], yield: "second" });
    registerStepPlanner("rd-test-yield-replan", plannerSpy);
    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 0,
        mode: "planner",
        plannerName: "rd-test-yield-replan",
        yieldAs: "x",
      },
      { db },
    );
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    const ctx = makeCtx({ config: { maxReplanAttempts: 3 } });

    // Pass 1: plans + submits leg 0 (planner call #1, yields "first") — no
    // poll progress yet (pollRequestKeys not wired), so the pool already
    // shows "first" once this pass stops.
    submit.mockResolvedValueOnce({ requestKey: "RK-1" }).mockResolvedValueOnce({ requestKey: "RK-2" });
    await driveRunOnce(runId, NOW, ctx);

    expect(getYieldPool(runId, { db })).toEqual({ x: "first" });
    expect(plannerSpy).toHaveBeenCalledTimes(1);

    // Pass 2: leg 0 (RK-1) fails, forcing a genuine re-plan — the SAME
    // planner's second invocation returns a DIFFERENT yield value ("second").
    pollRequestKeys.mockImplementation(async (keys: string[]) => {
      const out: Record<string, { result: { status: string; error?: { message: string } } }> = {};
      for (const k of keys) {
        out[k] =
          k === "RK-1"
            ? { result: { status: "failure", error: { message: "chain rejected" } } }
            : { result: { status: "success" } };
      }
      return out;
    });
    currentClient = { dirtyRead, submit, listen, pollRequestKeys };

    await driveRunOnce(runId, NOW, ctx);

    expect(plannerSpy).toHaveBeenCalledTimes(2);
    // ONLY the second attempt's value is visible — never the first's,
    // superseded one.
    expect(getYieldPool(runId, { db })).toEqual({ x: "second" });
    expect(getRun(runId, { db })!.status).toBe("succeeded");
  });

  it("the REAL ouronet.stoa-wrap -> ouronet.aqp-inject chain genuinely carries wrap's amount into inject's amount (the motivating case), not independently re-probed or statically pre-set", async () => {
    expect(getStepPlanner("ouronet.stoa-wrap")).toBe(stoaWrapPlanner); // this file's import triggered the real self-registration, not a test stand-in

    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 0,
        mode: "planner",
        plannerName: "ouronet.stoa-wrap",
        plannerParams: { patronAccount: "k:patron-wrap-inject", amountOverride: "50.0" },
        config: { chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 },
        payload: {},
        gasPayer: { type: "gas-station", gasStationSignerKey: PUB_A },
        signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
        yieldAs: "wrappedAmount",
      },
      { db },
    );
    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 1,
        mode: "planner",
        plannerName: "ouronet.aqp-inject",
        plannerParams: {
          fvtId: "fvt-wrap-inject",
          patronAccount: "k:patron-wrap-inject",
          executor: "Ѻ.executor-wrap-inject",
          rewardDptfId: "dptf-wrap-inject",
          amount: { $yield: "wrappedAmount" },
        },
        config: { chainId: "0", gasPrice: 0, gasLimit: 1000, autoGasLimit: false, ttl: 600 },
        payload: {},
        gasPayer: { type: "gas-station", gasStationSignerKey: PUB_A },
        signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
      },
      { db },
    );
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 2 }, { db });

    // Pass 1 — step 0 (stoa-wrap): amountOverride is set, so NO coin.get-balance
    // probe runs at all (Wave 1's T3) — build + submit leg 0 directly.
    await driveRunOnce(runId, NOW, makeCtx());

    let legs = listRunLegs(runId, { db }).sort((a, b) => a.step_index - b.step_index);
    expect(legs).toHaveLength(1);
    expect(legs[0].status).toBe("submitted");
    expect(getRun(runId, { db })!.step_index).toBe(0);
    expect(getYieldPool(runId, { db })).toEqual({ wrappedAmount: "50.0" });

    // Pass 2 — polling confirms step 0's leg, advancing to step 1, whose
    // planner_params_json's {"$yield":"wrappedAmount"} placeholder is
    // resolved to "50.0" BEFORE injectPlanner ever runs; its own
    // CC_InjectFinalize probe succeeds, so its leg is built/submitted/
    // confirmed all within this one call (driveRunOnce's own internal
    // "drive as far as it will synchronously go" loop).
    pollRequestKeys.mockResolvedValue({ "RK-1": { result: { status: "success" } } });
    currentClient = { dirtyRead, submit, listen, pollRequestKeys };
    dirtyRead.mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 50_000 });

    await driveRunOnce(runId, NOW, makeCtx());

    legs = listRunLegs(runId, { db }).sort((a, b) => a.step_index - b.step_index);
    expect(legs).toHaveLength(2);
    expect(legs[0].status).toBe("confirmed");
    expect(legs[1].status).toBe("confirmed");
    const injectDef = JSON.parse(legs[1].definition_json) as { pactCode: string; payload: Record<string, unknown> };
    expect(injectDef.pactCode).toContain("CC_InjectFinalize");
    // The exact motivating case: inject's amount genuinely carried from
    // wrap's actual used amount, not independently re-probed or statically
    // pre-set.
    expect(injectDef.payload.amount).toBe("50.0");
    expect(getRun(runId, { db })!.status).toBe("succeeded");
  });

  it("REGRESSION (terminal-pass finding): a planner returning { legs: [], yield } on a step with yield_as still persists the yield, even though the step's own barrier clears with zero legs", async () => {
    registerStepPlanner("rd-test-empty-legs-yield", async () => ({
      legs: [],
      yield: "nothing-to-drain-this-pass",
    }));
    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 0,
        mode: "planner",
        plannerName: "rd-test-empty-legs-yield",
        yieldAs: "drainResult",
      },
      { db },
    );
    const runId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    await driveRunOnce(runId, NOW, makeCtx());

    // The step is trivially satisfied (zero legs, matching the existing
    // "nothing owed" convention) AND its reported yield is still readable —
    // before the fix, the early `return handleAdvanceStep(...)` for the
    // empty-legs case skipped the yield-write entirely.
    expect(getRun(runId, { db })!.status).toBe("succeeded");
    expect(getYieldPool(runId, { db })).toEqual({ drainResult: "nothing-to-drain-this-pass" });
  });

  it("REGRESSION (terminal-pass finding): a concurrent loser's yield is never written — the yield upsert only runs after this caller's OWN legs have actually been inserted, not before", async () => {
    let concurrentRunId = "";
    registerStepPlanner("rd-test-yield-race", async () => {
      // Simulates a DIFFERENT concurrent `driveRunOnce` caller having
      // already won this exact leg-index slot AND already recorded its
      // own (different) yield value — mirroring the existing
      // "REGRESSION GUARD #2" concurrent-race test's own simulation
      // pattern above, extended to also cover the yield pool.
      insertRunLeg({ runId: concurrentRunId, stepIndex: 0, legIndex: 0, definitionJson: "{}" }, { db });
      upsertYield({ runId: concurrentRunId, name: "x", value: "winning-value", stepIndex: 0 }, { db });
      return { legs: [makePlannedLeg("(+ 1 1)")], yield: "losing-value" };
    });
    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 0,
        mode: "planner",
        plannerName: "rd-test-yield-race",
        yieldAs: "x",
      },
      { db },
    );
    concurrentRunId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });

    await expect(driveRunOnce(concurrentRunId, NOW, makeCtx())).rejects.toThrow(RunLegAlreadyExistsError);

    // The losing caller's `insertRunLeg` throws BEFORE its own `upsertYield`
    // call is ever reached (legs are inserted first, per the fix) — the
    // pool must still show the concurrent winner's value, never the
    // loser's, regardless of which caller's planner invocation happened to
    // finish computing its yield last.
    expect(getYieldPool(concurrentRunId, { db })).toEqual({ x: "winning-value" });
  });

  it("REGRESSION (round-3 terminal-pass finding): a concurrent genuine-replan racer's bumpRunAttempt is never double-counted — the loser's insertRunLeg collision happens BEFORE its own bumpRunAttempt/touchRunDeadline calls, not after", async () => {
    let concurrentRunId = "";
    const plannerSpy = vi
      .fn()
      .mockResolvedValueOnce([makePlannedLeg("(+ 1 1)")]) // pass 1: plans leg 0 (first entry, not a replan)
      .mockImplementationOnce(async () => {
        // Pass 2 is a GENUINE re-plan for this caller too (a prior leg
        // already exists for this step) — simulate a DIFFERENT concurrent
        // `driveRunOnce` caller having already won this exact re-plan
        // generation: its own bumpRunAttempt + insertRunLeg already landed,
        // between THIS call's own (now-stale) allRunLegs read and this
        // call's insertRunLeg write below.
        bumpRunAttempt(concurrentRunId, { db });
        insertRunLeg(
          { runId: concurrentRunId, stepIndex: 0, legIndex: 1, definitionJson: "{}", attempt: 1 },
          { db },
        );
        return [makePlannedLeg("(+ 2 2)")];
      });
    registerStepPlanner("rd-test-attempt-race", plannerSpy);
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 0, mode: "planner", plannerName: "rd-test-attempt-race" },
      { db },
    );
    concurrentRunId = createRun({ codexCronotonId: "cc-1", stepCount: 1 }, { db });
    const ctx = makeCtx({ config: { maxReplanAttempts: 3 } });

    // Pass 1: plans + submits leg 0 normally (first entry, isReplan=false).
    submit.mockResolvedValueOnce({ requestKey: "RK-1" });
    await driveRunOnce(concurrentRunId, NOW, ctx);
    expect(getRun(concurrentRunId, { db })!.attempt).toBe(0);

    // Pass 2: leg 0 fails on poll, forcing THIS caller into a genuine
    // re-plan (isReplan=true) — whose own planner invocation triggers the
    // simulated concurrent winner above, which collides on leg_index 1.
    pollRequestKeys.mockResolvedValue({
      "RK-1": { result: { status: "failure", error: { message: "chain rejected" } } },
    });
    currentClient = { dirtyRead, submit, listen, pollRequestKeys };

    await expect(driveRunOnce(concurrentRunId, NOW, ctx)).rejects.toThrow(RunLegAlreadyExistsError);

    // Only ONE bump ever happened — the simulated concurrent winner's,
    // executed inside the planner mock above. This (losing) caller's OWN
    // insertRunLeg call threw before it ever reached its own
    // bumpRunAttempt/touchRunDeadline calls, which now run strictly AFTER
    // the leg-insert loop. Before the fix, this caller's bump would have
    // already landed (making attempt 2), double-counting a single re-plan
    // generation and burning the maxReplanAttempts budget twice as fast.
    expect(getRun(concurrentRunId, { db })!.attempt).toBe(1);
  });
});
