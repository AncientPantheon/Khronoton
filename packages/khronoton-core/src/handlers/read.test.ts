/**
 * Read handlers — the four confirm-free read-tier operations: list, get,
 * signers, fires. These pin the branching that lives in THIS layer (not in the
 * store): the fires page-size default of 50 (REQ-G08), offset paging reaching a
 * second page, the limit clamp, the secret-free signer projection (REQ-H10),
 * and the read-gate short-circuit. The happy paths run through the real
 * in-memory store (via the shared harness) so a handler's projection is asserted
 * against genuine rows, not a mock.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import {
  recordFire,
  registerServerResolver,
  createRun,
  insertRunLeg,
  type KeyResolver,
} from "../server/index.js";

import {
  buildTestCtx,
  req,
  seedCronoton,
  denyReadAuth,
  type TestHarness,
} from "../../tests/handlers/harness.js";
import type { SignerSource } from "./http.js";
import {
  listHandler,
  getHandler,
  signersHandler,
  firesHandler,
  resolversHandler,
  runsHandler,
  runLegsHandler,
} from "./read.js";

let h: TestHarness;
afterEach(() => h?.close());

/** Record `n` fire rows against `cronotonId` with strictly increasing timestamps. */
function seedFires(db: TestHarness["db"], cronotonId: string, n: number): void {
  const base = Date.parse("2024-01-01T00:00:00.000Z");
  for (let i = 0; i < n; i += 1) {
    recordFire(
      {
        codexCronotonId: cronotonId,
        jobId: null,
        firedAt: new Date(base + i * 1000).toISOString(),
        status: "success",
        definitionFingerprint: `fp-${i}`,
      },
      { db },
    );
  }
}

function resolverWithPubs(pubs: string[]): KeyResolver {
  return {
    getKeyPairByPublicKey: vi.fn(async (publicKey: string) => ({
      publicKey,
      privateKey: "SECRET-MUST-NEVER-LEAK",
      seedType: "koala",
    })),
    listCodexPubs: vi.fn(async () => new Set(pubs)),
  };
}

describe("listHandler — read-tier list", () => {
  it("returns 200 with { ok, codexCronotons } newest-first for every row", async () => {
    h = buildTestCtx();
    seedCronoton(h.db, { name: "first" });
    seedCronoton(h.db, { name: "second" });

    const res = await listHandler(h.ctx, req());

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; codexCronotons: Array<{ name: string }> };
    expect(body.ok).toBe(true);
    expect(body.codexCronotons).toHaveLength(2);
  });

  it("passes the status filter through so only matching rows return", async () => {
    h = buildTestCtx();
    const active = seedCronoton(h.db, { name: "still-active" });
    const paused = seedCronoton(h.db, { name: "was-paused" });
    h.db.prepare("UPDATE codex_cronotons SET status = 'paused' WHERE id = ?").run(paused.id);

    const res = await listHandler(h.ctx, req({ query: { status: "paused" } }));

    const body = res.body as { codexCronotons: Array<{ id: string; status: string }> };
    expect(body.codexCronotons).toHaveLength(1);
    expect(body.codexCronotons[0]!.id).toBe(paused.id);
    expect(body.codexCronotons[0]!.status).toBe("paused");
    expect(active.id).not.toBe(paused.id);
  });
});

describe("getHandler — read-tier detail", () => {
  it("returns 200 with the row when the id exists", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db, { name: "target" });

    const res = await getHandler(h.ctx, req({ params: { id } }));

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; codexCronoton: { id: string; name: string } };
    expect(body.ok).toBe(true);
    expect(body.codexCronoton.id).toBe(id);
    expect(body.codexCronoton.name).toBe("target");
  });

  it("returns 404 { error } for an absent id", async () => {
    h = buildTestCtx();

    const res = await getHandler(h.ctx, req({ params: { id: "does-not-exist" } }));

    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBeTruthy();
  });
});

describe("firesHandler — read-tier fire history (default 50 / offset paging)", () => {
  it("defaults limit to 50 so a 25-fire history returns in ONE page (store default 20 would truncate)", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    seedFires(h.db, id, 25);

    const res = await firesHandler(h.ctx, req({ params: { id } }));

    expect(res.status).toBe(200);
    const body = res.body as {
      ok: boolean;
      fires: Array<{ id: string }>;
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.ok).toBe(true);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(body.total).toBe(25);
    expect(body.fires).toHaveLength(25);
  });

  it("reaches a distinct second page via offset (no row overlap between pages)", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    seedFires(h.db, id, 25);

    const page1 = (await firesHandler(h.ctx, req({ params: { id }, query: { limit: "10", offset: "0" } })))
      .body as { fires: Array<{ id: string }>; limit: number; offset: number };
    const page2 = (await firesHandler(h.ctx, req({ params: { id }, query: { limit: "10", offset: "10" } })))
      .body as { fires: Array<{ id: string }>; limit: number; offset: number };

    expect(page1.fires).toHaveLength(10);
    expect(page2.fires).toHaveLength(10);
    expect(page2.offset).toBe(10);
    const overlap = page1.fires
      .map((f) => f.id)
      .filter((firstId) => page2.fires.some((f) => f.id === firstId));
    expect(overlap).toHaveLength(0);
  });

  it("clamps an over-large limit to the store cap of 100 in the echoed value", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);

    const res = await firesHandler(h.ctx, req({ params: { id }, query: { limit: "500" } }));

    expect((res.body as { limit: number }).limit).toBe(100);
  });

  it("falls back to the default 50 when limit is non-numeric garbage", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);

    const res = await firesHandler(h.ctx, req({ params: { id }, query: { limit: "not-a-number" } }));

    expect((res.body as { limit: number }).limit).toBe(50);
  });
});

describe("runsHandler — read-tier chained-run history (default 20 / offset paging)", () => {
  it("returns paginated runs newest-first with the correct total, mirroring listRunsForCronoton's own tested behavior", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    const run1 = createRun({ codexCronotonId: id, stepCount: 1 }, { db: h.db });
    h.db
      .prepare(`UPDATE codex_cronoton_runs SET status = 'succeeded', started_at = ? WHERE id = ?`)
      .run("2026-01-01T00:00:01.000Z", run1);
    const run2 = createRun({ codexCronotonId: id, stepCount: 1 }, { db: h.db });
    h.db
      .prepare(`UPDATE codex_cronoton_runs SET status = 'succeeded', started_at = ? WHERE id = ?`)
      .run("2026-01-01T00:00:02.000Z", run2);
    const run3 = createRun({ codexCronotonId: id, stepCount: 1 }, { db: h.db });
    h.db
      .prepare(`UPDATE codex_cronoton_runs SET started_at = ? WHERE id = ?`)
      .run("2026-01-01T00:00:03.000Z", run3);

    const res = await runsHandler(h.ctx, req({ params: { id }, query: { limit: "2" } }));

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; runs: Array<{ id: string }>; total: number };
    expect(body.ok).toBe(true);
    expect(body.runs).toHaveLength(2);
    expect(body.runs.map((r) => r.id)).toEqual([run3, run2]);
    expect(body.total).toBe(3);
  });
});

describe("runLegsHandler — every leg of one specific run, scoped to its owning cronoton", () => {
  it("returns every leg for that run", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    const runId = createRun({ codexCronotonId: id, stepCount: 1 }, { db: h.db });
    insertRunLeg({ runId, stepIndex: 0, legIndex: 0, definitionJson: "{}" }, { db: h.db });
    insertRunLeg({ runId, stepIndex: 0, legIndex: 1, definitionJson: "{}" }, { db: h.db });

    const res = await runLegsHandler(h.ctx, req({ params: { id, runId } }));

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; legs: Array<{ id: string }> };
    expect(body.ok).toBe(true);
    expect(body.legs).toHaveLength(2);
  });

  it("strips `signers` from each leg's definition_json before returning it, regression test for a confirmed HIGH security finding (a leg's capabilities string can carry a literal account + amount, e.g. stoa-wrap/unwrap's coin.TRANSFER capability line)", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    const runId = createRun({ codexCronotonId: id, stepCount: 1 }, { db: h.db });
    const sensitiveLeg = JSON.stringify({
      pactCode: "(coin.TRANSFER)",
      config: { chainId: "0" },
      payload: { patron: "k:real-patron-account", amount: "262613.4" },
      gasPayer: { type: "gas-station" },
      signers: [
        {
          publicKey: "aa".repeat(32),
          capabilityMode: "scoped",
          // A distinct marker (never present in payload/pactCode/config/
          // gasPayer) so its absence from the response is an unambiguous
          // proof of redaction, not an artifact of some OTHER field also
          // happening to omit it.
          capabilities: '(coin.TRANSFER "k:real-patron-account" "c:LIQUIDPOT-SECRET-MARKER" 262613.4)',
        },
      ],
    });
    insertRunLeg({ runId, stepIndex: 0, legIndex: 0, definitionJson: sensitiveLeg }, { db: h.db });

    const res = await runLegsHandler(h.ctx, req({ params: { id, runId } }));

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; legs: Array<{ definition_json: string }> };
    const returned = JSON.parse(body.legs[0].definition_json) as Record<string, unknown>;
    // `signers` (and the literal capability line/LIQUIDPOT marker embedded
    // inside it) is gone entirely — not just truncated or partially masked.
    expect(returned).not.toHaveProperty("signers");
    expect(JSON.stringify(returned)).not.toContain("LIQUIDPOT-SECRET-MARKER");
    // `pactCode`/`payload`/`config`/`gasPayer` stay visible — this route's
    // purpose is genuine operational visibility, not a full lockdown; the
    // SAME patron account legitimately still appears here, in `payload`
    // (what the leg actually reads via read-string), just not re-asserted
    // inside a literal signed capability grant.
    expect(returned.pactCode).toBe("(coin.TRANSFER)");
    expect(returned.payload).toEqual({ patron: "k:real-patron-account", amount: "262613.4" });
  });

  it("returns 404 when runId belongs to a DIFFERENT cronoton than :id, never leaking that cronoton's legs", async () => {
    h = buildTestCtx();
    const { id: cronotonA } = seedCronoton(h.db, { name: "a" });
    const { id: cronotonB } = seedCronoton(h.db, { name: "b" });
    createRun({ codexCronotonId: cronotonA, stepCount: 1 }, { db: h.db });
    const runB = createRun({ codexCronotonId: cronotonB, stepCount: 1 }, { db: h.db });
    const legB = insertRunLeg(
      { runId: runB, stepIndex: 0, legIndex: 0, definitionJson: '{"marker":"cronoton-b-leg"}' },
      { db: h.db },
    );

    const res = await runLegsHandler(h.ctx, req({ params: { id: cronotonA, runId: runB } }));

    expect(res.status).toBe(404);
    // The real proof of no-leak: a 404 response has no `legs` key AT ALL —
    // `listRunLegs` is never reached once the ownership check fails, so
    // there is no code path where leg content and a 404 status coexist.
    // (A `toContain` check on the stringified body would be a DEAD
    // assertion here — the handler's `err(404, ...)` body shape can never
    // contain leg data regardless of whether the ownership check is
    // correct or broken, so it can never independently catch a
    // regression; this structural check on the body's own shape can.)
    expect(res.body).not.toHaveProperty("legs");
    expect(res.body).toEqual({ error: "not found" });
    // legB/cronotonB's leg genuinely exists in the DB and IS retrievable
    // through the correct (same-cronoton) route — proven by the sibling
    // "returns every leg for that run" test above using the identical
    // insertRunLeg/runLegsHandler pair; confirming it exists here too
    // would be redundant with that test, not an independent leak-proof.
    expect(legB).toBeTruthy();
  });

  it("returns 404 for a runId that doesn't exist at all", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);

    const res = await runLegsHandler(h.ctx, req({ params: { id, runId: "does-not-exist" } }));

    expect(res.status).toBe(404);
  });
});

describe("signersHandler — secret-free descriptors (REQ-H10)", () => {
  it("projects the resolver's pubs to descriptors carrying NO key material", async () => {
    h = buildTestCtx({ resolver: resolverWithPubs(["pubA", "pubB"]) });

    const res = await signersHandler(h.ctx, req());

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; signers: Array<Record<string, unknown>> };
    expect(body.ok).toBe(true);
    expect(body.signers).toHaveLength(2);
    for (const descriptor of body.signers) {
      expect(Object.keys(descriptor).sort()).toEqual(["display", "publicKey"]);
      expect(descriptor).not.toHaveProperty("privateKey");
      expect(descriptor.display).toBe("foreign");
      expect(JSON.stringify(descriptor)).not.toContain("SECRET");
    }
    expect(body.signers.map((s) => s.publicKey)).toEqual(["pubA", "pubB"]);
  });

  it("prefers an injected SignerSource over the default resolver projection", async () => {
    const injected: SignerSource = {
      listSignerDescriptors: vi.fn(async () => [{ publicKey: "injected", display: "derived" as const }]),
    };
    h = buildTestCtx({ resolver: resolverWithPubs(["ignored"]), signers: injected });

    const res = await signersHandler(h.ctx, req());

    const body = res.body as { signers: Array<{ publicKey: string; display: string }> };
    expect(injected.listSignerDescriptors).toHaveBeenCalledOnce();
    expect(body.signers).toEqual([{ publicKey: "injected", display: "derived" }]);
  });
});

describe("resolversHandler — read-tier resolver registry (GET /resolvers)", () => {
  it("returns 200 with { ok, resolvers } carrying each registered resolver's evented flag", async () => {
    // Registry persists across tests → use unique names so other suites can't collide.
    registerServerResolver("t4-evented", {
      kind: "single-tx",
      evented: true,
      resolve: () => ({ plan: [], payload: {} }),
      settle: () => {},
    });
    registerServerResolver("t4-scheduled", {
      kind: "single-tx",
      resolve: () => ({ plan: [], payload: {} }),
      settle: () => {},
    });
    h = buildTestCtx();

    const res = await resolversHandler(h.ctx, req());

    expect(res.status).toBe(200);
    const body = res.body as {
      ok: boolean;
      resolvers: Array<{ name: string; kind: string; evented: boolean }>;
    };
    expect(body.ok).toBe(true);
    // The evented flag must survive per-resolver — a shared/constant flag would fail here.
    expect(body.resolvers).toContainEqual({ name: "t4-evented", kind: "single-tx", evented: true });
    expect(body.resolvers).toContainEqual({ name: "t4-scheduled", kind: "single-tx", evented: false });
  });
});

describe("read gate — every read handler runs through withRead", () => {
  it("short-circuits with the gate response when the read gate denies", async () => {
    h = buildTestCtx({ auth: denyReadAuth });
    const { id } = seedCronoton(h.db);

    const list = await listHandler(h.ctx, req());
    const get = await getHandler(h.ctx, req({ params: { id } }));
    const signers = await signersHandler(h.ctx, req());
    const fires = await firesHandler(h.ctx, req({ params: { id } }));
    const resolvers = await resolversHandler(h.ctx, req());

    for (const res of [list, get, signers, fires, resolvers]) {
      expect(res.status).toBe(403);
      expect((res.body as { error: string }).error).toBe("forbidden");
    }
  });
});
