import { describe, it, expect, vi, beforeEach } from "vitest";

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
// The Yin Engine floor, mocked with the real formula's shape so the adapter's
// max()/convert wiring is exercised without pinning the live constants.
const GENESIS_S = 1771869600;
const TICK_S = 10800;
let mockNowS = GENESIS_S + TICK_S * 500; // -> floor 10500 ANU
const mockMinGasPriceAnu = vi.fn((t: number) =>
  Math.min(10000 + Math.max(0, Math.floor((t - GENESIS_S) / TICK_S)), 400000),
);
const mockAnuToStoaNumber = vi.fn((anu: number) =>
  Number("0." + String(anu).padStart(12, "0")),
);
const mockStoaGasMeta = vi.fn(() => ({
  creationTime: mockNowS,
  gasPrice: mockAnuToStoaNumber(mockMinGasPriceAnu(mockNowS)),
}));

vi.mock("@stoachain/stoa-core/gas", () => ({
  calculateAutoGasLimit: mockCalcGas,
  anuToStoa: mockAnuToStoa,
  minGasPriceAnu: mockMinGasPriceAnu,
  anuToStoaNumber: mockAnuToStoaNumber,
  stoaGasMeta: mockStoaGasMeta,
}));
vi.mock("@stoachain/stoa-core/constants", () => ({
  KADENA_NETWORK: mockNetwork,
  getPactUrl: mockGetPactUrl,
}));
vi.mock("@ouronet/ouronet-core/constants", () => ({
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
    expect(typeof rt.gasMeta).toBe("function");
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

describe("createStoachainRuntime — gasMeta (the live gas floor seam)", () => {
  beforeEach(() => {
    mockNowS = GENESIS_S + TICK_S * 500;
    // Scoped reset so a call-count assertion below is meaningful test-to-test —
    // this file has no global clearMocks, so an uncleared spy would accumulate
    // calls from earlier tests in this describe block.
    mockStoaGasMeta.mockClear();
  });

  it("raises a STALE stored price up to the live floor", async () => {
    const rt = await createStoachainRuntime();
    // Stored at the genesis default; the floor has since risen to 10500.
    expect(rt.gasMeta!(10000)).toEqual({
      creationTime: mockNowS,
      gasPrice: Number("0.000000010500"),
    });
  });

  it("leaves an operator-raised price above the floor alone (floor, not cap)", async () => {
    const rt = await createStoachainRuntime();
    expect(rt.gasMeta!(25000).gasPrice).toBe(Number("0.000000025000"));
  });

  it("derives the floor from stoaGasMeta's creationTime — ONE clock read, not two", async () => {
    const rt = await createStoachainRuntime();
    const out = rt.gasMeta!(10000);
    // The floor must be computed against the very creationTime that ships with
    // the price, so a tick boundary can never fall between the two reads. A
    // regression to a second `stoaGasMeta()` call — even one whose result is
    // discarded — would reintroduce exactly that race, so the count itself
    // (not just presence) is the invariant under test.
    expect(mockStoaGasMeta).toHaveBeenCalledTimes(1);
    expect(mockMinGasPriceAnu).toHaveBeenCalledWith(out.creationTime);
  });

  it("tracks the rising floor as the clock advances", async () => {
    const rt = await createStoachainRuntime();
    const before = rt.gasMeta!(10000).gasPrice;
    mockNowS += TICK_S * 10;
    const after = rt.gasMeta!(10000);
    expect(after.gasPrice).toBeGreaterThan(before);
    expect(after.gasPrice).toBe(Number("0.000000010510"));
    expect(after.creationTime).toBe(mockNowS);
  });

  it("converts with anuToStoaNumber, NOT the float-division anuToStoa", async () => {
    const rt = await createStoachainRuntime();
    rt.gasMeta!(10000);
    // `anuToStoa` stays exposed for display, but must never price a signed tx.
    expect(mockAnuToStoaNumber).toHaveBeenCalledWith(10500);
    expect(mockAnuToStoa).not.toHaveBeenCalled();
  });

  it("omitting bufferAnu behaves exactly as before (0.9.0 regression pin)", async () => {
    const rt = await createStoachainRuntime();
    expect(rt.gasMeta!(10000)).toEqual({
      creationTime: mockNowS,
      gasPrice: Number("0.000000010500"),
    });
  });

  it("sums floor+buffer in ANU before the ONE conversion — proves the precision fix", async () => {
    const rt = await createStoachainRuntime();
    // bufferAnu 100 (not 500): with this file's own mockAnuToStoaNumber
    // formula, `mockAnuToStoaNumber(10500) + mockAnuToStoaNumber(500)` happens
    // to be bit-identical to the single-conversion form for THIS pair (500
    // does not land in the ~1-in-5 divergent set the design doc measured for
    // the real anuToStoaNumber), so it can't distinguish a correct
    // implementation from the buggy two-call one. 100 does diverge under this
    // mock (verified: mockAnuToStoaNumber(10600) !==
    // mockAnuToStoaNumber(10500) + mockAnuToStoaNumber(100)), so it is the
    // value that actually exercises the regression this test exists to pin.
    const out = rt.gasMeta!(10000, 100);
    // The correct behaviour: ONE conversion of the pre-summed ANU total.
    expect(out.gasPrice).toBe(mockAnuToStoaNumber(10500 + 100));
    // The bug this pins against: summing two independently-converted STOA
    // floats produces a different serialized value than the single-conversion
    // form above — asserting inequality is what actually catches a regression
    // back to the buggy two-call form.
    expect(out.gasPrice).not.toBe(
      mockAnuToStoaNumber(10500) + mockAnuToStoaNumber(100),
    );
  });

  it("clamps a NEGATIVE buffer to 0 — never prices below the live floor", async () => {
    const rt = await createStoachainRuntime();
    // A negative buffer must never be able to pull the shipped price below
    // the live floor: it is treated as no premium at all, not a discount.
    expect(rt.gasMeta!(0, -500)).toEqual({
      creationTime: mockNowS,
      gasPrice: mockAnuToStoaNumber(10500),
    });
  });

  it("clamps a non-finite buffer (NaN/Infinity) to 0", async () => {
    const rt = await createStoachainRuntime();
    expect(rt.gasMeta!(0, NaN).gasPrice).toBe(mockAnuToStoaNumber(10500));
    expect(rt.gasMeta!(0, Infinity).gasPrice).toBe(mockAnuToStoaNumber(10500));
    expect(rt.gasMeta!(0, -Infinity).gasPrice).toBe(mockAnuToStoaNumber(10500));
  });
});
