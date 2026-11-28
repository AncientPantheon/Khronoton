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
  jsonToChainedBuilderState,
  KNOWN_PLANNERS,
  makeEmptyChainedBuilderState,
  makeEmptyStepState,
  moveStep,
  removeStep,
  replaceStep,
  selectedAfterMove,
  stepBuilderState,
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
    // No server resolver by default — an ordinary cronoton.
    expect(body.serverResolver).toBeUndefined();
  });

  it("writes serverResolver when set, omits it (not even as an empty string) when unset", () => {
    const withResolver = makeEmptyChainedBuilderState();
    withResolver.serverResolver = "pool-payout";
    expect(chainedBuilderToCommit(withResolver).serverResolver).toBe("pool-payout");

    const without = makeEmptyChainedBuilderState();
    without.serverResolver = undefined;
    expect(chainedBuilderToCommit(without).serverResolver).toBeUndefined();
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

  it("threads the envelope's serverResolver into every step's AND the single-tx variant's synthetic gas-waiver state", () => {
    // `validateStep`'s own unconditional `simulateCalibrated: true` currently
    // masks whether this threading actually changes canCommitChain's verdict
    // (AUTO gas is never blocked per-step regardless of resolver today — see
    // that call site's own comment) — so this asserts on `stepBuilderState`'s
    // OWN output directly, the only way to observe the wiring itself rather
    // than a verdict that would look identical whether the wiring exists or
    // not. Forward-looking: if per-step calibration is ever made conditional,
    // this threading is what will correctly protect a server-resolver
    // cronoton from suddenly blocking.
    const step = makeEmptyStepState("single");
    expect(stepBuilderState(step, "pool-payout").serverResolver).toBe("pool-payout");
    expect(stepBuilderState(step).serverResolver).toBeUndefined();

    const state = validState();
    state.serverResolver = "pool-payout";
    // Still ok — confirms the (currently redundant) threading introduces no
    // regression, not just that it compiles.
    expect(canCommitChain(state).ok).toBe(true);
  });

  // A further-strengthened test was attempted here: spying on the real
  // exported `stepBuilderState` (via a namespace import) while driving the
  // call through the public `canCommitChain` entry point, to prove
  // `canCommitChain` → `validateStep` actually FORWARD `state.serverResolver`
  // (the one hop the test above cannot observe, since it calls
  // `stepBuilderState` directly with explicit arguments). That attempt does
  // NOT work: `canCommitChain`/`validateStep` call `stepBuilderState`
  // directly (same module), and native ESM binds that call to the live
  // local binding, not through the exported namespace object — `vi.spyOn`
  // on the namespace import never observes an internal same-module call
  // here (confirmed empirically: the spy recorded zero calls while
  // `canCommitChain` plainly still worked). Proving this ONE hop would
  // require either weakening the module's own internals (e.g. routing the
  // call through an injectable seam) purely for a test, or waiting for
  // `validateStep`'s masking `simulateCalibrated: true` hardcode to become
  // conditional (at which point the forwarding becomes independently
  // OBSERVABLE via a real verdict change, and a meaningful test becomes
  // possible without any of this). Left untested now rather than faked.
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

describe("jsonToChainedBuilderState — the inverse of chainedBuilderToCommit", () => {
  function fixtureState(): ChainedBuilderState {
    const base = makeEmptyChainedBuilderState();
    const step1: StepState = {
      ...makeEmptyStepState("single"),
      pactCode: "(+ 1 2)",
      yieldAs: "amount",
      config: { chainId: "1", gasPriceBufferAnu: 5, gasLimit: 2000, autoGasLimit: false, ttl: 300 },
      payload: { entries: [], keysets: [], rawMode: true, rawJson: '{"foo":"bar"}' },
      gasPayer: { type: "gas-station", signingKey: "alice-key" },
      signers: [
        { id: "x", publicKey: "alice-pub", label: "Alice", source: "derived", capabilityMode: "pure", capabilities: "" },
      ],
    };
    const step2: StepState = {
      ...makeEmptyStepState("planner"),
      plannerName: "ouronet.stoa-wrap",
      plannerParamsJson: JSON.stringify({ amount: { $yield: "amount" } }),
      idempotent: true,
      config: { chainId: "1", gasPriceBufferAnu: 0, gasLimit: 1500, autoGasLimit: true, ttl: 600 },
      gasPayer: { type: "codex", address: "k:bob-address" },
      signers: [
        { id: "y", publicKey: "bob-pub", label: "Bob", source: "foreign", capabilityMode: "scoped", capabilities: "(coin.GAS)" },
      ],
    };
    const variant: StepState = {
      ...makeEmptyStepState("single"),
      pactCode: "(whole-chain-as-one-tx)",
      gasPayer: { type: "gas-station", signingKey: "variant-key" },
      signers: [
        { id: "z", publicKey: "variant-pub", label: "", source: "derived", capabilityMode: "pure", capabilities: "" },
      ],
    };
    return {
      ...base,
      name: "My Chain",
      description: "a test chain",
      singleTxVariant: variant,
      steps: [step1, step2],
      serverResolver: "pool-payout",
    };
  }

  it("round-trips name/description/schedule/serverResolver through chainedBuilderToCommit -> JSON -> import", () => {
    const original = fixtureState();
    const text = JSON.stringify(chainedBuilderToCommit(original));
    const result = jsonToChainedBuilderState(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.name).toBe("My Chain");
    expect(result.state.description).toBe("a test chain");
    expect(result.state.externalFireable).toBe(false);
    expect(result.state.schedule).toEqual(original.schedule);
    expect(result.state.serverResolver).toBe("pool-payout");
  });

  it("serverResolver: null (an ordinary cronoton, per ChainCommitBody's own doc), absent, and every non-string JSON type (number/boolean/object/array) all degrade to undefined — lenient, not a hard error", () => {
    for (const text of [
      '{"name":"X","steps":[{"mode":"single"}],"serverResolver":null}',
      '{"name":"X","steps":[{"mode":"single"}]}', // absent entirely
      '{"name":"X","steps":[{"mode":"single"}],"serverResolver":42}',
      '{"name":"X","steps":[{"mode":"single"}],"serverResolver":false}',
      // Structurally different from a primitive — a naive future rewrite of
      // the coercion (e.g. `String(parsed.serverResolver)`) could handle
      // primitives correctly while mishandling these ("[object Object]" is a
      // non-empty string that would NOT degrade to undefined).
      '{"name":"X","steps":[{"mode":"single"}],"serverResolver":{"foo":"bar"}}',
      '{"name":"X","steps":[{"mode":"single"}],"serverResolver":["pool-payout"]}',
    ]) {
      const result = jsonToChainedBuilderState(text);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.state.serverResolver).toBeUndefined();
    }
  });

  it("an empty-string serverResolver also degrades to undefined, matching chainedBuilderToCommit's own omit-when-falsy convention", () => {
    const result = jsonToChainedBuilderState('{"name":"X","steps":[{"mode":"single"}],"serverResolver":""}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.serverResolver).toBeUndefined();
  });

  it("round-trips a 'single' step's pactCode/config/gasPayer/payload/yieldAs/idempotent", () => {
    const original = fixtureState();
    const text = JSON.stringify(chainedBuilderToCommit(original));
    const result = jsonToChainedBuilderState(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [step1] = result.state.steps;
    expect(step1.mode).toBe("single");
    expect(step1.pactCode).toBe("(+ 1 2)");
    expect(step1.yieldAs).toBe("amount");
    expect(step1.idempotent).toBe(false);
    expect(step1.config).toEqual({ chainId: "1", gasPriceBufferAnu: 5, gasLimit: 2000, autoGasLimit: false, ttl: 300 });
    expect(step1.gasPayer).toEqual({ type: "gas-station", signingKey: "alice-key" });
    // Payload round-trips structurally (re-pretty-printed text, not byte-identical).
    expect(step1.payload.rawMode).toBe(true);
    expect(JSON.parse(step1.payload.rawJson)).toEqual({ foo: "bar" });
    // Signers round-trip the WIRE fields exactly; id/label/source are fresh
    // ephemeral values (the forward direction already drops them), matching
    // `detailToBuilderState`'s own established rehydration convention.
    expect(step1.signers).toHaveLength(1);
    expect(step1.signers[0].publicKey).toBe("alice-pub");
    expect(step1.signers[0].capabilityMode).toBe("pure");
    expect(step1.signers[0].capabilities).toBe("");
    expect(step1.signers[0].label).toBe("");
    expect(step1.signers[0].source).toBe("foreign");
  });

  it("round-trips a 'planner' step's plannerName/plannerParams/idempotent/gasPayer/signers", () => {
    const original = fixtureState();
    const text = JSON.stringify(chainedBuilderToCommit(original));
    const result = jsonToChainedBuilderState(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [, step2] = result.state.steps;
    expect(step2.mode).toBe("planner");
    expect(step2.plannerName).toBe("ouronet.stoa-wrap");
    expect(step2.idempotent).toBe(true);
    expect(JSON.parse(step2.plannerParamsJson)).toEqual({ amount: { $yield: "amount" } });
    expect(step2.gasPayer).toEqual({ type: "codex", address: "k:bob-address" });
    expect(step2.signers).toHaveLength(1);
    expect(step2.signers[0]).toMatchObject({ publicKey: "bob-pub", capabilityMode: "scoped", capabilities: "(coin.GAS)" });
  });

  it("round-trips the singleTxFirst variant into singleTxVariant", () => {
    const original = fixtureState();
    const text = JSON.stringify(chainedBuilderToCommit(original));
    const result = jsonToChainedBuilderState(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.singleTxVariant).not.toBeNull();
    const variant = result.state.singleTxVariant!;
    expect(variant.mode).toBe("single");
    expect(variant.pactCode).toBe("(whole-chain-as-one-tx)");
    expect(variant.gasPayer).toEqual({ type: "gas-station", signingKey: "variant-key" });
    expect(variant.signers).toHaveLength(1);
    expect(variant.signers[0].publicKey).toBe("variant-pub");
    // A variant has no plannerName/plannerParams/yieldAs/idempotent on the wire
    // at all — these come through as the fresh-step defaults.
    expect(variant.plannerName).toBe("");
    expect(variant.plannerParamsJson).toBe("");
    expect(variant.yieldAs).toBe("");
    expect(variant.idempotent).toBe(false);
  });

  it("accepts a minimal doc, defaulting every omitted field to makeEmptyBuilderState's own defaults", () => {
    const result = jsonToChainedBuilderState(JSON.stringify({ name: "Minimal", steps: [{ mode: "single" }] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.name).toBe("Minimal");
    expect(result.state.description).toBe("");
    expect(result.state.externalFireable).toBe(false);
    expect(result.state.singleTxVariant).toBeNull();
    expect(result.state.steps).toHaveLength(1);
    const [step] = result.state.steps;
    expect(step.pactCode).toBe("");
    expect(step.config).toEqual({ chainId: "0", gasPriceBufferAnu: 0, gasLimit: 1500, autoGasLimit: true, ttl: 600 });
    expect(step.gasPayer).toEqual({ type: "gas-station" });
    expect(step.signers).toEqual([]);
    expect(JSON.parse(step.payload.rawJson)).toEqual({});
  });

  it("drops an individually malformed signer entry rather than failing the whole step", () => {
    const result = jsonToChainedBuilderState(
      JSON.stringify({
        name: "X",
        steps: [{ mode: "single", signers: [{}, { publicKey: "bob", capabilityMode: "pure", capabilities: "" }] }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.steps[0].signers).toHaveLength(1);
    expect(result.state.steps[0].signers[0].publicKey).toBe("bob");
  });

  it("externalFireable:true wins over a stray schedule key present in the same doc", () => {
    const result = jsonToChainedBuilderState(
      JSON.stringify({
        name: "X",
        externalFireable: true,
        schedule: { mode: "daily-at-utc", config: { mode: "daily-at-utc", hours: [1], minute: 0 } },
        steps: [{ mode: "single" }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.externalFireable).toBe(true);
    // The default schedule, not the stray hours:[1] one from the doc.
    expect(result.state.schedule).toEqual(makeEmptyChainedBuilderState().schedule);
  });

  it("rejects invalid JSON syntax with a clear message, state untouched by the caller", () => {
    const result = jsonToChainedBuilderState("{not valid json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Invalid JSON/);
  });

  it.each([
    ["[]", "[]"],
    ["null", "null"],
    ['"hello"', '"hello"'],
    ["42", "42"],
  ])("rejects a non-object top level (%s)", (_label, text) => {
    const result = jsonToChainedBuilderState(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.toLowerCase()).toContain("object");
  });

  it.each([
    ['{"name":"X"}', "missing steps"],
    ['{"name":"X","steps":[]}', "empty steps"],
    ['{"name":"X","steps":"nope"}', "non-array steps"],
  ])("rejects %s using chained-validation.ts's own wording (%s)", (text) => {
    const result = jsonToChainedBuilderState(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("a chained cronoton needs at least one step");
  });

  it("rejects an invalid step mode using chained-validation.ts's own wording", () => {
    const result = jsonToChainedBuilderState(JSON.stringify({ name: "X", steps: [{ mode: "bogus" }] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("step 0: mode must be 'single' or 'planner'");
  });

  it("returns ok:false (never throws) when a step's payload is so deeply nested that re-serializing it would blow the call stack", () => {
    // JSON.parse tolerates far deeper nesting than JSON.stringify's own
    // recursive serializer, so a validly-parsed document can still blow the
    // stack when toPayloadStateFromWire re-stringifies it for the raw-JSON
    // pane. Built via string repeat (not JSON.stringify) since constructing
    // the fixture itself must not hit the same recursion limit.
    const depth = 50_000;
    const deepArrayJson = "[".repeat(depth) + "]".repeat(depth);
    const text = `{"name":"X","steps":[{"mode":"single","payload":{"deep":${deepArrayJson}}}]}`;
    const result = jsonToChainedBuilderState(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/serialize/i);
  });
});
