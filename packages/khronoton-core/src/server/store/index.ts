/**
 * The store public surface for `@ancientpantheon/khronoton-core/server`.
 *
 * Re-exports every store function/error/type the consumer drives, via relative
 * `.js`-suffixed paths (values with `export {…}`, types/interfaces with
 * `export type {…}`), so the emitted `.d.ts` stays fully erasable.
 *
 * Deliberately NOT re-exported from `./errors.js`: the tuning constants
 * `TICK_BATCH_LIMIT`, `MANUAL_BATCH_MIN`, `MANUAL_BATCH_MAX`,
 * `MANUAL_BATCH_INTERVAL_SECONDS`. Those names are already the public export at
 * `../seams.js` (the injectable `Config` defaults) and are surfaced by the
 * Phase-1 server barrel. The `./errors.js` copies exist only as the module-local
 * fallback backing `config?.<field> ?? <CONSTANT>`; re-exporting them here would
 * collide with the seams.ts source at the server barrel. seams.ts is the single
 * public source for those constants.
 */

// ── Typed errors (classes — values, not types) ───────────────────────────────
export {
  CodexCronotonValidationError,
  AutoGasGateError,
  TerminalCronotonError,
  ManualBatchActiveError,
} from "./errors.js";

// ── Pure mappers / gates ─────────────────────────────────────────────────────
export {
  rowToDefinition,
  rowExternalFireable,
  rowRuntimeArgKeys,
  assertAutoGasGate,
  manualBatchView,
} from "./mappers.js";

// ── Atomic claim + due selection + terminal/advance writes ───────────────────
export {
  fetchDueCodexCronotons,
  claimDueCodexCronoton,
  applyTerminalIntent,
  advanceRecurring,
} from "./claim.js";

// ── Fires: record / running / append / finalize / list / recover ─────────────
export {
  recordFire,
  createRunningFire,
  setFireJobId,
  appendFireTxKeys,
  finalizeFire,
  listFires,
  recoverFire,
} from "./fires.js";
export type { RecordFireInput, FireDep } from "./fires.js";

// ── Cronoton lifecycle: commit / read / find / list / edit / pause / resume / delete ─
export {
  commitCodexCronoton,
  getCodexCronoton,
  findCodexCronotonIdByServerResolver,
  listCodexCronotons,
  editCodexCronoton,
  pauseCodexCronoton,
  resumeCodexCronoton,
  deleteCodexCronoton,
} from "./cronoton.js";
export type { CommitCodexCronotonInput, EditCodexCronotonPatch } from "./cronoton.js";

// ── Manual-batch lifecycle: create / due-fetch / claim / cancel ──────────────
export {
  getManualBatch,
  getActiveManualBatchForCronoton,
  createManualBatch,
  fetchDueManualBatches,
  claimManualBatchFire,
  cancelManualBatch,
} from "./manual-batch.js";
export type { CreateManualBatchInput } from "./manual-batch.js";

// ── Fingerprint (Phase-1 pure helper, re-surfaced for Hub `store.ts` parity) ──
// The Hub exported `computeDefinitionFingerprint` FROM its store module; the
// store barrel is the single export site here (the Phase-1 server barrel drops
// its own direct fingerprint export in favor of this one to avoid a duplicate).
export { computeDefinitionFingerprint } from "../pure/fingerprint.js";
