/**
 * Generic server-resolver registry — kind-discriminated fire dispatch.
 *
 * The registry carries two resolver kinds distinguished by a `kind` field so the
 * tick can route each to the right path:
 *   - 'single-tx': one resolve→merge→simulate-guard→fire→settle, dispatched via
 *     `fireWithServerResolver`.
 *   - 'multi-tx': a net-new orchestrator (`run`) dispatched via
 *     `dispatchMultiTxResolver`, never merged through the single-tx path.
 *
 * These pins carry over the Hub's `server-resolvers` contract genericized: no
 * stoicism-mint / pool-payout domain coupling — a test-registered generic
 * resolver stands in. Each `it` uses a UNIQUE resolver name so the module-level
 * registry map does not leak state across cases.
 */
import { describe, it, expect, vi } from "vitest";

import {
  getServerResolver,
  registerServerResolver,
  resolveServerVars,
  fireWithServerResolver,
  fireByServerResolver,
  dispatchMultiTxResolver,
} from "./resolvers.js";
import type { ChainRuntime, KeyResolver } from "./seams.js";
import type { CodexTxDefinition, FireResult, SimulateResult } from "./types.js";

const baseDef: CodexTxDefinition = {
  pactCode: "(noop)",
  config: { chainId: "2", gasPrice: 1, gasLimit: 1000, autoGasLimit: false, ttl: 600 },
  payload: {},
  gasPayer: { type: "gas-station" },
  signers: [],
};

/**
 * A minimal working mock `ChainRuntime` + `KeyResolver` that carries the real
 * executor's fire path all the way to `submit` — used only by the ctx-bound
 * default-exec guard test (everywhere else `exec` is injected as a `vi.fn()`).
 */
function makeChainMocks() {
  const builder: Record<string, unknown> = {};
  const rec =
    () =>
    (..._a: unknown[]) =>
      builder;
  builder.setMeta = rec();
  builder.setNetworkId = rec();
  builder.addData = rec();
  builder.addSigner = rec();
  builder.createTransaction = () => ({
    cmd: '{"networkId":"stoa"}',
    hash: "RK-DERIVED",
    sigs: [{ sig: "x" }],
  });

  const dirtyRead = vi.fn().mockResolvedValue({ result: { status: "success" }, gas: 700 });
  const submit = vi.fn().mockResolvedValue({ requestKey: "RK-1" });
  const listen = vi.fn().mockResolvedValue({ result: { status: "success" }, reqKey: "RK-1" });
  const createClient = vi.fn(() => ({ dirtyRead, submit, listen }));

  const runtime: ChainRuntime = {
    Pact: { builder: { execution: (_code: string) => builder } },
    createClient,
    isSignedTransaction: () => true,
    universalSignTransaction: vi
      .fn()
      .mockResolvedValue({ cmd: '{"networkId":"stoa"}', hash: "RK-DERIVED", sigs: [{ sig: "x" }] }),
    calculateAutoGasLimit: (g: number) => g * 2,
    anuToStoa: (a: number) => a / 1e12,
    getPactUrl: (c: string) => `https://node/${c}`,
    networkId: "stoa",
    namespace: "ouronet-ns",
    gasStationAccount: "c:GAS",
  };

  const getKeyPairByPublicKey = vi
    .fn()
    .mockResolvedValue({ publicKey: "aa".repeat(32), privateKey: "deadbeef", seedType: "koala" });
  const resolver: KeyResolver = {
    getKeyPairByPublicKey,
    listCodexPubs: vi.fn(async () => new Set<string>()),
  };

  return { runtime, resolver, submit, getKeyPairByPublicKey };
}

describe("server-resolver registry: kind discriminator", () => {
  it("registers and reads back a single-tx entry carrying its resolve+settle pair", () => {
    const resolve = vi.fn(() => ({ plan: [], payload: {} }));
    const settle = vi.fn();
    registerServerResolver("kind-single", { kind: "single-tx", resolve, settle });

    const entry = getServerResolver("kind-single");
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("single-tx");
    // the single-tx discriminator is what routes a row to the merge-then-fire path.
    if (entry && entry.kind === "single-tx") {
      expect(entry.resolve).toBe(resolve);
      expect(entry.settle).toBe(settle);
    }
  });

  it("registers and reads back a multi-tx entry carrying its run orchestrator", () => {
    const run = vi.fn();
    registerServerResolver("kind-multi", { kind: "multi-tx", run });

    const entry = getServerResolver("kind-multi");
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("multi-tx");
    // a multi-tx entry carries an orchestrator run, NOT resolve/settle — the
    // discriminator routes it away from the single-tx fire.
    if (entry && entry.kind === "multi-tx") {
      expect(entry.run).toBe(run);
    }
  });
});

describe("dispatchMultiTxResolver: orchestrator seam", () => {
  it("forwards the opts bag verbatim to the registered run and returns its result", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, fired: 3 });
    registerServerResolver("dispatch-ok", { kind: "multi-tx", run });
    const opts = { marker: "X" };

    const result = await dispatchMultiTxResolver("dispatch-ok", opts);

    expect(run).toHaveBeenCalledWith(opts);
    expect(result).toEqual({ ok: true, fired: 3 });
  });

  it("rejects an unknown name rather than inventing an orchestrator", async () => {
    await expect(dispatchMultiTxResolver("nope", {})).rejects.toThrow(/unknown.*nope/i);
  });

  it("rejects dispatching a single-tx name through the multi-tx seam", async () => {
    registerServerResolver("dispatch-single", {
      kind: "single-tx",
      resolve: () => ({ plan: [], payload: {} }),
      settle: vi.fn(),
    });
    await expect(dispatchMultiTxResolver("dispatch-single", {})).rejects.toThrow(
      /not a multi-tx resolver/i,
    );
  });
});

describe("fireWithServerResolver: single-tx path", () => {
  it("passes straight through to exec(def,'fire') when no serverResolver is set", async () => {
    const exec = vi.fn().mockResolvedValue({
      ok: true,
      mode: "fire",
      requestKey: "rk",
      terminalIntent: null,
    } as FireResult);

    const result = await fireWithServerResolver(baseDef, {}, { exec });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(baseDef, "fire");
    expect(result.ok).toBe(true);
  });

  it("resolves→simulate-guards→fires→settles a registered single-tx resolver", async () => {
    const settle = vi.fn();
    const plan = [{ target: "a", amount: 1 }];
    const resolve = vi.fn(() => ({ plan, payload: { minted: [1] } }));
    registerServerResolver("fire-single", { kind: "single-tx", resolve, settle });
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        mode: "simulate",
        gasUsed: 800_000,
        terminalIntent: null,
      } as SimulateResult)
      .mockResolvedValueOnce({
        ok: true,
        mode: "fire",
        requestKey: "rk-OK",
        terminalIntent: null,
      } as FireResult);
    const def = { ...baseDef, serverResolver: "fire-single" };

    const result = await fireWithServerResolver(def, {}, { exec });

    // exactly two exec calls: the safety-guard simulate, then the fire.
    expect(exec).toHaveBeenCalledTimes(2);
    // the resolver payload is merged into the fired definition BEFORE simulate.
    expect(exec).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ payload: { minted: [1] } }),
      "simulate",
    );
    // settle runs on success with the LANDED request key so the ledger links on-chain.
    expect(settle).toHaveBeenCalledWith(plan, expect.objectContaining({ requestKey: "rk-OK" }));
    expect(result.ok).toBe(true);
  });

  it("keeps the fire ok:true when settle throws AFTER a landed fire (the tx already landed; settlement is not the fire)", async () => {
    const plan = [{ target: "a", amount: 1 }];
    const resolve = vi.fn(() => ({ plan, payload: { minted: [1] } }));
    const settle = vi.fn(() => {
      throw new Error("ledger down");
    });
    registerServerResolver("fire-single-settle-throws", { kind: "single-tx", resolve, settle });
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        mode: "simulate",
        gasUsed: 800_000,
        terminalIntent: null,
      } as SimulateResult)
      .mockResolvedValueOnce({
        ok: true,
        mode: "fire",
        requestKey: "rk-OK",
        terminalIntent: null,
      } as FireResult);
    const def = { ...baseDef, serverResolver: "fire-single-settle-throws" };

    const result = await fireWithServerResolver(def, {}, { exec });

    // the on-chain fire landed (rk-OK); a settlement failure AFTER it must NOT
    // flip the fire to failed — else the tick would record a failure for a tx
    // that actually landed, and the scheduler might re-fire it.
    expect(settle).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("fire");
    if (result.ok) expect(result.requestKey).toBe("rk-OK");
  });

  it("postpones (never fires) a multi-tx name routed through the single-tx path", async () => {
    const run = vi.fn();
    registerServerResolver("fire-multi-refuse", { kind: "multi-tx", run });
    const exec = vi.fn();
    const def = { ...baseDef, serverResolver: "fire-multi-refuse" };

    const result = await fireWithServerResolver(def, {}, { exec });

    // a multi-tx orchestrator must NEVER be merged+fired by the single-tx wrapper.
    expect(exec).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/multi-tx/i);
  });

  it("postpones over the single-tx gas guard rather than burning gas on an unlandable tx", async () => {
    const settle = vi.fn();
    registerServerResolver("fire-single-overgas", {
      kind: "single-tx",
      resolve: () => ({ plan: [], payload: {} }),
      settle,
    });
    const exec = vi.fn().mockResolvedValueOnce({
      ok: true,
      mode: "simulate",
      gasUsed: 1_700_000,
      terminalIntent: null,
    } as SimulateResult);
    const def = { ...baseDef, serverResolver: "fire-single-overgas" };

    const result = await fireWithServerResolver(def, {}, { exec });

    // simulate over the 1_600_000 guard → postpone; the fire exec never happens.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});

describe("fireByServerResolver: kind-routing fire dispatcher", () => {
  it("routes a no-serverResolver row straight to exec(def,'fire')", async () => {
    const exec = vi.fn().mockResolvedValue({
      ok: true,
      mode: "fire",
      requestKey: "rk",
      terminalIntent: null,
    } as FireResult);

    const result = await fireByServerResolver(baseDef, {}, { exec });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(baseDef, "fire");
    expect(result.ok).toBe(true);
  });

  it("delegates a single-tx resolver to the resolve→guard→fire→settle path", async () => {
    const settle = vi.fn();
    const plan = [{ t: "a" }];
    registerServerResolver("by-single", {
      kind: "single-tx",
      resolve: () => ({ plan, payload: {} }),
      settle,
    });
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        mode: "simulate",
        gasUsed: 800_000,
        terminalIntent: null,
      } as SimulateResult)
      .mockResolvedValueOnce({
        ok: true,
        mode: "fire",
        requestKey: "rk-OK",
        terminalIntent: null,
      } as FireResult);
    const def = { ...baseDef, serverResolver: "by-single" };

    const result = await fireByServerResolver(def, {}, { exec });

    expect(exec).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenCalledWith(plan, expect.objectContaining({ requestKey: "rk-OK" }));
    expect(result.ok).toBe(true);
  });

  it("routes a multi-tx resolver to dispatch + adapts the run summary → ok:true", async () => {
    const summary = {
      gatePassed: true,
      alertRaised: false,
      paid: [{ workerId: "w1" }],
      batches: [{ requestKey: "batch-rk-1" }],
    };
    const run = vi.fn().mockResolvedValue(summary);
    registerServerResolver("by-multi-ok", { kind: "multi-tx", run });
    const def = { ...baseDef, serverResolver: "by-multi-ok" };
    const exec = vi.fn();

    const result = await fireByServerResolver(def, {}, { exec, db: undefined });

    // the single-tx executor is NEVER touched for a multi-tx resolver…
    expect(exec).not.toHaveBeenCalled();
    // …the orchestrator is dispatched…
    expect(run).toHaveBeenCalledTimes(1);
    // …and a completed run adapts to an ok fire carrying the summary + batch key.
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("fire");
    expect(result.rawResult).toMatchObject({ gatePassed: true, alertRaised: false });
    expect(result.requestKey).toBe("batch-rk-1");
  });

  it("adapts a THROWING multi-tx run to ok:false WITHOUT throwing out of the dispatcher", async () => {
    const run = vi.fn().mockRejectedValue(new Error("boom in payout"));
    registerServerResolver("by-multi-throw", { kind: "multi-tx", run });
    const def = { ...baseDef, serverResolver: "by-multi-throw" };

    const result = await fireByServerResolver(def, {});

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("fire");
    // the error is carried so the failure fire row shows WHY it failed.
    expect(result.error).toMatch(/boom in payout/);
  });

  it("threads opts.deps verbatim into the multi-tx dispatch", async () => {
    const run = vi.fn().mockResolvedValue({ batches: [] });
    registerServerResolver("by-multi-deps", { kind: "multi-tx", run });
    const def = { ...baseDef, serverResolver: "by-multi-deps" };
    const deps = { day: "2026-07-12", marker: "Z" };

    await fireByServerResolver(def, {}, { deps });

    expect(run).toHaveBeenCalledWith(deps);
  });

  it("threads opts.db as {db} into the multi-tx dispatch when deps is absent", async () => {
    const run = vi.fn().mockResolvedValue({ batches: [] });
    registerServerResolver("by-multi-db", { kind: "multi-tx", run });
    const def = { ...baseDef, serverResolver: "by-multi-db" };
    const fakeDb = {} as never;

    await fireByServerResolver(def, {}, { db: fakeDb });

    expect(run).toHaveBeenCalledWith({ db: fakeDb });
  });

  it("routes a no-resolver row through the ctx-bound executeCodexTransaction when no exec override is given", async () => {
    const { runtime, resolver, submit, getKeyPairByPublicKey } = makeChainMocks();
    const pub = "aa".repeat(32);
    const def: CodexTxDefinition = {
      ...baseDef,
      pactCode: "(coin.transfer)",
      // A gas-station payer needs a codex key to sign DALOS.GAS_PAYER; reuse the
      // lone signer so the synthesized signer dedups and one keypair is resolved.
      gasPayer: { type: "gas-station", gasStationSignerKey: pub },
      signers: [{ publicKey: pub, capabilityMode: "pure", capabilities: "" }],
    };

    const result = await fireByServerResolver(def, {}, { runtime, resolver });

    // the default exec bound runtime+resolver into the real executor, which
    // consulted the resolver for the signer and submitted the signed tx once.
    expect(getKeyPairByPublicKey).toHaveBeenCalledWith(pub);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});

describe("resolveServerVars: single-tx preview", () => {
  it("returns null for an unknown name", () => {
    expect(resolveServerVars("does-not-exist")).toBeNull();
  });

  it("returns null for a multi-tx entry (no single-tx payload to preview)", () => {
    registerServerResolver("preview-multi", { kind: "multi-tx", run: vi.fn() });
    expect(resolveServerVars("preview-multi")).toBeNull();
  });

  it("returns the resolution for a single-tx entry", () => {
    const resolution = { plan: [{ x: 1 }], payload: { k: "v" } };
    registerServerResolver("preview-single", {
      kind: "single-tx",
      resolve: () => resolution,
      settle: vi.fn(),
    });
    expect(resolveServerVars("preview-single")).toEqual(resolution);
  });
});
