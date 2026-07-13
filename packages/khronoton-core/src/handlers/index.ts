/**
 * Public entry for `@ancientpantheon/khronoton-core/handlers` — the
 * framework-agnostic route surface over the `/server` store + executor. A
 * consumer adapts its framework's request/response into {@link HandlerRequest} /
 * {@link HandlerResponse}, injects a {@link HandlerContext} (db + runtime +
 * resolver + an {@link AuthSeam}), and calls the sixteen handlers below.
 *
 * The read handlers keep their contract names here (aliasing their module's
 * `*Handler` implementations), so the barrel exposes the exact route contract
 * from [PARITY §4]. This entry is React-free and built by `tsc` (not tsup) so it
 * stays importable in any server runtime; it imports no `@stoachain/*` (REQ-P01).
 *
 * Every re-export is `export type` where the symbol is a type, so the emitted
 * `.d.ts` stays fully erasable. Explicit `.js` extensions throughout.
 */

// ── Read handlers (TC.2) — aliased to their contract names ────────────────────
export {
  listHandler as listCodexCronotons,
  getHandler as getCodexCronoton,
  signersHandler as fetchSigners,
  firesHandler as fetchFires,
} from "./read.js";

// ── Cronoton-lifecycle handlers (TC.3) ────────────────────────────────────────
export {
  commitCodexCronoton,
  editCodexCronoton,
  pauseCodexCronoton,
  resumeCodexCronoton,
  deleteCodexCronoton,
} from "./cronoton.js";
export type { CommitBody, CommitEnvelope, CommitSchedule } from "./cronoton.js";

// ── Execution handlers (TC.4) ─────────────────────────────────────────────────
export { simulateCodexTx, executeNow, triggerCronoton, recoverFire } from "./execute.js";

// ── Manual-batch handlers (TC.5) ──────────────────────────────────────────────
export { startExecuteBatch, getExecuteBatch, cancelExecuteBatch } from "./batch.js";

// ── Kernel contract (TC.1): normalized request/response + helpers ─────────────
// The request/response shapes plus the response helpers a consumer needs to
// build its own auth seam, signer source, or error mapping.
export { json, err, errorBody, mapStoreError } from "./http.js";
export type { HandlerRequest, HandlerResponse } from "./http.js";

// ── Kernel contract (TC.1): signer descriptor seam (secret-free) ──────────────
export { defaultSignerSource, descriptorSourceToDisplay } from "./http.js";
export type { SignerSource, CodexSignerDescriptor } from "./http.js";

// ── Kernel contract (TC.1): handler context + auth/confirm seam ───────────────
// The gate wrappers stay module-internal to the handlers; a consumer WIRES the
// surface with the context type, the injectable auth seam, and the default open
// (trusted single-tenant) impl.
export { defaultOpenAuth, NeedsConfirmError } from "./context.js";
export type {
  Handler,
  HandlerContext,
  AuthSeam,
  AuthIdentity,
  AuthResult,
} from "./context.js";

// ── Re-exported `/server` seam types the handler contract references ───────────
// So a consumer builds a `HandlerContext` (and its `onAudit`/`config`) from the
// one handler entry, without reaching into `/server`. These are the SAME symbols
// `/server` exports — never a private copy (REQ-G01).
export type {
  ChainRuntime,
  Config,
  Database,
  KeyResolver,
  OnAudit,
  ResolveFireMode,
} from "./context.js";
