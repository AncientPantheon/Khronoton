/**
 * executor-signers — the gas-payer self-heal invariant (REQ-19), carried
 * verbatim from the AncientHoldings hub executor (executor.ts:57-192) behind the
 * Phase-1 domain types. The three helpers are pure (string / signer-list in,
 * signer-list out) and need NO chain seam: the namespace and gas-station account
 * are plain string params.
 *
 * The gas-station branch synthesizes the RAW capability string
 * `(${namespace}.DALOS.GAS_PAYER "" 0 0.0)`; the parse-into-caps happens
 * downstream in buildTransaction, so these tests assert the raw string, never a
 * parsed form.
 */
import { describe, it, expect } from "vitest";

import {
  stripPrefix,
  deriveSenderAccount,
  effectiveSigners,
} from "./executor-signers.js";
import type { CodexTxDefinition, CodexGasPayer } from "./types.js";

function makeDefinition(
  gasPayer: CodexGasPayer,
  signers: CodexTxDefinition["signers"] = [],
): CodexTxDefinition {
  return {
    pactCode: "(coin.GAS)",
    config: {
      chainId: "1",
      gasPrice: 1,
      gasLimit: 1000,
      autoGasLimit: false,
      ttl: 600,
    },
    payload: {},
    gasPayer,
    signers,
  };
}

describe("stripPrefix", () => {
  it("strips a leading k: prefix so the bare pubkey remains", () => {
    expect(stripPrefix("k:abc123")).toBe("abc123");
  });

  it("returns an address without a k: prefix unchanged", () => {
    expect(stripPrefix("abc123")).toBe("abc123");
  });
});

describe("deriveSenderAccount", () => {
  it("returns the gas-station account constant for a gas-station gas payer", () => {
    const gasPayer: CodexGasPayer = {
      type: "gas-station",
      gasStationSignerKey: "GASKEY",
    };
    expect(deriveSenderAccount(gasPayer, "c:GASSTATION")).toBe("c:GASSTATION");
  });

  it("prefixes a codex address that already lacks a k: with k:", () => {
    const gasPayer: CodexGasPayer = { type: "codex", address: "abc123" };
    expect(deriveSenderAccount(gasPayer, "c:GASSTATION")).toBe("k:abc123");
  });

  it("does not double the k: when the codex address already carries one", () => {
    const gasPayer: CodexGasPayer = { type: "codex", address: "k:abc123" };
    expect(deriveSenderAccount(gasPayer, "c:GASSTATION")).toBe("k:abc123");
  });
});

describe("effectiveSigners", () => {
  it("auto-appends an absent codex gas-payer pubkey as a pure signer", () => {
    const def = makeDefinition({ type: "codex", address: "k:GASPUB" });
    const result = effectiveSigners(def, "ouronet-ns");

    expect(result).toContainEqual({
      publicKey: "GASPUB",
      capabilityMode: "pure",
      capabilities: "",
    });
  });

  it("does not duplicate a codex gas-payer pubkey already among the signers", () => {
    const def = makeDefinition({ type: "codex", address: "k:GASPUB" }, [
      { publicKey: "GASPUB", capabilityMode: "scoped", capabilities: "(coin.GAS)" },
    ]);
    const result = effectiveSigners(def, "ouronet-ns");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      publicKey: "GASPUB",
      capabilityMode: "scoped",
      capabilities: "(coin.GAS)",
    });
  });

  it("synthesizes a scoped GAS_PAYER signer whose raw capabilities string is namespaced", () => {
    const def = makeDefinition({
      type: "gas-station",
      gasStationSignerKey: "GASKEY",
    });
    const result = effectiveSigners(def, "ouronet-ns");

    expect(result).toContainEqual({
      publicKey: "GASKEY",
      capabilityMode: "scoped",
      capabilities: '(ouronet-ns.DALOS.GAS_PAYER "" 0 0.0)',
    });
  });

  it("does not duplicate a gas-station signer key already present among signers", () => {
    const def = makeDefinition(
      { type: "gas-station", gasStationSignerKey: "GASKEY" },
      [{ publicKey: "GASKEY", capabilityMode: "pure", capabilities: "" }],
    );
    const result = effectiveSigners(def, "ouronet-ns");

    expect(result).toHaveLength(1);
  });

  it("throws when a gas-station gas payer has no signing key for the GAS_PAYER cap", () => {
    const def = makeDefinition({ type: "gas-station" });

    expect(() => effectiveSigners(def, "ouronet-ns")).toThrow(
      /Gas-station gas payer requires a signing key/,
    );
  });
});
