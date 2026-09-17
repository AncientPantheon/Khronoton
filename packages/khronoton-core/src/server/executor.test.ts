/**
 * Unit tests for the headless single-transaction executor.
 *
 * These pin the BUILD SHAPE, MODE BRANCHING, and the four load-bearing
 * invariants — fire-never-throws (F-002), the dirty-read pre-flight gate
 * (F-001), AUTO-gas calibrate, and the 504/derived-request-key recovery
 * (REQ-23) — against a PLAIN INJECTED mock `ChainRuntime` + mock `KeyResolver`.
 * There is no `vi.mock('@stoachain/...')` module interception: the seam is the
 * whole point, so the runtime + resolver are ordinary objects passed via `ctx`.
 * The real dirtyRead/submit/listen against a live node + the real WASM sign are
 * validated on-prod.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { executeCodexTransaction } from "./executor.js";
import type { ExecutorCtx } from "./executor.js";
import type { ChainRuntime, ChainClient, KeyResolver } from "./seams.js";
import { AUTO_GAS_CEILING } from "./seams.js";
import type { CodexTxDefinition } from "./types.js";

// ── recorders for the fake Pact.builder chain ───────────────────────────────
interface BuilderCall {
  method: string;
  args: unknown[];
}
let builderCalls: BuilderCall[] = [];
let lastSignerCaps: Array<{
  pub: string;
  caps: Array<{ name: string; args: unknown[] }>;
}> = [];

function makeFakeBuilder() {
  const builder: Record<string, unknown> = {};
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      builderCalls.push({ method, args });
      return builder;
    };
  builder.setMeta = record("setMeta");
  builder.setNetworkId = record("setNetworkId");
  builder.addData = record("addData");
  builder.addSigner = (
    pub: string,
    capFn?: (withCap: unknown) => unknown[],
  ) => {
    builderCalls.push({ method: "addSigner", args: [pub, capFn] });
    if (capFn) {
      const withCapability = (name: string, ...args: unknown[]) => ({
        name,
        args,
      });
      const caps = capFn(withCapability) as Array<{
        name: string;
        args: unknown[];
      }>;
      lastSignerCaps.push({ pub, caps });
    }
    return builder;
  };
  builder.createTransaction = () => ({ cmd: "UNSIGNED_CMD", sigs: [] });
  return builder;
}

const fakePactBuilder = {
  get builder() {
    return {
      execution: (code: string) => {
        builderCalls.push({ method: "execution", args: [code] });
        return makeFakeBuilder();
      },
    };
  },
};

// ── client mock (dirtyRead / preflightRead / submit / listen) ──────────────
const dirtyRead = vi.fn();
const preflightRead = vi.fn();
const submit = vi.fn();
const listen = vi.fn();
const createClient = vi.fn((..._a: unknown[]) => ({
  dirtyRead,
  submit,
  listen,
  preflightRead,
}));

// ── gas + sign + verify stubs ───────────────────────────────────────────────
const calculateAutoGasLimit = vi.fn((g: number) => g * 2);
const anuToStoa = vi.fn((a: number) => a / 1e12);

// ── live gas floor (Yin Engine) stub ────────────────────────────────────────
// Mirrors the real `blockchain/stoachain.ts` adapter: ONE clock read produces
// BOTH fields, and the caller's stored ANU is treated as a raisable FLOOR via
// Math.max against the live floor. `nowS` is mutable so a test can advance the
// clock across a tick boundary between two builds.
const GENESIS_S = 1771869600;
const TICK_S = 10800;
let nowS = GENESIS_S + TICK_S * 500; // 500 ticks past genesis -> floor 10500 ANU
const liveFloorAnu = (t: number) =>
  Math.min(10000 + Math.max(0, Math.floor((t - GENESIS_S) / TICK_S)), 400000);
const anuToStoaNumber = (anu: number) => Number("0." + String(anu).padStart(12, "0"));
// Mirrors `blockchain/stoachain.ts`'s defensive clamp: a negative/non-finite
// buffer is treated as no premium at all, never a discount below the floor.
const safeBufferAnu = (bufferAnu: number) =>
  Number.isFinite(bufferAnu) && bufferAnu > 0 ? bufferAnu : 0;
const gasMeta = vi.fn((floorAnu: number, bufferAnu = 0) => {
  const creationTime = nowS;
  return {
    creationTime,
    gasPrice: anuToStoaNumber(
      Math.max(floorAnu, liveFloorAnu(creationTime)) + safeBufferAnu(bufferAnu),
    ),
  };
});
const universalSignTransaction = vi.fn();
const isSignedTransaction = vi.fn((..._a: unknown[]) => true);
const getPactUrl = vi.fn((c: string) => `https://node/${c}`);

const mockRuntime: ChainRuntime = {
  Pact: fakePactBuilder,
  createClient,
  isSignedTransaction,
  universalSignTransaction,
  calculateAutoGasLimit,
  anuToStoa,
  gasMeta,
  getPactUrl,
  networkId: "stoa",
  namespace: "ouronet-ns",
  gasStationAccount: "c:GASSTATION",
};

// ── resolver mock ───────────────────────────────────────────────────────────
const getKeyPairByPublicKey = vi.fn();
const listCodexPubs = vi.fn(async () => new Set<string>());
const mockResolver: KeyResolver = { getKeyPairByPublicKey, listCodexPubs };

const ctx: ExecutorCtx = { runtime: mockRuntime, resolver: mockResolver };

const PUB_A = "aa".repeat(32);
const PUB_GAS = "gg".repeat(32);

function baseDef(over: Partial<CodexTxDefinition> = {}): CodexTxDefinition {
  return {
    pactCode: '(coin.transfer "a" "b" 1.0)',
    config: {
      chainId: "0",
      gasPrice: 10000,
      gasLimit: 1500,
      autoGasLimit: false,
      ttl: 28800,
    },
    payload: {},
    // A gas-station gas payer carries the codex key that signs DALOS.GAS_PAYER.
    // The default uses PUB_A (already a signer) so the synthesized GAS_PAYER
    // signer dedups against it and the generic tests keep their signer counts.
    gasPayer: { type: "gas-station", gasStationSignerKey: PUB_A },
    signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
    scheduleKind: "recurring",
    ...over,
  };
}

function findCall(method: string): BuilderCall | undefined {
  return builderCalls.find((c) => c.method === method);
}

beforeEach(() => {
  vi.clearAllMocks();
  builderCalls = [];
  lastSignerCaps = [];
  calculateAutoGasLimit.mockImplementation((g: number) => g * 2);
  anuToStoa.mockImplementation((a: number) => a / 1e12);
  nowS = GENESIS_S + TICK_S * 500;
  gasMeta.mockImplementation((floorAnu: number, bufferAnu = 0) => {
    const creationTime = nowS;
    return {
      creationTime,
      gasPrice: anuToStoaNumber(
        Math.max(floorAnu, liveFloorAnu(creationTime)) + safeBufferAnu(bufferAnu),
      ),
    };
  });
  isSignedTransaction.mockReturnValue(true);
  getPactUrl.mockImplementation((c: string) => `https://node/${c}`);
  createClient.mockReturnValue({ dirtyRead, submit, listen, preflightRead });
  universalSignTransaction.mockResolvedValue({ cmd: "SIGNED", sigs: [{ sig: "x" }] });
  getKeyPairByPublicKey.mockResolvedValue({
    publicKey: PUB_A,
    privateKey: "deadbeef",
    seedType: "koala",
  });
  dirtyRead.mockResolvedValue({ result: { status: "success", data: "OK" }, gas: 700 });
  preflightRead.mockResolvedValue({ result: { status: "success", data: "OK" }, gas: 700 });
  submit.mockResolvedValue({ requestKey: "RK-1" });
  listen.mockResolvedValue({ result: { status: "success", data: "DONE" }, reqKey: "RK-1" });
});

describe("executeCodexTransaction — build shape", () => {
  it("throws when there are zero signers", async () => {
    // A codex gas-payer with no address synthesizes no signer, so an empty
    // signer list stays empty and the zero-signer guard fires.
    await expect(
      executeCodexTransaction(
        baseDef({ signers: [], gasPayer: { type: "codex" } }),
        "simulate",
        ctx,
      ),
    ).rejects.toThrow(/signer/i);
  });

  it("gas-station gas-payer → senderAccount is the injected gasStationAccount", async () => {
    await executeCodexTransaction(baseDef(), "simulate", ctx);
    const meta = findCall("setMeta")!.args[0] as { senderAccount: string };
    expect(meta.senderAccount).toBe("c:GASSTATION");
  });

  it("codex gas-payer → k:-prefixed sender derived from the address", async () => {
    await executeCodexTransaction(
      baseDef({
        gasPayer: { type: "codex", address: PUB_GAS },
        signers: [{ publicKey: PUB_GAS, capabilityMode: "pure", capabilities: "" }],
      }),
      "simulate",
      ctx,
    );
    const meta = findCall("setMeta")!.args[0] as { senderAccount: string };
    expect(meta.senderAccount).toBe(`k:${PUB_GAS}`);
  });

  it("setMeta prices via the gasMeta seam (NOT anuToStoa) and carries chain/networkId/ttl", async () => {
    await executeCodexTransaction(baseDef(), "simulate", ctx);
    const meta = findCall("setMeta")!.args[0] as Record<string, unknown>;
    // floorAnu is always 0 now (no more stored absolute value to raise to a
    // floor), and `baseDef()`'s config has no gasPriceBufferAnu, so it
    // defaults to 0. `anuToStoa` — plain float division — is no longer used
    // to price a signed tx at all.
    expect(gasMeta).toHaveBeenCalledWith(0, 0);
    expect(anuToStoa).not.toHaveBeenCalled();
    expect(meta.chainId).toBe("0");
    expect(meta.ttl).toBe(28800);
    const net = findCall("setNetworkId")!.args[0];
    expect(net).toBe("stoa");
  });

  it("pure signer → addSigner called with pubkey and no capability closure", async () => {
    await executeCodexTransaction(baseDef(), "simulate", ctx);
    const addSigner = builderCalls.find((c) => c.method === "addSigner")!;
    expect(addSigner.args[0]).toBe(PUB_A);
    expect(addSigner.args[1]).toBeUndefined();
  });

  it("scoped signer with two cap lines → addSigner closure yields two parsed caps", async () => {
    await executeCodexTransaction(
      baseDef({
        signers: [
          {
            publicKey: PUB_A,
            capabilityMode: "scoped",
            capabilities: '(coin.GAS)\n(coin.TRANSFER "a" "b" 1)',
          },
        ],
      }),
      "simulate",
      ctx,
    );
    expect(lastSignerCaps).toHaveLength(1);
    expect(lastSignerCaps[0].caps).toEqual([
      { name: "coin.GAS", args: [] },
      { name: "coin.TRANSFER", args: ["a", "b", { int: 1 }] },
    ]);
  });

  it("payload entries → one addData per key", async () => {
    await executeCodexTransaction(
      baseDef({ payload: { ks: { keys: ["x"], pred: "keys-all" }, foo: "bar" } }),
      "simulate",
      ctx,
    );
    const addDatas = builderCalls.filter((c) => c.method === "addData");
    expect(addDatas).toHaveLength(2);
    expect(addDatas.map((c) => c.args[0]).sort()).toEqual(["foo", "ks"]);
  });
});

describe("executeCodexTransaction — simulate mode", () => {
  it("signs the tx and dirtyReads it, NEVER submits or listens", async () => {
    const res = await executeCodexTransaction(baseDef(), "simulate", ctx);
    expect(universalSignTransaction).toHaveBeenCalled();
    expect(dirtyRead).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.mode).toBe("simulate");
  });

  it("autoGasLimit → calibrated gas is calculateAutoGasLimit(700) === 1400", async () => {
    preflightRead.mockResolvedValue({ result: { status: "success" }, gas: 700 });
    const res = await executeCodexTransaction(
      baseDef({
        config: { chainId: "0", gasPrice: 10000, gasLimit: 1500, autoGasLimit: true, ttl: 28800 },
      }),
      "simulate",
      ctx,
    );
    expect(calculateAutoGasLimit).toHaveBeenCalledWith(700);
    expect(res.mode === "simulate" && res.calibratedGasLimit).toBe(1400);
    // AUTO-gas fires calibrate from the accurate preflight measurement, never
    // the old execution-only dirtyRead figure.
    expect(preflightRead).toHaveBeenCalled();
    expect(dirtyRead).not.toHaveBeenCalled();
  });

  it("dirty-read failure → structured failure result, no throw, no submit", async () => {
    dirtyRead.mockResolvedValue({
      result: { status: "failure", error: { message: "boom" } },
    });
    const res = await executeCodexTransaction(baseDef(), "simulate", ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/boom/);
    expect(submit).not.toHaveBeenCalled();
  });

  it("simulate terminalIntent is always null even for a one-time entry", async () => {
    const res = await executeCodexTransaction(
      baseDef({ scheduleKind: "one-time" }),
      "simulate",
      ctx,
    );
    expect(res.terminalIntent).toBeNull();
  });
});

describe("executeCodexTransaction — fire mode", () => {
  it("happy path → pre-flight dirtyRead then submit + listen, returns requestKey", async () => {
    const res = await executeCodexTransaction(baseDef(), "fire", ctx);
    expect(dirtyRead).toHaveBeenCalled();
    expect(submit).toHaveBeenCalled();
    expect(listen).toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.mode === "fire" && res.requestKey).toBe("RK-1");
  });

  it("(F-001) pre-submit dirty-read failure → NO submit + structured failure + one-time error intent", async () => {
    dirtyRead.mockResolvedValue({
      result: { status: "failure", error: { message: "preflight rejected" } },
    });
    const res = await executeCodexTransaction(
      baseDef({ scheduleKind: "one-time" }),
      "fire",
      ctx,
    );
    expect(submit).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/preflight rejected/);
    expect(res.terminalIntent).toEqual({ status: "error", clearNextFire: true });
  });

  it("one-time + fire + success → completed terminalIntent", async () => {
    const res = await executeCodexTransaction(
      baseDef({ scheduleKind: "one-time" }),
      "fire",
      ctx,
    );
    expect(res.terminalIntent).toEqual({ status: "completed", clearNextFire: true });
  });

  it("recurring + fire + success → null terminalIntent", async () => {
    const res = await executeCodexTransaction(
      baseDef({ scheduleKind: "recurring" }),
      "fire",
      ctx,
    );
    expect(res.terminalIntent).toBeNull();
  });

  it("(F-002) submit THROWS with no derivable key → structured failure, no escape, one-time error intent", async () => {
    // Default `signed` carries no `hash`, so the derived key is null and the
    // submit error rethrows — caught by the fire-never-throws guard.
    submit.mockRejectedValue(new Error("node 500"));
    const res = await executeCodexTransaction(
      baseDef({ scheduleKind: "one-time" }),
      "fire",
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/node 500/);
    expect(res.terminalIntent).toEqual({ status: "error", clearNextFire: true });
  });

  it("(F-002) resolver decrypt rejection → structured failure, no throw", async () => {
    getKeyPairByPublicKey.mockRejectedValue(new Error("CodexDecryptError: wrong pw"));
    const res = await executeCodexTransaction(
      baseDef({ scheduleKind: "one-time" }),
      "fire",
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/wrong pw|decrypt/i);
    expect(res.terminalIntent).toEqual({ status: "error", clearNextFire: true });
  });

  it("(F-002) isSignedTransaction false → sign-incompletion structured failure, no submit", async () => {
    isSignedTransaction.mockReturnValue(false);
    const res = await executeCodexTransaction(
      baseDef({ scheduleKind: "recurring" }),
      "fire",
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(res.error).toMatch(/sign/i);
  });

  it("autoGasLimit fire → rebuilds so the last setMeta.gasLimit === 1400", async () => {
    preflightRead.mockResolvedValue({ result: { status: "success" }, gas: 700 });
    await executeCodexTransaction(
      baseDef({
        config: { chainId: "0", gasPrice: 10000, gasLimit: 1500, autoGasLimit: true, ttl: 28800 },
      }),
      "fire",
      ctx,
    );
    expect(calculateAutoGasLimit).toHaveBeenCalledWith(700);
    const metas = builderCalls.filter((c) => c.method === "setMeta");
    const lastMeta = metas[metas.length - 1].args[0] as { gasLimit: number };
    expect(lastMeta.gasLimit).toBe(1400);
    // AUTO-gas fires calibrate from the accurate preflight measurement, never
    // the old execution-only dirtyRead figure.
    expect(preflightRead).toHaveBeenCalled();
    expect(dirtyRead).not.toHaveBeenCalled();
  });
});

describe("executeCodexTransaction — REQ-23 504/derived-request-key recovery", () => {
  it("(a) submit THROWS with a derived key present → listen polled by the derived key, result preserves it", async () => {
    // A `signed` carrying `hash` + a JSON `cmd` lets the executor derive the
    // request key + networkId up front; a lost submit (nginx 504) then recovers
    // by polling the chain for that key instead of discarding a landed tx.
    universalSignTransaction.mockResolvedValue({
      cmd: JSON.stringify({ networkId: "stoa" }),
      hash: "DERIVED-RK",
      sigs: [{ sig: "x" }],
    });
    submit.mockRejectedValue(new Error("gateway 504"));
    // listen returns success with NO reqKey so the preserved key must be the
    // derived one, not a listen-supplied value.
    listen.mockResolvedValue({ result: { status: "success", data: "DONE" } });

    const res = await executeCodexTransaction(
      baseDef({ scheduleKind: "recurring" }),
      "fire",
      ctx,
    );

    const descriptor = listen.mock.calls[0][0] as {
      requestKey: string;
      chainId: string;
      networkId?: string;
    };
    expect(descriptor.requestKey).toBe("DERIVED-RK");
    expect(descriptor.chainId).toBe("0");
    expect(descriptor.networkId).toBe("stoa");
    expect(res.ok).toBe(true);
    expect(res.mode === "fire" && res.requestKey).toBe("DERIVED-RK");
  });

  it("(b) listen rejects → structured failure that PRESERVES the request key + one-time error intent", async () => {
    submit.mockResolvedValue({ requestKey: "RK-SUBMIT" });
    listen.mockRejectedValue(new Error("confirmation lost"));
    const res = await executeCodexTransaction(
      baseDef({ scheduleKind: "one-time" }),
      "fire",
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.mode === "fire" && res.requestKey).toBe("RK-SUBMIT");
    expect(res.error).toMatch(/confirmation lost/);
    expect(res.terminalIntent).toEqual({ status: "error", clearNextFire: true });
  });

  it("(FIX 1) injected config.listenTimeoutMs bounds the listen race and preserves the key on timeout", async () => {
    vi.useFakeTimers();
    try {
      submit.mockResolvedValue({ requestKey: "RK-1" });
      listen.mockReturnValue(new Promise(() => {})); // never resolves
      const p = executeCodexTransaction(
        baseDef({ scheduleKind: "one-time" }),
        "fire",
        { runtime: mockRuntime, resolver: mockResolver, config: { listenTimeoutMs: 1000 } },
      );
      await vi.advanceTimersByTimeAsync(1000);
      const res = await p;
      expect(res.ok).toBe(false);
      expect(res.mode === "fire" && res.requestKey).toBe("RK-1");
      expect(res.error).toMatch(/timed out|confirmation/i);
      expect(res.terminalIntent).toEqual({ status: "error", clearNextFire: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("executeCodexTransaction — FIX 1 config.autoGasCeiling override", () => {
  it("injected autoGasCeiling is the gasLimit of the FIRST (pre-flight) build", async () => {
    preflightRead.mockResolvedValue({ result: { status: "success" }, gas: 700 });
    await executeCodexTransaction(
      baseDef({
        config: { chainId: "0", gasPrice: 10000, gasLimit: 1500, autoGasLimit: true, ttl: 28800 },
      }),
      "fire",
      { runtime: mockRuntime, resolver: mockResolver, config: { autoGasCeiling: 5_000_000 } },
    );
    const metas = builderCalls.filter((c) => c.method === "setMeta");
    const firstMeta = metas[0].args[0] as { gasLimit: number };
    const lastMeta = metas[metas.length - 1].args[0] as { gasLimit: number };
    expect(firstMeta.gasLimit).toBe(5_000_000);
    expect(lastMeta.gasLimit).toBe(1400);
  });
});

describe("executeCodexTransaction — F-004 WASM-path keypair fields", () => {
  it("derived signer keypair carries encryptedSecretKey + password + secretKey into universalSignTransaction", async () => {
    getKeyPairByPublicKey.mockResolvedValue({
      publicKey: PUB_A,
      privateKey: "cafe".repeat(16),
      seedType: "chainweaver",
      encryptedSecretKey: "ENC_SECRET",
      password: "codex-pw",
    });
    await executeCodexTransaction(baseDef(), "simulate", ctx);
    const keypairs = universalSignTransaction.mock.calls[0][1] as Array<
      Record<string, unknown>
    >;
    expect(keypairs[0].encryptedSecretKey).toBe("ENC_SECRET");
    expect(keypairs[0].password).toBe("codex-pw");
    // The privateKey→secretKey field rename must survive the resolver→signer map.
    expect(keypairs[0].secretKey).toBe("cafe".repeat(16));
  });
});

describe("executeCodexTransaction — F-007 codex gas-payer-must-sign invariant", () => {
  it("codex gas-payer whose pubkey is NOT among signers is auto-included and reaches the signer", async () => {
    await executeCodexTransaction(
      baseDef({
        gasPayer: { type: "codex", address: PUB_GAS },
        signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
      }),
      "simulate",
      ctx,
    );
    const signerPubs = builderCalls
      .filter((c) => c.method === "addSigner")
      .map((c) => c.args[0]);
    expect(signerPubs).toContain(PUB_GAS);
    expect(signerPubs).toContain(PUB_A);
  });

  it("codex gas-payer already carrying its coin.GAS scoped signer is NOT duplicated", async () => {
    await executeCodexTransaction(
      baseDef({
        gasPayer: { type: "codex", address: PUB_GAS },
        signers: [
          { publicKey: PUB_GAS, capabilityMode: "scoped", capabilities: "coin.GAS" },
          { publicKey: PUB_A, capabilityMode: "pure", capabilities: "" },
        ],
      }),
      "simulate",
      ctx,
    );
    const gasPubSigners = builderCalls
      .filter((c) => c.method === "addSigner")
      .filter((c) => c.args[0] === PUB_GAS);
    expect(gasPubSigners).toHaveLength(1);
    expect(lastSignerCaps.find((s) => s.pub === PUB_GAS)?.caps).toEqual([
      { name: "coin.GAS", args: [] },
    ]);
  });
});

describe("executeCodexTransaction — gas-station GAS_PAYER signer synthesis wiring", () => {
  it("synthesizes a scoped DALOS.GAS_PAYER signer whose parsed caps reach the builder closure", async () => {
    await executeCodexTransaction(
      baseDef({
        gasPayer: { type: "gas-station", gasStationSignerKey: PUB_GAS },
        signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
      }),
      "simulate",
      ctx,
    );
    const signerPubs = builderCalls
      .filter((c) => c.method === "addSigner")
      .map((c) => c.args[0]);
    expect(signerPubs).toContain(PUB_GAS);
    const meta = findCall("setMeta")!.args[0] as { senderAccount: string };
    expect(meta.senderAccount).toBe("c:GASSTATION");
    const gasCaps = lastSignerCaps.find((s) => s.pub === PUB_GAS);
    expect(gasCaps?.caps).toEqual([
      { name: "ouronet-ns.DALOS.GAS_PAYER", args: ["", { int: 0 }, { decimal: "0.0" }] },
    ]);
  });

  it("the synthesized GAS_PAYER signer keypair is resolved and reaches universalSignTransaction", async () => {
    getKeyPairByPublicKey.mockImplementation(async (pub: string) => ({
      publicKey: pub,
      privateKey: "deadbeef",
      seedType: "koala",
    }));
    await executeCodexTransaction(
      baseDef({
        gasPayer: { type: "gas-station", gasStationSignerKey: PUB_GAS },
        signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
      }),
      "simulate",
      ctx,
    );
    const resolvedPubs = getKeyPairByPublicKey.mock.calls.map((c) => c[0]);
    expect(resolvedPubs).toContain(PUB_GAS);
    const keypairs = universalSignTransaction.mock.calls[0][1] as Array<{
      publicKey: string;
    }>;
    expect(keypairs.map((k) => k.publicKey)).toContain(PUB_GAS);
  });

  it("gas-station with a MISSING gasStationSignerKey → fire structured failure (no submit, one-time error intent)", async () => {
    const res = await executeCodexTransaction(
      baseDef({
        gasPayer: { type: "gas-station" },
        signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
        scheduleKind: "one-time",
      }),
      "fire",
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/gas[_\s-]?station|key|GAS_PAYER/i);
    expect(submit).not.toHaveBeenCalled();
    expect(res.terminalIntent).toEqual({ status: "error", clearNextFire: true });
  });

  it("gas-station with a MISSING gasStationSignerKey → simulate throws the contract error", async () => {
    await expect(
      executeCodexTransaction(
        baseDef({
          gasPayer: { type: "gas-station" },
          signers: [{ publicKey: PUB_A, capabilityMode: "pure", capabilities: "" }],
        }),
        "simulate",
        ctx,
      ),
    ).rejects.toThrow(/gas[_\s-]?station|key|GAS_PAYER/i);
  });
});

// ── live gas floor (Yin Engine) ────────────────────────────────────────────
// The bug these pin: `definition.config.gasPrice` is a STATIC ANU number stored
// once at cronoton-creation time and read back verbatim on every tick, so a
// long-lived cronoton drifts below chainweb's rising floor and its 3am fire is
// rejected with nobody watching.
describe("executeCodexTransaction — live gas floor at fire time", () => {
  it("prices at exactly the live floor when no buffer is set — config.gasPrice is never read", async () => {
    // A deliberately huge, WRONG stored gasPrice proves it is never read for
    // pricing: the live floor is 10500 and the fire prices at exactly that.
    const def = baseDef({
      config: {
        chainId: "0",
        gasPrice: 99999999,
        gasLimit: 1500,
        autoGasLimit: false,
        ttl: 28800,
      },
    });
    await executeCodexTransaction(def, "simulate", ctx);
    const meta = findCall("setMeta")!.args[0] as Record<string, unknown>;
    expect(gasMeta).toHaveBeenCalledWith(0, 0);
    expect(meta.gasPrice).toBe(anuToStoaNumber(10500));
  });

  it("adds the priority buffer ON TOP of the live floor", async () => {
    const def = baseDef({
      config: {
        chainId: "0",
        gasPrice: 10000,
        gasPriceBufferAnu: 500,
        gasLimit: 1500,
        autoGasLimit: false,
        ttl: 28800,
      },
    });
    await executeCodexTransaction(def, "simulate", ctx);
    const meta = findCall("setMeta")!.args[0] as Record<string, unknown>;
    expect(gasMeta).toHaveBeenCalledWith(0, 500);
    // A SINGLE conversion of the summed ANU, not two summed STOA floats.
    expect(meta.gasPrice).toBe(anuToStoaNumber(10500 + 500));
  });

  it("passes a stored NEGATIVE gasPriceBufferAnu through to gasMeta unclamped — validation/clamping is the seam's job, not buildTransaction's", async () => {
    // buildTransaction itself does no defensive clamping of its own — it
    // trusts the seam (blockchain/stoachain.ts, defense-in-depth) and the
    // store's commit/edit-time rejection (server/store/cronoton.ts) to keep a
    // bad buffer from ever reaching here. This test documents that boundary:
    // the raw value is handed to gasMeta as-is, and it is gasMeta's own
    // clamp (mirrored in this file's `safeBufferAnu` helper) that keeps the
    // final price from falling below the live floor.
    const def = baseDef({
      config: {
        chainId: "0",
        gasPrice: 10000,
        gasPriceBufferAnu: -500,
        gasLimit: 1500,
        autoGasLimit: false,
        ttl: 28800,
      },
    });
    await executeCodexTransaction(def, "simulate", ctx);
    const meta = findCall("setMeta")!.args[0] as Record<string, unknown>;
    expect(gasMeta).toHaveBeenCalledWith(0, -500);
    // The seam clamps the negative buffer to 0 — the shipped price is
    // exactly the live floor, never below it.
    expect(meta.gasPrice).toBe(anuToStoaNumber(10500));
  });

  it("stamps creationTime from the SAME seam call that produced gasPrice (no two-clock race)", async () => {
    await executeCodexTransaction(baseDef(), "simulate", ctx);
    const meta = findCall("setMeta")!.args[0] as Record<string, unknown>;
    // Left unset, the Kadena builder would auto-stamp its own creationTime,
    // which could land on the far side of a tick boundary from the price.
    expect(meta.creationTime).toBe(nowS);
    expect(meta.gasPrice).toBe(anuToStoaNumber(liveFloorAnu(meta.creationTime as number)));
  });

  it("uses precision-safe ANU->STOA, not float division", async () => {
    // 0.0000000105 via padded-string conversion. Plain `10500 / 1e12` float
    // division is what upstream explicitly forbids for a value chainweb hashes.
    await executeCodexTransaction(baseDef(), "simulate", ctx);
    const meta = findCall("setMeta")!.args[0] as Record<string, unknown>;
    expect(meta.gasPrice).toBe(Number("0.000000010500"));
  });

  it("AUTO-gas rebuild re-derives gas meta FRESH for the second build", async () => {
    // REGRESSION: the calibrated rebuild+re-sign must not reuse the pre-flight
    // build's creationTime/gasPrice. If the two builds straddle a tick
    // boundary, reused values underprice the tx that actually gets submitted.
    // This fails if anyone hoists the seam call out of buildTransaction.
    const def = baseDef({
      config: {
        chainId: "0",
        gasPrice: 10000,
        gasPriceBufferAnu: 200,
        gasLimit: 1500,
        autoGasLimit: true,
        ttl: 28800,
      },
    });
    gasMeta.mockImplementation((floorAnu: number, bufferAnu = 0) => {
      const creationTime = nowS;
      nowS += TICK_S; // clock crosses a tick boundary between the two builds
      return {
        creationTime,
        gasPrice: anuToStoaNumber(
          Math.max(floorAnu, liveFloorAnu(creationTime)) + bufferAnu,
        ),
      };
    });

    await executeCodexTransaction(def, "fire", ctx);

    expect(gasMeta).toHaveBeenCalledTimes(2);
    expect(gasMeta).toHaveBeenNthCalledWith(1, 0, 200);
    expect(gasMeta).toHaveBeenNthCalledWith(2, 0, 200);
    const metas = builderCalls
      .filter((c) => c.method === "setMeta")
      .map((c) => c.args[0] as Record<string, unknown>);
    expect(metas).toHaveLength(2);
    expect(metas[1].creationTime).toBe((metas[0].creationTime as number) + TICK_S);
    expect(metas[0].gasPrice).toBe(anuToStoaNumber(10500 + 200));
    expect(metas[1].gasPrice).toBe(anuToStoaNumber(10501 + 200));
  });
});

describe("executeCodexTransaction — runtime WITHOUT the gasMeta capability", () => {
  function legacyCtx(): ExecutorCtx {
    const legacyRuntime = { ...mockRuntime } as ChainRuntime;
    delete (legacyRuntime as { gasMeta?: unknown }).gasMeta;
    return { runtime: legacyRuntime, resolver: mockResolver };
  }

  it("fire returns a CLEAR structured failure and never submits (F-002, no silent static price)", async () => {
    const res = await executeCodexTransaction(baseDef(), "fire", legacyCtx());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/gasMeta/);
    // Never silently falls back to the stale stored price.
    expect(submit).not.toHaveBeenCalled();
    // F-002: a one-time entry still records its spent attempt.
    expect(res.terminalIntent).not.toBeUndefined();
  });

  it("simulate surfaces the missing capability as a throw", async () => {
    await expect(
      executeCodexTransaction(baseDef(), "simulate", legacyCtx()),
    ).rejects.toThrow(/gasMeta/);
  });
});

// ── auto-gas: live block ceiling ────────────────────────────────────────────
// The bug this pins: the ceiling used to be a hardcoded AUTO_GAS_CEILING
// (StoaChain's own limit, wrong for chainweb's 1.6M default or Kadena
// mainnet's 150k). resolveCeiling must prefer a live client.getBlockGasLimit()
// read, falling back to the static constant only when that capability is
// absent or fails.
describe("executeCodexTransaction — live block gas limit", () => {
  it("resolves the ceiling via getBlockGasLimit when no config override is set", async () => {
    const liveRuntime: ChainRuntime = {
      ...mockRuntime,
      createClient: vi.fn(() => ({
        dirtyRead,
        submit,
        listen,
        preflightRead,
        getBlockGasLimit: vi.fn(async () => 1_600_000),
      })),
    };
    await executeCodexTransaction(
      baseDef({
        config: { chainId: "0", gasPrice: 10000, gasLimit: 1500, autoGasLimit: true, ttl: 28800 },
      }),
      "simulate",
      { runtime: liveRuntime, resolver: mockResolver },
    );
    const metas = builderCalls.filter((c) => c.method === "setMeta");
    const firstMeta = metas[0].args[0] as { gasLimit: number };
    expect(firstMeta.gasLimit).toBe(1_600_000);
  });

  it("falls back to AUTO_GAS_CEILING when getBlockGasLimit is absent", async () => {
    // The file's shared mockRuntime/createClient fixture predates
    // getBlockGasLimit — a regression pin that an un-upgraded runtime's
    // pre-existing default ceiling behavior is unchanged by this task.
    await executeCodexTransaction(
      baseDef({
        config: { chainId: "0", gasPrice: 10000, gasLimit: 1500, autoGasLimit: true, ttl: 28800 },
      }),
      "simulate",
      ctx,
    );
    const metas = builderCalls.filter((c) => c.method === "setMeta");
    const firstMeta = metas[0].args[0] as { gasLimit: number };
    expect(firstMeta.gasLimit).toBe(AUTO_GAS_CEILING);
  });

  it.each([NaN, 0, -1, Infinity])(
    "falls back to AUTO_GAS_CEILING when getBlockGasLimit resolves %s (not a sane ceiling)",
    async (badValue) => {
      // NaN in particular is the dangerous case: `typeof NaN === "number"` is
      // true, and `gasUsed > NaN` is ALWAYS false, so trusting it verbatim
      // would silently defeat the refuse-unmineable check below rather than
      // falling back as `ChainClient.getBlockGasLimit`'s own doc promises.
      const liveRuntime: ChainRuntime = {
        ...mockRuntime,
        createClient: vi.fn(() => ({
          dirtyRead,
          submit,
          listen,
          preflightRead,
          getBlockGasLimit: vi.fn(async () => badValue),
        })),
      };
      await executeCodexTransaction(
        baseDef({
          config: { chainId: "0", gasPrice: 10000, gasLimit: 1500, autoGasLimit: true, ttl: 28800 },
        }),
        "simulate",
        { runtime: liveRuntime, resolver: mockResolver },
      );
      const metas = builderCalls.filter((c) => c.method === "setMeta");
      const firstMeta = metas[0].args[0] as { gasLimit: number };
      expect(firstMeta.gasLimit).toBe(AUTO_GAS_CEILING);
    },
  );

  it("falls back to AUTO_GAS_CEILING when ctx.config.autoGasCeiling itself is NaN, never trusting it verbatim", async () => {
    await executeCodexTransaction(
      baseDef({
        config: { chainId: "0", gasPrice: 10000, gasLimit: 1500, autoGasLimit: true, ttl: 28800 },
      }),
      "simulate",
      { runtime: mockRuntime, resolver: mockResolver, config: { autoGasCeiling: NaN } },
    );
    const metas = builderCalls.filter((c) => c.method === "setMeta");
    const firstMeta = metas[0].args[0] as { gasLimit: number };
    expect(firstMeta.gasLimit).toBe(AUTO_GAS_CEILING);
  });

  it("constructs the ChainClient exactly ONCE per simulate/fire — never a second client for ceiling resolution", async () => {
    // `resolveCeiling` takes the already-constructed `client` as a parameter
    // specifically so it never calls `runtime.createClient` itself; a
    // regression that reintroduced a second, independent construction call
    // would otherwise be invisible to every dirtyRead/submit/listen/
    // preflightRead assertion in this file, since they all alias the same
    // shared spies regardless of call count.
    createClient.mockClear();
    await executeCodexTransaction(baseDef(), "simulate", ctx);
    expect(createClient).toHaveBeenCalledTimes(1);

    createClient.mockClear();
    await executeCodexTransaction(baseDef(), "fire", ctx);
    expect(createClient).toHaveBeenCalledTimes(1);
  });
});

// ── refuse the unmineable case ──────────────────────────────────────────────
// A transaction whose measured gas exceeds the resolved block ceiling must be
// refused with a structured error BEFORE any calibration/rebuild or submit —
// never silently capped, never submitted — for both an AUTO-gas fire and a
// manually-set-limit fire.
describe("executeCodexTransaction — refuse the unmineable case", () => {
  it("AUTO-gas simulate refuses when gasUsed exceeds the ceiling — never returns a calibratedGasLimit", async () => {
    preflightRead.mockResolvedValue({ result: { status: "success" }, gas: 3_000_000 });
    const res = await executeCodexTransaction(
      baseDef({
        config: { chainId: "0", gasPrice: 10000, gasLimit: 1500, autoGasLimit: true, ttl: 28800 },
      }),
      "simulate",
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/over the block limit/);
    expect(res.calibratedGasLimit).toBeUndefined();
  });

  it("MANUAL-gas fire also refuses when measured gas exceeds the ceiling", async () => {
    dirtyRead.mockResolvedValue({ result: { status: "success" }, gas: 3_000_000 });
    const res = await executeCodexTransaction(
      baseDef({ scheduleKind: "one-time" }),
      "fire",
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(res.error).toMatch(/over the block limit/);
    expect(res.terminalIntent).toEqual({ status: "error", clearNextFire: true });
  });
});

describe("executeCodexTransaction — AUTO-gas fire on a runtime WITHOUT preflightRead", () => {
  // Strips preflightRead from the CLIENT this fixture's createClient returns
  // (not the whole runtime) — a runtime that hasn't upgraded its ChainClient
  // adapter, mirroring the existing "runtime WITHOUT the gasMeta capability"
  // describe block above.
  function legacyCtx(): ExecutorCtx {
    const legacyRuntime: ChainRuntime = {
      ...mockRuntime,
      createClient: (..._a: unknown[]) => {
        const client: Partial<ChainClient> = { dirtyRead, submit, listen, preflightRead };
        delete client.preflightRead;
        return client as ChainClient;
      },
    };
    return { runtime: legacyRuntime, resolver: mockResolver };
  }

  it("AUTO-gas fire on this legacy client returns a structured failure, never submits", async () => {
    const res = await executeCodexTransaction(
      baseDef({
        config: { chainId: "0", gasPrice: 10000, gasLimit: 1500, autoGasLimit: true, ttl: 28800 },
      }),
      "fire",
      legacyCtx(),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/preflightRead/);
    expect(submit).not.toHaveBeenCalled();
  });

  it("AUTO-gas simulate on it rejects with a throw mentioning preflightRead", async () => {
    await expect(
      executeCodexTransaction(
        baseDef({
          config: { chainId: "0", gasPrice: 10000, gasLimit: 1500, autoGasLimit: true, ttl: 28800 },
        }),
        "simulate",
        legacyCtx(),
      ),
    ).rejects.toThrow(/preflightRead/);
  });

  it("MANUAL-gas fire on the SAME legacy client succeeds exactly as today", async () => {
    const res = await executeCodexTransaction(baseDef(), "fire", legacyCtx());
    expect(res.ok).toBe(true);
    expect(dirtyRead).toHaveBeenCalled();
  });
});
