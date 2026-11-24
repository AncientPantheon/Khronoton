/**
 * Pure builder model for a CHAINED codex-cronoton (multi-step) — the sibling of
 * the single-tx `builder-state.ts`.
 *
 * A chained cronoton is N ordered steps, each either:
 *   - `single`  — a composed Pact tx (pactCode + config + payload + gasPayer +
 *                 signers: the same per-step subset a single cronoton has), or
 *   - `planner` — a registered khronoton built-in (`ouronet.stoa-wrap` …) plus
 *                 free-form JSON params (which may carry `{"$yield":"name"}`).
 *     A planner step STILL carries config/gasPayer/signers — the executor signs
 *     each leg with them (an inject/evict planner throws with zero signers).
 *
 * "Step 0" is the optional single-tx variant (`singleTxVariant`): the whole chain
 * expressed as ONE gas-station-payable tx, which the engine simulates first and
 * fires if it fits, falling back to the step chain otherwise.
 *
 * Serialization REUSES the single-tx `builderToCommit` per step, so a step's
 * config/payload/gasPayer/signers are byte-identical to a single cronoton's.
 *
 * React-free: the chained builder component owns presentation and calls these.
 */
import type { CodexGasPayer, CodexSigner, CodexTxConfig } from "../server/index.js";
import type { ChainCommitBody, ChainSingleTxFirst, ChainStepInput } from "../handlers/chain.js";
import {
  builderToCommit,
  makeEmptyBuilderState,
  validateConfig,
  validateGasPayer,
  validatePayload,
  validateSigners,
  type BuilderConfig,
  type BuilderScheduleState,
  type BuilderState,
  type GasPayerState,
  type PayloadState,
  type SignerRow,
} from "./builder-state.js";
import {
  validateChain,
  validateSingleTxVariant,
  type ChainedStepInput,
} from "../server/pure/chained-validation.js";

/** The registered step planners khronoton ships (server barrel). */
export const KNOWN_PLANNERS = [
  "ouronet.stoa-wrap",
  "ouronet.stoa-unwrap",
  "ouronet.aqp-inject",
  "ouronet.aqp-evict",
  "ouronet.aqp-unstall",
] as const;

// ── State shape ───────────────────────────────────────────────────────────────

/** One step of a chained cronoton, as the rich builder edits it. */
export interface StepState {
  /** Ephemeral UI identity (React key); never reaches the commit body. */
  key: string;
  mode: "single" | "planner";
  /** single: the step's Pact code. */
  pactCode: string;
  config: BuilderConfig;
  payload: PayloadState;
  gasPayer: GasPayerState;
  signers: SignerRow[];
  /** planner: a registered planner name. */
  plannerName: string;
  /** planner: free-form JSON params (may carry `{"$yield":"name"}`), as text. */
  plannerParamsJson: string;
  idempotent: boolean;
  /** Names this step's confirmed on-chain return value (single) / planner yield
   *  for a LATER step to reference via `{"$yield":"name"}`. */
  yieldAs: string;
}

/** The complete pure form state the chained builder reads + writes. */
export interface ChainedBuilderState {
  name: string;
  description: string;
  schedule: BuilderScheduleState;
  /** Trigger-only (no schedule) — the external HMAC endpoint fires it. */
  externalFireable: boolean;
  /** "Step 0" — the single-tx variant (always a `single` tx). null = not enabled. */
  singleTxVariant: StepState | null;
  /** The chain: Step 1..N. */
  steps: StepState[];
}

// The committed wire shapes (`ChainStepInput` / `ChainSingleTxFirst` /
// `ChainCommitBody`) are the canonical contract in `handlers/chain.ts`, imported
// above and produced by the serializers below.

// ── Keys + defaults ───────────────────────────────────────────────────────────

function makeKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `step-${Math.random().toString(36).slice(2, 10)}`;
}

/** A fresh step with the single-tx builder's config/payload/gasPayer defaults. */
export function makeEmptyStepState(mode: "single" | "planner" = "single"): StepState {
  const base = makeEmptyBuilderState();
  return {
    key: makeKey(),
    mode,
    pactCode: "",
    config: base.config,
    payload: base.payload,
    gasPayer: base.gasPayer,
    signers: [],
    plannerName: mode === "planner" ? KNOWN_PLANNERS[0] : "",
    plannerParamsJson: "",
    idempotent: false,
    yieldAs: "",
  };
}

/** A fresh chained form: one empty single step, no variant. */
export function makeEmptyChainedBuilderState(): ChainedBuilderState {
  const base = makeEmptyBuilderState();
  return {
    name: "",
    description: "",
    schedule: base.schedule,
    externalFireable: false,
    singleTxVariant: null,
    steps: [makeEmptyStepState("single")],
  };
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

/** Parse planner params text; undefined for empty OR invalid (serializer is total). */
function parsePlannerParamsOrUndef(text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

/** True when non-empty planner params text fails to parse (validation uses this). */
function plannerParamsParseError(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  try {
    JSON.parse(t);
    return false;
  } catch {
    return true;
  }
}

/** Synthesize a single-tx BuilderState from a step's per-tx subset. */
function stepBuilderState(step: StepState): BuilderState {
  return {
    ...makeEmptyBuilderState(),
    pactCode: step.pactCode,
    config: step.config,
    payload: step.payload,
    gasPayer: step.gasPayer,
    signers: step.signers,
  };
}

/** The committed {pactCode, config, payload, gasPayer, signers} for a step —
 *  reuses the single-tx serializer so a step == a single cronoton on the wire. */
function stepEnvelope(step: StepState): {
  pactCode: string;
  config: CodexTxConfig;
  payload: Record<string, unknown>;
  gasPayer: CodexGasPayer;
  signers: CodexSigner[];
} {
  const env = builderToCommit(stepBuilderState(step)).envelope;
  return {
    pactCode: env.pactCode,
    config: env.config,
    payload: env.payload ?? {},
    gasPayer: env.gasPayer,
    signers: env.signers,
  };
}

// ── Serialization: state → ChainCommitBody ────────────────────────────────────

/** Map one step model to its committed wire shape. TOTAL (never throws). */
export function stepStateToStepInput(step: StepState): ChainStepInput {
  const env = stepEnvelope(step);
  if (step.mode === "planner") {
    return {
      mode: "planner",
      plannerName: step.plannerName.trim() || undefined,
      plannerParams: parsePlannerParamsOrUndef(step.plannerParamsJson),
      // Planner steps carry config/gasPayer/signers too (the executor signs each
      // leg with them) — never pactCode/payload (the planner builds those).
      config: env.config,
      gasPayer: env.gasPayer,
      signers: env.signers,
      idempotent: step.idempotent || undefined,
      yieldAs: step.yieldAs.trim() || undefined,
    };
  }
  return {
    mode: "single",
    pactCode: step.pactCode,
    config: env.config,
    payload: env.payload,
    gasPayer: env.gasPayer,
    signers: env.signers,
    idempotent: step.idempotent || undefined,
    yieldAs: step.yieldAs.trim() || undefined,
  };
}

/** Map the Step-0 variant to its single-tx-first wire shape. */
export function singleTxVariantToInput(step: StepState): ChainSingleTxFirst {
  const env = stepEnvelope(step);
  return {
    pactCode: step.pactCode,
    config: env.config,
    payload: env.payload,
    gasPayer: env.gasPayer,
    signers: env.signers,
  };
}

/** Serialize the chained form into the wire `ChainCommitBody`. TOTAL. */
export function chainedBuilderToCommit(state: ChainedBuilderState): ChainCommitBody {
  const body: ChainCommitBody = {
    name: state.name,
    steps: state.steps.map(stepStateToStepInput),
  };
  if (state.description.trim().length > 0) body.description = state.description;
  // externalFireable and a schedule are mutually exclusive (parity with the Hub).
  if (state.externalFireable) {
    body.externalFireable = true;
  } else {
    body.schedule = { mode: state.schedule.mode, config: state.schedule.config };
  }
  if (state.singleTxVariant) {
    body.singleTxFirst = singleTxVariantToInput(state.singleTxVariant);
  }
  return body;
}

// ── Validation ────────────────────────────────────────────────────────────────

const MSG = {
  name: "Name is required.",
  stepPact: "Pact code is required.",
  stepPlanner: "A built-in planner is required.",
  plannerParams: "Planner params must be valid JSON.",
  plannerSigner: "A planner step needs at least one signer (to sign its legs).",
} as const;

/** Blocking reasons for ONE step, prefixed with its label. */
function validateStep(step: StepState, label: string): string[] {
  const synthetic = stepBuilderState(step);
  const reasons: string[] = [];
  const prefix = (m: string) => `${label}: ${m}`;

  if (step.mode === "planner") {
    if (step.plannerName.trim().length === 0) reasons.push(prefix(MSG.stepPlanner));
    if (plannerParamsParseError(step.plannerParamsJson)) reasons.push(prefix(MSG.plannerParams));
    // A planner needs its own real signers — the synthesized gas-payer signer is
    // never written into signers_json, so effectiveSignerCount would over-count.
    if (step.signers.length === 0) reasons.push(prefix(MSG.plannerSigner));
  } else {
    if (step.pactCode.trim().length === 0) reasons.push(prefix(MSG.stepPact));
    reasons.push(...validatePayload(synthetic).errors.map(prefix));
    reasons.push(...validateSigners(synthetic).map(prefix));
  }

  // AUTO-gas calibration is waived per-step here — the chained simulator
  // calibrates each step's gas when it runs; this gate is structural only.
  reasons.push(...validateConfig(synthetic, { simulateCalibrated: true }).map(prefix));
  reasons.push(...validateGasPayer(synthetic).map(prefix));
  return reasons;
}

/**
 * The chained commit gate: cronoton-level name + per-step structural validation +
 * the pure chain rules (yield graph, decimal tripwire) + the optional single-tx
 * variant. Returns every blocking reason.
 *
 * `stepInputs` — the `state.steps` mapped through `stepStateToStepInput` — may be
 * passed in already-computed (the caller, e.g. `chainedBuilderToCommit`'s result,
 * typically has one lying around) to avoid re-running that per-step mapping a
 * second time on every state change; defaults to mapping it here when omitted.
 */
export function canCommitChain(
  state: ChainedBuilderState,
  stepInputs: ChainedStepInput[] = state.steps.map(stepStateToStepInput),
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (state.name.trim().length === 0) reasons.push(MSG.name);

  state.steps.forEach((step, i) => {
    reasons.push(...validateStep(step, `Step ${i + 1}`));
  });
  if (state.singleTxVariant) {
    reasons.push(...validateStep(state.singleTxVariant, "Step 0 (single-tx)"));
  }

  // Pure chain rules over the mapped step inputs (yield graph + decimal tripwire).
  const chain = validateChain(stepInputs);
  if (!chain.ok) reasons.push(chain.reason);

  if (state.singleTxVariant) {
    const variant = validateSingleTxVariant(singleTxVariantToInput(state.singleTxVariant));
    if (!variant.ok) reasons.push(variant.reason);
  }

  return { ok: reasons.length === 0, reasons };
}

// ── Step-list mutation helpers (pure; the component wraps these in setState) ───

/**
 * The "Step 0" renumbering rule: with exactly one step it is the unlabeled
 * "Step 0" (a plain single cronoton, see the module header); once the chain has
 * 2+ steps they are 1-based "Step 1" … "Step N" and the variant slot takes the
 * "Step 0" label instead. Shared by the step rail and every per-step heading so
 * the off-by-one-prone rule lives in exactly one place.
 */
export function stepLabel(steps: StepState[], index: number): string {
  return steps.length === 1 ? "Step 0" : `Step ${index + 1}`;
}

/**
 * Drop the single-tx variant once the chain shrinks back below 2 steps — the
 * variant's only enable/disable control (the rail's checkbox) is itself hidden
 * below 2 steps, so a shrink that leaves a variant set would orphan it with no
 * way to disable it short of re-adding a step. Mirrors the explicit "uncheck"
 * clearing already done by the variant toggle handler.
 */
export function clearVariantIfOrphaned(
  steps: StepState[],
  variant: StepState | null,
): StepState | null {
  return steps.length < 2 ? null : variant;
}

/**
 * The commit-routing predicate: exactly ONE `single`-mode step and no single-tx
 * variant is a plain single cronoton (the "Step 0" case, routed through
 * `adapter.commit`); anything else is a real chain, routed through
 * `adapter.commitChain`. Pure function of `state` alone.
 */
export function isSingleStepChain(state: ChainedBuilderState): boolean {
  return state.steps.length === 1 && !state.singleTxVariant && state.steps[0].mode === "single";
}

/** Names declared by steps BEFORE `index` — referenceable via `{"$yield":"…"}`. */
export function earlierYields(steps: StepState[], index: number): string[] {
  return steps
    .slice(0, index)
    .map((s) => s.yieldAs.trim())
    .filter((y) => y.length > 0);
}

/** Append a fresh step. If this is the 2nd step and there is no variant yet, the
 *  caller may choose to seed Step 0 — kept a pure list op here (no migration). */
export function appendStep(steps: StepState[], mode: "single" | "planner" = "single"): StepState[] {
  return [...steps, makeEmptyStepState(mode)];
}

/** Replace the step at `index`. */
export function replaceStep(steps: StepState[], index: number, next: StepState): StepState[] {
  return steps.map((s, i) => (i === index ? next : s));
}

/** Remove the step at `index` (never empties the list — keeps ≥1). */
export function removeStep(steps: StepState[], index: number): StepState[] {
  if (steps.length <= 1) return steps;
  return steps.filter((_, i) => i !== index);
}

/** Move the step at `index` by `delta` (±1), clamped. */
export function moveStep(steps: StepState[], index: number, delta: number): StepState[] {
  const target = index + delta;
  if (target < 0 || target >= steps.length) return steps;
  const next = [...steps];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * Where the rail's `selected` index should land after `moveStep(steps, index,
 * delta)` reorders `steps` — kept in lockstep with `moveStep`'s own clamping
 * (`length` is `steps.length`, which `moveStep` never changes) so the two can
 * never disagree about whether a move actually happened.
 *
 * - The out-of-range (clamped, no-op) case: `selected` is unchanged.
 * - `selected === index` (the moved step itself): follows its content to
 *   `target`.
 * - `selected === target` (the step displaced FROM the target slot): follows
 *   its content to `index`.
 * - Anything else: untouched.
 */
export function selectedAfterMove(
  selected: number,
  index: number,
  delta: number,
  length: number,
): number {
  const target = index + delta;
  if (target < 0 || target >= length) return selected;
  if (selected === index) return target;
  if (selected === target) return index;
  return selected;
}
