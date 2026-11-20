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
import { resolveYieldRefs } from "../pure/yields.js";

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
 *
 * A planner may ALSO return `{ legs, yield? }` instead of a bare array, to
 * additionally report a value for `runs-driver.ts` to store into the run's
 * yield pool (`docs/work/khronoton-step-yield-carry/design.md`'s "Producing
 * a yield") — see `normalizePlannerResult` below. The bare-array return
 * stays valid forever; none of the 5 existing built-ins that don't produce a
 * yield (`evict`/`inject`/`unstall`/`stoa-unwrap`) are forced to change.
 * Deliberately a bare, unnamed `yield` value here — the NAME a yield is
 * stored under always comes from the consuming step's own `step.yield_as`,
 * decided by whoever wrote the step, never by the planner itself.
 */
export type StepPlanner = (
  step: CodexCronotonStepRow,
  ctx: PlannerCtx,
) => Promise<PlannedLeg[] | { legs: PlannedLeg[]; yield?: unknown }>;

/**
 * Normalize a `StepPlanner`'s return value to the `{ legs, yield? }` shape
 * regardless of which form the planner actually returned — the SINGLE
 * shared normalizer `runs-driver.ts` and `handlers/steps.ts` both call, so
 * neither hand-rolls its own array-vs-object check.
 */
export function normalizePlannerResult(
  result: Awaited<ReturnType<StepPlanner>>,
): { legs: PlannedLeg[]; yield?: unknown } {
  if (Array.isArray(result)) return { legs: result };
  return result;
}

/**
 * Registry of step planners keyed by `planner_name`. Built via
 * `Object.create(null)`, NOT a `{}` literal — `planner_name` is unconstrained
 * free-form `TEXT` (schema.ts only enforces NOT NULL for a planner-mode
 * step, no enum/whitelist), so a step row naming
 * `"constructor"`/`"toString"`/`"hasOwnProperty"`/etc. would otherwise make a
 * `{}`-based lookup return a truthy inherited `Object.prototype` member
 * instead of `undefined`, bypassing every caller's "undefined means not
 * registered" contract (`resolvePlannerFor` below, and
 * `runs-driver.ts`'s/`handlers/steps.ts`'s "planner not registered" branches)
 * and failing downstream with an unrelated `TypeError` instead of the
 * intended clean `PlannerNotRegisteredError`/404. Mirrors the identical fix
 * already applied to the sibling yield pool (`store/yields.ts`'s
 * `getYieldPool`) for the same class of bug.
 */
const STEP_PLANNERS: Record<string, StepPlanner> = Object.create(null);

/**
 * Register (or replace) a named step planner. A module that owns a planner
 * calls this at module-eval time so the registry is populated by the time
 * `handleReplanStep` consults it.
 */
export function registerStepPlanner(name: string, planner: StepPlanner): void {
  STEP_PLANNERS[name] = planner;
}

/** Read a registered step planner by name, or `undefined` — including for a
 * name colliding with an `Object.prototype` member, since `STEP_PLANNERS` is
 * prototype-less (see its own doc comment above). */
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
 *
 * Also resolves any `{"$yield": "<name>"}` placeholder in the step's
 * `planner_params_json` against `yieldPool` BEFORE a caller ever invokes the
 * planner (`docs/work/khronoton-step-yield-carry/design.md`'s "Consuming a
 * yield") — returned as a shallow-cloned `resolvedStep` with that field
 * replaced by the resolved JSON string, so `ouronet.aqp-inject` and every
 * other planner keep calling `parseJson(step.planner_params_json, {})`
 * exactly as they do today and simply receive already-resolved values; zero
 * planner-side changes needed. `yieldPool` defaults to `{}`, so every
 * pre-Wave-3 call site (passing only `(step, seams)`) is unaffected — a step
 * with no `$yield` references anywhere resolves byte-identical to before
 * this parameter existed.
 */
export function resolvePlannerFor(
  step: CodexCronotonStepRow,
  seams: { runtime: ChainRuntime; resolver: KeyResolver; config?: Partial<Config> },
  yieldPool: Record<string, unknown> = {},
): { planner: StepPlanner; plannerCtx: PlannerCtx; resolvedStep: CodexCronotonStepRow } | undefined {
  const planner = getStepPlanner(step.planner_name ?? "");
  if (!planner) return undefined;
  const plannerCtx: PlannerCtx = { runtime: seams.runtime, resolver: seams.resolver, config: seams.config };
  const resolvedStep: CodexCronotonStepRow = {
    ...step,
    planner_params_json: JSON.stringify(
      resolveYieldRefs(JSON.parse(step.planner_params_json ?? "{}"), yieldPool),
    ),
  };
  return { planner, plannerCtx, resolvedStep };
}
