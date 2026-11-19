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
