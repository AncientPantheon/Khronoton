/**
 * True for the better-sqlite3 `SqliteError` a UNIQUE index violation raises.
 * The single shared home for this driver-error-classification check — a
 * cross-phase review found `store/runs.ts` and `store/steps.ts` each
 * carrying a byte-identical, independently-declared copy (one file's own
 * doc comment admitted it "mirrors" the other's), which is exactly the kind
 * of drift risk `planners/registry.ts`'s `resolvePlannerFor` was extracted
 * to close for a different pair of duplicated call sites.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";
}

// ── Typed errors ─────────────────────────────────────────────────────────────

/** Generic validation/schedule reject — the route maps it to 400 + the reason. */
export class CodexCronotonValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexCronotonValidationError';
  }
}

/** AUTO-gas commit-gate breach — an AUTO row needs a concrete calibrated limit. */
export class AutoGasGateError extends CodexCronotonValidationError {
  constructor(message = 'AUTO-gas row requires a concrete calibrated gasLimit > 0') {
    super(message);
    this.name = 'AutoGasGateError';
  }
}

/** Refusal to pause/resume/fire a spent one-time (completed/error) row. */
export class TerminalCronotonError extends Error {
  constructor(status: string) {
    super(
      `codex cronoton is terminal (status='${status}'): a spent one-time entry cannot be reactivated or re-fired`,
    );
    this.name = 'TerminalCronotonError';
  }
}

/** A batch is already running for this cronoton — the route maps this to 409. */
export class ManualBatchActiveError extends Error {
  constructor() {
    super('a manual execution batch is already running for this codex cronoton');
    this.name = 'ManualBatchActiveError';
  }
}

/** A non-terminal run already exists for this cronoton — self-blocking only (a DIFFERENT cronoton must never be blocked by this). */
export class RunAlreadyInFlightError extends Error {
  constructor(codexCronotonId: string) {
    super(
      `codex cronoton ${codexCronotonId} already has a non-terminal run in flight — a new run cannot start until it settles`,
    );
    this.name = 'RunAlreadyInFlightError';
  }
}

/** A run leg already has (or is past) a request key — re-submission is refused; the leg must only be polled, never re-submitted. */
export class LegAlreadySubmittedError extends Error {
  constructor(legId: string) {
    super(
      `run leg ${legId} is already submitted (or past submission) — re-submission is refused, only polling for its outcome is allowed`,
    );
    this.name = 'LegAlreadySubmittedError';
  }
}

/** markLegConfirmed/markLegFailed require the leg to currently be 'submitted' — a leg that never reached the chain cannot be confirmed, and an already-terminal leg cannot be silently overwritten. */
export class LegNotSubmittedError extends Error {
  constructor(legId: string) {
    super(
      `run leg ${legId} is not in 'submitted' status — it has either never been submitted or is already in a terminal status (confirmed/failed)`,
    );
    this.name = 'LegNotSubmittedError';
  }
}

/** A step already exists at this (codexCronotonId, stepIndex) — step indexes are immutable once written, mirroring RunAlreadyInFlightError's "no raw driver error escapes the store layer" posture. */
export class StepAlreadyExistsError extends Error {
  constructor(codexCronotonId: string, stepIndex: number) {
    super(
      `codex cronoton ${codexCronotonId} already has a step at index ${stepIndex} — step indexes are immutable once written`,
    );
    this.name = 'StepAlreadyExistsError';
  }
}

/** A leg already exists at this (runId, stepIndex, legIndex) slot — the same "no raw driver error escapes the store layer" posture as StepAlreadyExistsError/RunAlreadyInFlightError. */
export class RunLegAlreadyExistsError extends Error {
  constructor(runId: string, stepIndex: number, legIndex: number) {
    super(
      `run ${runId} already has a leg at step ${stepIndex}, leg ${legIndex} — that slot cannot be inserted twice`,
    );
    this.name = 'RunLegAlreadyExistsError';
  }
}

/** advanceRunStep's fromStepIndex no longer matches the run's live step_index — a stale caller must fail loudly rather than overwrite a step another process already moved past. */
export class RunStepMismatchError extends Error {
  constructor(runId: string, expectedStepIndex: number) {
    super(
      `run ${runId} is not at step ${expectedStepIndex} — its step_index has already moved on, so this advance is stale`,
    );
    this.name = 'RunStepMismatchError';
  }
}

/** markRunTerminal requires the run to currently be non-terminal — an already-terminal run (succeeded/failed/abandoned) cannot be silently overwritten. */
export class RunAlreadyTerminalError extends Error {
  constructor(runId: string) {
    super(`run ${runId} is already in a terminal status (succeeded/failed/abandoned)`);
    this.name = 'RunAlreadyTerminalError';
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Batch count bounds + fixed cadence. These back the injectable Config seam as
 * its DEFAULTS: consumer sites read `config?.manualBatch?.<field> ?? <CONSTANT>`
 * (min/max/intervalSeconds) so the constants stay the fallback contract.
 */
export const MANUAL_BATCH_MIN = 2;
export const MANUAL_BATCH_MAX = 60;
export const MANUAL_BATCH_INTERVAL_SECONDS = 60;

/** Default per-tick due-selection ceiling — backs `config.tickBatchLimit`. */
export const TICK_BATCH_LIMIT = 100;
