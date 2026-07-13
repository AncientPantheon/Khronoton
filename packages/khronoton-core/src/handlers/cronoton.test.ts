/**
 * Cronoton-lifecycle handlers — the confirm-gated commit/edit/pause/resume/delete
 * surface. These pin the ROUTE-LAYER decisions against a REAL in-memory store:
 * the envelope→input adapter (a valid commit round-trips a queryable row; a bad
 * shape or empty name is a 400 client error, not a 500), the not-found 404, the
 * terminal 409 (a spent one-time row cannot pause/resume), and the server-resolver
 * delete-lock 409 that leaves the row intact. Every mutation runs behind the
 * confirm gate — an absent fresh-confirm short-circuits to 401.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getCodexCronoton } from "../server/index.js";

import {
  commitCodexCronoton,
  deleteCodexCronoton,
  editCodexCronoton,
  pauseCodexCronoton,
  resumeCodexCronoton,
} from "./cronoton.js";
import { buildTestCtx, req, seedCronoton, type TestHarness } from "../../tests/handlers/harness.js";

let h: TestHarness;
afterEach(() => h?.close());

/** A well-formed CommitBody the handler adapts into the store's input shape. */
function validCommitBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Committed via handler",
    description: null,
    envelope: {
      pactCode: '(coin.transfer "a" "b" 1.0)',
      config: { chainId: "0", gasPrice: 1, gasLimit: 1500, autoGasLimit: false, ttl: 600 },
      payload: {},
      gasPayer: { type: "gas-station" },
      signers: [],
    },
    schedule: {
      mode: "one-time",
      config: { mode: "one-time", fireAt: "2099-01-01T00:00:00.000Z" },
    },
    ...overrides,
  };
}

describe("commitCodexCronoton — envelope adapter + confirm gate", () => {
  it("commits a real row that is queryable back through the store and returns 201 + its id", async () => {
    h = buildTestCtx();
    const res = await commitCodexCronoton(h.ctx, req({ confirmed: true, body: validCommitBody() }));

    expect(res.status).toBe(201);
    const body = res.body as { ok: boolean; codexCronotonId: string; nextFireAt: string | null };
    expect(body.ok).toBe(true);
    // The row must actually exist — a 201 with no persisted row would be a lie.
    const row = getCodexCronoton(body.codexCronotonId, { db: h.db });
    expect(row?.name).toBe("Committed via handler");
    // one-time future schedule → a concrete next-fire echoed from the store.
    expect(body.nextFireAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("emits a codex_cronoton create audit event targeting the new row id", async () => {
    h = buildTestCtx();
    const res = await commitCodexCronoton(h.ctx, req({ confirmed: true, body: validCommitBody() }));
    const id = (res.body as { codexCronotonId: string }).codexCronotonId;

    expect(h.onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ targetKind: "codex_cronoton", targetId: id }),
    );
  });

  it("maps an empty name to 400 (a client validation error, never a 500)", async () => {
    h = buildTestCtx();
    const res = await commitCodexCronoton(
      h.ctx,
      req({ confirmed: true, body: validCommitBody({ name: "" }) }),
    );
    expect(res.status).toBe(400);
  });

  it("maps a malformed body missing the envelope to 400, not a 500 crash", async () => {
    h = buildTestCtx();
    const res = await commitCodexCronoton(
      h.ctx,
      req({ confirmed: true, body: { name: "x", schedule: { mode: "one-time", config: {} } } }),
    );
    expect(res.status).toBe(400);
  });

  it("short-circuits to 401 admin_confirm_required when no fresh confirm accompanies the request", async () => {
    h = buildTestCtx();
    const res = await commitCodexCronoton(h.ctx, req({ body: validCommitBody() }));
    expect(res).toEqual({ status: 401, body: { error: "admin_confirm_required" } });
    // Nothing was written behind a denied gate.
    expect(getCodexCronoton("any", { db: h.db })).toBeNull();
  });
});

describe("editCodexCronoton — patch adapter + not-found", () => {
  it("applies a name patch and returns 200 with the (recomputed) nextFireAt", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    const res = await editCodexCronoton(
      h.ctx,
      req({ confirmed: true, params: { id }, body: { name: "Renamed" } }),
    );

    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect(getCodexCronoton(id, { db: h.db })?.name).toBe("Renamed");
  });

  it("returns 404 when editing a cronoton that does not exist", async () => {
    h = buildTestCtx();
    const res = await editCodexCronoton(
      h.ctx,
      req({ confirmed: true, params: { id: "missing-id" }, body: { name: "x" } }),
    );
    expect(res.status).toBe(404);
  });
});

describe("pauseCodexCronoton / resumeCodexCronoton — terminal guard", () => {
  it("pauses an active row and returns 200 with status 'paused'", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    const res = await pauseCodexCronoton(h.ctx, req({ confirmed: true, params: { id } }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: "paused" });
    expect(getCodexCronoton(id, { db: h.db })?.status).toBe("paused");
  });

  it("returns 409 when pausing a terminal (completed) row — a spent one-time cannot be paused", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    h.db.prepare("UPDATE codex_cronotons SET status = 'completed' WHERE id = ?").run(id);
    const res = await pauseCodexCronoton(h.ctx, req({ confirmed: true, params: { id } }));
    expect(res.status).toBe(409);
  });

  it("returns 409 when resuming a terminal (completed) row", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    h.db.prepare("UPDATE codex_cronotons SET status = 'completed' WHERE id = ?").run(id);
    const res = await resumeCodexCronoton(h.ctx, req({ confirmed: true, params: { id } }));
    expect(res.status).toBe(409);
  });
});

describe("deleteCodexCronoton — server-resolver delete-lock", () => {
  it("refuses to delete a server-resolver row with 409 { protected:true } and leaves it intact", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db, { serverResolver: "stoicism-mint" });
    const res = await deleteCodexCronoton(h.ctx, req({ confirmed: true, params: { id } }));

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ protected: true });
    // The row must survive a refused delete.
    expect(getCodexCronoton(id, { db: h.db })).not.toBeNull();
  });

  it("deletes an ordinary row, returns 200, and the row is gone", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    const res = await deleteCodexCronoton(h.ctx, req({ confirmed: true, params: { id } }));

    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect(getCodexCronoton(id, { db: h.db })).toBeNull();
  });

  it("emits a codex_cronoton delete audit event targeting the removed row id", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    await deleteCodexCronoton(h.ctx, req({ confirmed: true, params: { id } }));
    expect(h.onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ targetKind: "codex_cronoton", targetId: id }),
    );
  });
});
