/**
 * Public entry for `@ancientpantheon/khronoton-core/server`.
 *
 * Re-exports the Phase-1 server surface: the shared domain types, the six
 * injection seams (plus their carrier types and default tuning constants), the
 * dependency-free pure helpers, and the driver-free `installSchema`. The
 * schedule symbols the server surface leans on are re-exported from the root
 * core so a consumer gets the whole contract from one entry (REQ-16) without a
 * private copy. Every re-export is `export type` where the symbol is a type, so
 * the emitted `.d.ts` stays fully erasable and carries no external module
 * reference.
 */

// ── Shared domain types (T1.1) ───────────────────────────────────────────────
export type {
  ChainId,
  ExecutorMode,
  ScheduleKind,
  CapabilityMode,
  CodexSigner,
  CodexGasPayer,
  CodexTxConfig,
  CodexTxDefinition,
  TerminalIntent,
  SimulateResult,
  FireResult,
  SubmitResult,
  ExecutorResult,
  CodexCronotonRow,
  CodexCronotonListItem,
  CodexFireMode,
  FireTxKey,
  CodexCronotonFireRow,
  CodexManualBatchRow,
  ManualBatchView,
} from "./types.js";

// ── Injection seams + carrier types (T1.2) ───────────────────────────────────
export type {
  KeyResolver,
  ChainRuntime,
  Database,
  DbDep,
  OnAudit,
  ResolveFireMode,
  Config,
  IKadenaKeypair,
  UniversalKeypair,
  IUnsignedCommand,
  DirtyReadResult,
  ListenResult,
  ChainClient,
  Statement,
  AuditEvent,
} from "./seams.js";

// ── Seam defaults + tuning constants (T1.2) ──────────────────────────────────
export {
  defaultOnAudit,
  defaultResolveFireMode,
  TICK_INTERVAL_MS,
  LISTEN_TIMEOUT_MS,
  AUTO_GAS_CEILING,
  SINGLE_TX_GAS_GUARD,
  TICK_BATCH_LIMIT,
  MANUAL_BATCH_MIN,
  MANUAL_BATCH_MAX,
  MANUAL_BATCH_INTERVAL_SECONDS,
  RUN_STEP_DEADLINE_MS,
  DEFAULT_MAX_REPLAN_ATTEMPTS,
} from "./seams.js";

// ── Pure helpers (T1.3 / T1.5) ───────────────────────────────────────────────
// `computeDefinitionFingerprint` is intentionally NOT exported here: the store
// barrel (`./store/index.js`, re-exported below) is its single export site, so
// the `/server` surface carries it once — mirroring the Hub, where it lived on
// the store module. Re-exporting it here too would duplicate that one binding.
export { parseCapabilityLine, computeTerminalIntent } from "./pure/capability.js";
export {
  parseRuntimeArgKeys,
  validateRuntimeArgs,
  applyRuntimeArgs,
  runtimeArgKeysCollide,
  hashRuntimeArgs,
} from "./pure/runtime-args.js";
export type { RuntimeArgs, ValidateRuntimeArgsResult } from "./pure/runtime-args.js";
export { advanceRun } from "./pure/run-advance.js";
export type { StepMode, RunState, LegState, RunPolicy, RunAction } from "./pure/run-advance.js";

// ── Consolidated schema installer (T1.6) ─────────────────────────────────────
export { installSchema } from "./schema.js";

// ── Root-core schedule symbols the server surface leans on (REQ-16) ───────────
// Re-exported from the already-published root core so a `/server` consumer gets
// the schedule contract from one entry without a private copy. `ScheduleConfig`
// is re-exported directly here because `types.ts` deliberately does not import
// it (it would trip `noUnusedLocals`).
export type { ScheduleMode, ScheduleConfig } from "../schedule.js";

// ── Headless executor (Phase 3: build/sign/simulate/fire behind the seams) ────
// `LISTEN_TIMEOUT_MS` is NOT re-exported here — the seam-defaults group above is
// its single barrel source (identical 300_000 constant), so re-exporting the
// executor's own copy would be a duplicate named export.
export { executeCodexTransaction } from "./executor.js";
export type { ExecutorCtx } from "./executor.js";
export { effectiveSigners } from "./executor-signers.js";

// ── Store surface (Phase 2: errors, mappers, claim, fires, cronoton, batch) ───
// `export *` here is collision-free: the store barrel deliberately omits the
// `TICK_BATCH_LIMIT` / `MANUAL_BATCH_*` constants (seams.js above is their single
// source) and `computeDefinitionFingerprint` is exported ONLY through the store
// barrel now (the direct pure-helper re-export above was dropped).
export * from "./store/index.js";

// ── Server-resolver registry + fire dispatcher (Phase 4: registry, kind-routed
// fire, single-tx merge path). Collision-free: the constant it leans on
// (`SINGLE_TX_GAS_GUARD`) is imported from `./seams.js`, not re-declared, so the
// seam-defaults group above stays its single barrel source.
export * from "./resolvers.js";

// ── StepPlanner registry + the real `ouronet.aqp-evict`/`ouronet.aqp-inject`/
// `ouronet.aqp-unstall`/`ouronet.stoa-wrap`/`ouronet.stoa-unwrap` planners
// (Phase 4 / Phase 4.1 / Phase 4b: registerStepPlanner/getStepPlanner/
// StepPlanner/PlannedLeg/PlannerCtx, plus `evictPlanner`/`injectPlanner`/
// `unstallPlanner`/`stoaWrapPlanner`/`stoaUnwrapPlanner` themselves).
// Collision-free: none re-exports anything already barrelled above.
// Importing `./planners/evict.js`/`./planners/inject.js`/
// `./planners/unstall.js`/`./planners/stoa-wrap.js`/`./planners/stoa-unwrap.js`
// here is load-bearing, not cosmetic — their module-eval side effects
// (`registerStepPlanner("ouronet.aqp-evict", evictPlanner)`,
// `registerStepPlanner("ouronet.aqp-inject", injectPlanner)`,
// `registerStepPlanner("ouronet.aqp-unstall", unstallPlanner)`,
// `registerStepPlanner("ouronet.stoa-wrap", stoaWrapPlanner)`, and
// `registerStepPlanner("ouronet.stoa-unwrap", stoaUnwrapPlanner)`) are what
// make those planner names resolvable at all for a consumer who imports
// anything from this package's `/server` entry point.
export * from "./planners/registry.js";
export * from "./planners/evict.js";
export * from "./planners/inject.js";
export * from "./planners/unstall.js";
export * from "./planners/stoa-wrap.js";
export * from "./planners/stoa-unwrap.js";

// ── Server tick (Phase 4: select → claim → fire → record → finalize → audit).
// `codexCronotonTickOnce` / `processDueManualBatchesOnce` + `TickCtx` + the two
// tick result types. Collision-free: `TickCtx` and the result interfaces are
// declared only here, and the tick imports the store fns from their submodules
// (no re-export of an already-barrelled symbol).
export * from "./tick.js";

// ── Server loop driver (Phase 4: the single-instance setInterval driver with the
// one-boolean re-entrancy guard). `startKhronotonLoop` + its opts/handle types.
// Collision-free: it re-exports nothing already barrelled — it only imports the
// two tick fns (via `./tick.js`) as its injectable defaults.
export * from "./loop.js";

// ── Chained-run driver (Phase 3: executes Phase 2's pure `advanceRun`
// decision function against the real store/chain). `driveRunOnce` +
// `advanceInFlightRunsOnce` + `RunsDriverCtx` + `PlannerNotRegisteredError`.
// Collision-free: it re-exports nothing already barrelled.
export * from "./runs-driver.js";
