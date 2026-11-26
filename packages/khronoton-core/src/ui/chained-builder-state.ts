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
  freshSignerId,
  isPlainObject,
  makeEmptyBuilderState,
  toGasPayerState,
  toRawPayloadState,
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

// ── Deserialization: JSON text → ChainedBuilderState (the inverse) ────────────

/** `jsonToChainedBuilderState`'s result — never throws; a parse failure carries
 *  a human-readable reason and leaves the caller's own state untouched. */
export type ChainedBuilderImportResult =
  | { ok: true; state: ChainedBuilderState }
  | { ok: false; error: string };

/** The primitive type `coerce` returns for a given `kind` literal — ties `T`
 *  to `kind` structurally so a mismatched pair (e.g. `kind:"string"` with a
 *  `boolean` fallback) is a compile error instead of an unchecked cast. */
type PrimitiveFor<K extends "string" | "number" | "boolean"> = K extends "string"
  ? string
  : K extends "number"
    ? number
    : boolean;

/** `v ?? fallback`, but only when `v` is actually of type `kind` — a present-
 *  but-wrong-typed field degrades to the default the same as an absent one. */
function coerce<K extends "string" | "number" | "boolean">(
  v: unknown,
  kind: K,
  fallback: PrimitiveFor<K>,
): PrimitiveFor<K> {
  return typeof v === kind ? (v as PrimitiveFor<K>) : fallback;
}

/** `CodexTxConfig` (wire, possibly malformed) → `BuilderConfig`, one field at a
 *  time — mirrors `detailToBuilderState`'s own `gasPriceBufferAnu ?? 0` idiom,
 *  just per-field instead of object-level, so ONE bad field degrades alone. */
function toBuilderConfigFromWire(raw: unknown): BuilderConfig {
  const empty = makeEmptyBuilderState().config;
  if (!isPlainObject(raw)) return empty;
  return {
    chainId: coerce(raw.chainId, "string", empty.chainId),
    gasPriceBufferAnu: coerce(raw.gasPriceBufferAnu, "number", empty.gasPriceBufferAnu),
    gasLimit: coerce(raw.gasLimit, "number", empty.gasLimit),
    autoGasLimit: coerce(raw.autoGasLimit, "boolean", empty.autoGasLimit),
    ttl: coerce(raw.ttl, "number", empty.ttl),
  };
}

/** A raw (untrusted) payload value → `PayloadState`, always in raw mode — the
 *  same "lossless raw mode" convention `detailToBuilderState` already uses for
 *  a stored row's `payload_json`. A non-object payload degrades to `{}`. */
function toPayloadStateFromWire(raw: unknown): PayloadState {
  const obj = isPlainObject(raw) ? raw : {};
  return toRawPayloadState(obj);
}

/** `CodexGasPayer` (wire, possibly malformed) → `GasPayerState`, reusing the
 *  single-tx builder's own mapping (`toGasPayerState`) once the shape is
 *  confirmed well-formed enough to pass it (a valid `type` discriminant). */
function toGasPayerStateFromWire(raw: unknown): GasPayerState {
  if (isPlainObject(raw)) {
    const type = raw.type;
    if (type === "gas-station") {
      const key = raw.gasStationSignerKey;
      return toGasPayerState({ type, gasStationSignerKey: typeof key === "string" ? key : undefined });
    }
    if (type === "codex") {
      const address = raw.address;
      return toGasPayerState({ type, address: typeof address === "string" ? address : undefined });
    }
  }
  return makeEmptyBuilderState().gasPayer;
}

/** `CodexSigner[]` (wire, possibly malformed) → `SignerRow[]` — an individual
 *  malformed entry (not an object, or no string `publicKey`) is DROPPED rather
 *  than failing the whole step, matching the design's leaf-level tolerance.
 *  Fresh ids via the single-tx builder's own counter (`freshSignerId`), same
 *  `label:"", source:"foreign"` convention `detailToBuilderState` uses. */
function toSignerRowsFromWire(raw: unknown): SignerRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: SignerRow[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry) || typeof entry.publicKey !== "string") continue;
    rows.push({
      id: freshSignerId(),
      publicKey: entry.publicKey,
      label: "",
      source: "foreign",
      capabilityMode: entry.capabilityMode === "scoped" ? "scoped" : "pure",
      capabilities: coerce(entry.capabilities, "string", ""),
    });
  }
  return rows;
}

/** The `{pactCode, config, payload, gasPayer, signers}` tuple shared by a
 *  `"single"`-mode step AND the `singleTxFirst` variant (identical sub-shape
 *  minus `yieldAs`/`idempotent`/planner fields, none of which exist on
 *  `ChainSingleTxFirst`'s type at all) — built once here, not twice. */
function stepEnvelopeFromWire(raw: Record<string, unknown>): {
  pactCode: string;
  config: BuilderConfig;
  payload: PayloadState;
  gasPayer: GasPayerState;
  signers: SignerRow[];
} {
  return {
    pactCode: coerce(raw.pactCode, "string", ""),
    config: toBuilderConfigFromWire(raw.config),
    payload: toPayloadStateFromWire(raw.payload),
    gasPayer: toGasPayerStateFromWire(raw.gasPayer),
    signers: toSignerRowsFromWire(raw.signers),
  };
}

/** One `ChainStepInput` (wire, already shape-checked for a valid `mode` by the
 *  caller) → `StepState`. Lenient on everything below `mode` — a malformed or
 *  absent sub-field degrades to `makeEmptyStepState`'s own default. */
function toStepStateFromWire(raw: Record<string, unknown>): StepState {
  const mode: "single" | "planner" = raw.mode === "planner" ? "planner" : "single";
  const base = makeEmptyStepState(mode);
  if (mode === "planner") {
    const config = toBuilderConfigFromWire(raw.config);
    const gasPayer = toGasPayerStateFromWire(raw.gasPayer);
    const signers = toSignerRowsFromWire(raw.signers);
    return {
      ...base,
      plannerName: coerce(raw.plannerName, "string", ""),
      plannerParamsJson: "plannerParams" in raw ? JSON.stringify(raw.plannerParams, null, 2) : "",
      config,
      gasPayer,
      signers,
      idempotent: coerce(raw.idempotent, "boolean", false),
      yieldAs: coerce(raw.yieldAs, "string", ""),
    };
  }
  const env = stepEnvelopeFromWire(raw);
  return {
    ...base,
    pactCode: env.pactCode,
    config: env.config,
    payload: env.payload,
    gasPayer: env.gasPayer,
    signers: env.signers,
    idempotent: coerce(raw.idempotent, "boolean", false),
    yieldAs: coerce(raw.yieldAs, "string", ""),
  };
}

/** The `singleTxFirst` variant (wire, already known to be a plain object) →
 *  `StepState` — always `mode:"single"`; `yieldAs`/`idempotent`/planner fields
 *  don't exist on `ChainSingleTxFirst`'s type, so they stay at the fresh-step
 *  default rather than being read from anywhere. */
function toVariantStepStateFromWire(raw: Record<string, unknown>): StepState {
  const base = makeEmptyStepState("single");
  const env = stepEnvelopeFromWire(raw);
  return { ...base, ...env };
}

/** A structurally plausible `{mode, config}` schedule is trusted as-is — the
 *  same level of trust `detailToBuilderState` already gives a stored row's
 *  `schedule_config_json` (re-validating the full `ScheduleMode`/
 *  `ScheduleConfig` union here would duplicate `schedule.ts`'s own validation
 *  for no real benefit: a bad schedule just renders oddly in the shared
 *  `ScheduleStep`, same as a hand-corrupted edit would today). */
function toScheduleStateFromWire(raw: unknown): BuilderScheduleState | null {
  if (!isPlainObject(raw) || typeof raw.mode !== "string" || !isPlainObject(raw.config)) {
    return null;
  }
  return { mode: raw.mode as BuilderScheduleState["mode"], config: raw.config as BuilderScheduleState["config"] };
}

/**
 * Parse raw JSON TEXT (the Raw JSON pane's import textarea, or an uploaded
 * `.json` file's content) into a `ChainedBuilderState` — the inverse of
 * {@link chainedBuilderToCommit}. NEVER throws.
 *
 * STRICT (a hard error) only on the load-bearing shape — a malformed document
 * here is worse to silently paper over than to refuse clearly: invalid JSON
 * syntax, a non-object top level, and a missing/non-array/empty `steps` (the
 * last three share `chained-validation.ts`'s OWN "a chained cronoton needs at
 * least one step" wording, so the author sees one voice across import and the
 * commit gate). Any step whose `mode` isn't `"single"`/`"planner"` is the same
 * deal, same wording, with the step's index.
 *
 * LENIENT (coerce-to-default) on everything else — `name`/`description`
 * default to `""`; a missing/malformed per-step `config`/`payload`/`gasPayer`/
 * `signers` falls back to `makeEmptyBuilderState()`'s own per-field defaults;
 * an individually malformed signer entry is dropped, not fatal to its step.
 * The existing `canCommitChain` gate re-surfaces anything genuinely missing
 * (e.g. "Name is required.") once imported — this function's only job is to
 * populate state faithfully, not to pre-validate commit-readiness, since the
 * author may be loading a deliberately incomplete draft to keep editing it.
 */
export function jsonToChainedBuilderState(text: string): ChainedBuilderImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: "Expected a JSON object (the canonical chained-cronoton shape)." };
  }

  const rawSteps = parsed.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { ok: false, error: "a chained cronoton needs at least one step" };
  }
  for (let i = 0; i < rawSteps.length; i += 1) {
    const s = rawSteps[i];
    if (!isPlainObject(s) || (s.mode !== "single" && s.mode !== "planner")) {
      return { ok: false, error: `step ${i}: mode must be 'single' or 'planner'` };
    }
  }

  const base = makeEmptyChainedBuilderState();
  // A step's payload / plannerParams was already successfully JSON.parse'd
  // above, but re-serializing it below (to seed the raw-JSON pane's pretty
  // text) is its OWN recursive walk with its OWN stack limit — a
  // pathologically deep-but-valid document can parse fine and still blow
  // the stack here. Caught so this function's "NEVER throws" contract holds
  // regardless of how deep a pasted/uploaded document goes.
  let steps: StepState[];
  let singleTxVariant: StepState | null;
  try {
    steps = (rawSteps as Record<string, unknown>[]).map(toStepStateFromWire);
    const singleTxFirst = parsed.singleTxFirst;
    singleTxVariant = isPlainObject(singleTxFirst) ? toVariantStepStateFromWire(singleTxFirst) : null;
  } catch (e) {
    return {
      ok: false,
      error: `Could not serialize a field back to JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const externalFireable = parsed.externalFireable === true;
  const schedule = externalFireable ? base.schedule : toScheduleStateFromWire(parsed.schedule) ?? base.schedule;

  return {
    ok: true,
    state: {
      name: coerce(parsed.name, "string", ""),
      description: coerce(parsed.description, "string", ""),
      schedule,
      externalFireable,
      singleTxVariant,
      steps,
    },
  };
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
