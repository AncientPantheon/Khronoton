/**
 * Pure tests for the chained-builder form model (no DB, no chain, no React). The
 * step-list helpers must be pure (never mutate their input array); the
 * serializers must be TOTAL (never throw); and the commit gate must fold every
 * blocking reason. Defaults, the single-vs-planner mapping, and earlier-only
 * yield visibility are pinned to the source behavior.
 */
import { describe, expect, it } from "vitest";

import {
  appendStep,
  canCommitChain,
  chainedBuilderToCommit,
  clearVariantIfOrphaned,
  earlierYields,
  isSingleStepChain,
  KNOWN_PLANNERS,
  makeEmptyChainedBuilderState,
  makeEmptyStepState,
  moveStep,
  removeStep,
  replaceStep,
  selectedAfterMove,
  stepLabel,
  stepStateToStepInput,
  type ChainedBuilderState,
  type StepState,
} from "./chained-builder-state.js";

describe("makeEmptyChainedBuilderState — documented defaults", () => {
  it("empty name/description, external off, no variant, one empty single step", () => {
    const s = makeEmptyChainedBuilderState();
    expect(s.name).toBe("");
    expect(s.description).toBe("");
    expect(s.externalFireable).toBe(false);
    expect(s.singleTxVariant).toBeNull();
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0].mode).toBe("single");
    // Schedule seeded from the single-tx builder's default.
    expect(s.schedule.mode).toBe("daily-at-utc");
  });
});

describe("makeEmptyStepState — defaults per mode", () => {
  it("defaults to a single step with no planner name", () => {
    const s = makeEmptyStepState();
    expect(s.mode).toBe("single");
    expect(s.plannerName).toBe("");
    expect(s.yieldAs).toBe("");
    expect(s.idempotent).toBe(false);
  });

  it("a planner step seeds the first known planner", () => {
    const s = makeEmptyStepState("planner");
    expect(s.mode).toBe("planner");
    expect(s.plannerName).toBe(KNOWN_PLANNERS[0]);
  });
});

describe("appendStep — extends without mutating the input", () => {
  it("appends a fresh step of the given mode and leaves the source untouched", () => {
    const steps = makeEmptyChainedBuilderState().steps;
    const before = steps.length;
    const next = appendStep(steps, "planner");
    expect(next).toHaveLength(before + 1);
    expect(next[next.length - 1].mode).toBe("planner");
    expect(steps).toHaveLength(before); // original unchanged
    expect(next).not.toBe(steps);
  });
});

describe("removeStep / moveStep / replaceStep are pure", () => {
  function threeSteps(): StepState[] {
    return [
      makeEmptyStepState("single"),
      makeEmptyStepState("single"),
      makeEmptyStepState("planner"),
    ];
  }

  it("removeStep returns a new array without the index and keeps the original", () => {
    const steps = threeSteps();
    const snapshot = [...steps];
    const next = removeStep(steps, 1);
    expect(next).toHaveLength(2);
    expect(next).not.toBe(steps);
    expect(next[0]).toBe(steps[0]);
    expect(next[1]).toBe(steps[2]);
    expect(steps).toEqual(snapshot); // input array untouched
  });

  it("removeStep never empties the list (returns the same ref at length 1)", () => {
    const one = [makeEmptyStepState("single")];
    expect(removeStep(one, 0)).toBe(one);
  });

  it("moveStep reorders without mutating the input", () => {
    const steps = threeSteps();
    const snapshot = [...steps];
    const next = moveStep(steps, 0, 1);
    expect(next[0]).toBe(steps[1]);
    expect(next[1]).toBe(steps[0]);
    expect(next).not.toBe(steps);
    expect(steps).toEqual(snapshot);
  });

  it("moveStep out of range returns the same array (clamped)", () => {
    const steps = threeSteps();
    expect(moveStep(steps, 0, -1)).toBe(steps);
    expect(moveStep(steps, 2, 1)).toBe(steps);
  });

  it("replaceStep swaps one slot and keeps the original array", () => {
    const steps = threeSteps();
    const snapshot = [...steps];
    const repl = makeEmptyStepState("planner");
    const next = replaceStep(steps, 2, repl);
    expect(next[2]).toBe(repl);
    expect(next).not.toBe(steps);
    expect(steps).toEqual(snapshot);
  });
});

describe("selectedAfterMove — follows the moved step's content so the editor pane doesn't silently desync", () => {
  // Regression: ChainedBuilder's onMove used to reorder `steps` without ever
  // touching `selected`, so after e.g. moving the selected step up, the still-
  // selected OLD index pointed at a DIFFERENT step's content. This pins the
  // pure selection math against moveStep's own clamping so the two can never
  // disagree (moveStep is a 3-step array, delta ±1).
  const LENGTH = 3;

  it("the moved step's own selection follows it to the target index", () => {
    // steps [A(0), B(1), C(2)], B selected, move B up → selection follows to 0.
    expect(selectedAfterMove(1, 1, -1, LENGTH)).toBe(0);
    // Move B down → selection follows to 2.
    expect(selectedAfterMove(1, 1, 1, LENGTH)).toBe(2);
  });

  it("the displaced step (at the target slot) is selected and moves to index", () => {
    // A(0) selected, B(1) moved up (swaps with A) → A ends up at 1.
    expect(selectedAfterMove(0, 1, -1, LENGTH)).toBe(1);
  });

  it("an unrelated selection (not the moved or displaced step) is unaffected", () => {
    // C(2) selected while A(0) and B(1) swap — C never moves.
    expect(selectedAfterMove(2, 0, 1, LENGTH)).toBe(2);
  });

  it("matches moveStep's own clamping: an out-of-range move is a no-op, selection stays put", () => {
    // moveStep(steps, 0, -1) and moveStep(steps, 2, 1) are both no-ops (clamped
    // at the boundary) — selection must likewise stay exactly where it was,
    // never jumping to the out-of-range target.
    expect(selectedAfterMove(0, 0, -1, LENGTH)).toBe(0);
    expect(selectedAfterMove(2, 2, 1, LENGTH)).toBe(2);
  });

  it("the single-tx variant's sentinel selection (-1) is never touched by a chain-step move", () => {
    expect(selectedAfterMove(-1, 0, -1, LENGTH)).toBe(-1);
    expect(selectedAfterMove(-1, 1, 1, LENGTH)).toBe(-1);
  });
});

describe("stepStateToStepInput — single vs planner shape", () => {
  it("maps a single step to a single ChainStepInput carrying pactCode + payload", () => {
    const step = makeEmptyStepState("single");
    step.pactCode = "(+ 1 2)";
    const input = stepStateToStepInput(step);
    expect(input.mode).toBe("single");
    expect(input.pactCode).toBe("(+ 1 2)");
    expect(input).toHaveProperty("payload");
    expect(input.config).toBeDefined();
    expect(input.plannerName).toBeUndefined();
  });

  it("maps a planner step carrying config/gasPayer/signers but NOT pactCode/payload", () => {
    const step = makeEmptyStepState("planner");
    const input = stepStateToStepInput(step);
    expect(input.mode).toBe("planner");
    expect(input.plannerName).toBe(KNOWN_PLANNERS[0]);
    expect("pactCode" in input).toBe(false);
    expect("payload" in input).toBe(false);
    expect(input.config).toBeDefined();
    expect(input.gasPayer).toBeDefined();
    expect(input.signers).toBeDefined();
  });

  it("omits optional fields when defaulted (idempotent off, blank yieldAs)", () => {
    const input = stepStateToStepInput(makeEmptyStepState("single"));
    expect(input.idempotent).toBeUndefined();
    expect(input.yieldAs).toBeUndefined();
  });
});

describe("chainedBuilderToCommit — TOTAL on an empty state", () => {
  it("never throws and serializes the default form", () => {
    const state = makeEmptyChainedBuilderState();
    expect(() => chainedBuilderToCommit(state)).not.toThrow();
    const body = chainedBuilderToCommit(state);
    expect(body.name).toBe("");
    expect(body.steps).toHaveLength(1);
    // external off → a schedule is emitted and no single-tx-first variant.
    expect(body.schedule).toBeDefined();
    expect(body.singleTxFirst).toBeUndefined();
  });
});

describe("canCommitChain — commit gate", () => {
  function validState(): ChainedBuilderState {
    const state = makeEmptyChainedBuilderState();
    state.name = "test chain";
    const step = makeEmptyStepState("single");
    step.pactCode = "(+ 1 2)";
    step.gasPayer = { type: "gas-station", signingKey: "key-1" };
    state.steps = [step];
    return state;
  }

  it("returns blocking reasons for the empty default form", () => {
    const { ok, reasons } = canCommitChain(makeEmptyChainedBuilderState());
    expect(ok).toBe(false);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons).toContain("Name is required.");
  });

  it("returns ok with no reasons for a valid chain", () => {
    const { ok, reasons } = canCommitChain(validState());
    expect(ok).toBe(true);
    expect(reasons).toEqual([]);
  });

  it("accepts precomputed step inputs (the ChainedBuilder perf path) with identical results", () => {
    // ChainedBuilder.tsx maps `state.steps` to step inputs once (as part of
    // chainedBuilderToCommit) and passes that array in here instead of letting
    // canCommitChain re-derive it — this pins that path to the same verdict as
    // the self-mapping default, for both a valid and a blocked chain.
    for (const state of [validState(), makeEmptyChainedBuilderState()]) {
      const precomputed = state.steps.map(stepStateToStepInput);
      expect(canCommitChain(state, precomputed)).toEqual(canCommitChain(state));
    }
  });
});

describe("stepLabel — the Step-0 renumbering rule, shared by rail + per-step headings", () => {
  it("labels the sole step 'Step 0' when there is exactly one step", () => {
    const steps = [makeEmptyStepState("single")];
    expect(stepLabel(steps, 0)).toBe("Step 0");
  });

  it("labels 1-based 'Step N' once the chain has 2+ steps", () => {
    const steps = [makeEmptyStepState("single"), makeEmptyStepState("single"), makeEmptyStepState("planner")];
    expect(stepLabel(steps, 0)).toBe("Step 1");
    expect(stepLabel(steps, 1)).toBe("Step 2");
    expect(stepLabel(steps, 2)).toBe("Step 3");
  });
});

describe("clearVariantIfOrphaned — drops the single-tx variant when the chain shrinks below 2 steps", () => {
  it("clears a set variant once the chain is back to 1 step", () => {
    const variant = makeEmptyStepState("single");
    expect(clearVariantIfOrphaned([makeEmptyStepState("single")], variant)).toBeNull();
  });

  it("leaves a set variant untouched while the chain still has 2+ steps", () => {
    const variant = makeEmptyStepState("single");
    const steps = [makeEmptyStepState("single"), makeEmptyStepState("single")];
    expect(clearVariantIfOrphaned(steps, variant)).toBe(variant);
  });

  it("stays null when there was no variant to begin with, at any chain length", () => {
    expect(clearVariantIfOrphaned([makeEmptyStepState("single")], null)).toBeNull();
    expect(clearVariantIfOrphaned([makeEmptyStepState("single"), makeEmptyStepState("single")], null)).toBeNull();
  });
});

describe("earlierYields — only strictly-earlier declared yields", () => {
  it("returns yields from steps before the index, dropping blank names", () => {
    const steps: StepState[] = [
      { ...makeEmptyStepState("single"), yieldAs: "a" },
      { ...makeEmptyStepState("single"), yieldAs: "" },
      { ...makeEmptyStepState("single"), yieldAs: "c" },
    ];
    expect(earlierYields(steps, 0)).toEqual([]);
    expect(earlierYields(steps, 2)).toEqual(["a"]); // index 1 blank dropped
    expect(earlierYields(steps, 3)).toEqual(["a", "c"]);
  });
});

describe("isSingleStepChain — the commit-routing predicate (plain `adapter.commit` vs `adapter.commitChain`)", () => {
  it("is true for exactly one single-mode step with no variant", () => {
    const state = makeEmptyChainedBuilderState();
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0].mode).toBe("single");
    expect(isSingleStepChain(state)).toBe(true);
  });

  it("is false when the sole step is a planner step", () => {
    const state = makeEmptyChainedBuilderState();
    state.steps = [makeEmptyStepState("planner")];
    expect(isSingleStepChain(state)).toBe(false);
  });

  it("is false when a single-tx variant is set, even with one step", () => {
    const state = makeEmptyChainedBuilderState();
    state.singleTxVariant = makeEmptyStepState("single");
    expect(isSingleStepChain(state)).toBe(false);
  });

  it("is false once the chain has 2+ steps", () => {
    const state = makeEmptyChainedBuilderState();
    state.steps = [makeEmptyStepState("single"), makeEmptyStepState("single")];
    expect(isSingleStepChain(state)).toBe(false);
  });
});
