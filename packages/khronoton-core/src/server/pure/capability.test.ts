/**
 * capability — pure helper pins carried verbatim from the AncientHoldings hub
 * executor unit suite (tests/unit/codex-cronoton/executor.test.ts:148-192).
 *
 * `parseCapabilityLine` turns a capability line into `{ name, args }`; the
 * F-006 case pins the KNOWN ported limitation that a negative numeric arg
 * encodes as the STRING `'-1'` (the int/decimal regexes both reject `-1`, so
 * it falls through to the raw-token branch). `computeTerminalIntent` pins the
 * one-time/recurring × fire/simulate × ok matrix.
 */
import { describe, it, expect } from "vitest";

import { parseCapabilityLine, computeTerminalIntent } from "./capability.js";

describe("parseCapabilityLine", () => {
  it("parses a parenthesized cap with quoted, int, and decimal args", () => {
    const r = parseCapabilityLine('(coin.TRANSFER "from" "to" 5)');
    expect(r).toEqual({ name: "coin.TRANSFER", args: ["from", "to", { int: 5 }] });
  });

  it("parses a decimal arg into a Pact decimal object", () => {
    const r = parseCapabilityLine("(coin.GAS_PAYER 0.5)");
    expect(r).toEqual({ name: "coin.GAS_PAYER", args: [{ decimal: "0.5" }] });
  });

  it("parses a bare dotted name with no args", () => {
    expect(parseCapabilityLine("coin.GAS")).toEqual({ name: "coin.GAS", args: [] });
  });

  it("returns null for an unparseable bare token (no dot, no parens)", () => {
    expect(parseCapabilityLine("GARBAGE")).toBeNull();
  });

  it("(F-006) encodes a negative numeric arg as a STRING, not a number (ported limitation)", () => {
    const r = parseCapabilityLine("(m.CAP -1)");
    expect(r).toEqual({ name: "m.CAP", args: ["-1"] });
    expect(typeof r!.args[0]).toBe("string");
  });
});

describe("computeTerminalIntent", () => {
  it("one-time + fire + success → completed/clearNextFire", () => {
    expect(computeTerminalIntent("one-time", "fire", true)).toEqual({
      status: "completed",
      clearNextFire: true,
    });
  });
  it("one-time + fire + failure → error/clearNextFire", () => {
    expect(computeTerminalIntent("one-time", "fire", false)).toEqual({
      status: "error",
      clearNextFire: true,
    });
  });
  it("recurring + fire → null", () => {
    expect(computeTerminalIntent("recurring", "fire", true)).toBeNull();
  });
  it("any + simulate → null", () => {
    expect(computeTerminalIntent("one-time", "simulate", true)).toBeNull();
  });
});
