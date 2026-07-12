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
import type { ChainRuntime, KeyResolver } from "./seams.js";
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

// ── client mock (dirtyRead / submit / listen) ───────────────────────────────
const dirtyRead = vi.fn();
const submit = vi.fn();
const listen = vi.fn();
const createClient = vi.fn((..._a: unknown[]) => ({ dirtyRead, submit, listen }));

// ── gas + sign + verify stubs ───────────────────────────────────────────────
const calculateAutoGasLimit = vi.fn((g: number) => g * 2);
const anuToStoa = vi.fn((a: number) => a / 1e12);
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
  isSignedTransaction.mockReturnValue(true);
  getPactUrl.mockImplementation((c: string) => `https://node/${c}`);
  createClient.mockReturnValue({ dirtyRead, submit, listen });
  universalSignTransaction.mockResolvedValue({ cmd: "SIGNED", sigs: [{ sig: "x" }] });
  getKeyPairByPublicKey.mockResolvedValue({
    publicKey: PUB_A,
    privateKey: "deadbeef",
    seedType: "koala",
  });
  dirtyRead.mockResolvedValue({ result: { status: "success", data: "OK" }, gas: 700 });
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

  it("setMeta uses anuToStoa for gasPrice and carries chain/networkId/ttl", async () => {
    await executeCodexTransaction(baseDef(), "simulate", ctx);
    const meta = findCall("setMeta")!.args[0] as Record<string, unknown>;
    expect(anuToStoa).toHaveBeenCalledWith(10000);
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
    dirtyRead.mockResolvedValue({ result: { status: "success" }, gas: 700 });
    const res = await executeCodexTransaction(
      baseDef({
        config: { chainId: "0", gasPrice: 10000, gasLimit: 1500, autoGasLimit: true, ttl: 28800 },
      }),
      "simulate",
      ctx,
    );
    expect(calculateAutoGasLimit).toHaveBeenCalledWith(700);
    expect(res.mode === "simulate" && res.calibratedGasLimit).toBe(1400);
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
    dirtyRead.mockResolvedValue({ result: { status: "success" }, gas: 700 });
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
    dirtyRead.mockResolvedValue({ result: { status: "success" }, gas: 700 });
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
