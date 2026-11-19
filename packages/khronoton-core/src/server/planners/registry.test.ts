/**
 * The `StepPlanner` registry — pure in-memory registration, mirroring
 * `resolvers.test.ts`'s own register/get coverage for `SERVER_RESOLVERS`.
 * No DB, no chain client: the registry only ever stores/returns function
 * references, so these tests never need a real `PlannerCtx` or step row.
 */
import { describe, it, expect } from "vitest";

import { getStepPlanner, registerStepPlanner } from "./registry.js";
import type { StepPlanner } from "./registry.js";

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
});
