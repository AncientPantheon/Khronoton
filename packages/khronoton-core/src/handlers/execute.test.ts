/**
 * Execution handlers — the branching route contract: the 200-on-`ok:false`
 * rule (a fire-level failure rides in the body, never as a non-200), the 202
 * multi-tx queued short-circuit (never an inline fire), the runtime-arg
 * validation on trigger, the recover requestKey regex + the failure→success
 * flip, and the confirm gate.
 *
 * Drives real behavior through `HandlerRequest → HandlerResponse` against the
 * shared harness (real in-memory DB + mock runtime/resolver), asserting status
 * codes AND the store side-effects (a fire row written exactly once, a one-time
 * terminal transition, a flipped fire status) — not mock return values.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";

import {
  getCodexCronoton,
  recordFire,
  registerServerResolver,
  insertStep,
  listRunLegs,
  getStepPlanner,
  editCodexCronoton,
  type CodexTxConfig,
} from "../server/index.js";
import {
  buildTestCtx,
  req,
  seedCronoton,
  type TestHarness,
} from "../../tests/handlers/harness.js";
import {
  simulateCodexTx,
  executeNow,
  triggerCronoton,
  recoverFire,
} from "./execute.js";
// Triggers evict.ts's own module-eval `registerStepPlanner("ouronet.aqp-evict",
// evictPlanner)` side effect — regression test for a confirmed MEDIUM
// cross-phase-review finding: executeNow's chained-row branch was only ever
// tested with a `mode:'single'` step, never `mode:'planner'`.
import { evictPlanner } from "../server/planners/evict.js";

// A gas payer that self-heals to a signable set (codex address → one pure
// signer), so a fire runs green through the mock runtime without a gas-station
// signing key. Fixed-payload envelopes reuse it.
const CODEX_GAS_PAYER = { type: "codex" as const, address: "k:abcdef0123456789" };

const CONFIG: CodexTxConfig = {
  chainId: "0",
  gasPrice: 1,
  gasLimit: 1500,
  autoGasLimit: false,
  ttl: 600,
};

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    pactCode: '(coin.transfer "a" "b" 1.0)',
    config: CONFIG,
    payload: {},
    gasPayer: CODEX_GAS_PAYER,
    signers: [],
    ...overrides,
  };
}

// A 43-char request key inside the ^[A-Za-z0-9_-]{40,48}$ window.
const VALID_REQUEST_KEY = "Qm7xZ0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2y";

beforeAll(() => {
  registerServerResolver("exec-test-single", {
    kind: "single-tx",
    // Three plan entries → plannedCount 3; non-empty → not postponed.
    resolve: () => ({ plan: [{ a: 1 }, { b: 2 }, { c: 3 }], payload: { resolved: "yes" } }),
    settle: () => {},
  });
  registerServerResolver("exec-test-multi", {
    kind: "multi-tx",
    run: async () => ({ batches: [] }),
  });
});

describe("simulateCodexTx", () => {
  let h: TestHarness;
  afterEach(() => h?.close());

  it("returns HTTP 200 with ok:false when the dirty-read fails (failure rides in the body)", async () => {
    h = buildTestCtx();
    h.runtime.dirtyRead.mockResolvedValueOnce({
      result: { status: "failure", error: { message: "row read pact error" } },
      gas: 0,
    });
    const res = await simulateCodexTx(h.ctx, req({ confirmed: true, body: { envelope: envelope() } }));
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(false);
    expect((res.body as { error?: string }).error).toContain("row read pact error");
  });

  it("returns 200 ok:true with chainData projected from rawResult.data on a clean simulate", async () => {
    h = buildTestCtx();
    const res = await simulateCodexTx(h.ctx, req({ confirmed: true, body: { envelope: envelope() } }));
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    // The mock dirty-read returns { status:'success', data:'OK' } → chainData is the pretty data.
    expect((res.body as { chainData?: unknown }).chainData).toBe("OK");
  });

  it("passes plannedCount (plan length) and postponed through for a registered single-tx resolver", async () => {
    h = buildTestCtx();
    const res = await simulateCodexTx(
      h.ctx,
      req({ confirmed: true, body: { envelope: envelope({ serverResolver: "exec-test-single" }) } }),
    );
    expect(res.status).toBe(200);
    // plannedCount is derived generically from the resolver's plan length (3), never a resolver name.
    expect((res.body as { plannedCount?: number }).plannedCount).toBe(3);
    expect((res.body as { postponed?: boolean }).postponed).toBe(false);
  });

  it("blocks with 401 admin_confirm_required when no fresh confirm accompanies the request", async () => {
    h = buildTestCtx();
    const res = await simulateCodexTx(h.ctx, req({ body: { envelope: envelope() } }));
    expect(res).toEqual({ status: 401, body: { error: "admin_confirm_required" } });
  });
});

/** Seed a single `mode:'single'` step for a chained cronoton, mirroring `runs-driver.test.ts`'s `insertSingleStep` fixture — a signable definition the real executor can build without throwing. */
function seedSingleStep(h: TestHarness, cronotonId: string): void {
  insertStep(
    {
      codexCronotonId: cronotonId,
      stepIndex: 0,
      mode: "single",
      pactCode: '(coin.transfer "a" "b" 1.0)',
      config: CONFIG,
      payload: {},
      gasPayer: CODEX_GAS_PAYER,
      signers: [],
    },
    { db: h.db },
  );
}

describe("executeNow", () => {
  let h: TestHarness;
  afterEach(() => h?.close());

  it("fires a one-time row, records exactly one success fire, and applies the terminal transition", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db, { gasPayer: CODEX_GAS_PAYER });

    const res = await executeNow(h.ctx, req({ confirmed: true, params: { id } }));

    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect((res.body as { requestKey?: string }).requestKey).toBe("RK-TEST");

    const fires = h.db
      .prepare("SELECT status FROM codex_cronoton_fires WHERE codex_cronoton_id = ?")
      .all(id) as Array<{ status: string }>;
    expect(fires).toHaveLength(1);
    expect(fires[0].status).toBe("success");

    // One-time success → the terminal intent flips the row to 'completed'.
    expect(getCodexCronoton(id, { db: h.db })?.status).toBe("completed");
  });

  it("records a failure fire (still HTTP 200, ok:false) when the fire cannot be built", async () => {
    h = buildTestCtx();
    // A gas-station gas payer with no signing key makes the fire fail structurally.
    const { id } = seedCronoton(h.db, { gasPayer: { type: "gas-station" } });

    const res = await executeNow(h.ctx, req({ confirmed: true, params: { id } }));

    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(false);
    const fires = h.db
      .prepare("SELECT status FROM codex_cronoton_fires WHERE codex_cronoton_id = ?")
      .all(id) as Array<{ status: string }>;
    expect(fires).toHaveLength(1);
    expect(fires[0].status).toBe("failure");
  });

  it("returns 202 queued for a registered multi-tx resolver WITHOUT firing inline", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db, { serverResolver: "exec-test-multi" });

    const res = await executeNow(h.ctx, req({ confirmed: true, params: { id } }));

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, queued: true });
    // The multi-tx branch returns BEFORE any inline fire → no fire row written.
    const count = h.db
      .prepare("SELECT COUNT(*) AS c FROM codex_cronoton_fires WHERE codex_cronoton_id = ?")
      .get(id) as { c: number };
    expect(count.c).toBe(0);
  });

  it("fires an event-driven (scheduler-off, next_fire_at NULL) server-resolver row on demand", async () => {
    h = buildTestCtx();
    // An event-driven server-resolver cronoton commits scheduler-off: the store
    // stores next_fire_at = NULL so the tick loop's due-query never selects it.
    const { id, nextFireAt } = seedCronoton(h.db, {
      serverResolver: "exec-test-single",
      eventDriven: true,
      gasPayer: CODEX_GAS_PAYER,
    });
    // Precondition: the row really is scheduler-off — if this were non-null the
    // test wouldn't be exercising the event-driven path at all.
    expect(nextFireAt).toBeNull();

    const res = await executeNow(h.ctx, req({ confirmed: true, params: { id } }));

    // A host-initiated executeNow fires it regardless of the NULL schedule: the
    // regression this guards is executeNow/fireByServerResolver gaining a
    // next_fire_at gate that would silently drop event-driven rows.
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    const fires = h.db
      .prepare("SELECT status FROM codex_cronoton_fires WHERE codex_cronoton_id = ?")
      .all(id) as Array<{ status: string }>;
    expect(fires).toHaveLength(1);
    expect(fires[0].status).toBe("success");
  });

  it("returns 404 for an unknown cronoton id", async () => {
    h = buildTestCtx();
    const res = await executeNow(h.ctx, req({ confirmed: true, params: { id: "does-not-exist" } }));
    expect(res.status).toBe(404);
  });

  it("returns 400 for a paused row (a paused cronoton cannot be fired on demand)", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db, { gasPayer: CODEX_GAS_PAYER });
    h.db.prepare("UPDATE codex_cronotons SET status = 'paused' WHERE id = ?").run(id);
    const res = await executeNow(h.ctx, req({ confirmed: true, params: { id } }));
    expect(res.status).toBe(400);
  });

  it("starts a real run for a chained row (>=1 step) instead of firing inline or 202-queuing", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db, { gasPayer: CODEX_GAS_PAYER });
    seedSingleStep(h, id);

    const res = await executeNow(h.ctx, req({ confirmed: true, params: { id } }));

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; runId?: string; status?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.runId).toBe("string");
    expect(body.runId?.length).toBeGreaterThan(0);
    // The mock chain client has no pollRequestKeys, so a single-step run's
    // one leg lands in 'submitted' and stays non-terminal at 'planning' —
    // driveRunOnce never flips status itself (only markRunTerminal does);
    // 'awaiting'/'advancing' are documented status values (schema.ts,
    // design.md §A) this driver pass just doesn't reach in this fixture.
    expect(["planning", "awaiting", "advancing", "succeeded", "failed"]).toContain(body.status);

    // Proves driveRunOnce actually ran (not just createRun): at least one leg
    // was built and inserted for the run.
    const legs = listRunLegs(body.runId as string, { db: h.db });
    expect(legs.length).toBeGreaterThan(0);
  });

  // `try_single_tx_first` + custom single-tx mode (docs/work/khronoton-single-tx-custom):
  // `attemptSingleTxFirst` is consulted BEFORE the chained/plain decision above —
  // these three cases prove the manual-trigger branch wires it in exactly as T3
  // wires it into the scheduler tick, adapted to executeNow's HTTP response shape.
  // The top-level row's pact code is deliberately DIFFERENT from the fallback
  // step's. The harness's mock `universalSignTransaction` normally clobbers the
  // built tx's `cmd` to a fixed "SIGNED" placeholder (see harness.ts) — pass it
  // through unchanged instead, so a test can tell which definition a given
  // `dirtyRead` call actually simulated/fired by its `cmd`.
  const SINGLE_TX_PACT_CODE = "(+ 1 1)";

  function seedSingleTxFirstChained(h: TestHarness): { id: string } {
    const { id } = seedCronoton(h.db, { gasPayer: CODEX_GAS_PAYER, pactCode: SINGLE_TX_PACT_CODE });
    seedSingleStep(h, id);
    editCodexCronoton(id, { trySingleTxFirst: true, singleTxMode: "custom" }, { db: h.db });
    h.runtime.universalSignTransaction.mockImplementation(async (tx: unknown) => ({
      cmd: (tx as { cmd?: string }).cmd,
      sigs: [{ sig: "x" }],
    }));
    return { id };
  }

  it("fires the single-tx variant inline (200 ok:true, fireId/requestKey) and never creates a run, when try_single_tx_first is on and the variant fits under the gas ceiling", async () => {
    h = buildTestCtx();
    const { id } = seedSingleTxFirstChained(h);

    const res = await executeNow(h.ctx, req({ confirmed: true, params: { id } }));

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; fireId?: string; requestKey?: string };
    expect(body.ok).toBe(true);
    expect(body.fireId).toBeTruthy();
    expect(body.requestKey).toBe("RK-TEST");

    // The row's OWN top-level pact code (the single-tx variant) is what got
    // simulated/fired — never the fallback step's.
    expect(
      (h.runtime.dirtyRead.mock.calls[0]?.[0] as { cmd?: string } | undefined)?.cmd,
    ).toBe(SINGLE_TX_PACT_CODE);

    // The plain one-shot fire path ran — never the chained run machinery.
    const runRows = h.db.prepare("SELECT COUNT(*) AS c FROM codex_cronoton_runs").get() as { c: number };
    expect(runRows.c).toBe(0);
    const fires = h.db
      .prepare("SELECT status FROM codex_cronoton_fires WHERE codex_cronoton_id = ?")
      .all(id) as Array<{ status: string }>;
    expect(fires).toHaveLength(1);
    expect(fires[0].status).toBe("success");
  });

  it("audits the single-tx fire with actor:'ancient' (a review finding caught this attribution silently missing), unlike a scheduler-driven fire's actor:'scheduler'", async () => {
    h = buildTestCtx();
    const { id } = seedSingleTxFirstChained(h);

    await executeNow(h.ctx, req({ confirmed: true, params: { id } }));

    const singleTxCalls = h.onAudit.mock.calls.filter(
      (call: unknown[]) => (call[0] as { action: string }).action === "codex_cronoton.single_tx.fire",
    );
    expect(singleTxCalls).toHaveLength(1);
    expect((singleTxCalls[0][0] as { detail: { actor?: string } }).detail.actor).toBe("ancient");
  });

  it("falls through to the existing chained-run response (200 ok:true, runId/status) when the single-tx variant is refused specifically for exceeding the gas ceiling", async () => {
    h = buildTestCtx();
    const { id } = seedSingleTxFirstChained(h);
    // Over the harness's configured autoGasCeiling (2,000,000) — the executor's
    // own refuse-unmineable signal — for the single-tx SIMULATE call only; the
    // chain's own step execution below falls back to the default (fits) mock.
    h.runtime.dirtyRead.mockResolvedValueOnce({
      result: { status: "success", data: "OK" },
      gas: 3_000_000,
    });

    const res = await executeNow(h.ctx, req({ confirmed: true, params: { id } }));

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; runId?: string; status?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.runId).toBe("string");
    expect(body.runId?.length).toBeGreaterThan(0);

    // The FIRST dirtyRead call simulated the single-tx variant (and was the
    // one refused for gas) — the LAST call actually built/fired the fallback
    // step's own definition, proving the chain genuinely ran, not a no-op.
    const calls = h.runtime.dirtyRead.mock.calls as Array<[{ cmd?: string }]>;
    expect(calls[0][0].cmd).toBe(SINGLE_TX_PACT_CODE);
    expect(calls[calls.length - 1][0].cmd).toBe('(coin.transfer "a" "b" 1.0)');

    // The single-tx attempt never fired — no fire row from it, and the chained
    // path drove a real run through the normal step machinery.
    const fires = h.db
      .prepare("SELECT COUNT(*) AS c FROM codex_cronoton_fires WHERE codex_cronoton_id = ?")
      .get(id) as { c: number };
    expect(fires.c).toBe(0);
    const legs = listRunLegs(body.runId as string, { db: h.db });
    expect(legs.length).toBeGreaterThan(0);
  });

  // NOTE: the error genuinely propagates OUT of attemptSingleTxFirst/executeNow's
  // handler body as a real thrown Error — it is NOT caught-and-converted by
  // anything this task added. It surfaces as HTTP 500 because `withConfirm`'s
  // shared `runGated` wrapper (context.ts, every mutate-tier handler in this
  // file) already catches and maps ANY thrown error via `mapStoreError`'s
  // generic fallback — the same thing that would happen to any other
  // unexpected error thrown from this handler today. This is NOT a new
  // catch-and-convert added for this feature, just the pre-existing shared one.
  it("surfaces a genuine non-gas simulate failure as a real error (HTTP 500, never silently falling back to the chain)", async () => {
    h = buildTestCtx();
    const { id } = seedSingleTxFirstChained(h);
    h.runtime.dirtyRead.mockRejectedValueOnce(new Error("node unreachable"));

    const res = await executeNow(h.ctx, req({ confirmed: true, params: { id } }));

    expect(res.status).toBe(500);
    expect((res.body as { error?: string }).error).toContain("node unreachable");

    // Exactly the single-tx simulate's own dirtyRead ran — the chain was never
    // reached at all (not merely "reached but produced no rows").
    expect(h.runtime.dirtyRead).toHaveBeenCalledTimes(1);

    // Neither path recorded anything — the error surfaced before any
    // fire/run bookkeeping ran.
    const runRows = h.db.prepare("SELECT COUNT(*) AS c FROM codex_cronoton_runs").get() as { c: number };
    expect(runRows.c).toBe(0);
    const fires = h.db
      .prepare("SELECT COUNT(*) AS c FROM codex_cronoton_fires WHERE codex_cronoton_id = ?")
      .get(id) as { c: number };
    expect(fires.c).toBe(0);
  });

  it("returns 409 with a clear error when a run is already in flight for the chained cronoton, never throwing out of the handler", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db, { gasPayer: CODEX_GAS_PAYER });
    seedSingleStep(h, id);

    // The mock runtime's client has no pollRequestKeys, so driveRunOnce's leg
    // never confirms — the first call's run is left non-terminal.
    const first = await executeNow(h.ctx, req({ confirmed: true, params: { id } }));
    expect(first.status).toBe(200);

    const second = await executeNow(h.ctx, req({ confirmed: true, params: { id } }));

    expect(second.status).toBe(409);
    expect((second.body as { error: string }).error).toMatch(/already in flight/);
  });

  it("audits codex_cronoton.run_started exactly once for a chained row's executeNow", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db, { gasPayer: CODEX_GAS_PAYER });
    seedSingleStep(h, id);

    await executeNow(h.ctx, req({ confirmed: true, params: { id } }));

    const runStartedCalls = h.onAudit.mock.calls.filter(
      (call: unknown[]) => (call[0] as { action: string }).action === "codex_cronoton.run_started",
    );
    expect(runStartedCalls).toHaveLength(1);
  });

  it("starts a real run for a chained row whose step is mode:'planner' (wired to the REAL ouronet.aqp-evict planner), not just the simpler mode:'single' case", async () => {
    expect(getStepPlanner("ouronet.aqp-evict")).toBe(evictPlanner);

    h = buildTestCtx();
    const { id } = seedCronoton(h.db, { gasPayer: CODEX_GAS_PAYER });
    const PUB_A = "aa".repeat(32);
    insertStep(
      {
        codexCronotonId: id,
        stepIndex: 0,
        mode: "planner",
        plannerName: "ouronet.aqp-evict",
        plannerParams: { fvtId: "fvt-executenow-planner", patronAccount: "k:patron-executenow-planner" },
        config: CONFIG,
        payload: {},
        gasPayer: { type: "gas-station", gasStationSignerKey: PUB_A },
        signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
      },
      { db: h.db },
    );
    // evictPlanner's own two-probe sequence: plan-read (one entry), then the
    // full-evict probe, comfortably under the gas ceiling.
    h.runtime.dirtyRead
      .mockResolvedValueOnce({
        result: {
          status: "success",
          data: [{ beneficiary: "k:ben-x", scoreEntityType: 1, scoreEntityId: "se-1", rewardDptfId: "dptf-1" }],
        },
      })
      .mockResolvedValueOnce({ result: { status: "success", data: null }, gas: 50_000 });

    const res = await executeNow(h.ctx, req({ confirmed: true, params: { id } }));

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; runId?: string };
    expect(body.ok).toBe(true);
    const legs = listRunLegs(body.runId as string, { db: h.db });
    expect(legs).toHaveLength(1);
    expect(legs[0].status).toBe("submitted");
    const definition = JSON.parse(legs[0].definition_json) as { pactCode: string };
    expect(definition.pactCode).toContain("CC_FullEvictRewards");
  });
});

describe("triggerCronoton", () => {
  let h: TestHarness;
  afterEach(() => h?.close());

  it("fires a runtime-arg row when the supplied args match the declared keys (HTTP 200)", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db, {
      gasPayer: CODEX_GAS_PAYER,
      runtimeArgKeys: ["amount"],
    });

    const res = await triggerCronoton(
      h.ctx,
      req({ confirmed: true, params: { id }, body: { args: { amount: "5" } } }),
    );

    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    const count = h.db
      .prepare("SELECT COUNT(*) AS c FROM codex_cronoton_fires WHERE codex_cronoton_id = ?")
      .get(id) as { c: number };
    expect(count.c).toBe(1);
  });

  it("returns 400 when the supplied args carry an undeclared key", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db, { gasPayer: CODEX_GAS_PAYER, runtimeArgKeys: ["amount"] });

    const res = await triggerCronoton(
      h.ctx,
      req({ confirmed: true, params: { id }, body: { args: { wrongKey: "5" } } }),
    );

    expect(res.status).toBe(400);
    // No fire is recorded when validation rejects.
    const count = h.db
      .prepare("SELECT COUNT(*) AS c FROM codex_cronoton_fires WHERE codex_cronoton_id = ?")
      .get(id) as { c: number };
    expect(count.c).toBe(0);
  });

  it("returns 400 for a row that declares no runtime args (not runtime-arg-fireable)", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db, { gasPayer: CODEX_GAS_PAYER });
    const res = await triggerCronoton(
      h.ctx,
      req({ confirmed: true, params: { id }, body: { args: {} } }),
    );
    expect(res.status).toBe(400);
  });
});

describe("recoverFire", () => {
  let h: TestHarness;
  afterEach(() => h?.close());

  function seedFailureFire(hh: TestHarness, cronotonId: string): string {
    return recordFire(
      {
        codexCronotonId: cronotonId,
        jobId: null,
        firedAt: new Date().toISOString(),
        status: "failure",
        errorMessage: "nginx 504 hid a landed submit",
        definitionFingerprint: "fp-test",
      },
      { db: hh.db },
    );
  }

  it("flips a seeded failure fire to success and returns 200 with the reconciled key", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    const fireId = seedFailureFire(h, id);

    const res = await recoverFire(
      h.ctx,
      req({ confirmed: true, params: { id, fireId }, body: { requestKey: VALID_REQUEST_KEY } }),
    );

    expect(res).toEqual({
      status: 200,
      body: { ok: true, fireId, requestKey: VALID_REQUEST_KEY },
    });
    const fire = h.db
      .prepare("SELECT status, request_key FROM codex_cronoton_fires WHERE id = ?")
      .get(fireId) as { status: string; request_key: string };
    expect(fire.status).toBe("success");
    expect(fire.request_key).toBe(VALID_REQUEST_KEY);
    expect(h.onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "codex_cronoton.fire_recover" }),
    );
  });

  it("returns 404 'No failed fire to recover' when the fire is not in a failure state", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    // A success fire cannot be recovered.
    const fireId = recordFire(
      {
        codexCronotonId: id,
        jobId: null,
        firedAt: new Date().toISOString(),
        status: "success",
        requestKey: "RK-OK",
        definitionFingerprint: "fp-test",
      },
      { db: h.db },
    );

    const res = await recoverFire(
      h.ctx,
      req({ confirmed: true, params: { id, fireId }, body: { requestKey: VALID_REQUEST_KEY } }),
    );

    expect(res).toEqual({ status: 404, body: { error: "No failed fire to recover" } });
  });

  it("returns 400 for a requestKey that fails the ^[A-Za-z0-9_-]{40,48}$ shape", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    const fireId = seedFailureFire(h, id);

    const res = await recoverFire(
      h.ctx,
      req({ confirmed: true, params: { id, fireId }, body: { requestKey: "too-short" } }),
    );

    expect(res.status).toBe(400);
    // A bad-shape key never touches the store — the failure row is untouched.
    const fire = h.db
      .prepare("SELECT status FROM codex_cronoton_fires WHERE id = ?")
      .get(fireId) as { status: string };
    expect(fire.status).toBe("failure");
  });
});
