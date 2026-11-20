/**
 * yields — the pure `$yield` placeholder resolver
 * (`docs/work/khronoton-step-yield-carry/design.md`'s "Consuming a yield").
 *
 * A step references a value a prior step produced by writing a structured
 * placeholder, `{"$yield": "<name>"}`, anywhere a literal value would
 * normally go inside its stored `payload_json`/`planner_params_json`.
 * `resolveYieldRefs` walks a parsed JSON value and substitutes every such
 * placeholder against a run's yield pool (a flat `{name: value}` map — see
 * `store/yields.ts`'s `getYieldPool`), leaving everything else untouched. No
 * DB, no chain client, no I/O: pure and dependency-free, following
 * `run-advance.ts`/`split-plan.ts`'s convention of keeping types local to the
 * module that owns them.
 *
 * A yielded value is returned as-is, never recursed into further — it is
 * already fully resolved (it was produced by a planner's return value or a
 * confirmed leg's on-chain result, not itself written with placeholders).
 */

/**
 * Thrown by `resolveYieldRefs` when a `{"$yield": "<name>"}` placeholder
 * names a yield that has not been produced yet in this run (typo, wrong
 * step order, or referenced before it was ever produced) — mirroring
 * `runs-driver.ts`'s `PlannerNotRegisteredError` precedent of living next
 * to its own primary thrower rather than in `store/errors.ts`, and this
 * package's existing "never silently guess" posture: a missing yield must
 * never silently resolve to `null`/`undefined`.
 */
export class YieldNotFoundError extends Error {
  constructor(name: string) {
    super(`no yield named "${name}" has been produced yet in this run`);
    this.name = "YieldNotFoundError";
  }
}

/** True for a plain object whose OWN keys are exactly `["$yield"]` and whose
 *  `$yield` value is a string — the one shape `resolveYieldRefs` treats as a
 *  placeholder rather than an ordinary object to recurse into. */
function isYieldPlaceholder(value: unknown): value is { $yield: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return (
    keys.length === 1 &&
    keys[0] === "$yield" &&
    typeof (value as Record<string, unknown>).$yield === "string"
  );
}

/**
 * Recursively walks `value`, substituting every `{"$yield": "<name>"}`
 * placeholder against `pool`. Arrays map each element through
 * `resolveYieldRefs`; a placeholder object resolves to `pool[name]` (not
 * recursed into further); any other plain object has every one of its own
 * entries individually resolved; anything else (string/number/boolean/
 * null) returns as-is.
 */
export function resolveYieldRefs(value: unknown, pool: Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveYieldRefs(item, pool));
  }
  if (isYieldPlaceholder(value)) {
    const name = value.$yield;
    // `Object.prototype.hasOwnProperty.call`, NEVER the `in` operator —
    // `in` walks the full prototype chain, so for a pool that is (or
    // ever could be) a plain object literal, a never-produced name like
    // "toString"/"constructor"/"valueOf"/"hasOwnProperty" would silently
    // resolve to an inherited Object.prototype function instead of
    // throwing YieldNotFoundError, exactly defeating this module's own
    // "never silently guess" invariant (see the class doc above). This
    // check is safe regardless of how `pool` was constructed — it does
    // not rely on every caller remembering to build a prototype-less
    // object (`store/yields.ts`'s `getYieldPool` does, via
    // `Object.create(null)`, but `handlers/steps.ts`'s standalone-fire
    // route passes a bare `{}` literal directly).
    if (!Object.prototype.hasOwnProperty.call(pool, name)) {
      throw new YieldNotFoundError(name);
    }
    return pool[name];
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveYieldRefs(v, pool)]),
    );
  }
  return value;
}

/**
 * The `mode:'single'` analog of `planners/registry.ts`'s `resolvePlannerFor`:
 * build a shallow clone of a step row with its `payload_json` field's
 * `$yield` placeholders resolved against `pool`, ready to pass straight into
 * `store/mappers.ts`'s `stepRowToDefinition`. Planner-mode steps get this
 * exact pattern for free via `resolvePlannerFor`; a review finding caught
 * that the single-mode case had quietly re-derived the identical
 * JSON.parse/resolveYieldRefs/JSON.stringify/spread sequence independently
 * in both `runs-driver.ts` and `handlers/steps.ts` instead of sharing one
 * implementation — the exact drift risk `resolvePlannerFor` itself was
 * extracted to close for the planner-mode case, left open for this sibling
 * one. A generic constraint (not importing `CodexCronotonStepRow` by name)
 * keeps this module import-free, matching its own "pure and dependency-free"
 * doc claim above.
 */
export function resolveSingleStepPayload<T extends { payload_json: string | null }>(
  step: T,
  pool: Record<string, unknown>,
): T {
  return {
    ...step,
    payload_json: JSON.stringify(resolveYieldRefs(JSON.parse(step.payload_json ?? "{}"), pool)),
  };
}
