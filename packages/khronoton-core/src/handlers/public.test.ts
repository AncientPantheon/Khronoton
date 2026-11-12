/**
 * `publicCronotonHandler` — the unauthenticated-by-design public observability
 * route. Pins the three-way 404/404/200 token resolution (an unknown token and
 * a known-but-non-observable token must be INDISTINGUISHABLE, per the design's
 * "never 403, never leak which" rule), proves the handler never touches
 * `ctx.auth` at all (a context whose auth seam unconditionally blocks still
 * returns 200 for an observable token), and pins the same defensive
 * limit/offset clamping convention as `read.ts`'s `firesHandler` (1..100,
 * default 50) across a full 150-fire pagination sweep.
 */
import { describe, it, expect, afterEach } from "vitest";

import { recordFire, setPublicObservable } from "../server/index.js";

import { buildTestCtx, req, seedCronoton, type TestHarness } from "../../tests/handlers/harness.js";
import type { AuthResult, AuthSeam } from "./context.js";
import { publicCronotonHandler } from "./public.js";

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

/** An auth seam whose BOTH gates unconditionally block with 403 — proves a bypass is real. */
const alwaysBlockAuth: AuthSeam = {
  requireRead: (): AuthResult => ({ ok: false, response: { status: 403, body: { error: "blocked" } } }),
  requireConfirm: (): AuthResult => ({ ok: false, response: { status: 403, body: { error: "blocked" } } }),
};

describe("publicCronotonHandler — unknown/non-observable token (identical 404)", () => {
  it("returns 404 { error: 'not found' } for a token that resolves to no row", async () => {
    h = buildTestCtx();

    const res = await publicCronotonHandler(h.ctx, req({ params: { token: "no-such-token" } }));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not found" });
  });

  it("returns the IDENTICAL 404 shape for a known token whose row is non-observable", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    const { publicToken } = setPublicObservable(id, { observable: true }, { db: h.db });
    // Flip back off — the token still exists in the column but the row is no longer observable.
    setPublicObservable(id, { observable: false }, { db: h.db });

    const res = await publicCronotonHandler(h.ctx, req({ params: { token: publicToken! } }));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not found" });
  });
});

describe("publicCronotonHandler — known observable token", () => {
  it("returns 200 with a toPublicCronotonView-shaped body", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db, { name: "Stoicism Minter" });
    const { publicToken } = setPublicObservable(id, { observable: true }, { db: h.db });
    seedFires(h.db, id, 3);

    const res = await publicCronotonHandler(h.ctx, req({ params: { token: publicToken! } }));

    expect(res.status).toBe(200);
    const body = res.body as {
      ok: boolean;
      name: string;
      status: string;
      counts: { fired: number };
      fires: { page: unknown[]; total: number; limit: number; offset: number };
    };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("Stoicism Minter");
    expect(body.counts.fired).toBe(3);
    expect(body.fires.total).toBe(3);
    expect(body.fires.page).toHaveLength(3);
    // The sanitized view never carries the internal row id or raw pact code.
    expect(JSON.stringify(body)).not.toContain(id);
  });

  it("still returns 200 when ctx.auth unconditionally blocks both gates (bypass is real, not coincidental)", async () => {
    h = buildTestCtx({ auth: alwaysBlockAuth });
    const { id } = seedCronoton(h.db);
    const { publicToken } = setPublicObservable(id, { observable: true }, { db: h.db });

    const res = await publicCronotonHandler(h.ctx, req({ params: { token: publicToken! } }));

    expect(res.status).toBe(200);
  });
});

describe("publicCronotonHandler — malformed data degrades gracefully, never a raw throw", () => {
  it("returns 200 with chainResponse omitted (not a 500) for a fire row with malformed chain_response_json", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    const { publicToken } = setPublicObservable(id, { observable: true }, { db: h.db });
    // fires.ts's listFires guards this parse (parseChainResponse degrades to
    // null on malformed input, matching its sibling parseTxKeys's existing
    // try/catch) — so a corrupted/legacy row no longer throws at all, and
    // this route's own catch/mapStoreError safety net (below) never even has
    // to run for this particular case anymore.
    h.db
      .prepare(
        `INSERT INTO codex_cronoton_fires (id, codex_cronoton_id, fired_at, status, chain_response_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("fire-malformed", id, "2026-01-01T00:00:00.000Z", "success", "SECRET_LEAK_not_valid_json");

    const res = await publicCronotonHandler(h.ctx, req({ params: { token: publicToken! } }));

    expect(res.status).toBe(200);
    // The public per-fire view never carries chainResponse at all (see
    // PublicCronotonFireView) — but belt-and-suspenders, confirm the raw
    // malformed string never rides out through any path.
    expect(JSON.stringify(res.body)).not.toContain("SECRET_LEAK");
  });
});

describe("publicCronotonHandler — thrown-error translation (no withRead/withConfirm safety net to lean on)", () => {
  it("returns a structured 500 via mapStoreError when the underlying store throws unexpectedly, instead of throwing uncaught", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    const { publicToken } = setPublicObservable(id, { observable: true }, { db: h.db });
    // This handler deliberately never runs inside withRead/withConfirm (that
    // would reintroduce the ctx.auth call it exists to bypass), so it owns
    // its own try/catch -> mapStoreError instead. Proven here generically
    // (a closed db handle — ANY query against it throws) rather than tied to
    // one specific now-fixed store bug, since the whole point of this
    // safety net is to catch WHATEVER unexpectedly throws, not just the one
    // case that prompted adding it.
    h.db.close();

    const res = await publicCronotonHandler(h.ctx, req({ params: { token: publicToken! } }));

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });
});

describe("publicCronotonHandler — limit/offset clamping (matches read.ts's firesHandler bounds)", () => {
  it("defaults limit to 50 and clamps an over-large limit to 100", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    const { publicToken } = setPublicObservable(id, { observable: true }, { db: h.db });
    seedFires(h.db, id, 5);

    const defaulted = (await publicCronotonHandler(h.ctx, req({ params: { token: publicToken! } })))
      .body as { fires: { limit: number } };
    expect(defaulted.fires.limit).toBe(50);

    const overLarge = (
      await publicCronotonHandler(h.ctx, req({ params: { token: publicToken! }, query: { limit: "500" } }))
    ).body as { fires: { limit: number } };
    expect(overLarge.fires.limit).toBe(100);
  });

  it("falls back to the default 50 when limit is non-numeric garbage", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    const { publicToken } = setPublicObservable(id, { observable: true }, { db: h.db });

    const res = (
      await publicCronotonHandler(h.ctx, req({ params: { token: publicToken! }, query: { limit: "not-a-number" } }))
    ).body as { fires: { limit: number } };
    expect(res.fires.limit).toBe(50);
  });

  it("clamps a negative offset to 0 and falls back to the default 0 for non-numeric offset garbage", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    const { publicToken } = setPublicObservable(id, { observable: true }, { db: h.db });
    seedFires(h.db, id, 5);

    const negative = (
      await publicCronotonHandler(h.ctx, req({ params: { token: publicToken! }, query: { offset: "-5" } }))
    ).body as { fires: { offset: number } };
    expect(negative.fires.offset).toBe(0);

    const garbage = (
      await publicCronotonHandler(h.ctx, req({ params: { token: publicToken! }, query: { offset: "not-a-number" } }))
    ).body as { fires: { offset: number } };
    expect(garbage.fires.offset).toBe(0);
  });

  it("pages through 150 fires via increasing offset with no duplicates/gaps, total always 150", async () => {
    h = buildTestCtx();
    const { id } = seedCronoton(h.db);
    const { publicToken } = setPublicObservable(id, { observable: true }, { db: h.db });
    seedFires(h.db, id, 150);

    const windows = await Promise.all(
      [0, 50, 100].map((offset) =>
        publicCronotonHandler(
          h.ctx,
          req({ params: { token: publicToken! }, query: { limit: "50", offset: String(offset) } }),
        ),
      ),
    );

    const seen = new Set<string>();
    for (const res of windows) {
      const body = res.body as {
        fires: { page: Array<{ firedAt: string }>; total: number; limit: number; offset: number };
      };
      expect(body.fires.total).toBe(150);
      expect(body.fires.page).toHaveLength(50);
      for (const fire of body.fires.page) {
        expect(seen.has(fire.firedAt)).toBe(false);
        seen.add(fire.firedAt);
      }
    }
    expect(seen.size).toBe(150);
  });
});
