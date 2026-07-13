/**
 * `@ancientpantheon/khronoton-core/provider` — the consumer-facing data layer:
 * the `<KhronotonProvider>` root, the `KhronotonAdapter` seam (how the UI reaches
 * the backend), the two reference adapters (`createFetchAdapter` over HTTP,
 * `createMemoryAdapter` over an in-process handler context), the `runGated`
 * confirm-retry helper, and the public config/view types. Built by tsup with
 * `react` external (a peer dep). The `useKhronoton()` status hook is re-exported
 * here for the mount site; the full data + action hook API lives under `/hooks`.
 *
 * `useKhronotonAdapter()` / `useKhronotonConfig()` are deliberately NOT exported:
 * they are the internal seam the `/hooks` layer reads, not part of the public
 * surface (a consumer reaches data through the hooks, never the raw adapter).
 */

// ── The provider root + its top-level status hook ─────────────────────────────
export { KhronotonProvider } from "./KhronotonProvider.js";
export { useKhronoton } from "./context.js";
export type {
  KhronotonProviderProps,
  KhronotonConfig,
  UseKhronotonResult,
  ServerResolverOption,
  RenderMultiTx,
  ConfirmGate,
} from "./context.js";
export {
  DEFAULT_EXPLORER_BASE,
  DEFAULT_PAGE_SIZE,
  DEFAULT_POLL_CADENCE_MS,
} from "./context.js";

// ── The adapter seam + its guard, empty seed, and needs-confirm sentinel ──────
export { assertAdapter, emptySnapshot, NeedsConfirmError } from "./adapter.js";
export type {
  KhronotonAdapter,
  KhronotonSnapshot,
  ConfirmOpts,
  ListCronotonsQuery,
  FiresQuery,
  EditPatch,
  SimulateEnvelope,
  ListCronotonsView,
  GetCronotonView,
  FiresView,
  SignersView,
  CommitView,
  EditView,
  ToggleView,
  DeleteView,
  SimulateView,
  ExecuteView,
  StartBatchView,
  GetBatchView,
  CancelBatchView,
  RecoverView,
} from "./adapter.js";

// ── Reference adapters (the two ways to satisfy the seam) ─────────────────────
export { createFetchAdapter, CONFIRMED_HEADER } from "./fetch-adapter.js";
export type { FetchAdapterOptions, FetchLike } from "./fetch-adapter.js";
export { createMemoryAdapter } from "./memory-adapter.js";
export type { MemoryAdapterOptions } from "./memory-adapter.js";

// ── Adapter building blocks — the shared status→seam mapping a custom adapter
//    reuses so its error contract never drifts from the reference adapters. ─────
export { parseHandlerResult, parseFetchResponse } from "./status-map.js";
export type { FetchResponse, StatusResult } from "./status-map.js";

// ── The shared confirm-retry helper (every mutating action hook runs through it)
export { runGated } from "./runGated.js";
export type { GatedFn, RunGatedOptions } from "./runGated.js";

// ── Element types the adapter methods take/return (re-exported for the contract)
export type { CommitBody, CodexSignerDescriptor } from "../handlers/index.js";
export type {
  CodexCronotonRow,
  CodexCronotonFireRow,
  ManualBatchView,
  RuntimeArgs,
} from "../server/index.js";
