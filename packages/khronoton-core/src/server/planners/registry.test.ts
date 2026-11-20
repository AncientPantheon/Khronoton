/**
 * The `StepPlanner` registry — pure in-memory registration, mirroring
 * `resolvers.test.ts`'s own register/get coverage for `SERVER_RESOLVERS`.
 * No DB, no chain client: the registry only ever stores/returns function
 * references, so these tests never need a real `PlannerCtx` or step row.
 *
 * `normalizePlannerResult`/`resolvePlannerFor`'s `$yield`-resolution widening
 * (`docs/work/khronoton-step-yield-carry/design.md`, plan.md's T4) is
 * covered below against a LOCAL test-registered planner, never the real
 * built-ins (`stoa-wrap`/`inject`/`evict`/`unstall`/`stoa-unwrap`) — those
 * planners' own test files are run unmodified as this task's done-when (e).
 */
import { describe, it, expect } from "vitest";

import {
  getStepPlanner,
  normalizePlannerResult,
  registerStepPlanner,
  resolvePlannerFor,
} from "./registry.js";
import type { ChainRuntime, KeyResolver } from "../seams.js";
import type { PlannedLeg, StepPlanner } from "./registry.js";
import type { CodexCronotonStepRow } from "../store/steps.js";

describe("step-planner registry: register/get", () => {
  it("returns undefined for a name nothing registered", () => {
    expect(getStepPlanner("nothing-registered-under-this-name")).toBeUndefined();
  });

  it("returns the exact function reference registered under a name", () => {
    const planner: StepPlanner = async () => [];
    registerStepPlanner("rt-exact-reference", planner);

    expect(getStepPlanner("rt-exact-reference")).toBe(planner);
  });

  it("replaces an existing entry when a second planner is registered under the SAME name", () => {
    const first: StepPlanner = async () => [];
    const second: StepPlanner = async () => [];
    registerStepPlanner("rt-replace", first);
    registerStepPlanner("rt-replace", second);

    expect(getStepPlanner("rt-replace")).toBe(second);
    expect(getStepPlanner("rt-replace")).not.toBe(first);
  });

  // Regression: a review finding caught that the registry's own {} literal
  // (before this fix) would return a truthy inherited Object.prototype
  // member for a never-registered name colliding with one, instead of
  // undefined — bypassing every caller's "undefined means not registered"
  // contract. Mirrors store/yields.ts's getYieldPool's identical fix.
  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "isPrototypeOf"])(
    'getStepPlanner("%s") returns undefined when nothing was ever registered under that name, never an inherited Object.prototype member',
    (name) => {
      expect(getStepPlanner(name)).toBeUndefined();
    },
  );

  it("a planner genuinely registered under a reserved-looking name still resolves correctly (the fix must distinguish own vs. inherited, not refuse the name outright)", () => {
    const planner: StepPlanner = async () => [];
    registerStepPlanner("constructor", planner);

    expect(getStepPlanner("constructor")).toBe(planner);
  });
});

const ONE_LEG: PlannedLeg = {
  pactCode: "(coin.transfer \"a\" \"b\" 1.0)",
  config: { chainId: "0", gasPrice: 1, gasLimit: 1500, autoGasLimit: false, ttl: 600 },
  payload: {},
  gasPayer: { type: "gas-station" },
  signers: [],
};

/** Mirrors `store/mappers.test.ts`'s own `baseStepRow` convention. */
function baseStepRow(overrides: Partial<CodexCronotonStepRow> = {}): CodexCronotonStepRow {
  return {
    id: "step-1",
    codex_cronoton_id: "cc-1",
    step_index: 0,
    mode: "planner",
    pact_code: null,
    config_json: null,
    payload_json: null,
    gas_payer_json: null,
    signers_json: null,
    planner_name: "rt-yield-test-planner",
    planner_params_json: null,
    yield_as: null,
    idempotent: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    modified_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A `PlannerCtx`'s `runtime`/`resolver` seams are never consulted by these
 *  tests (no planner here actually reads them) — bare placeholder objects,
 *  cast to their seam types, are enough. */
const fakeSeams = { runtime: {} as ChainRuntime, resolver: {} as KeyResolver };

describe("normalizePlannerResult: bare-array vs. object-return normalization", () => {
  it("normalizes a bare PlannedLeg[] return to { legs } with no yield key", async () => {
    const planner: StepPlanner = async () => [ONE_LEG];
    registerStepPlanner("rt-bare-array", planner);

    const result = await getStepPlanner("rt-bare-array")!(baseStepRow(), fakeSeams);
    const normalized = normalizePlannerResult(result);

    expect(normalized).toEqual({ legs: [ONE_LEG] });
    expect(normalized).not.toHaveProperty("yield");
  });

  it("passes a { legs, yield } object return through unchanged", async () => {
    const planner: StepPlanner = async () => ({ legs: [ONE_LEG], yield: 42 });
    registerStepPlanner("rt-object-with-yield", planner);

    const result = await getStepPlanner("rt-object-with-yield")!(baseStepRow(), fakeSeams);
    const normalized = normalizePlannerResult(result);

    expect(normalized).toEqual({ legs: [ONE_LEG], yield: 42 });
  });
});

describe("resolvePlannerFor: $yield resolution in planner_params_json", () => {
  it("resolves a {$yield} placeholder against the supplied pool, replacing it with the real value", () => {
    const planner: StepPlanner = async () => [];
    registerStepPlanner("rt-yield-test-planner", planner);
    const step = baseStepRow({
      planner_params_json: JSON.stringify({ amount: { $yield: "drainedAmount" } }),
    });

    const resolved = resolvePlannerFor(step, fakeSeams, { drainedAmount: "123.45" });

    expect(resolved).toBeDefined();
    expect(JSON.parse(resolved!.resolvedStep.planner_params_json!)).toEqual({ amount: "123.45" });
  });

  it("defaults to resolving against an empty pool when no pool argument is given, leaving a step with no $yield references byte-identical", () => {
    const planner: StepPlanner = async () => [];
    registerStepPlanner("rt-yield-test-planner", planner);
    const originalParams = { patronAccount: "k:abc" };
    const step = baseStepRow({ planner_params_json: JSON.stringify(originalParams) });

    const resolved = resolvePlannerFor(step, fakeSeams);

    expect(resolved).toBeDefined();
    expect(JSON.parse(resolved!.resolvedStep.planner_params_json!)).toEqual(originalParams);
  });
});
