import { describe, it, expect } from "vitest";

import { formatStepResult, stableStringify } from "./step-result-text.js";

describe("stableStringify", () => {
  it("sorts object keys so two structurally-equal objects stringify identically regardless of build order", () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { a: 2, c: { y: 2, z: 1 }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify(a)).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}');
  });

  it("sorts keys inside array elements too, not just top-level objects", () => {
    const value = [{ b: 1, a: 2 }, { d: 1, c: 2 }];
    expect(stableStringify(value)).toBe('[{"a":2,"b":1},{"c":2,"d":1}]');
  });

  it("passes primitives through unchanged", () => {
    expect(stableStringify("50.0")).toBe('"50.0"');
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify(null)).toBe("null");
  });
});

describe("formatStepResult", () => {
  it("renders an ok step with a yield as 'Name · Step k/N · ok · yields <name> = <json>'", () => {
    const line = formatStepResult({
      cronotonName: "Nightly chain",
      stepIndex: 0,
      totalSteps: 3,
      ok: true,
      yieldAs: "amount",
      yielded: "50.0",
    });
    expect(line).toBe('Nightly chain · Step 1/3 · ok · yields amount = "50.0"');
  });

  it("renders an ok step with NO yield as 'Name · Step k/N · ok' (no trailing yields clause)", () => {
    const line = formatStepResult({
      cronotonName: "Nightly chain",
      stepIndex: 1,
      totalSteps: 3,
      ok: true,
    });
    expect(line).toBe("Nightly chain · Step 2/3 · ok");
  });

  it("omits the yields clause when yieldAs is set but yielded is undefined (no value was actually captured)", () => {
    const line = formatStepResult({
      cronotonName: "Nightly chain",
      stepIndex: 1,
      totalSteps: 3,
      ok: true,
      yieldAs: "amount",
      yielded: undefined,
    });
    expect(line).toBe("Nightly chain · Step 2/3 · ok");
  });

  it("renders a failed step with an error as 'Name · Step k/N · FAILED · <error>'", () => {
    const line = formatStepResult({
      cronotonName: "Nightly chain",
      stepIndex: 2,
      totalSteps: 3,
      ok: false,
      error: "insufficient funds",
    });
    expect(line).toBe("Nightly chain · Step 3/3 · FAILED · insufficient funds");
  });

  it("renders a failed step with no error text as 'Name · Step k/N · FAILED' (no trailing separator)", () => {
    const line = formatStepResult({
      cronotonName: "Nightly chain",
      stepIndex: 2,
      totalSteps: 3,
      ok: false,
    });
    expect(line).toBe("Nightly chain · Step 3/3 · FAILED");
  });

  it("falls back to 'Cronoton' when cronotonName is blank or whitespace-only", () => {
    expect(formatStepResult({ cronotonName: "", stepIndex: 0, totalSteps: 1, ok: true })).toBe(
      "Cronoton · Step 1/1 · ok",
    );
    expect(formatStepResult({ cronotonName: "   ", stepIndex: 0, totalSteps: 1, ok: true })).toBe(
      "Cronoton · Step 1/1 · ok",
    );
    expect(formatStepResult({ stepIndex: 0, totalSteps: 1, ok: true })).toBe("Cronoton · Step 1/1 · ok");
  });

  it("produces a byte-identical line for the same inputs across repeated calls (determinism)", () => {
    const input = {
      cronotonName: "Drain chain",
      stepIndex: 1,
      totalSteps: 2,
      ok: true,
      yieldAs: "drained",
      yielded: { amount: "12.5", account: "k:alice" },
    };
    expect(formatStepResult(input)).toBe(formatStepResult({ ...input }));
  });
});
