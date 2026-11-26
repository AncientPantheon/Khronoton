/**
 * The CHAINED-cronoton wire contract — the multi-step sibling of
 * `cronoton.ts`'s single-tx `CommitBody`.
 *
 * A chained cronoton is N ordered steps committed as one parent
 * `codex_cronotons` row + N `codex_cronoton_steps` rows, optionally with a
 * single-tx-first variant written into the parent's own fields. The package has
 * no ambient transactional DB (the `Database` seam deliberately omits
 * `transaction`), so the ATOMIC commit belongs to the consumer: the store-level
 * {@link commitChainedCronoton} does the commit+insertSteps+enable sequence, and
 * the consumer wraps it in its own real transaction. These types are the shared
 * contract across the store helper, the `KhronotonAdapter.commitChain` seam, and
 * the chained builder UI.
 */
import type {
  CodexGasPayer,
  CodexSigner,
  CodexTxConfig,
  ScheduleConfig,
  ScheduleMode,
} from "../server/index.js";

/** One committed step of a chain (the insert shape, minus parent id + index). */
export interface ChainStepInput {
  mode: "single" | "planner";
  /** single: the step's Pact code. */
  pactCode?: string;
  config?: CodexTxConfig;
  /** single: env-data; may carry `{"$yield":"name"}` references. */
  payload?: Record<string, unknown>;
  gasPayer?: CodexGasPayer;
  signers?: CodexSigner[];
  /** planner: a registered planner name (e.g. 'ouronet.aqp-inject'). */
  plannerName?: string;
  /** planner: free-form params; may carry `{"$yield":"name"}` references. */
  plannerParams?: unknown;
  idempotent?: boolean;
  /** Names this step's result for a LATER step to reference via `$yield`. */
  yieldAs?: string;
}

/**
 * The single-tx-first variant — a complete one-shot tx (the whole chain as one
 * transaction) written into the parent row. When present, the engine simulates
 * it first and fires it if it fits the gas ceiling, falling back to the chain.
 */
export interface ChainSingleTxFirst {
  pactCode: string;
  config?: CodexTxConfig;
  payload?: Record<string, unknown>;
  gasPayer: CodexGasPayer;
  signers: CodexSigner[];
}

/** The schedule half of a chained commit (absent when `externalFireable`). */
export interface ChainSchedule {
  mode: ScheduleMode;
  config: ScheduleConfig;
}

/** The client-facing chained-commit payload. */
export interface ChainCommitBody {
  name: string;
  description?: string | null;
  /** Present unless `externalFireable` — the two are mutually exclusive. */
  schedule?: ChainSchedule;
  /** Trigger-only: the external HMAC endpoint fires it (no schedule). */
  externalFireable?: boolean;
  /** Opt-in single-tx-first variant. */
  singleTxFirst?: ChainSingleTxFirst;
  /**
   * A chained cronoton needs at least one step — enforced identically at
   * commit time by `server/pure/chained-validation.ts`'s `validateChain`.
   * @minItems 1
   */
  steps: ChainStepInput[];
}

/** `POST /chain` body — the new id, its first fire, and the step ids. */
export interface ChainCommitView {
  ok: true;
  codexCronotonId: string;
  nextFireAt: string | null;
  stepIds: string[];
}

/** One step's simulate verdict within a whole-chain simulate. */
export interface ChainStepSimResult {
  stepIndex: number;
  /** 'single' | 'planner' for display. */
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

/**
 * `POST /chain/simulate` body — the whole-chain dry run. The single-tx variant
 * (when present) is simulated as one tx; the step chain is walked with each
 * step's yield fed forward. `ok` is the AND of every leg that ran.
 *
 * Hand-maintained mirror: structurally identical to `server/chain-simulate.ts`'s
 * `ChainSimulationResult` (`singleTx` mirrors `ChainSingleTxSimOutcome`, `steps`
 * mirrors `ChainStepSimOutcome[]`) — defined separately only so the server layer
 * never imports UP from `handlers`. Update BOTH sides together whenever either
 * changes.
 */
export interface ChainSimulateView {
  ok: boolean;
  /** The single-tx-variant result when one was supplied + simulated. */
  singleTx?: {
    ok: boolean;
    gasUsed?: number;
    error?: string;
    /**
     * Whether the one tx WOULD BE USED at fire time. `true` when `ok`. When
     * `!ok`, mirrors `single-tx.ts`'s `attemptSingleTxFirst`'s own
     * distinction: a numeric `gasUsed` on a failed simulate is the
     * executor's refuse-unmineable signal (falls through to the chain), so
     * `fits` is `false` but {@link hardFailure} is NOT set. Any other
     * failure (no `gasUsed` at all) is what `attemptSingleTxFirst` instead
     * THROWS on, never reaching the chained fallback — so `fits` is `false`
     * AND `hardFailure` is `true`.
     */
    fits?: boolean;
    /**
     * `true` when the simulate failed for a reason OTHER than the gas
     * ceiling — the real fire-time engine throws in this case rather than
     * gracefully falling back to the step chain. Unset whenever the tx fits
     * or the failure was a gas-ceiling refusal.
     */
    hardFailure?: boolean;
    rawResult?: unknown;
  };
  /** Per-step results of walking the chain (the fallback path). */
  steps: ChainStepSimResult[];
  /** A chain-level error that stopped the walk before a step could run. */
  error?: string;
}

// ── Runtime handlers ───────────────────────────────────────────────────────────
//
// The confirm-gated commit/simulate half of the chained-cronoton route surface —
// the multi-step sibling of `cronoton.ts`'s `commitCodexCronoton`/`simulateCodexTx`.
// Both handlers follow the SAME two conventions those modules already document:
// a malformed wire body is a 400 client error (REQ-H01, via the store's own
// `validateChain` reject for `commitChainedCronoton`), and `simulateChain` returns
// HTTP 200 even when the result's own `ok` is false (REQ-H04) — a chain/step
// failure rides in the body for the caller to inspect via `result.ok`.
import {
  CodexCronotonValidationError,
  commitChainedCronoton as storeCommitChainedCronoton,
  simulateChainBody,
  type CommitChainedCronotonInput,
  type SimulateChainInput,
} from "../server/index.js";
import { withConfirm, type AuthIdentity, type HandlerContext } from "./context.js";
import { json, type HandlerRequest, type HandlerResponse } from "./http.js";

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new CodexCronotonValidationError(message);
  }
  return value as Record<string, unknown>;
}

/** Attribute a write to the gate identity, falling back to a system marker. */
function createdByOf(identity: AuthIdentity | undefined): string {
  return identity?.email ?? identity?.id ?? "system";
}

/**
 * Adapt a normalized `ChainCommitBody` into the store's
 * `CommitChainedCronotonInput`. A missing/mistyped body is a 400 client error
 * (the store's `validateChain` then rejects a missing/empty `steps` array with
 * its own 400 — this adapter does not duplicate that check).
 */
function toCommitChainInput(body: unknown, createdBy: string): CommitChainedCronotonInput {
  const b = requireObject(body, "request body must be a chain commit object");
  return {
    name: b.name as string,
    description: (b.description as string | null | undefined) ?? null,
    schedule: b.schedule as ChainSchedule | undefined,
    externalFireable: b.externalFireable as boolean | undefined,
    singleTxFirst: b.singleTxFirst as ChainSingleTxFirst | undefined,
    steps: (b.steps as ChainStepInput[] | undefined) ?? [],
    createdBy,
  };
}

/**
 * POST /chain — commit a new CHAINED codex cronoton (parent row + N ordered
 * steps). Confirm-gated; 201 on success with the new id, its first scheduled
 * fire, and the step ids (matching {@link ChainCommitView}).
 */
export async function commitChainedCronoton(
  ctx: HandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  return withConfirm(ctx, req, async (identity) => {
    const input = toCommitChainInput(req.body, createdByOf(identity));
    const { id, nextFireAt, stepIds } = storeCommitChainedCronoton(input, { db: ctx.db });
    await ctx.onAudit?.({
      action: "chained_cronoton.commit",
      result: "ok",
      targetKind: "codex_cronoton",
      targetId: id,
      detail: { name: input.name, stepCount: input.steps.length },
    });
    return json(201, { ok: true, codexCronotonId: id, nextFireAt, stepIds });
  });
}

/**
 * POST /chain/simulate — the whole-chain dry run. Confirm-gated (a dry run
 * still signs + costs a real node read, same precedent as `simulateCodexTx` in
 * `execute.ts`). Reuses the SAME `ChainCommitBody`-shaped wire body as the
 * commit handler — `simulateChainBody` accepts a `steps`/`singleTxFirst` pair
 * straight through with no translation. Always 200: `ChainSimulateView.ok`
 * already carries the AND-of-every-leg verdict in the body (REQ-H04 — do not
 * map `ok:false` to a non-200 status).
 */
export async function simulateChain(
  ctx: HandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  return withConfirm(ctx, req, async () => {
    const b = requireObject(req.body, "request body must be a chain simulate object");
    const input: SimulateChainInput = {
      singleTxFirst: b.singleTxFirst as SimulateChainInput["singleTxFirst"],
      steps: (b.steps as SimulateChainInput["steps"] | undefined) ?? [],
    };
    const result = await simulateChainBody(input, {
      runtime: ctx.runtime,
      resolver: ctx.resolver,
      config: ctx.config,
    });
    return json(200, result);
  });
}
