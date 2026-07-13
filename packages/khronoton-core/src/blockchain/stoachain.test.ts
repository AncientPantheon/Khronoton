import { describe, it, expect, vi } from "vitest";

// The five `@stoachain/*` modules the factory dynamic-imports are mocked so the
// test exercises the adapter's own wiring (defaults, getPactUrl branch,
// pass-through) without pulling the real WASM/crypto runtime. vitest intercepts
// the `await import()` calls. Helper names are `mock`-prefixed so vitest's
// hoisting of `vi.mock` permits referencing them inside the factories.
const mockPact = { builder: { execution: (code: string) => ({ code }) } };
const mockCreateClient = vi.fn((url: string) => ({
  dirtyRead: async () => ({ result: { status: "success" } }),
  submit: async () => ({ requestKey: "rk" }),
  listen: async () => ({ result: { status: "success" } }),
  url,
}));
const mockIsSignedTransaction = vi.fn((_tx: unknown) => true);
const mockUniversalSign = vi.fn(async (_tx: unknown, _kps: unknown) => ({
  signed: true,
}));
const mockCalcGas = vi.fn((g: number) => g * 2);
const mockAnuToStoa = vi.fn((a: number) => a / 3);
const mockGetPactUrl = vi.fn(
  (chainId: string) => `https://constants.example/chain/${chainId}`,
);
const mockNetwork = "mainnet01";
const mockNamespace = "kadena-namespace";
const mockGasStation = "constants-gas-station";

vi.mock("@stoachain/kadena-stoic-legacy/client", () => ({
  Pact: mockPact,
  createClient: mockCreateClient,
  isSignedTransaction: mockIsSignedTransaction,
}));
vi.mock("@stoachain/stoa-core/signing", () => ({
  universalSignTransaction: mockUniversalSign,
}));
vi.mock("@stoachain/stoa-core/gas", () => ({
  calculateAutoGasLimit: mockCalcGas,
  anuToStoa: mockAnuToStoa,
}));
vi.mock("@stoachain/stoa-core/constants", () => ({
  KADENA_NETWORK: mockNetwork,
  getPactUrl: mockGetPactUrl,
}));
vi.mock("@stoachain/ouronet-core/constants", () => ({
  KADENA_NAMESPACE: mockNamespace,
  STOA_AUTONOMIC_OURONETGASSTATION: mockGasStation,
}));

import { createStoachainRuntime } from "./stoachain";

describe("createStoachainRuntime", () => {
  it("is an async factory: the call returns a Promise before the runtime resolves", () => {
    // Async is load-bearing — `@stoachain/*` are ESM-only and a static value
    // import would break CJS `tsx` workers, so the factory MUST defer to
    // `await import()` and hand back a Promise.
    const pending = createStoachainRuntime();
    expect(pending).toBeInstanceOf(Promise);
  });

  it("resolves to an object exposing every ChainRuntime member with the expected type", async () => {
    const rt = await createStoachainRuntime();
    expect(rt.Pact.builder.execution("(+ 1 2)")).toEqual({ code: "(+ 1 2)" });
    expect(typeof rt.createClient).toBe("function");
    expect(typeof rt.isSignedTransaction).toBe("function");
    expect(typeof rt.universalSignTransaction).toBe("function");
    expect(typeof rt.calculateAutoGasLimit).toBe("function");
    expect(typeof rt.anuToStoa).toBe("function");
    expect(typeof rt.getPactUrl).toBe("function");
    expect(typeof rt.networkId).toBe("string");
    expect(typeof rt.namespace).toBe("string");
    expect(typeof rt.gasStationAccount).toBe("string");
  });

  it("defaults networkId/namespace/gasStationAccount from the @stoachain constants when no config is given", async () => {
    const rt = await createStoachainRuntime();
    expect(rt.networkId).toBe(mockNetwork);
    expect(rt.namespace).toBe(mockNamespace);
    expect(rt.gasStationAccount).toBe(mockGasStation);
  });

  it("lets config overrides win over the @stoachain constant defaults", async () => {
    const rt = await createStoachainRuntime({
      networkId: "x",
      namespace: "y",
      gasStationAccount: "z",
    });
    expect(rt.networkId).toBe("x");
    expect(rt.namespace).toBe("y");
    expect(rt.gasStationAccount).toBe("z");
  });

  it("passes the mocked @stoachain runtime functions through by identity", async () => {
    const rt = await createStoachainRuntime();
    expect(rt.Pact).toBe(mockPact);
    expect(rt.createClient).toBe(mockCreateClient);
    expect(rt.isSignedTransaction).toBe(mockIsSignedTransaction);
    expect(rt.universalSignTransaction).toBe(mockUniversalSign);
    expect(rt.calculateAutoGasLimit).toBe(mockCalcGas);
    expect(rt.anuToStoa).toBe(mockAnuToStoa);
    // Behaviour flows through: the wrapped gas fn computes from its input.
    expect(rt.calculateAutoGasLimit(10)).toBe(20);
  });

  it("delegates getPactUrl to constants.getPactUrl when no nodeBaseUrl is configured", async () => {
    const rt = await createStoachainRuntime();
    expect(rt.getPactUrl).toBe(mockGetPactUrl);
    expect(rt.getPactUrl("2")).toBe("https://constants.example/chain/2");
  });

  it("builds a per-chain Pact URL against nodeBaseUrl, bypassing constants.getPactUrl", async () => {
    const rt = await createStoachainRuntime({
      nodeBaseUrl: "http://127.0.0.1:1848",
    });
    expect(rt.getPactUrl).not.toBe(mockGetPactUrl);
    expect(rt.getPactUrl("0")).toBe(
      `http://127.0.0.1:1848/chainweb/0.0/${mockNetwork}/chain/0/pact`,
    );
  });

  it("uses the resolved (config-overridden) networkId in the nodeBaseUrl Pact URL template", async () => {
    const rt = await createStoachainRuntime({
      nodeBaseUrl: "http://127.0.0.1:1848",
      networkId: "testnet04",
    });
    expect(rt.getPactUrl("1")).toBe(
      "http://127.0.0.1:1848/chainweb/0.0/testnet04/chain/1/pact",
    );
  });
});
