/**
 * Chained-cronoton handlers — the confirm-gated commit/simulate surface this
 * package was missing (every other mutate/execute handler in `/handlers` is
 * wrapped in `withConfirm` with an audit event; the chained-commit and
 * whole-chain-simulate store functions had no handler-layer wrapper at all).
 * These pin: a successful chained commit writes a REAL queryable row + steps
 * and emits an audit event, a denied confirm gate writes nothing, a malformed
 * body is a 400 via the store's own `validateChain` reject (not a 500), and
 * `simulateChain` returns HTTP 200 even when the dry run's own `ok` is false
 * (REQ-H04 — the same convention `execute.ts`'s `simulateCodexTx` documents).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { getCodexCronoton } from "../server/index.js";
import * as executorModule from "../server/executor.js";
import type { ChainSingleTxSimOutcome, ChainStepSimOutcome } from "../server/chain-simulate.js";

import {
  commitChainedCronoton,
  simulateChain,
  type ChainSimulateView,
  type ChainStepSimResult,
} from "./chain.js";
import { buildTestCtx, req, type TestHarness } from "../../tests/handlers/harness.js";

// Compile-time guard: `ChainSimulateView` (handlers/chain.ts) is a
// hand-maintained mirror of `ChainSimulationResult`/`ChainSingleTxSimOutcome`/
// `ChainStepSimOutcome` (server/chain-simulate.ts). A one-directional
// assignability check (`wire = {} as server`) only catches the target
// requiring a field the source lacks — it does NOT catch the server side
// gaining a field that was never mirrored onto the wire type (excess-property
// checking only applies to object literals, not to a value flowing through a
// cast). So each pair is checked in BOTH directions.
type AssertEqual<A, B> = A extends B ? (B extends A ? true : false) : false;
function assertMirrored<A, B>(_check: AssertEqual<A, B>): void {
  void _check;
}
assertMirrored<NonNullable<ChainSimulateView["singleTx"]>, ChainSingleTxSimOutcome>(true);
assertMirrored<ChainStepSimResult, ChainStepSimOutcome>(true);

let h: TestHarness;
afterEach(() => {
  h?.close();
  vi.restoreAllMocks();
});

/** A well-formed ChainCommitBody the handler adapts into the store's input shape. */
function validChainBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Chained via handler",
    description: null,
    schedule: {
      mode: "one-time",
      config: { mode: "one-time", fireAt: "2099-01-01T00:00:00.000Z" },
    },
    steps: [
      { mode: "single", pactCode: "(step-0)" },
      { mode: "single", pactCode: "(step-1)" },
    ],
    ...overrides,
  };
}

function countCronotonRows(db: TestHarness["db"]): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM codex_cronotons`).get() as { n: number }).n;
}

describe("commitChainedCronoton — chain commit adapter + confirm gate", () => {
  it("commits a real chained row (+ its steps) that is queryable back through the store and returns 201 with the right shape", async () => {
    h = buildTestCtx();
    const res = await commitChainedCronoton(h.ctx, req({ confirmed: true, body: validChainBody() }));

    expect(res.status).toBe(201);
    const body = res.body as {
      ok: boolean;
      codexCronotonId: string;
      nextFireAt: string | null;
      stepIds: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.stepIds).toHaveLength(2);
    // The row must actually exist — a 201 with no persisted row would be a lie.
    const row = getCodexCronoton(body.codexCronotonId, { db: h.db });
    expect(row?.name).toBe("Chained via handler");
    expect(body.nextFireAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("emits a chained_cronoton.commit audit event targeting the new row id", async () => {
    h = buildTestCtx();
    const res = await commitChainedCronoton(h.ctx, req({ confirmed: true, body: validChainBody() }));
    const id = (res.body as { codexCronotonId: string }).codexCronotonId;

    expect(h.onAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "chained_cronoton.commit",
        result: "ok",
        targetKind: "codex_cronoton",
        targetId: id,
        detail: { name: "Chained via handler", stepCount: 2 },
      }),
    );
  });

  it("short-circuits to 401 admin_confirm_required when no fresh confirm accompanies the request, writing nothing", async () => {
    h = buildTestCtx();
    const before = countCronotonRows(h.db);
    const res = await commitChainedCronoton(h.ctx, req({ body: validChainBody() }));

    expect(res).toEqual({ status: 401, body: { error: "admin_confirm_required" } });
    expect(countCronotonRows(h.db)).toBe(before);
  });

  it("maps a body missing steps to 400 via the store's validateChain reject, writing nothing", async () => {
    h = buildTestCtx();
    const before = countCronotonRows(h.db);
    const res = await commitChainedCronoton(
      h.ctx,
      req({
        confirmed: true,
        body: { name: "no steps here", schedule: validChainBody().schedule },
      }),
    );

    expect(res.status).toBe(400);
    expect(countCronotonRows(h.db)).toBe(before);
  });
});

describe("simulateChain — whole-chain dry run (200-on-ok:false)", () => {
  it("returns 200 with ok:false in the body (never a non-200 status) when a step's simulate fails", async () => {
    h = buildTestCtx();
    vi.spyOn(executorModule, "executeCodexTransaction").mockResolvedValueOnce({
      ok: false,
      mode: "simulate",
      error: "boom: reverted",
      terminalIntent: null,
    } as never);

    const res = await simulateChain(
      h.ctx,
      req({ confirmed: true, body: { steps: [{ mode: "single", pactCode: "(step-0)" }] } }),
    );

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; steps: Array<{ ok: boolean; error?: string }> };
    expect(body.ok).toBe(false);
    expect(body.steps[0].ok).toBe(false);
    expect(body.steps[0].error).toBe("boom: reverted");
  });

  it("carries a fitting singleTxFirst's ok:true/fits:true verdict through the full handler path", async () => {
    h = buildTestCtx();
    vi.spyOn(executorModule, "executeCodexTransaction").mockResolvedValueOnce({
      ok: true,
      mode: "simulate",
      gasUsed: 500,
      rawResult: { result: { data: "OK" } },
      terminalIntent: null,
    } as never);

    const res = await simulateChain(
      h.ctx,
      req({
        confirmed: true,
        body: {
          singleTxFirst: {
            pactCode: "(single-tx)",
            gasPayer: { type: "gas-station" },
            signers: [],
          },
          steps: [],
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = res.body as { singleTx?: ChainSingleTxSimOutcome };
    expect(body.singleTx).toEqual({
      ok: true,
      fits: true,
      gasUsed: 500,
      rawResult: { result: { data: "OK" } },
    });
  });

  it("marks a non-gas-ceiling singleTxFirst failure as hardFailure (fits:false), distinct from a refuse-unmineable one", async () => {
    h = buildTestCtx();
    vi.spyOn(executorModule, "executeCodexTransaction").mockResolvedValueOnce({
      ok: false,
      mode: "simulate",
      error: "bad signer",
      terminalIntent: null,
    } as never);

    const res = await simulateChain(
      h.ctx,
      req({
        confirmed: true,
        body: {
          singleTxFirst: {
            pactCode: "(single-tx)",
            gasPayer: { type: "gas-station" },
            signers: [],
          },
          steps: [],
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = res.body as { singleTx?: ChainSingleTxSimOutcome };
    expect(body.singleTx).toEqual({ ok: false, fits: false, hardFailure: true, error: "bad signer" });
  });
});
