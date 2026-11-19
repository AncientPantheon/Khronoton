/**
 * The `StepPlanner` registry — the `mode:'planner'` analog of `resolvers.ts`'s
 * `SERVER_RESOLVERS` registry.
 *
 * A step planner is a named hook consulted when a chained run's current step
 * is `mode:'planner'`: given the step row + a `PlannerCtx`, it decides at RUN
 * TIME how many legs to build this pass (zero, one, or many) rather than the
 * fixed single leg a `mode:'single'` step's own stored definition already
 * fully specifies. `runs-driver.ts`'s `handleReplanStep` is the sole consumer,
 * looking a planner up by `step.planner_name` and calling it to produce the
 * `PlannedLeg[]` it then inserts.
 *
 * This module carries NO domain-planner coupling: the concrete planners
 * (e.g. `ouronet.aqp-evict`) live in sibling modules and self-register here
 * at module-eval time, exactly as a server resolver self-registers into
 * `resolvers.ts`.
 */

import type { CodexGasPayer, CodexSigner, CodexTxConfig } from "../types.js";
import type { ChainRuntime, Config, KeyResolver } from "../seams.js";
import type { CodexCronotonStepRow } from "../store/steps.js";

/**
 * The seams a step planner runs against — the same three injectable
 * dependencies `executor.ts`'s `ExecutorCtx` carries, declared as this
 * module's OWN interface (matching `runs-driver.ts`'s `RunsDriverCtx`
 * precedent) rather than importing another module's ctx type name.
 */
export interface PlannerCtx {
  runtime: ChainRuntime;
  resolver: KeyResolver;
  config?: Partial<Config>;
}

/**
 * One leg a planner produces for the step's current pass. Deliberately the
 * same field set as `CodexTxDefinition` minus `scheduleKind`/`serverResolver`
 * — a leg never needs either — matching `store/mappers.ts`'s own
 * `stepRowToDefinition` output shape exactly, so `JSON.stringify`-ing a
 * `PlannedLeg` produces a string `handleSubmitLeg`'s existing
 * `parseLegDefinition` already accepts without any change there.
 */
export interface PlannedLeg {
  pactCode: string;
  config: CodexTxConfig;
  payload: Record<string, unknown>;
  gasPayer: CodexGasPayer;
  signers: CodexSigner[];
}

/**
 * A step planner: given the step row + the injected seams, decides the legs
 * to build for the step's current pass. An empty array means "nothing to do
 * this pass" — `handleReplanStep` treats that like a cleared barrier.
 */
export type StepPlanner = (
  step: CodexCronotonStepRow,
  ctx: PlannerCtx,
) => Promise<PlannedLeg[]>;

/** Registry of step planners keyed by `planner_name`. */
const STEP_PLANNERS: Record<string, StepPlanner> = {};

/**
 * Register (or replace) a named step planner. A module that owns a planner
 * calls this at module-eval time so the registry is populated by the time
 * `handleReplanStep` consults it.
 */
export function registerStepPlanner(name: string, planner: StepPlanner): void {
  STEP_PLANNERS[name] = planner;
}

/** Read a registered step planner by name, or `undefined`. */
export function getStepPlanner(name: string): StepPlanner | undefined {
  return STEP_PLANNERS[name];
}

/**
 * Resolve a `mode:'planner'` step's registered planner AND build the
 * `PlannerCtx` it needs, in one call — the single shared implementation of
 * "which planner handles this step, with what ctx" that `runs-driver.ts`'s
 * `handleReplanStep` and `handlers/steps.ts`'s standalone-fire route both
 * consume, so the two call sites can never silently drift from each other
 * (a prior version of this codebase had each hand-copy this exact lookup;
 * Phase 5's review found that drift risk and this function closes it).
 * Returns `undefined` for an unregistered `planner_name` — callers decide
 * how to report that (a thrown `PlannerNotRegisteredError` for the real
 * driver, a 404 for the standalone-fire route).
 */
export function resolvePlannerFor(
  step: CodexCronotonStepRow,
  seams: { runtime: ChainRuntime; resolver: KeyResolver; config?: Partial<Config> },
): { planner: StepPlanner; plannerCtx: PlannerCtx } | undefined {
  const planner = getStepPlanner(step.planner_name ?? "");
  if (!planner) return undefined;
  const plannerCtx: PlannerCtx = { runtime: seams.runtime, resolver: seams.resolver, config: seams.config };
  return { planner, plannerCtx };
}
