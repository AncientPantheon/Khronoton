/**
 * Server tick orchestration tests — `codexCronotonTickOnce` +
 * `processDueManualBatchesOnce`.
 *
 * Carried from the Hub `tick.test.ts` but adapted from `vi.mock` module
 * interception to the injected `TickCtx`: the tick is a pure ctx-taker, so the
 * store/dispatch seams are observed via `vi.spyOn` on the real modules the tick
 * imports (no module replacement), and `db`/`onAudit`/`resolveFireMode` arrive
 * on the ctx. Each test pins ONE orchestration branch of the select → claim →
 * fire → record → finalize → audit sequence:
 *
 *   - due recurring + ok       → claim + fire + recordFire(success) +
 *                                `codex_cronoton.fire` audit, NO terminal/pause write
 *   - due recurring + ok:false → recordFire(failure), stays active, fire_failed audit
 *   - due one-time + ok        → applyTerminalIntent(completed); no advance
 *   - due one-time + failure   → applyTerminalIntent(error)
 *   - claim false              → skipped, NO fire, NO recordFire
 *   - per-row isolation        → rowToDefinition throw on row 1 → skipped; row 2 fires
 *   - multi-tx resolver row    → dispatched via the orchestrator (executor untouched)
 *   - EXACTLY ONE recordFire per fired row + NEVER a status='paused' write
 *   - manual batch: parent inactive → cancel; claim lost → skip; due slot →
 *     fire + manual_fire audit attributed to the batch creator, schedule untouched
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import * as claim from "./store/claim.js";
import * as mappers from "./store/mappers.js";
import * as fires from "./store/fires.js";
import * as fingerprint from "./pure/fingerprint.js";
import * as manualBatch from "./store/manual-batch.js";
import * as cronotonStore from "./store/cronoton.js";
import * as resolvers from "./resolvers.js";
import * as executor from "./executor.js";
import { registerServerResolver } from "./resolvers.js";

import { codexCronotonTickOnce, processDueManualBatchesOnce } from "./tick.js";
import type { TickCtx } from "./tick.js";
import type {
  ChainRuntime,
  Config,
  Database,
  KeyResolver,
  OnAudit,
} from "./seams.js";
import type {
  CodexCronotonRow,
  CodexManualBatchRow,
  CodexTxDefinition,
  FireResult,
} from "./types.js";

const NOW = new Date("2026-06-08T12:00:00.000Z");

const CONFIG: Config = {
  tickIntervalMs: 30_000,
  listenTimeoutMs: 300_000,
  autoGasCeiling: 2_000_000,
  singleTxGasGuard: 1_600_000,
  tickBatchLimit: 100,
  manualBatch: { min: 2, max: 60, intervalSeconds: 60 },
};

function makeCtx(over: Partial<TickCtx> = {}): TickCtx {
  return {
    db: {} as unknown as Database,
    resolver: {} as unknown as KeyResolver,
    runtime: {} as unknown as ChainRuntime,
    onAudit: vi.fn() as OnAudit,
    resolveFireMode: () => "live",
    config: CONFIG,
    ...over,
  };
}

function makeRow(over: Partial<CodexCronotonRow> = {}): CodexCronotonRow {
  return {
    id: "cc-1",
    name: "Test cronoton",
    description: null,
    pact_code: '(coin.transfer "a" "b" 1.0)',
    config_json: '{"chainId":"0"}',
    payload_json: null,
    gas_payer_json: '{"type":"gas-station"}',
    signers_json: "[]",
    schedule_mode: "every-n-minutes",
    schedule_config_json: '{"minutes":5}',
    status: "active",
    next_fire_at: NOW.toISOString(),
    last_fire_at: null,
    created_at: NOW.toISOString(),
    modified_at: NOW.toISOString(),
    created_by: "ancient@example.com",
    ...over,
  };
}

function makeBatch(over: Partial<CodexManualBatchRow> = {}): CodexManualBatchRow {
  return {
    id: "mb-1",
    codex_cronoton_id: "cc-parent",
    total: 3,
    completed: 0,
    interval_seconds: 60,
    status: "active",
    next_at: NOW.toISOString(),
    created_at: NOW.toISOString(),
    modified_at: NOW.toISOString(),
    created_by: "ancient@example.com",
    ...over,
  };
}

function defFor(row: CodexCronotonRow): CodexTxDefinition {
  return {
    pactCode: row.pact_code,
    config: { chainId: "0", gasPrice: 1, gasLimit: 1000, autoGasLimit: false, ttl: 600 },
    payload: {},
    gasPayer: { type: "gas-station" },
    signers: [],
    scheduleKind: row.schedule_mode === "one-time" ? "one-time" : "recurring",
  };
}

function fireOk(over: Partial<FireResult> = {}): FireResult {
  return {
    ok: true,
    mode: "fire",
    chainId: "0",
    requestKey: "rk-success",
    rawResult: { status: "success" },
    terminalIntent: null,
    ...over,
  };
}

function fireFail(over: Partial<FireResult> = {}): FireResult {
  return {
    ok: false,
    mode: "fire",
    chainId: "0",
    error: "on-chain failure",
    rawResult: { status: "failure" },
    terminalIntent: null,
    ...over,
  };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
let claimSpy: ReturnType<typeof vi.spyOn>;
let applyTerminalSpy: ReturnType<typeof vi.spyOn>;
let advanceSpy: ReturnType<typeof vi.spyOn>;
let rowToDefSpy: ReturnType<typeof vi.spyOn>;
let recordSpy: ReturnType<typeof vi.spyOn>;
let fireSpy: ReturnType<typeof vi.spyOn>;
let fetchBatchSpy: ReturnType<typeof vi.spyOn>;
let claimBatchSpy: ReturnType<typeof vi.spyOn>;
let cancelBatchSpy: ReturnType<typeof vi.spyOn>;
let getCronotonSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();

  fetchSpy = vi.spyOn(claim, "fetchDueCodexCronotons").mockReturnValue([]);
  claimSpy = vi.spyOn(claim, "claimDueCodexCronoton").mockReturnValue(true);
  applyTerminalSpy = vi.spyOn(claim, "applyTerminalIntent").mockImplementation(() => {});
  advanceSpy = vi.spyOn(claim, "advanceRecurring").mockImplementation(() => {});
  rowToDefSpy = vi
    .spyOn(mappers, "rowToDefinition")
    .mockImplementation((row: CodexCronotonRow) => defFor(row));
  recordSpy = vi.spyOn(fires, "recordFire").mockReturnValue("fire-id-1");
  vi.spyOn(fingerprint, "computeDefinitionFingerprint").mockReturnValue("fp-abc123");

  fetchBatchSpy = vi.spyOn(manualBatch, "fetchDueManualBatches").mockReturnValue([]);
  claimBatchSpy = vi.spyOn(manualBatch, "claimManualBatchFire").mockReturnValue(true);
  cancelBatchSpy = vi
    .spyOn(manualBatch, "cancelManualBatch")
    .mockReturnValue({ ok: true });
  getCronotonSpy = vi.spyOn(cronotonStore, "getCodexCronoton").mockReturnValue(null);

  fireSpy = vi.spyOn(resolvers, "fireByServerResolver").mockResolvedValue(fireOk());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("codexCronotonTickOnce", () => {
  it("claims, fires, and records a success fire for a due recurring row, threading ctx seams and auditing codex_cronoton.fire with NO terminal/pause write", async () => {
    fetchSpy.mockReturnValue([makeRow({ id: "cc-rec" })]);
    fireSpy.mockResolvedValue(fireOk());
    const onAudit = vi.fn();
    const ctx = makeCtx({ onAudit });

    const result = await codexCronotonTickOnce(NOW, ctx);

    expect(claimSpy).toHaveBeenCalledTimes(1);
    // the tick threads runtime/resolver/config/db straight off the ctx into the dispatcher.
    expect(fireSpy).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleKind: "recurring" }),
      expect.objectContaining({ id: "cc-rec" }),
      expect.objectContaining({
        runtime: ctx.runtime,
        resolver: ctx.resolver,
        config: ctx.config,
        db: ctx.db,
        deps: expect.anything(),
      }),
    );
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        codexCronotonId: "cc-rec",
        jobId: null,
        status: "success",
        requestKey: "rk-success",
        definitionFingerprint: "fp-abc123",
      }),
      expect.objectContaining({ db: ctx.db, resolveFireMode: ctx.resolveFireMode }),
    );
    // recurring success → the claim already advanced next_fire_at; no terminal write.
    expect(applyTerminalSpy).not.toHaveBeenCalled();
    // no post-fire recurring advance (the claim already advanced it).
    expect(advanceSpy).not.toHaveBeenCalled();
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "codex_cronoton.fire",
        result: "success",
        targetKind: "codex_cronoton",
        targetId: "cc-rec",
        detail: expect.objectContaining({ actor: "scheduler", fireId: "fire-id-1" }),
      }),
    );
    expect(result.firedIds).toEqual(["cc-rec"]);
    expect(result.failedIds).toEqual([]);
    expect(result.skippedIds).toEqual([]);
  });

  it("records a failure fire for a due recurring row whose fire returns ok:false, staying active (no terminal, no advance), auditing fire_failed", async () => {
    fetchSpy.mockReturnValue([makeRow({ id: "cc-recf" })]);
    fireSpy.mockResolvedValue(fireFail());
    const onAudit = vi.fn();

    const result = await codexCronotonTickOnce(NOW, makeCtx({ onAudit }));

    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        codexCronotonId: "cc-recf",
        status: "failure",
        errorMessage: "on-chain failure",
      }),
      expect.anything(),
    );
    expect(applyTerminalSpy).not.toHaveBeenCalled();
    expect(advanceSpy).not.toHaveBeenCalled();
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "codex_cronoton.fire_failed", targetId: "cc-recf" }),
    );
    expect(result.firedIds).toEqual([]);
    expect(result.failedIds).toEqual(["cc-recf"]);
  });

  it("applies the completed terminal intent for a one-time success (claim already cleared next_fire_at)", async () => {
    fetchSpy.mockReturnValue([makeRow({ id: "cc-ot", schedule_mode: "one-time" })]);
    fireSpy.mockResolvedValue(fireOk({ terminalIntent: { status: "completed", clearNextFire: true } }));
    const ctx = makeCtx();

    const result = await codexCronotonTickOnce(NOW, ctx);

    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(applyTerminalSpy).toHaveBeenCalledWith(
      "cc-ot",
      { status: "completed", clearNextFire: true },
      expect.objectContaining({ db: ctx.db }),
    );
    expect(advanceSpy).not.toHaveBeenCalled();
    expect(result.firedIds).toEqual(["cc-ot"]);
  });

  it("applies the error terminal intent for a one-time failure", async () => {
    fetchSpy.mockReturnValue([makeRow({ id: "cc-otf", schedule_mode: "one-time" })]);
    fireSpy.mockResolvedValue(fireFail({ terminalIntent: { status: "error", clearNextFire: true } }));
    const ctx = makeCtx();

    const result = await codexCronotonTickOnce(NOW, ctx);

    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failure" }),
      expect.anything(),
    );
    expect(applyTerminalSpy).toHaveBeenCalledWith(
      "cc-otf",
      { status: "error", clearNextFire: true },
      expect.objectContaining({ db: ctx.db }),
    );
    expect(result.failedIds).toEqual(["cc-otf"]);
  });

  it("skips a row whose claim is lost to an overlapping tick (claim returns false) — no fire, no recordFire", async () => {
    fetchSpy.mockReturnValue([makeRow({ id: "cc-lost" })]);
    claimSpy.mockReturnValue(false);

    const result = await codexCronotonTickOnce(NOW, makeCtx());

    expect(fireSpy).not.toHaveBeenCalled();
    expect(recordSpy).not.toHaveBeenCalled();
    expect(result.firedIds).toEqual([]);
    expect(result.failedIds).toEqual([]);
    expect(result.skippedIds).toEqual(["cc-lost"]);
  });

  it("isolates a per-row orchestration error (rowToDefinition throws) — the bad row is skipped and the next due row still fires exactly once", async () => {
    fetchSpy.mockReturnValue([makeRow({ id: "cc-bad" }), makeRow({ id: "cc-good" })]);
    rowToDefSpy.mockImplementationOnce(() => {
      throw new Error("corrupt config_json");
    });
    fireSpy.mockResolvedValue(fireOk());

    const result = await codexCronotonTickOnce(NOW, makeCtx());

    expect(result.skippedIds).toEqual(["cc-bad"]);
    expect(result.firedIds).toEqual(["cc-good"]);
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({ codexCronotonId: "cc-good" }),
      expect.anything(),
    );
  });

  it("dispatches a MULTI-TX server-resolver row through the orchestrator (not the single-tx executor) and records the adapted-summary success fire", async () => {
    // Let the REAL fireByServerResolver run so the multi-tx routing is exercised
    // end-to-end; the single-tx executor must never be touched for this row.
    fireSpy.mockRestore();
    const execSpy = vi.spyOn(executor, "executeCodexTransaction");
    const summary = {
      gatePassed: true,
      alertRaised: false,
      batches: [{ requestKey: "batch-rk-9" }],
    };
    const run = vi.fn().mockResolvedValue(summary);
    registerServerResolver("tick-multitx-payout", { kind: "multi-tx", run });
    rowToDefSpy.mockReturnValue({
      ...defFor(makeRow({ id: "cc-payout" })),
      pactCode: "(noop)",
      serverResolver: "tick-multitx-payout",
    });
    fetchSpy.mockReturnValue([makeRow({ id: "cc-payout" })]);

    const result = await codexCronotonTickOnce(NOW, makeCtx());

    expect(execSpy).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        codexCronotonId: "cc-payout",
        status: "success",
        requestKey: "batch-rk-9",
        chainResponse: expect.objectContaining({ gatePassed: true, alertRaised: false }),
      }),
      expect.anything(),
    );
    expect(result.firedIds).toEqual(["cc-payout"]);
  });

  it("records EXACTLY ONE fire per fired row and issues the one-time terminal as the ONLY status write (never a paused write) across a batch", async () => {
    fetchSpy.mockReturnValue([
      makeRow({ id: "cc-a" }),
      makeRow({ id: "cc-b", schedule_mode: "one-time" }),
    ]);
    fireSpy
      .mockResolvedValueOnce(fireOk())
      .mockResolvedValueOnce(fireOk({ terminalIntent: { status: "completed", clearNextFire: true } }));

    await codexCronotonTickOnce(NOW, makeCtx());

    expect(recordSpy).toHaveBeenCalledTimes(2);
    // the sole status write is the one-time terminal — recurring cc-a gets none.
    expect(applyTerminalSpy).toHaveBeenCalledTimes(1);
    expect(applyTerminalSpy).toHaveBeenCalledWith(
      "cc-b",
      expect.objectContaining({ status: "completed" }),
      expect.anything(),
    );
    expect(advanceSpy).not.toHaveBeenCalled();
  });
});

describe("processDueManualBatchesOnce", () => {
  it("auto-cancels a batch whose parent cronoton is no longer active, without claiming or firing", async () => {
    fetchBatchSpy.mockReturnValue([makeBatch({ id: "mb-x", codex_cronoton_id: "cc-p" })]);
    getCronotonSpy.mockReturnValue(makeRow({ id: "cc-p", status: "paused" }));
    const ctx = makeCtx();

    const result = await processDueManualBatchesOnce(NOW, ctx);

    expect(cancelBatchSpy).toHaveBeenCalledWith("mb-x", expect.objectContaining({ db: ctx.db }));
    expect(claimBatchSpy).not.toHaveBeenCalled();
    expect(fireSpy).not.toHaveBeenCalled();
    expect(recordSpy).not.toHaveBeenCalled();
    expect(result.cancelledIds).toEqual(["mb-x"]);
    expect(result.firedIds).toEqual([]);
  });

  it("skips a batch whose slot claim is lost to an overlapping tick — no fire", async () => {
    fetchBatchSpy.mockReturnValue([makeBatch({ id: "mb-lost" })]);
    getCronotonSpy.mockReturnValue(makeRow({ id: "cc-parent", status: "active" }));
    claimBatchSpy.mockReturnValue(false);

    const result = await processDueManualBatchesOnce(NOW, makeCtx());

    expect(fireSpy).not.toHaveBeenCalled();
    expect(recordSpy).not.toHaveBeenCalled();
    expect(result.skippedIds).toEqual(["mb-lost"]);
  });

  it("fires a due batch slot against the parent, records the fire, and audits manual_fire attributed to the batch creator without advancing the cronoton schedule", async () => {
    const batch = makeBatch({
      id: "mb-go",
      codex_cronoton_id: "cc-parent",
      total: 3,
      completed: 1,
      created_by: "creator@example.com",
    });
    fetchBatchSpy.mockReturnValue([batch]);
    getCronotonSpy.mockReturnValue(makeRow({ id: "cc-parent", status: "active" }));
    claimBatchSpy.mockReturnValue(true);
    fireSpy.mockResolvedValue(fireOk());
    const onAudit = vi.fn();
    const ctx = makeCtx({ onAudit });

    const result = await processDueManualBatchesOnce(NOW, ctx);

    expect(fireSpy).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleKind: "recurring" }),
      expect.objectContaining({ id: "cc-parent" }),
      expect.objectContaining({ db: ctx.db }),
    );
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({ codexCronotonId: "cc-parent", status: "success" }),
      expect.anything(),
    );
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "codex_cronoton.manual_fire",
        result: "success",
        targetId: "cc-parent",
        detail: expect.objectContaining({
          actor: "ancient",
          via: "manual_batch",
          batchId: "mb-go",
          batchIndex: 2,
          batchTotal: 3,
          scheduleKind: "recurring",
          createdBy: "creator@example.com",
        }),
      }),
    );
    // a batch fire NEVER advances the cronoton's own schedule.
    expect(claimSpy).not.toHaveBeenCalled();
    expect(advanceSpy).not.toHaveBeenCalled();
    expect(applyTerminalSpy).not.toHaveBeenCalled();
    expect(result.firedIds).toEqual(["mb-go"]);
  });
});
