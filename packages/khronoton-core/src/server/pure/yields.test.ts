/**
 * yields — the pure `$yield` placeholder resolver
 * (`docs/work/khronoton-step-yield-carry/design.md`'s "Consuming a yield").
 * One `it` per behavior the design's acceptance criteria and T2's own
 * "done when" enumerate: a direct substitution, recursion into nested
 * objects/arrays, a pass-through for a value with no placeholder anywhere
 * (proving zero behavior change for every existing step definition), and
 * the named-error refusal for a yield that was never produced.
 */
import { describe, it, expect } from "vitest";

import { resolveYieldRefs, YieldNotFoundError } from "./yields.js";

describe("resolveYieldRefs — a direct $yield placeholder substitutes the pooled value", () => {
  it('{"amount": {"$yield": "drainedAmount"}} resolves to {"amount": "123.45"}', () => {
    const result = resolveYieldRefs(
      { amount: { $yield: "drainedAmount" } },
      { drainedAmount: "123.45" },
    );
    expect(result).toEqual({ amount: "123.45" });
  });
});

describe("resolveYieldRefs — recursion into nested structures", () => {
  it("resolves a $yield reference nested one object level deep", () => {
    const result = resolveYieldRefs(
      { outer: { inner: { $yield: "x" } } },
      { x: 42 },
    );
    expect(result).toEqual({ outer: { inner: 42 } });
  });

  it("resolves a $yield reference inside an array element", () => {
    const result = resolveYieldRefs(
      { items: ["k:abc", { $yield: "x" }, 7] },
      { x: "resolved" },
    );
    expect(result).toEqual({ items: ["k:abc", "resolved", 7] });
  });
});

describe("resolveYieldRefs — no $yield reference anywhere passes through unchanged", () => {
  it("a step definition with no placeholders returns the same keys/values", () => {
    const value = { patronAccount: "k:abc", amount: "5.0", nested: { a: 1, b: [1, 2, 3] } };
    const result = resolveYieldRefs(value, { unrelated: "ignored" });
    expect(result).toEqual(value);
  });
});

describe("resolveYieldRefs — a never-produced yield name throws YieldNotFoundError", () => {
  it('{"amount": {"$yield": "neverProduced"}} against an empty pool throws, naming "neverProduced"', () => {
    expect(() =>
      resolveYieldRefs({ amount: { $yield: "neverProduced" } }, {}),
    ).toThrow(YieldNotFoundError);
    expect(() =>
      resolveYieldRefs({ amount: { $yield: "neverProduced" } }, {}),
    ).toThrow(/neverProduced/);
  });
});

describe("resolveYieldRefs — regression: never-produced names that collide with Object.prototype members still throw", () => {
  // A real security-review finding: `name in pool` walks the prototype
  // chain, so against ANY plain-object pool (including an empty `{}`
  // literal — exactly what handlers/steps.ts's standalone-fire route
  // passes), "toString"/"constructor"/"valueOf"/"hasOwnProperty" all read
  // as "present" even though no yield by that name was ever produced,
  // silently resolving to a built-in function instead of throwing.
  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "isPrototypeOf"])(
    '{"$yield": "%s"} against an empty {} pool still throws YieldNotFoundError, never resolves to the inherited Object.prototype member',
    (name) => {
      expect(() => resolveYieldRefs({ $yield: name }, {})).toThrow(YieldNotFoundError);
      expect(() => resolveYieldRefs({ $yield: name }, {})).toThrow(new RegExp(name));
    },
  );

  it("a genuinely present own property named one of those reserved names still resolves correctly (the check must distinguish own vs. inherited, not refuse the name outright)", () => {
    const pool = Object.create(null) as Record<string, unknown>;
    pool["toString"] = "a-real-yielded-string";
    expect(resolveYieldRefs({ $yield: "toString" }, pool)).toBe("a-real-yielded-string");
  });
});
