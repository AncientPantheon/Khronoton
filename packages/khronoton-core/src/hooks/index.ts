/**
 * `@ancientpantheon/khronoton-core/hooks` — the data + action hook API the
 * Phase-E UI consumes. Every hook reads the injected adapter + resolved config
 * from `<KhronotonProvider>` (mount it once at the tree root). Built by tsup with
 * `react` external (a peer dep).
 *
 * Data hooks:  `useKhronoton` (readiness/config), `useCronotons` (list),
 *   `useCronoton` (one row), `useCronotonFires` (offset-paged history + the
 *   fires-while-running poller), `useManualBatch` (batch state + the
 *   batch-while-active poller).
 * Action hooks: `useCronotonActions` (create/edit/pause/resume/remove, each
 *   confirm-gated) and the execution tier (`useExecuteNow`, `useTrigger`,
 *   `useSimulate`, `useStartBatch`, `useCancelBatch`, `useRecoverFire`). Every
 *   mutating action routes through the shared `runGated` confirm-retry helper,
 *   except the deliberately confirm-free `useCancelBatch`.
 */

// ── Top-level status hook (re-exported from the provider seam) ────────────────
export { useKhronoton } from "../provider/context.js";
export type { UseKhronotonResult } from "../provider/context.js";

// ── Data hooks ────────────────────────────────────────────────────────────────
export { useCronotons } from "./useCronotons.js";
export type { UseCronotonsView } from "./useCronotons.js";
export { useCronoton } from "./useCronoton.js";
export type { UseCronotonView } from "./useCronoton.js";
export { useCronotonFires } from "./useCronotonFires.js";
export type {
  UseCronotonFiresResult,
  UseCronotonFiresOptions,
} from "./useCronotonFires.js";
export { useManualBatch } from "./useManualBatch.js";
export type { UseManualBatchResult } from "./useManualBatch.js";

// ── Lifecycle action hook (create / edit / pause / resume / remove) ───────────
export { useCronotonActions } from "./useCronotonActions.js";
export type {
  CronotonActions,
  UseCronotonActionsOptions,
  GatedAction,
  ActionResult,
  ActionOk,
  ActionFail,
  CreateAction,
  EditAction,
  ToggleAction,
  DeleteAction,
} from "./useCronotonActions.js";

// ── Execution action hooks (executeNow / trigger / simulate / batch / recover) ─
export {
  useExecuteNow,
  useTrigger,
  useSimulate,
  useStartBatch,
  useCancelBatch,
  useRecoverFire,
} from "./useExecuteActions.js";
export type { UseExecuteActionResult } from "./useExecuteActions.js";
