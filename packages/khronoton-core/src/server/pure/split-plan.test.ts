/**
 * split-plan — Phase 4.1's port of OuronetUI's `measureSplit.ts` (handoff:
 * `docs/work/khronoton-chained-runs-phase-4.1/design.md` §B). Each probe
 * is a hand-written fake (no DB, no chain client) that counts its own
 * calls, so these tests pin the exact probe sequence/count the real
 * source's own "bounded probe count" guarantee depends on, not just the
 * final answer.
 */
import { describe, it, expect } from "vitest";

import {
  evenSplit,
  measureSize,
  planFromSizing,
  splitPlan,
} from "./split-plan.js";
import type { ProbeOutcome, SplitSizing } from "./split-plan.js";

const CEILING = 2_000_000;

describe("splitPlan — a single item that fits (1 probe total)", () => {
  it("returns batches:[[item]] and probes the item exactly once", async () => {
    let calls = 0;
    const probe = async (): Promise<ProbeOutcome> => {
      calls++;
      return { ok: true, gas: 100 };
    };

    const result = await splitPlan(["only"], probe, CEILING);

    expect(result).toEqual({
      ok: true,
      batches: [["only"]],
      worstBatchGas: 100,
      estimatedTotalGas: 100,
      model: { fixed: 0, perItem: 100 },
      probes: 1,
    });
    expect(calls).toBe(1);
  });
});

describe("splitPlan — zero items (measureSize's synthetic n===0 branch, never probed)", () => {
  it("returns the synthetic ok:true/empty-batch shape without ever calling probe", async () => {
    let calls = 0;
    const probe = async (): Promise<ProbeOutcome> => {
      calls++;
      return { ok: true, gas: 100 };
    };

    const result = await splitPlan([], probe, CEILING);

    expect(result).toEqual({
      ok: true,
      batches: [[]],
      worstBatchGas: 0,
      estimatedTotalGas: 0,
      model: { fixed: 0, perItem: 0 },
      probes: 0,
    });
    expect(calls).toBe(0);
  });
});

describe("measureSize — a >1-item selection whose sample probe covers the whole selection and fits (fitsInOne via the sample, not the n===1 short-circuit)", () => {
  it("returns fitsInOne:true with the sample's measured gas, having spent exactly 2 probes", async () => {
    // n=10 <= SAMPLE_SIZE(64), so sampleN === n: the sample probe covers the
    // WHOLE selection, distinct from the dedicated n===1 short-circuit
    // (measureSize.ts lines ~238-249) and from the n>SAMPLE_SIZE path the
    // "200 items" test below exercises.
    const probe = async (batch: readonly unknown[]): Promise<ProbeOutcome> => {
      if (batch.length === 1) return { ok: true, gas: 1_000 };
      if (batch.length === 10) return { ok: true, gas: 10_000 };
      throw new Error(`unexpected probe batch size ${batch.length}`);
    };
    const items = Array.from({ length: 10 }, (_, i) => i);

    const sizing = await measureSize(items, probe, CEILING);

    expect(sizing).toEqual({
      ok: true,
      fitsInOne: true,
      measuredGas: 10_000,
      // lineThrough({1,1000},{10,10000}): slope=(10000-1000)/9=1000, fixed=1000-1000=0
      estimatedTotalGas: 10_000,
      estimatedTransactions: 1,
      model: { fixed: 0, perItem: 1_000 },
      probes: 2,
      readings: { one: { n: 1, gas: 1_000 }, sample: { n: 10, gas: 10_000 } },
    });
  });
});

describe("measureSize + planFromSizing — 200 items, sample doesn't cover the selection, confirms immediately", () => {
  it("sizes to estimatedTransactions > 1, then packs into evenly-sized batches in one more probe", async () => {
    // A perfectly linear fake cost model (gas = 10,000/item, no fixed cost) so
    // every probe at every batch size, including the eventual growth-refit
    // probe candidate, is governed by one formula instead of hand-picked
    // per-call canned values.
    let calls = 0;
    const probe = async (batch: readonly unknown[]): Promise<ProbeOutcome> => {
      calls++;
      return { ok: true, gas: batch.length * 10_000 };
    };

    const items = Array.from({ length: 200 }, (_, i) => i);

    const sizing = await measureSize(items, probe, CEILING);
    expect(sizing.ok).toBe(true);
    const sized = sizing as Extract<SplitSizing, { ok: true }>;
    expect(sized.fitsInOne).toBe(false);
    // capacity 184 (see the exact-value comment below) -> ceil(200/184) = 2.
    expect(sized.estimatedTransactions).toBe(2);
    expect(calls).toBe(2); // probe(1 item), probe(64-item sample)

    const result = await planFromSizing(items, sized, probe, CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Pins the exact result this linear model/ceiling combination must
    // produce (capacity 184 -> evenSplit(200,2)=[100,100], confirmed at
    // 1,000,000 gas, growth loop breaks without spending a probe since
    // capacityFor at the 0.99 margin still rounds to the same 2 batches) —
    // a looser length/balance/sum check would also pass a capacity/margin
    // regression that happened to still produce a different, still-balanced
    // batch count.
    expect(result.batches).toEqual([items.slice(0, 100), items.slice(100, 200)]);
    expect(result.worstBatchGas).toBe(1_000_000);
    // Exactly one more probe than measureSize already spent — the
    // confirmation call succeeds on its first attempt, so the shrink loop
    // never runs and the growth loop breaks before spending a probe
    // (planAt(grown) still rounds to the same batch count).
    expect(calls).toBe(3);
  });
});

describe("planFromSizing — a confirmation probe that refuses once, then succeeds after shrinking", () => {
  it("still returns ok:true, having actually exercised the shrink-and-retry loop", async () => {
    const calls: number[] = [];
    const probe = async (batch: readonly unknown[]): Promise<ProbeOutcome> => {
      calls.push(batch.length);
      if (batch.length === 1) return { ok: true, gas: 5_000 };
      if (batch.length === 64) return { ok: true, gas: 893_300 };
      // First confirmation attempt: the whole 100-item selection as one
      // batch (capacity 130 > n), refused by the chain.
      if (batch.length === 100) return { ok: false, floor: 1_900_000 };
      // Second confirmation attempt, after capacity shrinks 130 -> 97: a
      // 50-item batch, which succeeds.
      if (batch.length === 50) return { ok: true, gas: 1_960_000 };
      throw new Error(`unexpected probe batch size ${batch.length}`);
    };

    const items = Array.from({ length: 100 }, (_, i) => i);

    const sizing = await measureSize(items, probe, CEILING);
    expect(sizing.ok).toBe(true);
    const sized = sizing as Extract<SplitSizing, { ok: true }>;

    const result = await planFromSizing(items, sized, probe, CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.batches).toEqual([
      items.slice(0, 50),
      items.slice(50, 100),
    ]);
    expect(result.worstBatchGas).toBe(1_960_000);
    // probe(1), probe(64), probe(100) [refused], probe(50) [confirmed] —
    // the shrink-and-retry loop genuinely ran exactly once.
    expect(calls).toEqual([1, 64, 100, 50]);
  });
});

describe("planFromSizing — the growth loop's success path: a probe at a larger capacity succeeds and replaces `best` with fewer, larger batches", () => {
  it("adopts the grown plan, dropping from 3 confirmed batches to 2", async () => {
    // Every value below is hand-picked (not derived from a formula) so the
    // growth loop's refit — lineThrough({1, one.gas}, {best.size, best.gas})
    // — produces a materially roomier model than the initial sizing line,
    // giving `grown` (margin 0.99) genuine extra capacity over the first
    // confirmed batch size (67), enough that planAt(grown) rounds down to 2
    // batches instead of 3. This is the exact mechanism (an anchored refit
    // through a REAL measurement replacing an extrapolated two-point line)
    // the growth loop exists for — see split-plan.ts's own comment on the
    // `fitted` reassignment.
    const calls: number[] = [];
    const probe = async (batch: readonly unknown[]): Promise<ProbeOutcome> => {
      calls.push(batch.length);
      if (batch.length === 1) return { ok: true, gas: 10_000 };
      if (batch.length === 64) return { ok: true, gas: 1_648_000 };
      // First confirmation attempt: capacity 70 -> evenSplit(200, 3) -> [67, 67, 66].
      if (batch.length === 67) return { ok: true, gas: 1_000_000 };
      // Growth attempt 1: refit through (1, 67) gives capacity 132 ->
      // evenSplit(200, 2) -> [100, 100], fewer batches than 3, so the loop
      // probes it. It succeeds, and `best` is replaced.
      if (batch.length === 100) return { ok: true, gas: 1_900_000 };
      throw new Error(`unexpected probe batch size ${batch.length}`);
    };

    const items = Array.from({ length: 200 }, (_, i) => i);

    const sizing = await measureSize(items, probe, CEILING);
    expect(sizing.ok).toBe(true);
    const sized = sizing as Extract<SplitSizing, { ok: true }>;
    expect(sized.estimatedTransactions).toBe(3);

    const result = await planFromSizing(items, sized, probe, CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // The growth loop's own success — 2 batches, not the 3 the initial
    // confirmation settled on — and `worstBatchGas` reflects the GROWN
    // probe's measurement (1,900,000), not the superseded 67-item one.
    expect(result.batches).toHaveLength(2);
    expect(result.batches.map((b) => b.length)).toEqual([100, 100]);
    expect(result.worstBatchGas).toBe(1_900_000);
    // probe(1), probe(64) [sizing] ; probe(67) [confirm] ; probe(100)
    // [growth attempt 1, succeeds]. Growth attempt 2 (MAX_GROWTHS=2) breaks
    // on "no fewer batches than what's already confirmed" before spending a
    // probe — exactly as the non-growth test above documents for a
    // different model.
    expect(calls).toEqual([1, 64, 67, 100]);
    expect(result.probes).toBe(4);
  });
});

describe("planFromSizing — the growth loop's refusal branch: a probe at a larger capacity is refused, and the previously confirmed plan is left standing", () => {
  it("keeps the 3-batch confirmed plan when the growth attempt is refused", async () => {
    const calls: number[] = [];
    const probe = async (batch: readonly unknown[]): Promise<ProbeOutcome> => {
      calls.push(batch.length);
      if (batch.length === 1) return { ok: true, gas: 10_000 };
      if (batch.length === 64) return { ok: true, gas: 1_648_000 };
      if (batch.length === 67) return { ok: true, gas: 1_000_000 };
      // Same growth candidate as the success test above (100 items), but
      // this time the chain refuses it — proving the loop does NOT adopt a
      // refused growth probe's (nonexistent) measurement, and leaves the
      // already-confirmed 67-item-batch plan exactly as it was.
      if (batch.length === 100) return { ok: false, floor: 1_999_999 };
      throw new Error(`unexpected probe batch size ${batch.length}`);
    };

    const items = Array.from({ length: 200 }, (_, i) => i);

    const sizing = await measureSize(items, probe, CEILING);
    expect(sizing.ok).toBe(true);
    const sized = sizing as Extract<SplitSizing, { ok: true }>;

    const result = await planFromSizing(items, sized, probe, CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Unchanged from the first confirmation — the refused growth attempt
    // never replaces `best`.
    expect(result.batches).toHaveLength(3);
    expect(result.batches.map((b) => b.length)).toEqual([67, 67, 66]);
    expect(result.worstBatchGas).toBe(1_000_000);
    // The refused growth probe still COUNTS (probes increments before the
    // outcome is known) even though its measurement is discarded.
    expect(calls).toEqual([1, 64, 67, 100]);
    expect(result.probes).toBe(4);
  });
});

describe("planFromSizing — the growth loop runs BOTH of its MAX_GROWTHS=2 iterations, each a successful probe that replaces `best` again", () => {
  it("adopts the second growth's plan too, dropping from 4 batches to 3 to 2", async () => {
    // Distinct hand-picked numbers from the other growth tests, specifically
    // engineered so growth attempt 0's refit leaves ENOUGH extra room that
    // growth attempt 1's refit (through best.size=100, not the original
    // sample) still finds a fewer-batches candidate (2, down from 3) — the
    // other two growth tests both stop after one iteration (one succeeds
    // once then the second iteration finds no further gain; the other is
    // refused on its first attempt), so neither exercises a SECOND
    // successful growth probe actually running and replacing `best` again.
    const calls: number[] = [];
    const probe = async (batch: readonly unknown[]): Promise<ProbeOutcome> => {
      calls.push(batch.length);
      if (batch.length === 1) return { ok: true, gas: 23_000 };
      if (batch.length === 64) return { ok: true, gas: 1_472_000 };
      // Confirmation: capacity 80 -> evenSplit(300, 4) -> four 75-item batches.
      if (batch.length === 75) return { ok: true, gas: 1_000_000 };
      // Growth attempt 1: refit through (1, 75) gives capacity ~149 ->
      // evenSplit(300, 3) -> three 100-item batches (fewer than 4).
      if (batch.length === 100) return { ok: true, gas: 1_200_000 };
      // Growth attempt 2: refit through (1, 100) gives capacity ~165 ->
      // evenSplit(300, 2) -> two 150-item batches (fewer than 3). This is
      // the probe the other two growth tests never reach.
      if (batch.length === 150) return { ok: true, gas: 1_900_000 };
      throw new Error(`unexpected probe batch size ${batch.length}`);
    };

    const items = Array.from({ length: 300 }, (_, i) => i);

    const sizing = await measureSize(items, probe, CEILING);
    expect(sizing.ok).toBe(true);
    const sized = sizing as Extract<SplitSizing, { ok: true }>;
    expect(sized.estimatedTransactions).toBe(4);

    const result = await planFromSizing(items, sized, probe, CEILING);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // The SECOND growth's plan — 2 batches, not the 3 the first growth
    // settled on, and not the 4 the initial confirmation settled on.
    expect(result.batches).toHaveLength(2);
    expect(result.batches.map((b) => b.length)).toEqual([150, 150]);
    expect(result.worstBatchGas).toBe(1_900_000);
    // probe(1), probe(64) [sizing]; probe(75) [confirm]; probe(100) [growth
    // 1, succeeds]; probe(150) [growth 2, succeeds] — both MAX_GROWTHS=2
    // iterations actually ran a probe and both replaced `best`.
    expect(calls).toEqual([1, 64, 75, 100, 150]);
    expect(result.probes).toBe(5);
  });
});

describe("measureSize — a single item probe that is refused outright (not merely over ceiling)", () => {
  it("returns ok:false quoting the refusal floor, spending exactly 1 probe", async () => {
    const probe = async (): Promise<ProbeOutcome> => ({ ok: false, floor: 123 });

    const sizing = await measureSize(["only"], probe, CEILING);

    expect(sizing).toEqual({
      ok: false,
      probes: 1,
      reason: "a single item could not be simulated (the chain stopped at 123 gas).",
    });
  });
});

describe("measureSize — the sample-batch probe is refused after the one-item probe succeeds", () => {
  it("returns ok:false quoting the refusal floor, spending exactly 2 probes", async () => {
    const probe = async (batch: readonly unknown[]): Promise<ProbeOutcome> => {
      if (batch.length === 1) return { ok: true, gas: 10_000 };
      return { ok: false, floor: 50_000 };
    };
    const items = Array.from({ length: 200 }, (_, i) => i);

    const sizing = await measureSize(items, probe, CEILING);

    expect(sizing).toEqual({
      ok: false,
      probes: 2,
      reason: "a 64-item sample could not be simulated (the chain stopped at 50,000 gas). Try a smaller selection.",
    });
  });
});

describe("measureSize — the fixed cost alone leaves no room under the ceiling (capacity < 1)", () => {
  it("returns ok:false with the infeasible shape, without ever probing the full selection", async () => {
    // one.gas and the 64-item sample are both comfortably under ceiling on
    // their own, but the FITTED fixed cost (~1,999,998) consumes nearly all
    // of it, leaving `capacityFor` no room for even a single item once the
    // 0.92 planning margin is applied.
    const probe = async (batch: readonly unknown[]): Promise<ProbeOutcome> => {
      if (batch.length === 1) return { ok: true, gas: 1_999_999 };
      if (batch.length === 64) return { ok: true, gas: 2_000_062 };
      throw new Error(`unexpected probe batch size ${batch.length}`);
    };
    const items = Array.from({ length: 65 }, (_, i) => i);

    const sizing = await measureSize(items, probe, CEILING);

    expect(sizing).toEqual({
      ok: false,
      probes: 2,
      // round(model.fixed + model.perItem * n) = round(1,999,998 + 1*65)
      estimatedTotalGas: 2_000_063,
      infeasible: { singleItemGas: 1_999_999, ceiling: CEILING },
      reason:
        "the fixed cost of one transaction (about 1,999,998 gas) leaves no room under the 2,000,000 limit. This operation needs a multi-step route.",
    });
  });
});

describe("planFromSizing — capacity < 1 reached directly (a sizing whose model leaves no room), never spending a probe", () => {
  it("returns ok:false with the infeasible shape, and the probe is never called", async () => {
    // Constructed by hand rather than produced by measureSize: measureSize
    // would already have refused a model this tight (see the test above),
    // so the only way to exercise planFromSizing's OWN capacity<1 guard
    // (lines ~332-344) in isolation is to hand it a sizing object directly
    // — legitimate per split-plan.ts's own doc comment on why
    // `planFromSizing` is exported standalone from `measureSize`.
    const sizing: Extract<SplitSizing, { ok: true }> = {
      ok: true,
      fitsInOne: false,
      measuredGas: null,
      estimatedTotalGas: 5_000_000,
      estimatedTransactions: 3,
      model: { fixed: 1_999_999, perItem: 1 },
      probes: 2,
      readings: { one: { n: 1, gas: 1_999_999 }, sample: { n: 64, gas: 2_000_062 } },
    };
    const probe = async (): Promise<ProbeOutcome> => {
      throw new Error("must not be called — capacity<1 should return before any probe");
    };
    const items = Array.from({ length: 200 }, (_, i) => i);

    const result = await planFromSizing(items, sizing, probe, CEILING);

    expect(result).toEqual({
      ok: false,
      probes: 2,
      estimatedTotalGas: 5_000_000,
      infeasible: { singleItemGas: 1_999_999, ceiling: CEILING },
      reason:
        "the fixed cost of one transaction (about 1,999,999 gas) leaves no room under the 2,000,000 limit. This operation needs a multi-step route.",
    });
  });
});

describe("planFromSizing — the confirmation loop exhausts all MAX_CONFIRMATIONS attempts without ever confirming a batch", () => {
  it("returns ok:false after shrinking 3 times, having spent exactly 3 confirmation probes", async () => {
    const calls: number[] = [];
    // Refuses every batch, regardless of size, so the shrink-and-retry loop
    // runs all 3 attempts and still never confirms. The underlying CAPACITY
    // shrinks 92 -> 69 -> 51 (floor(capacity * SHRINK) each time), but
    // `planAt` converts capacity to a batch COUNT first (Math.ceil(n /
    // capacity)) and then evenly splits — so the actual batch length handed
    // to `probe` is [67, 67, 50], not [92, 69, 51]: capacities 92 and 69
    // both round up to the same 3-batch split (evenSplit(200,3)=[67,67,66],
    // largest 67), and only the third shrink (to 51) changes the batch
    // count to 4 (evenSplit(200,4)=[50,50,50,50], largest 50).
    const probe = async (batch: readonly unknown[]): Promise<ProbeOutcome> => {
      calls.push(batch.length);
      return { ok: false, floor: 1_999_999 };
    };
    const sizing: Extract<SplitSizing, { ok: true }> = {
      ok: true,
      fitsInOne: false,
      measuredGas: null,
      estimatedTotalGas: 4_000_000,
      estimatedTransactions: 3,
      model: { fixed: 0, perItem: 20_000 },
      probes: 2,
      readings: { one: { n: 1, gas: 10_000 }, sample: { n: 64, gas: 1_280_000 } },
    };
    const items = Array.from({ length: 200 }, (_, i) => i);

    const result = await planFromSizing(items, sizing, probe, CEILING);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe(
      "could not confirm a batch size under 2,000,000 gas after 5 simulation(s). Try a smaller selection.",
    );
    expect(result.probes).toBe(5); // sizing's 2 + 3 confirmation attempts, all refused
    // Pins the actual shrink-and-retry sequence (not just the attempt
    // count) so a broken SHRINK constant that still happened to refuse 3
    // times for an unrelated reason would be caught here.
    expect(calls).toEqual([67, 67, 50]);
  });
});

describe("measureSize — a single item over the ceiling is infeasible, and splitPlan propagates the failure", () => {
  it("never throws; returns ok:false with the infeasible shape", async () => {
    const probe = async (): Promise<ProbeOutcome> => ({ ok: true, gas: 3_000_000 });

    const sizing = await measureSize(["only"], probe, CEILING);
    expect(sizing).toEqual({
      ok: false,
      probes: 1,
      estimatedTotalGas: 3_000_000,
      infeasible: { singleItemGas: 3_000_000, ceiling: CEILING },
      reason:
        "one item alone costs 3,000,000 gas, over the 2,000,000 a transaction may use. No split can fix that — this operation needs a multi-step route.",
    });

    const result = await splitPlan(["only"], probe, CEILING);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.infeasible).toEqual({ singleItemGas: 3_000_000, ceiling: CEILING });
  });
});

describe("evenSplit — balances batches instead of front-loading the remainder", () => {
  it("evenSplit([1..10], 3) puts the one extra item in the first batch", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(evenSplit(items, 3)).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7],
      [8, 9, 10],
    ]);
  });
});
