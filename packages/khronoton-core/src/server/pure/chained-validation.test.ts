/**
 * Pure tests for the chained-cronoton validation rule set (no DB, no chain, no
 * I/O — the functions are zero-import). Covers the yield graph (uniqueness +
 * earlier-only references), the decimal-amount tripwire, the single-tx variant
 * gate, and the recursive `$yield` ref collector. Return shape is asserted to be
 * exactly `{ ok: true }` / `{ ok: false, reason }`.
 */
import { describe, expect, it } from "vitest";

import {
  collectYieldRefs,
  findBadDecimalAmount,
  validateChain,
  validateSingleTxVariant,
  type ChainedStepInput,
} from "./chained-validation.js";

describe("validateChain — a valid 2-step chain passes", () => {
  it("accepts two single steps where step 1 references step 0's EARLIER yield", () => {
    const steps: ChainedStepInput[] = [
      { mode: "single", pactCode: "(+ 1 2)", yieldAs: "drained", payload: { amount: "50.0" } },
      { mode: "single", pactCode: "(foo)", payload: { amount: { $yield: "drained" } } },
    ];
    expect(validateChain(steps)).toEqual({ ok: true });
  });
});

describe("validateChain — a $yield ref to a NON-earlier step fails", () => {
  it("rejects a forward reference (step 0 references a yield declared by step 1)", () => {
    const steps: ChainedStepInput[] = [
      { mode: "single", pactCode: "(a)", payload: { x: { $yield: "later" } } },
      { mode: "single", pactCode: "(b)", yieldAs: "later" },
    ];
    const r = validateChain(steps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/EARLIER/);
  });

  it("rejects a self reference (a step referencing its own yield)", () => {
    const steps: ChainedStepInput[] = [
      { mode: "single", pactCode: "(a)", yieldAs: "self", payload: { x: { $yield: "self" } } },
    ];
    const r = validateChain(steps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/EARLIER/);
  });

  it("rejects a dangling reference (no step declares it)", () => {
    const steps: ChainedStepInput[] = [
      { mode: "single", pactCode: "(a)", payload: { x: { $yield: "ghost" } } },
    ];
    const r = validateChain(steps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no step declares/);
  });
});

describe("validateChain — yieldAs uniqueness", () => {
  it("rejects two steps declaring the same yieldAs name", () => {
    const steps: ChainedStepInput[] = [
      { mode: "single", pactCode: "(a)", yieldAs: "dup" },
      { mode: "single", pactCode: "(b)", yieldAs: "dup" },
    ];
    const r = validateChain(steps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/already declared/);
  });
});

describe("validateChain — structural guards", () => {
  it("rejects an empty step list", () => {
    expect(validateChain([])).toEqual({ ok: false, reason: expect.stringMatching(/at least one step/) });
  });

  it("rejects a single step with a blank pactCode", () => {
    const r = validateChain([{ mode: "single", pactCode: "   " }]);
    expect(r.ok).toBe(false);
  });

  it("rejects a planner step with no plannerName", () => {
    const r = validateChain([{ mode: "planner" }]);
    expect(r.ok).toBe(false);
  });

  it("surfaces a bad decimal amount in a step payload", () => {
    const steps: ChainedStepInput[] = [{ mode: "single", pactCode: "(a)", payload: { amount: "50" } }];
    const r = validateChain(steps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Pact decimal/);
  });
});

describe("findBadDecimalAmount — bare-integer-under-amount tripwire", () => {
  it("flags a bare-integer string under an amount key, naming the offender", () => {
    expect(findBadDecimalAmount({ amount: "50" })).toBe('amount="50"');
  });

  it("passes a proper Pact decimal string", () => {
    expect(findBadDecimalAmount({ amount: "50.0" })).toBeNull();
  });

  it("is case-insensitive about the key (*amount*)", () => {
    expect(findBadDecimalAmount({ transferAmount: "7" })).toBe('transferAmount="7"');
  });

  it("ignores a $yield ref even under an amount key (the engine resolves it)", () => {
    expect(findBadDecimalAmount({ amount: { $yield: "drained" } })).toBeNull();
  });

  it("walks nested arrays/objects to find the offender", () => {
    expect(findBadDecimalAmount({ a: [{ b: { amount: "9" } }] })).toBe('amount="9"');
  });
});

describe("validateSingleTxVariant — the one-shot variant gate", () => {
  it("rejects an obviously invalid variant (empty pact body)", () => {
    const r = validateSingleTxVariant({ pactCode: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/non-empty single-tx Pact body/);
  });

  it("accepts a valid one-shot tx", () => {
    expect(validateSingleTxVariant({ pactCode: "(let ((x 1)) x)" })).toEqual({ ok: true });
  });

  it("rejects a $yield placeholder (a single tx has no run to carry yields)", () => {
    const r = validateSingleTxVariant({ pactCode: "(bundle)", payload: { x: { $yield: "d" } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/\$yield/);
  });

  it("still catches a bad decimal amount in the variant payload", () => {
    const r = validateSingleTxVariant({ pactCode: "(bundle)", payload: { amount: "50" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Pact decimal/);
  });
});

describe("collectYieldRefs — recursive ref collection", () => {
  it("finds refs nested in objects and arrays", () => {
    const refs = collectYieldRefs({ a: { b: [{ $yield: "one" }, { c: { $yield: "two" } }] } });
    expect(refs).toEqual(new Set(["one", "two"]));
  });

  it("treats a $yield object as a leaf (does not recurse into it)", () => {
    // If it recursed, it would still only see the string "x"; this documents the
    // leaf behavior: exactly the one name is collected.
    expect(collectYieldRefs({ $yield: "x" })).toEqual(new Set(["x"]));
  });

  it("returns an empty set when there is no ref anywhere", () => {
    expect(collectYieldRefs({ a: 1, b: "x", c: [1, 2, { d: true }] })).toEqual(new Set());
  });

  it("does NOT collect a $yield-plus-extra-keys object as a ref (matches isYieldPlaceholder's exact single-key shape)", () => {
    // yields.ts's isYieldPlaceholder only treats {"$yield":"..."} (exactly one
    // key) as a resolvable placeholder; a sibling key makes it an ordinary
    // object at resolve time. collectYieldRefs must agree, or author-time
    // validation vouches for a reference the engine will never substitute.
    expect(collectYieldRefs({ $yield: "name", extra: "x" })).toEqual(new Set());
  });
});

describe("findBadDecimalAmount — agrees with isYieldPlaceholder's exact single-key shape", () => {
  it("does not let a malformed $yield-plus-extra-keys object mask a genuinely bad decimal sibling", () => {
    // {"$yield":"x","amount":"7"} is NOT a valid placeholder (extra key), so it
    // must be recursed into like any other object — surfacing the bad "amount".
    expect(findBadDecimalAmount({ $yield: "x", amount: "7" })).toBe('amount="7"');
  });
});

describe("validateChain — mirrors isYieldPlaceholder's exact single-key $yield shape", () => {
  it("rejects a chain whose malformed $yield object hides a bad decimal amount behind an extra key", () => {
    // Previously `findBadDecimalAmount`'s loose `typeof obj.$yield === "string"`
    // check short-circuited on this object (treating it as an innocuous ref)
    // and never saw the sibling "amount":"7" at all, so the chain wrongly passed.
    const steps: ChainedStepInput[] = [
      { mode: "single", pactCode: "(a)", payload: { outer: { $yield: "x", amount: "7" } } },
    ];
    const r = validateChain(steps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Pact decimal/);
  });
});

describe("validateChain — structural guards (mode)", () => {
  it("rejects a step with an invalid mode", () => {
    const r = validateChain([{ mode: "bogus" } as unknown as ChainedStepInput]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/mode must be/);
  });
});
