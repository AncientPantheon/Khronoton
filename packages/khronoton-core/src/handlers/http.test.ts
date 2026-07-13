/**
 * Handler kernel — the branching contract: the typed-store-error → HTTP status
 * mapper, the confirm-gate 401/403 branches, and the two gate wrappers'
 * short-circuit-vs-pass-through behavior.
 *
 * These pin the ROUTE-LAYER decisions (which status a given store error becomes,
 * when a gate blocks vs lets through, whether a thrown error inside a handler is
 * translated) against the REAL typed errors imported from `/server`. No mock of
 * the error classes — a genuine `CodexCronotonValidationError('not found')` must
 * map to 404 while any other message maps to 400, so the discriminant is real.
 */
import { describe, it, expect, vi } from "vitest";

import {
  AutoGasGateError,
  CodexCronotonValidationError,
  ManualBatchActiveError,
  TerminalCronotonError,
} from "../server/index.js";

import { errorBody, json, mapStoreError } from "./http.js";
import type { HandlerResponse } from "./http.js";
import {
  defaultOpenAuth,
  NeedsConfirmError,
  withConfirm,
  withRead,
  type AuthSeam,
  type HandlerContext,
} from "./context.js";

/** A ctx carrying only the gate the wrapper reads — the wrappers touch nothing else. */
function ctxWith(auth: AuthSeam): HandlerContext {
  return { auth } as unknown as HandlerContext;
}

describe("mapStoreError — typed store error → HTTP status", () => {
  it("maps CodexCronotonValidationError('not found') to 404 with the message body", () => {
    const res = mapStoreError(new CodexCronotonValidationError("not found"));
    expect(res).toEqual({ status: 404, body: { error: "not found" } });
  });

  it("maps any other CodexCronotonValidationError to 400 (client error, not 404/500)", () => {
    const res = mapStoreError(new CodexCronotonValidationError("name must be a non-empty string"));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "name must be a non-empty string" });
  });

  it("maps AutoGasGateError (a CodexCronotonValidationError subclass) to 400, never 404", () => {
    // Its message is not 'not found', so the message discriminant must keep it a 400.
    expect(mapStoreError(new AutoGasGateError()).status).toBe(400);
  });

  it("maps TerminalCronotonError to 409 (a spent one-time row is a conflict)", () => {
    expect(mapStoreError(new TerminalCronotonError("completed")).status).toBe(409);
  });

  it("maps ManualBatchActiveError to 409 (a batch already runs)", () => {
    expect(mapStoreError(new ManualBatchActiveError()).status).toBe(409);
  });

  it("maps an unknown throw to 500 (no typed error leaks as a client error)", () => {
    expect(mapStoreError(new Error("db exploded")).status).toBe(500);
  });
});

describe("response helpers", () => {
  it("json packs status + body verbatim", () => {
    expect(json(202, { queued: true })).toEqual({ status: 202, body: { queued: true } });
  });

  it("errorBody defaults the message to 'HTTP {status}' when none is given", () => {
    expect(errorBody(418)).toEqual({ error: "HTTP 418" });
    expect(errorBody(400, "bad name")).toEqual({ error: "bad name" });
  });
});

describe("defaultOpenAuth — trusted single-tenant gates", () => {
  it("grants the read gate unconditionally with an empty identity", async () => {
    const gate = await defaultOpenAuth.requireRead({});
    expect(gate.ok).toBe(true);
    expect(gate.ok && gate.identity).toEqual({});
  });

  it("blocks the confirm gate with 401 admin_confirm_required when confirmed is absent", async () => {
    const gate = await defaultOpenAuth.requireConfirm({});
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.response).toEqual({
      status: 401,
      body: { error: "admin_confirm_required" },
    });
  });

  it("grants the confirm gate when confirmed is exactly true", async () => {
    const gate = await defaultOpenAuth.requireConfirm({ confirmed: true });
    expect(gate.ok).toBe(true);
  });
});

describe("withConfirm — confirm-gated wrapper", () => {
  it("short-circuits to 401 admin_confirm_required and never runs fn without a fresh confirm", async () => {
    const fn = vi.fn(async (): Promise<HandlerResponse> => json(200, { ok: true }));
    const res = await withConfirm(ctxWith(defaultOpenAuth), {}, fn);
    expect(res).toEqual({ status: 401, body: { error: "admin_confirm_required" } });
    expect(fn).not.toHaveBeenCalled();
  });

  it("runs fn and returns its response when the confirm gate passes", async () => {
    const fn = vi.fn(async (): Promise<HandlerResponse> => json(200, { ok: true, id: "c1" }));
    const res = await withConfirm(ctxWith(defaultOpenAuth), { confirmed: true }, fn);
    expect(res).toEqual({ status: 200, body: { ok: true, id: "c1" } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("translates a thrown 'not found' store error to a 404 (not a 500)", async () => {
    const res = await withConfirm(ctxWith(defaultOpenAuth), { confirmed: true }, async () => {
      throw new CodexCronotonValidationError("not found");
    });
    expect(res.status).toBe(404);
  });

  it("translates a thrown ManualBatchActiveError to a 409", async () => {
    const res = await withConfirm(ctxWith(defaultOpenAuth), { confirmed: true }, async () => {
      throw new ManualBatchActiveError();
    });
    expect(res.status).toBe(409);
  });

  it("translates a thrown NeedsConfirmError to a 401 admin_confirm_required", async () => {
    const res = await withConfirm(ctxWith(defaultOpenAuth), { confirmed: true }, async () => {
      throw new NeedsConfirmError();
    });
    expect(res).toEqual({ status: 401, body: { error: "admin_confirm_required" } });
  });

  it("translates an unexpected throw to a 500", async () => {
    const res = await withConfirm(ctxWith(defaultOpenAuth), { confirmed: true }, async () => {
      throw new Error("boom");
    });
    expect(res.status).toBe(500);
  });
});

describe("withRead — read-gated wrapper", () => {
  it("runs fn under the default-open read gate (read is always allowed)", async () => {
    const res = await withRead(ctxWith(defaultOpenAuth), {}, async () => json(200, { list: [] }));
    expect(res).toEqual({ status: 200, body: { list: [] } });
  });

  it("short-circuits with the gate response when the read gate denies", async () => {
    const denyRead: AuthSeam = {
      requireRead: () => ({ ok: false, response: json(403, { error: "forbidden" }) }),
      requireConfirm: () => ({ ok: true, identity: {} }),
    };
    const fn = vi.fn(async (): Promise<HandlerResponse> => json(200, { list: [] }));
    const res = await withRead(ctxWith(denyRead), {}, fn);
    expect(res).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(fn).not.toHaveBeenCalled();
  });
});
