/**
 * The fetch reference adapter + the shared status→seam mapping it delegates to.
 *
 * These tests pin the CLIENT half of the Phase-C handler contract:
 *  - every seam method issues the exact route/verb/body the host route expects
 *    (so a consumer wiring its routes to `khronoton-core/handlers` matches 1:1);
 *  - confirm-gated methods carry the fresh-confirm signal (a header the host maps
 *    back to `req.confirmed`) while read methods never do;
 *  - the shared status map throws `NeedsConfirmError` for a 401
 *    `admin_confirm_required`, a plain `Error(body.error ?? 'HTTP {status}')` for
 *    any other non-2xx, and returns the body untouched on 2xx — including the
 *    200-on-`ok:false` simulate/execute/trigger path (a chain failure rides in the
 *    body; it is NOT a thrown error).
 */
import { describe, it, expect } from "vitest";

import { NeedsConfirmError } from "./adapter.js";
import { createFetchAdapter, CONFIRMED_HEADER } from "./fetch-adapter.js";
import { parseHandlerResult, type FetchResponse } from "./status-map.js";

const BASE = "/api/admin/codex-cronotons";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A canned fetch response with a JSON body and a status. */
function response(status: number, body: unknown): FetchResponse {
  return {
    status,
    json: async () => body,
  };
}

/**
 * A fake fetch that records the last call and returns a queued response. Every
 * mapping test drives the seam through this so no real network is touched.
 */
function fakeFetch(next: FetchResponse) {
  const calls: RecordedCall[] = [];
  const fn = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    });
    return next;
  };
  return { fn, calls, last: () => calls[calls.length - 1] };
}

describe("createFetchAdapter — routing", () => {
  it("list() GETs the base with no query when unfiltered", async () => {
    const f = fakeFetch(response(200, { ok: true, codexCronotons: [] }));
    const adapter = createFetchAdapter(BASE, { fetch: f.fn });
    await adapter.list();
    expect(f.last().method).toBe("GET");
    expect(f.last().url).toBe(BASE);
  });

  it("get(id) GETs the row by id", async () => {
    const f = fakeFetch(response(200, { ok: true, codexCronoton: {} }));
    await createFetchAdapter(BASE, { fetch: f.fn }).get("c1");
    expect(f.last().method).toBe("GET");
    expect(f.last().url).toBe(`${BASE}/c1`);
  });

  it("fires() GETs the offset-paged fires window with ?limit&offset", async () => {
    const f = fakeFetch(response(200, { ok: true, fires: [], total: 0, limit: 50, offset: 100 }));
    await createFetchAdapter(BASE, { fetch: f.fn }).fires({ id: "c1", limit: 50, offset: 100 });
    expect(f.last().method).toBe("GET");
    expect(f.last().url).toBe(`${BASE}/c1/fires?limit=50&offset=100`);
  });

  it("signers() GETs the signers route", async () => {
    const f = fakeFetch(response(200, { ok: true, signers: [] }));
    await createFetchAdapter(BASE, { fetch: f.fn }).signers();
    expect(f.last().url).toBe(`${BASE}/signers`);
  });

  it("commit() POSTs the CommitBody directly to the base", async () => {
    const f = fakeFetch(response(200, { ok: true, codexCronotonId: "c9", nextFireAt: null }));
    const body = { name: "x", envelope: {}, schedule: {} } as never;
    await createFetchAdapter(BASE, { fetch: f.fn }).commit(body, { confirmed: true });
    expect(f.last().method).toBe("POST");
    expect(f.last().url).toBe(BASE);
    expect(f.last().body).toEqual(body);
  });

  it("edit() PATCHes the patch directly to the row", async () => {
    const f = fakeFetch(response(200, { ok: true, nextFireAt: null }));
    await createFetchAdapter(BASE, { fetch: f.fn }).edit("c1", { name: "new" } as never, { confirmed: true });
    expect(f.last().method).toBe("PATCH");
    expect(f.last().url).toBe(`${BASE}/c1`);
    expect(f.last().body).toEqual({ name: "new" });
  });

  it("pause() and resume() PATCH the lifecycle sub-routes", async () => {
    const f = fakeFetch(response(200, { ok: true, status: "paused", nextFireAt: null }));
    const adapter = createFetchAdapter(BASE, { fetch: f.fn });
    await adapter.pause("c1", { confirmed: true });
    expect(f.last().method).toBe("PATCH");
    expect(f.last().url).toBe(`${BASE}/c1/pause`);
    await adapter.resume("c1", { confirmed: true });
    expect(f.last().url).toBe(`${BASE}/c1/resume`);
  });

  it("delete() DELETEs the row", async () => {
    const f = fakeFetch(response(200, { ok: true }));
    await createFetchAdapter(BASE, { fetch: f.fn }).delete("c1", { confirmed: true });
    expect(f.last().method).toBe("DELETE");
    expect(f.last().url).toBe(`${BASE}/c1`);
  });

  it("simulate() POSTs the envelope wrapped as { envelope }", async () => {
    const f = fakeFetch(response(200, { ok: true, calibratedGasLimit: 1 }));
    await createFetchAdapter(BASE, { fetch: f.fn }).simulate({ pactCode: "(x)" }, { confirmed: true });
    expect(f.last().method).toBe("POST");
    expect(f.last().url).toBe(`${BASE}/simulate`);
    expect(f.last().body).toEqual({ envelope: { pactCode: "(x)" } });
  });

  it("executeNow() POSTs the execute sub-route", async () => {
    const f = fakeFetch(response(200, { ok: true, fireId: "f1" }));
    await createFetchAdapter(BASE, { fetch: f.fn }).executeNow("c1", { confirmed: true });
    expect(f.last().method).toBe("POST");
    expect(f.last().url).toBe(`${BASE}/c1/execute`);
  });

  it("trigger() POSTs the runtime args wrapped as { args }", async () => {
    const f = fakeFetch(response(200, { ok: true, fireId: "f1" }));
    await createFetchAdapter(BASE, { fetch: f.fn }).trigger("c1", { amount: "5" }, { confirmed: true });
    expect(f.last().url).toBe(`${BASE}/c1/trigger`);
    expect(f.last().body).toEqual({ args: { amount: "5" } });
  });

  it("startBatch() POSTs { count } to the batch route", async () => {
    const f = fakeFetch(response(200, { ok: true, batch: {} }));
    await createFetchAdapter(BASE, { fetch: f.fn }).startBatch("c1", 10, { confirmed: true });
    expect(f.last().method).toBe("POST");
    expect(f.last().url).toBe(`${BASE}/c1/execute-batch`);
    expect(f.last().body).toEqual({ count: 10 });
  });

  it("getBatch() GETs the batch route", async () => {
    const f = fakeFetch(response(200, { ok: true, batch: null }));
    await createFetchAdapter(BASE, { fetch: f.fn }).getBatch("c1");
    expect(f.last().method).toBe("GET");
    expect(f.last().url).toBe(`${BASE}/c1/execute-batch`);
  });

  it("cancelBatch() DELETEs the batch route", async () => {
    const f = fakeFetch(response(200, { ok: true, cancelled: true }));
    await createFetchAdapter(BASE, { fetch: f.fn }).cancelBatch("c1");
    expect(f.last().method).toBe("DELETE");
    expect(f.last().url).toBe(`${BASE}/c1/execute-batch`);
  });

  it("recover() POSTs { requestKey } to the fire-recover route", async () => {
    const f = fakeFetch(response(200, { ok: true, fireId: "f1", requestKey: "rk" }));
    await createFetchAdapter(BASE, { fetch: f.fn }).recover("c1", "f1", "rk-value", { confirmed: true });
    expect(f.last().method).toBe("POST");
    expect(f.last().url).toBe(`${BASE}/c1/fires/f1/recover`);
    expect(f.last().body).toEqual({ requestKey: "rk-value" });
  });

  it("strips a trailing slash from baseUrl so routes never double-slash", async () => {
    const f = fakeFetch(response(200, { ok: true, codexCronoton: {} }));
    await createFetchAdapter(`${BASE}/`, { fetch: f.fn }).get("c1");
    expect(f.last().url).toBe(`${BASE}/c1`);
  });
});

describe("createFetchAdapter — confirm threading", () => {
  it("sends the confirm header only when a mutating call carries confirmed:true", async () => {
    const f = fakeFetch(response(200, { ok: true, nextFireAt: null }));
    const adapter = createFetchAdapter(BASE, { fetch: f.fn });
    await adapter.pause("c1", { confirmed: true });
    expect(f.last().headers[CONFIRMED_HEADER]).toBe("1");
  });

  it("omits the confirm header when a mutating call has no fresh confirm", async () => {
    const f = fakeFetch(response(200, { ok: true, nextFireAt: null }));
    const adapter = createFetchAdapter(BASE, { fetch: f.fn });
    await adapter.pause("c1");
    expect(f.last().headers[CONFIRMED_HEADER]).toBeUndefined();
  });

  it("never sends the confirm header on read methods", async () => {
    const f = fakeFetch(response(200, { ok: true, codexCronotons: [] }));
    const adapter = createFetchAdapter(BASE, { fetch: f.fn });
    await adapter.list();
    expect(f.last().headers[CONFIRMED_HEADER]).toBeUndefined();
  });

  it("merges caller-supplied static headers into every request", async () => {
    const f = fakeFetch(response(200, { ok: true, codexCronotons: [] }));
    const adapter = createFetchAdapter(BASE, { fetch: f.fn, headers: { authorization: "Bearer t" } });
    await adapter.list();
    expect(f.last().headers.authorization).toBe("Bearer t");
  });
});

describe("createFetchAdapter — status → seam mapping", () => {
  it("returns the parsed body on a 2xx read", async () => {
    const f = fakeFetch(response(200, { ok: true, codexCronotons: [{ id: "c1" }] }));
    const view = await createFetchAdapter(BASE, { fetch: f.fn }).list();
    expect(view.codexCronotons).toEqual([{ id: "c1" }]);
  });

  it("throws NeedsConfirmError on a 401 admin_confirm_required", async () => {
    const f = fakeFetch(response(401, { error: "admin_confirm_required" }));
    const adapter = createFetchAdapter(BASE, { fetch: f.fn });
    await expect(adapter.pause("c1", { confirmed: true })).rejects.toBeInstanceOf(NeedsConfirmError);
  });

  it("throws Error(body.error) on a non-confirm non-2xx", async () => {
    const f = fakeFetch(response(409, { error: "System cronoton — cannot be deleted." }));
    const adapter = createFetchAdapter(BASE, { fetch: f.fn });
    await expect(adapter.delete("c1", { confirmed: true })).rejects.toThrow(
      "System cronoton — cannot be deleted.",
    );
  });

  it("falls back to 'HTTP {status}' when a non-2xx body carries no error", async () => {
    const f = fakeFetch(response(500, {}));
    const adapter = createFetchAdapter(BASE, { fetch: f.fn });
    await expect(adapter.get("c1")).rejects.toThrow("HTTP 500");
  });

  it("does NOT throw on a 200-on-ok:false simulate — returns the body untouched", async () => {
    const f = fakeFetch(response(200, { ok: false, error: "gas estimation failed" }));
    const view = await createFetchAdapter(BASE, { fetch: f.fn }).simulate({}, { confirmed: true });
    expect(view.ok).toBe(false);
    expect(view.error).toBe("gas estimation failed");
  });

  it("does NOT throw on a 200-on-ok:false executeNow — returns the failed-fire body", async () => {
    const f = fakeFetch(response(200, { ok: false, error: "chain rejected", fireId: "f2" }));
    const view = await createFetchAdapter(BASE, { fetch: f.fn }).executeNow("c1", { confirmed: true });
    expect(view.ok).toBe(false);
    expect(view.fireId).toBe("f2");
  });
});

describe("createFetchAdapter — lazy fetch resolution", () => {
  it("constructs successfully with no fetch available (resolution is deferred to the first call)", () => {
    const original = (globalThis as { fetch?: unknown }).fetch;
    delete (globalThis as { fetch?: unknown }).fetch;
    try {
      // Construction must never touch fetch — a host that builds the adapter at
      // import time (before any request) must not crash for lack of a global.
      expect(() => createFetchAdapter(BASE)).not.toThrow();
    } finally {
      (globalThis as { fetch?: unknown }).fetch = original;
    }
  });

  it("throws 'no fetch available' only when a method is invoked, not at construction", async () => {
    const original = (globalThis as { fetch?: unknown }).fetch;
    delete (globalThis as { fetch?: unknown }).fetch;
    try {
      const adapter = createFetchAdapter(BASE);
      // The missing-fetch error surfaces on the first METHOD call, per contract.
      await expect(adapter.list()).rejects.toThrow("no fetch available");
    } finally {
      (globalThis as { fetch?: unknown }).fetch = original;
    }
  });
});

describe("parseHandlerResult — the shared status map (reused by the memory adapter)", () => {
  it("returns the body on any 2xx", () => {
    expect(parseHandlerResult({ status: 201, body: { ok: true, id: "x" } })).toEqual({ ok: true, id: "x" });
  });

  it("throws NeedsConfirmError only for a 401 admin_confirm_required", () => {
    expect(() => parseHandlerResult({ status: 401, body: { error: "admin_confirm_required" } })).toThrow(
      NeedsConfirmError,
    );
  });

  it("throws a plain Error (not NeedsConfirm) for a 401 with a different code", () => {
    let thrown: unknown;
    try {
      parseHandlerResult({ status: 401, body: { error: "unauthorized" } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(NeedsConfirmError);
    expect((thrown as Error).message).toBe("unauthorized");
  });

  it("defaults the message to 'HTTP {status}' when the error body is absent", () => {
    expect(() => parseHandlerResult({ status: 404, body: {} })).toThrow("HTTP 404");
  });
});
