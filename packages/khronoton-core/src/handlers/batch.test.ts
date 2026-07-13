/**
 * Manual-batch handler group — the confirm-vs-read tier split that makes the
 * "Execute ×N" stop path one-click.
 *
 * These pin three decisions the route surface promises: START is confirm-gated
 * (a mutation that spends chain gas N times, so it demands a fresh admin-confirm
 * → 401 without one), while GET and CANCEL are DELIBERATELY confirm-free
 * (read-gated, REQ-H09) so an operator can watch or stop a runaway batch with a
 * single click even when no fresh confirm is on hand. Cancel is idempotent. The
 * count bounds / already-active guards ride through as the store's typed errors
 * mapped to 400/409.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createManualBatch } from "../server/index.js";
import {
  buildTestCtx,
  confirmRequiredAuth,
  req,
  seedCronoton,
  type TestHarness,
} from "../../tests/handlers/harness.js";
import { cancelExecuteBatch, getExecuteBatch, startExecuteBatch } from "./batch.js";

/** A recurring cronoton — one-time rows are rejected by createManualBatch. */
const RECURRING = {
  scheduleMode: "every-n-minutes" as const,
  scheduleConfig: {
    mode: "every-n-minutes" as const,
    startDate: "2020-01-01T00:00:00.000Z",
    intervalMinutes: 5,
  },
};

describe("startExecuteBatch", () => {
  let h: TestHarness;
  beforeEach(() => (h = buildTestCtx()));
  afterEach(() => h.close());

  it("starts a batch of the requested count and returns its active ManualBatchView", async () => {
    const { id } = seedCronoton(h.db, RECURRING);

    const res = await startExecuteBatch(h.ctx, req({ params: { id }, body: { count: 5 }, confirmed: true }));

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; batch: { codexCronotonId: string; total: number; remaining: number; status: string } };
    expect(body.ok).toBe(true);
    expect(body.batch.codexCronotonId).toBe(id);
    expect(body.batch.total).toBe(5);
    expect(body.batch.remaining).toBe(5);
    expect(body.batch.status).toBe("active");
  });

  it("demands a fresh confirm: a request without `confirmed` short-circuits 401 before any batch is written", async () => {
    const { id } = seedCronoton(h.db, RECURRING);

    const res = await startExecuteBatch(h.ctx, req({ params: { id }, body: { count: 5 } }));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "admin_confirm_required" });
  });

  it("maps a second concurrent batch to 409 (ManualBatchActiveError) — only one runs at a time", async () => {
    const { id } = seedCronoton(h.db, RECURRING);
    createManualBatch({ cronotonId: id, total: 5, createdBy: "admin@x" }, { db: h.db });

    const res = await startExecuteBatch(h.ctx, req({ params: { id }, body: { count: 5 }, confirmed: true }));

    expect(res.status).toBe(409);
  });

  it("maps a below-minimum count (1) to 400 via the store's bounds validation", async () => {
    const { id } = seedCronoton(h.db, RECURRING);

    const res = await startExecuteBatch(h.ctx, req({ params: { id }, body: { count: 1 }, confirmed: true }));

    expect(res.status).toBe(400);
  });

  it("maps an above-maximum count (61) to 400 via the store's bounds validation", async () => {
    const { id } = seedCronoton(h.db, RECURRING);

    const res = await startExecuteBatch(h.ctx, req({ params: { id }, body: { count: 61 }, confirmed: true }));

    expect(res.status).toBe(400);
  });
});

describe("getExecuteBatch", () => {
  let h: TestHarness;
  beforeEach(() => (h = buildTestCtx()));
  afterEach(() => h.close());

  it("returns the active batch view when one is running", async () => {
    const { id } = seedCronoton(h.db, RECURRING);
    createManualBatch({ cronotonId: id, total: 4, createdBy: "admin@x" }, { db: h.db });

    const res = await getExecuteBatch(h.ctx, req({ params: { id } }));

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; batch: { total: number; status: string } | null };
    expect(body.ok).toBe(true);
    expect(body.batch?.total).toBe(4);
    expect(body.batch?.status).toBe("active");
  });

  it("returns batch:null when no batch is active for the cronoton", async () => {
    const { id } = seedCronoton(h.db, RECURRING);

    const res = await getExecuteBatch(h.ctx, req({ params: { id } }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, batch: null });
  });

  it("is read-gated, NOT confirm-gated: it resolves under a confirm-denying seam with no `confirmed` flag", async () => {
    const denyConfirm = buildTestCtx({ auth: confirmRequiredAuth });
    const { id } = seedCronoton(denyConfirm.db, RECURRING);
    createManualBatch({ cronotonId: id, total: 3, createdBy: "admin@x" }, { db: denyConfirm.db });

    const res = await getExecuteBatch(denyConfirm.ctx, req({ params: { id } }));

    expect(res.status).toBe(200);
    expect((res.body as { batch: { total: number } | null }).batch?.total).toBe(3);
    denyConfirm.close();
  });
});

describe("cancelExecuteBatch", () => {
  let h: TestHarness;
  beforeEach(() => (h = buildTestCtx()));
  afterEach(() => h.close());

  it("cancels an active batch → 200 { cancelled: true }", async () => {
    const { id } = seedCronoton(h.db, RECURRING);
    createManualBatch({ cronotonId: id, total: 5, createdBy: "admin@x" }, { db: h.db });

    const res = await cancelExecuteBatch(h.ctx, req({ params: { id } }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cancelled: true });
  });

  it("is idempotent: cancelling an already-cancelled batch returns cancelled:false", async () => {
    const { id } = seedCronoton(h.db, RECURRING);
    createManualBatch({ cronotonId: id, total: 5, createdBy: "admin@x" }, { db: h.db });

    await cancelExecuteBatch(h.ctx, req({ params: { id } }));
    const second = await cancelExecuteBatch(h.ctx, req({ params: { id } }));

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, cancelled: false });
  });

  it("is confirm-FREE (one-click stop, REQ-H09): it cancels under a confirm-denying seam with no `confirmed` flag", async () => {
    const denyConfirm = buildTestCtx({ auth: confirmRequiredAuth });
    const { id } = seedCronoton(denyConfirm.db, RECURRING);
    createManualBatch({ cronotonId: id, total: 5, createdBy: "admin@x" }, { db: denyConfirm.db });

    const res = await cancelExecuteBatch(denyConfirm.ctx, req({ params: { id } }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cancelled: true });
    denyConfirm.close();
  });
});
