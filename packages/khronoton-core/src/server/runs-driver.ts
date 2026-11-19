/**
 * The non-blocking chained-run driver — executes Phase 2's pure `advanceRun`
 * decision function against the real store/chain, per
 * `docs/work/khronoton-chained-runs-phase-3/design.md` §D/§F.
 *
 * `driveRunOnce` is a SINGLE-RUN, loop-until-no-progress pass: it repeatedly
 * (1) reads the run + its current step + that step's legs, (2) calls the pure
 * `advanceRun` to decide what happens next, and (3) executes the returned
 * `RunAction`s against the store/executor — re-reading fresh state and
 * calling `advanceRun` again after every mutating action, stopping only once
 * a pass makes NO further store write (a `poll` that landed nothing new, a
 * `submit-leg` that failed, or the defensive `wait`), the run/step vanishes,
 * or an action throws.
 *
 * This internal looping is deliberate, not incidental: `advanceRun` itself
 * documents its own terminal-run check (step 1) as "defends against a driver
 * that calls advanceRun on a run it should have already stopped touching" —
 * i.e. the pure function already anticipates being re-invoked, within one
 * driver pass, on a run this SAME pass just terminalized. It is also the only
 * way to satisfy design.md §B's requirement that a freshly created run's step
 * 0 gets "planned-and-submitted" — i.e. both `replan-step` (build leg 0) AND
 * `submit-leg` (submit it) — within the SAME tick pass that created the run,
 * rather than waiting a full `tickIntervalMs` for the next
 * `advanceInFlightRunsOnce` pass to notice the freshly-built leg.
 *
 * `advanceInFlightRunsOnce` is the scheduler-facing sweep: every in-flight
 * run, one `driveRunOnce` each, same per-row isolation posture
 * `codexCronotonTickOnce` already applies (one run's failure never blocks the
 * others).
 *
 * Deliberately does NOT import anything from `./tick.js` or `./loop.js` —
 * both of those import FROM this module in a later wave of this same phase;
 * importing `TickCtx` here instead of declaring the structurally-compatible
 * `RunsDriverCtx` below would create a circular import.
 */

import type { ChainRuntime, Config, Database, KeyResolver, OnAudit } from "./seams.js";
import { DEFAULT_MAX_REPLAN_ATTEMPTS, RUN_STEP_DEADLINE_MS } from "./seams.js";
import {
  advanceRunStep,
  bumpRunAttempt,
  getRun,
  insertRunLeg,
  listInFlightRuns,
  listRunLegs,
  claimLegForSubmit,
  releaseLegClaim,
  markLegConfirmed,
  markLegFailed,
  markLegSubmitted,
  markRunTerminal,
  touchRunDeadline,
  type CodexCronotonRunLegRow,
  type CodexCronotonRunRow,
} from "./store/runs.js";
import { listStepsForCronoton, type CodexCronotonStepRow } from "./store/steps.js";
import { RunLegAlreadyExistsError } from "./store/errors.js";
import { stepRowToDefinition } from "./store/mappers.js";
import { executeCodexTransaction } from "./executor.js";
import { resolvePlannerFor, type PlannedLeg } from "./planners/registry.js";
import { advanceRun, type LegState, type RunAction, type RunPolicy, type RunState } from "./pure/run-advance.js";
import type { CodexTxDefinition } from "./types.js";

/**
 * The injected context `driveRunOnce`/`advanceInFlightRunsOnce` run against —
 * a structural SUBSET of `tick.ts`'s `TickCtx` (same `db`/`runtime`/
 * `resolver`/`onAudit`/`config` shape, `TickCtx` just adds `resolveFireMode`
 * on top), so a real `TickCtx` satisfies this interface already and needs no
 * conversion at either of this phase's tick/loop call sites.
 */
export interface RunsDriverCtx {
  db: Database;
  runtime: ChainRuntime;
  resolver: KeyResolver;
  onAudit: OnAudit;
  config?: Partial<Config>;
}

/**
 * Thrown by `driveRunOnce` when a `mode: 'planner'` step names a
 * `planner_name` that `resolvePlannerFor` cannot resolve — e.g. a typo, or a
 * planner that genuinely hasn't been registered yet. The `StepPlanner`
 * registry itself (`planners/registry.ts`) and its real planners
 * (`ouronet.aqp-evict`/`ouronet.aqp-inject`/`ouronet.aqp-unstall`) are fully
 * built; this error reports an unresolved NAME against that registry, not a
 * missing registry mechanism.
 */
export class PlannerNotRegisteredError extends Error {
  constructor(plannerName: string) {
    super(`planner '${plannerName}' is not registered in the StepPlanner registry`);
    this.name = "PlannerNotRegisteredError";
  }
}

/** This pass's per-step barrier deadline, `now + (config override ?? the module default)`. */
function computeStepDeadline(now: Date, ctx: RunsDriverCtx): string {
  return new Date(now.getTime() + (ctx.config?.runStepDeadlineMs ?? RUN_STEP_DEADLINE_MS)).toISOString();
}

/**
 * Parse a leg's stored `definition_json` and check its MINIMAL shape before
 * it is trusted enough to sign and submit as a real transaction. Today's
 * only writer (`handleReplanStep` → `stepRowToDefinition`) is type-checked
 * and always produces a well-formed value, so this never actually fires on
 * any path Phase 3 exercises — it exists because `insertRunLeg` is public
 * store API (not module-private), and Phase 4's planner registry will be
 * the next writer of `definition_json`. A shallow check (not a full schema
 * validator): non-empty `pactCode`, an array `signers`, an object
 * `gasPayer`/`config`. Throws a plain `Error` (caught by the caller) rather
 * than returning a sentinel, since every other parse failure in this layer
 * (a corrupt `schedule_config_json`, for example — see `store/claim.ts`) is
 * handled the same way: catch at the call site, never let `JSON.parse`'s
 * own exception or a malformed shape reach the signer.
 */
function parseLegDefinition(definitionJson: string): CodexTxDefinition {
  const parsed = JSON.parse(definitionJson) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("leg definition is not an object");
  }
  const def = parsed as Record<string, unknown>;
  if (typeof def.pactCode !== "string" || def.pactCode.length === 0) {
    throw new Error("leg definition is missing a non-empty pactCode");
  }
  if (!Array.isArray(def.signers)) {
    throw new Error("leg definition is missing a signers array");
  }
  if (typeof def.gasPayer !== "object" || def.gasPayer === null) {
    throw new Error("leg definition is missing a gasPayer object");
  }
  if (typeof def.config !== "object" || def.config === null) {
    throw new Error("leg definition is missing a config object");
  }
  return parsed as CodexTxDefinition;
}

/**
 * `submit-leg { legIndex }`: submit the already-`pending` leg at this index
 * (built by an earlier `replan-step` pass; `submit-leg` never builds a leg
 * itself). Returns `true` iff the leg flipped to `submitted` (a store write
 * happened) — a submit failure leaves the leg `pending` and returns `false`,
 * so the caller's loop stops rather than busy-retrying within this same pass;
 * the *next* `driveRunOnce` pass naturally re-selects the same still-pending
 * leg (design.md §F — no retry-counting write exists or is needed).
 *
 * CONCURRENCY (Phase 5 fix): before the chain submission
 * (`executeCodexTransaction`) is awaited, this now calls
 * `claimLegForSubmit` — a real claim-before-submit step, mirroring
 * `claim.ts`'s `claimDueCodexCronoton` idiom. Two concurrent callers racing
 * the same `pending` leg (e.g. `executeNow`'s chained-row branch invoking
 * `driveRunOnce` directly from an HTTP handler, racing the background
 * loop's own `advanceInFlightRunsOnce` sweep — both are public exports, and
 * only the LOOP's own pass sits behind `loop.ts`'s re-entrancy guard) can
 * never both win the claim, so at most one of them ever reaches the real
 * network call. A lost claim (the leg was already claimed/submitted by a
 * concurrent winner, or moved on since `stepLegs` was read) returns `false`
 * immediately — exactly like "wait", never a second submit. A submit
 * attempt that does not land releases the claim (`releaseLegClaim`) so a
 * LATER pass can still retry the still-`pending` leg, preserving the
 * existing no-retry-cap posture (design.md §F) unchanged.
 */
async function handleSubmitLeg(
  legIndex: number,
  run: CodexCronotonRunRow,
  stepLegs: readonly CodexCronotonRunLegRow[],
  now: Date,
  ctx: RunsDriverCtx,
): Promise<boolean> {
  const leg = stepLegs.find((l) => l.leg_index === legIndex);
  if (!leg) {
    // Defensive — should never happen, since every submit-leg action targets
    // a pending leg advanceRun itself selected from the very legs array this
    // function passed it.
    await ctx.onAudit({
      action: "codex_cronoton_run_leg.not_found",
      result: "failure",
      targetKind: "codex_cronoton_run",
      targetId: run.id,
      detail: { codexCronotonId: run.codex_cronoton_id, stepIndex: run.step_index, legIndex },
    });
    return false;
  }

  let definition: CodexTxDefinition;
  try {
    definition = parseLegDefinition(leg.definition_json);
  } catch (err) {
    // Malformed/invalid stored definition — never hand this to the signer.
    // Leaves the leg `pending` (same posture as a submit failure below): no
    // request key was ever derived, so nothing unsafe happened, and this is
    // deterministic (retrying will fail the same way every pass) — but
    // Phase 3 has no retry-cap mechanism (see design.md's Out of scope), so
    // an operator noticing the repeated audit event is the backstop today.
    await ctx.onAudit({
      action: "codex_cronoton_run_leg.invalid_definition",
      result: "failure",
      targetKind: "codex_cronoton_run_leg",
      targetId: leg.id,
      detail: {
        runId: run.id,
        stepIndex: run.step_index,
        legIndex,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return false;
  }

  const claimed = claimLegForSubmit(leg.id, now.toISOString(), { db: ctx.db });
  if (!claimed) {
    // Lost the race: a concurrent caller already claimed (or submitted, or
    // otherwise moved on) this exact leg since `stepLegs` was read. Back off
    // silently — this pass makes no progress on this leg, exactly like
    // "wait" — never a second submit attempt.
    return false;
  }

  const result = await executeCodexTransaction(definition, "submit", {
    runtime: ctx.runtime,
    resolver: ctx.resolver,
    config: ctx.config,
  });

  if (result.ok && result.requestKey && result.chainId) {
    markLegSubmitted(leg.id, { requestKey: result.requestKey, chainId: result.chainId }, { db: ctx.db });
    return true;
  }

  // Release the claim so a LATER pass can still retry this still-`pending`
  // leg — the existing no-retry-cap posture (design.md §F) is unchanged; only
  // the CONCURRENT-double-submit window this claim closes is new.
  releaseLegClaim(leg.id, { db: ctx.db });

  await ctx.onAudit({
    action: "codex_cronoton_run_leg.submit_failed",
    result: "failure",
    targetKind: "codex_cronoton_run_leg",
    targetId: leg.id,
    detail: { runId: run.id, stepIndex: run.step_index, legIndex, error: result.error },
  });
  return false;
}

/**
 * `poll {}`: one `pollRequestKeys` call per distinct chain for every
 * `submitted` leg of the current step (Phase 0's "one request per chain per
 * tick" contract). Returns `true` iff at least one leg landed (confirmed or
 * failed) this pass.
 */
async function handlePoll(
  stepLegs: readonly CodexCronotonRunLegRow[],
  ctx: RunsDriverCtx,
): Promise<boolean> {
  const submitted = stepLegs.filter(
    (l): l is CodexCronotonRunLegRow & { request_key: string; chain_id: string } =>
      l.status === "submitted" && l.request_key != null && l.chain_id != null,
  );
  if (submitted.length === 0) return false;

  const byChain = new Map<string, Array<CodexCronotonRunLegRow & { request_key: string; chain_id: string }>>();
  for (const leg of submitted) {
    const group = byChain.get(leg.chain_id) ?? [];
    group.push(leg);
    byChain.set(leg.chain_id, group);
  }

  let mutated = false;
  for (const [chainId, legsForChain] of byChain) {
    const client = ctx.runtime.createClient(ctx.runtime.getPactUrl(chainId));
    const polled =
      (await client.pollRequestKeys?.(legsForChain.map((l) => l.request_key), chainId)) ?? {};
    for (const leg of legsForChain) {
      const landed = polled[leg.request_key];
      if (!landed) continue; // still pending — absent key means "not landed yet"
      if (landed.result.status === "success") {
        markLegConfirmed(leg.id, { db: ctx.db });
      } else {
        markLegFailed(
          leg.id,
          { errorMessage: landed.result.error?.message ?? "transaction failed on-chain" },
          { db: ctx.db },
        );
      }
      mutated = true;
    }
  }
  return mutated;
}

/**
 * `advance-step {}`: the barrier for the current step is met. Terminal
 * (`succeeded`) if this was the last step, else move `step_index` forward and
 * reset `attempt`/stamp a fresh deadline for the next step. Always a store
 * write.
 */
function handleAdvanceStep(run: CodexCronotonRunRow, now: Date, ctx: RunsDriverCtx): boolean {
  if (run.step_index + 1 >= run.step_count) {
    markRunTerminal(run.id, "succeeded", { db: ctx.db });
  } else {
    advanceRunStep(
      run.id,
      { fromStepIndex: run.step_index, toStepIndex: run.step_index + 1, deadlineAt: computeStepDeadline(now, ctx) },
      { db: ctx.db },
    );
  }
  return true;
}

/**
 * `replan-step { reason }`: as of Phase 4.1, `driveRunOnce` sets
 * `canReplan: step.mode === "planner"`, so this action is reached in TWO
 * distinct situations, both handled here — a step's very first entry
 * (`advanceRun`'s "no legs yet" branch, no prior legs for this step) and a
 * genuine re-plan after a leg failure (`replanOrFail`, prior legs for this
 * step already exist). The `isReplan` check below distinguishes them: a
 * `mode: 'planner'` step looks its `planner_name` up in Phase 4's
 * `StepPlanner` registry and calls it to produce this pass's legs (zero legs
 * is treated exactly like a cleared barrier, matching `handleAdvanceStep`'s
 * own terminal-vs-advance branch verbatim rather than duplicating it) — on a
 * genuine re-plan, the new legs land at a bumped `attempt` generation and a
 * fresh `leg_index` range (never colliding with the prior generation's now-
 * failed legs), and the run's `attempt` counter and step deadline are
 * advanced directly rather than through `advanceRunStep` (whose own
 * attempt-reset side effect would otherwise silently undo the bump — see
 * design.md §A and `store/runs.ts`'s `touchRunDeadline` doc comment); a
 * `mode: 'single'` step builds its one fixed leg from the step row and stamps
 * this step's first deadline (single-mode steps never set `canReplan`, so
 * `isReplan` is always `false` on this branch). Always a store write (or a
 * throw).
 *
 * CRITICAL, cross-phase-review-found fix (NARROWLY SCOPED — a first
 * version of this fix wrapped EVERY call unconditionally and was itself
 * found, on the SAME review's own terminal pass, to introduce two new
 * regressions; both are explained below, not just the original bug):
 *
 * The original bug: a step whose CURRENT generation has NEVER had a
 * single leg (`stepHasAnyLegs` below, `false`) is the ONLY situation
 * `advanceRun`'s "no legs yet" decision (step 2, pure/run-advance.ts) can
 * reach — and that decision is checked UNCONDITIONALLY, before its OWN
 * deadline-exceeded check (step 4), REGARDLESS of whether `deadline_at`
 * happens to already be set. So if the planner lookup/call (or, for
 * `mode:'single'`, `stepRowToDefinition`) throws EVERY time before ever
 * successfully inserting this step's first leg, `legs.length` stays `0`
 * forever and `advanceRun` can NEVER reach its own deadline/attempt-budget
 * recovery machinery — not just on a run's absolute first step, but on
 * ANY step whose planner never manages one successful plan. Nothing else
 * in this codebase can terminalize such a run (no exposed handler, no
 * cron); left unguarded, it permanently occupies its cronoton's self-block
 * slot (`schema.ts`'s partial unique index).
 *
 * Regression #1 (HIGH) an unconditional catch introduced: a GENUINE
 * re-plan (`stepHasAnyLegs === true` — this step already built at least
 * one PRIOR leg; `replanOrFail`'s own `maxReplanAttempts` budget already
 * decided this attempt was worth making) throwing must NOT be
 * terminalized here — that would silently zero out the retry budget
 * `maxReplanAttempts`/`replanOrFail` exist to grant. Letting it propagate
 * exactly as before this fix (isolated by `advanceInFlightRunsOnce`,
 * retried or genuinely exhausted by the NEXT pass's own deadline/attempt
 * check) is correct; only the `stepHasAnyLegs === false` case ever needed
 * protection, because only it has no OTHER recovery path at all.
 *
 * Regression #2 (CRITICAL) an unconditional catch introduced: TWO
 * concurrent `driveRunOnce` callers (e.g. `executeNow`'s HTTP-triggered
 * call racing the background loop's own sweep — `store/runs.ts`'s own doc
 * comment names this exact scenario) can both reach a step's first entry
 * and race on `insertRunLeg`; the loser gets `RunLegAlreadyExistsError`
 * while the WINNER is concurrently making real progress. Terminalizing
 * the LOSER's run would incorrectly fail a run that is actually
 * succeeding via the winner's write — `RunLegAlreadyExistsError` is
 * therefore never terminalized here either, regardless of
 * `stepHasAnyLegs`.
 */
async function handleReplanStep(
  run: CodexCronotonRunRow,
  step: CodexCronotonStepRow,
  allRunLegs: readonly CodexCronotonRunLegRow[],
  now: Date,
  ctx: RunsDriverCtx,
): Promise<boolean> {
  const stepHasAnyLegs = allRunLegs.some((l) => l.step_index === run.step_index);
  try {
    return await handleReplanStepInner(run, step, allRunLegs, now, ctx);
  } catch (err) {
    if (stepHasAnyLegs || err instanceof RunLegAlreadyExistsError) {
      // Regression #1 / #2 guards (see doc comment above) — let it
      // propagate exactly as before this fix, isolated by
      // `advanceInFlightRunsOnce`, never terminalized here.
      throw err;
    }
    // This step's CURRENT generation has never had a single leg — the
    // ONLY case with no other recovery path at all (see doc comment).
    const reason = `replan-step threw: ${err instanceof Error ? err.message : String(err)}`;
    await handleFailRun(run, reason, ctx);
    throw err;
  }
}

async function handleReplanStepInner(
  run: CodexCronotonRunRow,
  step: CodexCronotonStepRow,
  allRunLegs: readonly CodexCronotonRunLegRow[],
  now: Date,
  ctx: RunsDriverCtx,
): Promise<boolean> {
  if (step.mode === "planner") {
    const resolved = resolvePlannerFor(step, ctx);
    if (!resolved) {
      throw new PlannerNotRegisteredError(step.planner_name ?? "(unnamed)");
    }
    const legs: PlannedLeg[] = await resolved.planner(step, resolved.plannerCtx);
    if (legs.length === 0) {
      // The planner decided this step needs no work this pass (e.g. nothing
      // owed) — treat exactly like a cleared barrier, matching
      // `handleAdvanceStep`'s own terminal-vs-advance branch verbatim rather
      // than duplicating it.
      return handleAdvanceStep(run, now, ctx);
    }

    // Every generation of this step's legs, NOT attempt-filtered — unlike
    // `driveRunOnce`'s own `stepLegs` (which only ever sees the CURRENT
    // generation for the barrier/submit/poll decision), a re-plan needs to
    // see every PRIOR generation's `leg_index` values too, to compute a new
    // one that can never collide with the unique `(run_id, step_index,
    // leg_index)` index — see design.md §A. Filtered from `allRunLegs`,
    // the SAME query `driveRunOnce` already issued this outer iteration —
    // no second `listRunLegs` round-trip for the same run (a confirmed LOW
    // performance finding this fix closes).
    const allStepLegs = allRunLegs.filter((l) => l.step_index === run.step_index);
    const isReplan = allStepLegs.length > 0;
    const newAttempt = isReplan ? run.attempt + 1 : run.attempt;
    const startLegIndex = isReplan ? Math.max(...allStepLegs.map((l) => l.leg_index)) + 1 : 0;

    if (isReplan) {
      // `bumpRunAttempt` + `touchRunDeadline`, NEVER `advanceRunStep`, for a
      // genuine re-plan: `advanceRunStep` unconditionally resets `attempt`
      // back to 0 as part of its contract, which would silently undo the
      // bump on every re-plan and turn `maxReplanAttempts` into dead config
      // (an infinite retry loop with no error ever surfacing) — see
      // `store/runs.ts`'s `touchRunDeadline` doc and design.md §A.
      bumpRunAttempt(run.id, { db: ctx.db });
      touchRunDeadline(run.id, computeStepDeadline(now, ctx), { db: ctx.db });
    }

    legs.forEach((leg, i) => {
      insertRunLeg(
        {
          runId: run.id,
          stepIndex: run.step_index,
          legIndex: startLegIndex + i,
          definitionJson: JSON.stringify(leg),
          attempt: newAttempt,
        },
        { db: ctx.db },
      );
    });

    if (!isReplan) {
      // First entry (no legs existed yet) — byte-identical in final effect
      // to before: stamp this step's first deadline (and the no-op
      // `attempt = 0` reset `advanceRunStep` always performs, matching the
      // `attempt: 0` every leg above was just inserted with).
      advanceRunStep(
        run.id,
        { fromStepIndex: run.step_index, toStepIndex: run.step_index, deadlineAt: computeStepDeadline(now, ctx) },
        { db: ctx.db },
      );
    }
    return true;
  }

  const definition = stepRowToDefinition(step);
  insertRunLeg(
    { runId: run.id, stepIndex: run.step_index, legIndex: 0, definitionJson: JSON.stringify(definition) },
    { db: ctx.db },
  );
  advanceRunStep(
    run.id,
    { fromStepIndex: run.step_index, toStepIndex: run.step_index, deadlineAt: computeStepDeadline(now, ctx) },
    { db: ctx.db },
  );
  return true;
}

/**
 * `fail-run { reason }`: terminalize the run as `failed` and audit the
 * reason (not persisted on the run row itself — no such column exists; see
 * design.md's "Out of scope"). Always a store write.
 */
async function handleFailRun(run: CodexCronotonRunRow, reason: string, ctx: RunsDriverCtx): Promise<boolean> {
  markRunTerminal(run.id, "failed", { db: ctx.db });
  await ctx.onAudit({
    action: "codex_cronoton_run.failed",
    result: "failure",
    targetKind: "codex_cronoton_run",
    targetId: run.id,
    detail: { codexCronotonId: run.codex_cronoton_id, stepIndex: run.step_index, reason },
  });
  return true;
}

/** Execute one `RunAction`, returning `true` iff it performed a store write. */
async function executeAction(
  action: RunAction,
  run: CodexCronotonRunRow,
  step: CodexCronotonStepRow,
  stepLegs: readonly CodexCronotonRunLegRow[],
  allRunLegs: readonly CodexCronotonRunLegRow[],
  now: Date,
  ctx: RunsDriverCtx,
): Promise<boolean> {
  switch (action.kind) {
    case "submit-leg":
      return handleSubmitLeg(action.legIndex, run, stepLegs, now, ctx);
    case "poll":
      return handlePoll(stepLegs, ctx);
    case "advance-step":
      return handleAdvanceStep(run, now, ctx);
    case "replan-step":
      return handleReplanStep(run, step, allRunLegs, now, ctx);
    case "fail-run":
      return handleFailRun(run, action.reason, ctx);
    case "wait":
      return false;
  }
}

/**
 * Drive one run forward as far as it will synchronously go this pass — see
 * the module doc above for why this loops internally rather than making a
 * single `advanceRun` call. Returns once the run/current step vanishes (both
 * defensive no-ops) or a pass makes no further progress.
 */
export async function driveRunOnce(runId: string, now: Date, ctx: RunsDriverCtx): Promise<void> {
  for (;;) {
    const run = getRun(runId, { db: ctx.db });
    if (!run) return; // the run vanished between listInFlightRuns and this call

    const steps = listStepsForCronoton(run.codex_cronoton_id, { db: ctx.db });
    const step = steps.find((s) => s.step_index === run.step_index);
    if (!step) {
      // A run/step-definition mismatch (e.g. steps deleted out from under a
      // live run) must fail loudly, not loop forever.
      markRunTerminal(runId, "failed", { db: ctx.db });
      await ctx.onAudit({
        action: "codex_cronoton_run.step_missing",
        result: "failure",
        targetKind: "codex_cronoton_run",
        targetId: runId,
        detail: { codexCronotonId: run.codex_cronoton_id, stepIndex: run.step_index },
      });
      return;
    }

    // Fetched ONCE per outer iteration — `handleReplanStep` used to issue
    // its own independent `listRunLegs` query for the same run (a confirmed
    // LOW performance finding from a cross-phase review); it now reuses
    // this same result (filtered differently: by step_index only, across
    // every attempt generation, not just the current one — see its own
    // leg-index-collision-avoidance doc comment).
    const allRunLegs = listRunLegs(runId, { db: ctx.db });
    const stepLegs = allRunLegs.filter((l) => l.step_index === run.step_index && l.attempt === run.attempt);
    const legs: LegState[] = stepLegs.map((l) => ({ legIndex: l.leg_index, status: l.status }));

    const policy: RunPolicy = {
      stepMode: step.mode === "single" ? "serial" : "parallel",
      canReplan: step.mode === "planner",
      maxReplanAttempts: ctx.config?.maxReplanAttempts ?? DEFAULT_MAX_REPLAN_ATTEMPTS,
    };
    const runState: RunState = {
      status: run.status,
      stepIndex: run.step_index,
      stepCount: run.step_count,
      deadlineAt: run.deadline_at,
      attempt: run.attempt,
    };

    const actions = advanceRun(runState, legs, now, policy);

    let progressed = false;
    for (const action of actions) {
      // for...of with await, not Promise.all: a parallel step's multiple
      // submit-leg actions must submit one at a time, never concurrently.
      const mutated = await executeAction(action, run, step, stepLegs, allRunLegs, now, ctx);
      if (mutated) progressed = true;
    }
    if (!progressed) return;
  }
}

/** Result of one {@link advanceInFlightRunsOnce} sweep. */
export interface AdvanceRunsResult {
  /** Run ids successfully driven (possibly a no-op pass) this sweep. */
  drivenIds: string[];
  /** Run ids whose `driveRunOnce` call threw — isolated, not re-thrown. */
  erroredIds: string[];
}

/**
 * Sweep every in-flight run, driving each forward one `driveRunOnce` pass.
 * Per-run `try`/`catch` isolation — one run's thrown error (including
 * `PlannerNotRegisteredError`) never blocks the others — mirrors
 * `codexCronotonTickOnce`'s own per-row isolation posture.
 *
 * `excludeRunIds`, when given, skips those runs entirely this sweep. This
 * exists so `loop.ts` can pass the run ids `codexCronotonTickOnce` already
 * drove inline this SAME pass (design.md §B's "plan-and-submit step 0
 * within one tick pass," built by calling `driveRunOnce` directly from the
 * tick) — without it, a freshly created run would be driven twice in one
 * loop callback: once inline by the tick, once again by this sweep moments
 * later, doubling `pollRequestKeys` traffic for no benefit (the inline call
 * already drove it as far as it would synchronously go).
 */
export async function advanceInFlightRunsOnce(
  now: Date,
  ctx: RunsDriverCtx,
  excludeRunIds?: ReadonlySet<string>,
): Promise<AdvanceRunsResult> {
  const drivenIds: string[] = [];
  const erroredIds: string[] = [];

  const runs = listInFlightRuns({ db: ctx.db });
  for (const run of runs) {
    if (excludeRunIds?.has(run.id)) continue;
    try {
      await driveRunOnce(run.id, now, ctx);
      drivenIds.push(run.id);
    } catch (err) {
      console.error(`khronoton runs-driver: run ${run.id} errored while advancing`, err);
      erroredIds.push(run.id);
    }
  }

  return { drivenIds, erroredIds };
}
