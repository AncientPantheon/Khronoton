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
