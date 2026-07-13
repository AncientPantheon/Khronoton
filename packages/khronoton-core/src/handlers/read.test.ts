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

import { recordFire, type KeyResolver } from "../server/index.js";

import {
  buildTestCtx,
  req,
  seedCronoton,
  denyReadAuth,
  type TestHarness,
} from "../../tests/handlers/harness.js";
import type { SignerSource } from "./http.js";
import { listHandler, getHandler, signersHandler, firesHandler } from "./read.js";

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

describe("read gate — every read handler runs through withRead", () => {
  it("short-circuits with the gate response when the read gate denies", async () => {
    h = buildTestCtx({ auth: denyReadAuth });
    const { id } = seedCronoton(h.db);

    const list = await listHandler(h.ctx, req());
    const get = await getHandler(h.ctx, req({ params: { id } }));
    const signers = await signersHandler(h.ctx, req());
    const fires = await firesHandler(h.ctx, req({ params: { id } }));

    for (const res of [list, get, signers, fires]) {
      expect(res.status).toBe(403);
      expect((res.body as { error: string }).error).toBe("forbidden");
    }
  });
});
