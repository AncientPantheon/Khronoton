/**
 * simulateChainBody — the whole-chain DRY RUN, the server-side counterpart of
 * the chained builder's "simulate the whole thing before it goes live" button.
 *
 * It is the SIMULATE sibling of `store/chain.ts`'s `commitChainedCronoton`: that
 * helper WRITES a chain; this one REPLAYS it against the live chain without ever
 * submitting, so an operator sees — per step — whether each leg builds, signs,
 * and passes a signed `/local` on the real node BEFORE committing anything.
 *
 * ── Faithful to `runs-driver.ts`, not a parallel model ────────────────────────
 * The walk mirrors the REAL chained-run driver's semantics exactly, reusing its
 * own primitives rather than re-deriving them:
 *   - a `mode:'single'` step builds one definition, simulates it signed, and —
 *     exactly like the driver's `handlePoll` capturing `landed.result.data` into
 *     the yield pool on confirm — captures the simulate's result data as this
 *     step's yield under `yieldAs`;
 *   - a `mode:'planner'` step is resolved through the SAME `resolvePlannerFor`
 *     (which resolves `{"$yield":"name"}` refs in `planner_params_json` against
 *     the pool) + `normalizePlannerResult` the driver's `handleReplanStep` uses,
 *     then every planned leg is simulated; the planner's own reported `yield`
 *     (never an on-chain read) becomes this step's yield, matching the driver;
 *   - yields thread forward through the SAME pure `resolveYieldRefs` + a
 *     prototype-less pool (`Object.create(null)`) the driver's yield store uses.
 *
 * ── "True mode" (signed) is the default ───────────────────────────────────────
 * `executeCodexTransaction(def, "simulate", ctx)` SIGNS the command (via the
 * injected `KeyResolver`) and dirty-reads it on the node — i.e. this is the
 * "with signatures / true mode" research the operator asked for, and it is the
 * only mode this helper runs. An UNSIGNED `/local` (OuronetUI's older chained
 * simulator) is a separate, shallower path not exposed by the executor seam; a
 * consumer that wants it keeps it app-local.
 *
 * ── Dry-run honesty about yields ──────────────────────────────────────────────
 * A single step's TRUE yield is only produced by a CONFIRMED on-chain tx, which
 * a dry run never performs. The value threaded forward here is the signed
 * simulate's result data — the best available approximation. When a later step
 * references a yield that an earlier step could not produce (it failed, or set
 * no `yieldAs`), `resolveYieldRefs` throws `YieldNotFoundError`; that is caught
 * and reported as THAT step's error, and the walk continues so the operator sees
 * every step's verdict in one pass rather than stopping at the first gap.
 *
 * NOT atomic, NO DB: unlike the commit helper this touches no store at all — it
 * only reaches the chain (read-only) through the injected `ExecutorCtx`. Built-in
 * planners must be registered (importing anything from `/server` does this); a
 * consumer importing this module in isolation should import `/server` too.
 */
import { executeCodexTransaction, type ExecutorCtx } from "./executor.js";
import { normalizePlannerResult, resolvePlannerFor } from "./planners/registry.js";
import { resolveYieldRefs } from "./pure/yields.js";
import type { CodexCronotonStepRow } from "./store/steps.js";
import type { CodexGasPayer, CodexSigner, CodexTxConfig, CodexTxDefinition } from "./types.js";

// ── Input (the server-native counterpart of handlers/chain.ts's wire types) ───
// Mirrors `ChainStepInput`/`ChainSingleTxFirst` structurally (minus `idempotent`,
// which a dry run ignores), so a consumer passes a `ChainCommitBody`'s own
// `steps`/`singleTxFirst` straight through with no translation.

/** One step to replay. `single` carries pact/payload; `planner` carries name/params. */
export interface SimulateChainStep {
  mode: "single" | "planner";
  pactCode?: string;
  config?: CodexTxConfig;
  payload?: Record<string, unknown>;
  gasPayer?: CodexGasPayer;
  signers?: CodexSigner[];
  plannerName?: string;
  plannerParams?: unknown;
  yieldAs?: string;
}

/** The single-tx-first variant simulated as one tx. */
export interface SimulateChainSingleTxFirst {
  pactCode: string;
  config?: CodexTxConfig;
  payload?: Record<string, unknown>;
  gasPayer: CodexGasPayer;
  signers: CodexSigner[];
}

/** The whole chain to replay: the optional single-tx variant + the ordered steps. */
export interface SimulateChainInput {
  singleTxFirst?: SimulateChainSingleTxFirst;
  steps: SimulateChainStep[];
}

// ── Result (structurally identical to handlers/chain.ts's ChainSimulateView) ──
// Defined server-native here so the server layer never imports UP from handlers;
// the consumer's `simulateChain` adapter method returns this value as the wire
// `ChainSimulateView` directly (the shapes are field-for-field the same).

/** One step's dry-run verdict. */
export interface ChainStepSimOutcome {
  stepIndex: number;
  mode: "single" | "planner";
  yieldAs?: string;
  ok: boolean;
  gasUsed?: number;
  error?: string;
  /** Planner legs resolved (planner steps only). */
  plannedCount?: number;
  /** The value captured as this step's yield (fed into later steps). */
  yielded?: unknown;
  rawResult?: unknown;
}

/** The single-tx-variant dry-run verdict. */
export interface ChainSingleTxSimOutcome {
  ok: boolean;
  gasUsed?: number;
  error?: string;
  /**
   * Whether the one tx WOULD BE USED at fire time. `true` when `ok`. When
   * `!ok`, mirrors `single-tx.ts`'s `attemptSingleTxFirst`'s own distinction:
   * a numeric `gasUsed` on a failed simulate is the executor's refuse-
   * unmineable signal, which `attemptSingleTxFirst` treats as "doesn't fit,
   * fall through to the chain" — so `fits` is `false` but {@link hardFailure}
   * is NOT set. Any other failure (no `gasUsed` at all — a genuine Pact
   * error, missing capability, bad signer, etc.) is what
   * `attemptSingleTxFirst` instead THROWS on, never reaching the chained
   * fallback — so `fits` is `false` AND `hardFailure` is `true`.
   */
  fits?: boolean;
  /**
   * `true` when the simulate failed for a reason OTHER than the gas
   * ceiling — the real fire-time engine (`single-tx.ts`'s
   * `attemptSingleTxFirst`) throws in this case rather than gracefully
   * falling back to the step chain. Unset (not merely `false`) whenever the
   * tx fits or the failure was a gas-ceiling refusal.
   */
  hardFailure?: boolean;
  rawResult?: unknown;
}

/** The whole-chain dry-run result. */
export interface ChainSimulationResult {
  ok: boolean;
  singleTx?: ChainSingleTxSimOutcome;
  steps: ChainStepSimOutcome[];
  error?: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort extraction of the Pact return VALUE from a signed-simulate's
 * `rawResult`, to thread forward as a single step's yield — the dry-run analog
 * of the driver's `landed.result.data`. Shapes vary by chain client, so this
 * reaches for `result.data`, then a top-level `data`, else the raw value itself.
 */
function extractResultData(raw: unknown): unknown {
  if (raw && typeof raw === "object") {
    const outer = raw as Record<string, unknown>;
    const inner = outer.result;
    if (inner && typeof inner === "object" && "data" in (inner as Record<string, unknown>)) {
      return (inner as Record<string, unknown>).data;
    }
    if ("data" in outer) return outer.data;
  }
  return raw;
}

/** Build a `mode:'single'` step's definition, resolving `$yield` refs in its payload. */
function singleStepDefinition(step: SimulateChainStep, pool: Record<string, unknown>): CodexTxDefinition {
  return {
    pactCode: step.pactCode ?? "",
    config: step.config ?? ({} as CodexTxConfig),
    payload: resolveYieldRefs(step.payload ?? {}, pool) as Record<string, unknown>,
    gasPayer: step.gasPayer ?? { type: "gas-station" },
    signers: step.signers ?? [],
  };
}

/**
 * Synthesize the step ROW a planner reads (`planner_params_json`/`signers_json`/
 * `config_json`/`gas_payer_json`), so `resolvePlannerFor` + the real built-in
 * planners run against it unchanged — no DB row exists yet at simulate time.
 */
function syntheticStepRow(step: SimulateChainStep, stepIndex: number): CodexCronotonStepRow {
  const now = new Date(0).toISOString();
  return {
    id: `sim-step-${stepIndex}`,
    codex_cronoton_id: "sim",
    step_index: stepIndex,
    mode: step.mode,
    pact_code: step.pactCode ?? null,
    config_json: step.config !== undefined ? JSON.stringify(step.config) : null,
    payload_json: step.payload !== undefined ? JSON.stringify(step.payload) : null,
    gas_payer_json: step.gasPayer !== undefined ? JSON.stringify(step.gasPayer) : null,
    signers_json: step.signers !== undefined ? JSON.stringify(step.signers) : null,
    planner_name: step.plannerName ?? null,
    planner_params_json: step.plannerParams !== undefined ? JSON.stringify(step.plannerParams) : null,
    idempotent: 0,
    created_at: now,
    modified_at: now,
    yield_as: step.yieldAs ?? null,
  };
}

/** Simulate a `mode:'planner'` step: resolve the planner, simulate each planned leg. */
async function simulatePlannerStep(
  step: SimulateChainStep,
  stepIndex: number,
  pool: Record<string, unknown>,
  ctx: ExecutorCtx,
  outcome: ChainStepSimOutcome,
): Promise<void> {
  const row = syntheticStepRow(step, stepIndex);
  const resolved = resolvePlannerFor(row, ctx, pool);
  if (!resolved) {
    outcome.ok = false;
    outcome.error = `planner '${step.plannerName ?? "(unnamed)"}' is not registered`;
    return;
  }
  const normalized = normalizePlannerResult(await resolved.planner(resolved.resolvedStep, resolved.plannerCtx));
  outcome.plannedCount = normalized.legs.length;

  let gasUsed = 0;
  let allOk = true;
  let lastRaw: unknown;
  for (const leg of normalized.legs) {
    const sim = await executeCodexTransaction(leg, "simulate", ctx);
    if (!sim.ok) {
      allOk = false;
      if (sim.error && !outcome.error) outcome.error = sim.error;
    }
    if (typeof sim.gasUsed === "number") gasUsed += sim.gasUsed;
    lastRaw = sim.rawResult;
  }
  // Zero legs = "nothing to do this pass" — the driver treats that as a cleared
  // barrier, so the dry run treats it as a passing step.
  outcome.ok = allOk;
  if (gasUsed > 0) outcome.gasUsed = gasUsed;
  if (lastRaw !== undefined) outcome.rawResult = lastRaw;

  // A planner's yield is its own reported value (never an on-chain read) — the
  // SAME source the driver persists. Faithful even in a dry run.
  if (normalized.yield !== undefined) {
    outcome.yielded = normalized.yield;
    if (step.yieldAs) pool[step.yieldAs] = normalized.yield;
  }
}

/** Simulate a `mode:'single'` step: resolve `$yield` refs, sign-simulate, capture the yield. */
async function simulateSingleStep(
  step: SimulateChainStep,
  pool: Record<string, unknown>,
  ctx: ExecutorCtx,
  outcome: ChainStepSimOutcome,
): Promise<void> {
  // `singleStepDefinition` may throw `YieldNotFoundError` (a `$yield` the pool
  // lacks) — the caller's try/catch turns that into this step's error.
  const sim = await executeCodexTransaction(singleStepDefinition(step, pool), "simulate", ctx);
  outcome.ok = sim.ok;
  if (typeof sim.gasUsed === "number") outcome.gasUsed = sim.gasUsed;
  if (sim.error) outcome.error = sim.error;
  if (sim.rawResult !== undefined) outcome.rawResult = sim.rawResult;
  if (sim.ok) {
    const yielded = extractResultData(sim.rawResult);
    outcome.yielded = yielded;
    if (step.yieldAs) pool[step.yieldAs] = yielded;
  }
}

/**
 * Replay a whole chain as a signed dry run. Simulates the single-tx-first variant
 * (when present) as one tx, then walks the steps feeding each yield forward.
 * `ok` is the AND of every step; the single-tx verdict is reported separately
 * (it is the ALTERNATIVE fire path, not part of the step chain). Never throws —
 * a per-step failure rides in that step's `error`, a pre-walk failure in the
 * top-level `error`.
 */
export async function simulateChainBody(
  input: SimulateChainInput,
  ctx: ExecutorCtx,
): Promise<ChainSimulationResult> {
  // Prototype-less pool, exactly like the driver's `getYieldPool` — so a step
  // referencing `{"$yield":"toString"}` throws `YieldNotFoundError` rather than
  // silently resolving to `Object.prototype.toString`.
  const pool: Record<string, unknown> = Object.create(null);

  let singleTx: ChainSingleTxSimOutcome | undefined;
  if (input.singleTxFirst) {
    const stx = input.singleTxFirst;
    try {
      const sim = await executeCodexTransaction(
        {
          pactCode: stx.pactCode,
          config: stx.config ?? ({} as CodexTxConfig),
          payload: stx.payload ?? {},
          gasPayer: stx.gasPayer,
          signers: stx.signers,
        },
        "simulate",
        ctx,
      );
      // Mirror `single-tx.ts`'s `attemptSingleTxFirst` own distinction: an
      // `ok:false` simulate with a numeric `gasUsed` is the executor's
      // refuse-unmineable signal (gracefully falls through to the chain at
      // fire time — "doesn't fit" but not an error); any OTHER `ok:false`
      // (no `gasUsed` at all) is a genuine failure that THROWS at fire time
      // instead, never reaching the chained fallback.
      const gasCeilingRefusal = !sim.ok && typeof sim.gasUsed === "number";
      const hardFailure = !sim.ok && !gasCeilingRefusal;
      singleTx = {
        ok: sim.ok,
        fits: sim.ok,
        ...(hardFailure ? { hardFailure: true } : {}),
        ...(typeof sim.gasUsed === "number" ? { gasUsed: sim.gasUsed } : {}),
        ...(sim.error ? { error: sim.error } : {}),
        ...(sim.rawResult !== undefined ? { rawResult: sim.rawResult } : {}),
      };
    } catch (err) {
      // A synchronous throw during build (e.g. zero signers) rather than a
      // resolved simulate result — also propagates as a real throw at fire
      // time (nothing in `attemptSingleTxFirst` catches it either), so it is
      // a hard failure by the same reasoning.
      singleTx = { ok: false, fits: false, hardFailure: true, error: errMessage(err) };
    }
  }

  const steps: ChainStepSimOutcome[] = [];
  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i];
    const outcome: ChainStepSimOutcome = {
      stepIndex: i,
      mode: step.mode,
      ok: false,
      ...(step.yieldAs ? { yieldAs: step.yieldAs } : {}),
    };
    try {
      if (step.mode === "planner") {
        await simulatePlannerStep(step, i, pool, ctx, outcome);
      } else {
        await simulateSingleStep(step, pool, ctx, outcome);
      }
    } catch (err) {
      outcome.ok = false;
      outcome.error = errMessage(err);
    }
    steps.push(outcome);
  }

  return {
    ok: steps.every((s) => s.ok),
    ...(singleTx ? { singleTx } : {}),
    steps,
  };
}
