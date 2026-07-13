/**
 * The **KhronotonAdapter seam** — the CLIENT side of the Phase-C handler
 * contract. It is exactly one async method per handler operation, returning each
 * handler's response **body** (the `{ ok, ... }` payload) rather than the
 * `{ status, body }` envelope: an adapter implementation unwraps the status
 * itself (2xx → resolve with the body; non-2xx → throw). This keeps the seam
 * framework-neutral — the reference fetch adapter (T4.3) and the in-process
 * MemoryAdapter (T4.4) both satisfy this one interface, and the provider/hooks
 * consume it without knowing whether the backend is HTTP or an in-memory handler
 * context.
 *
 * ── The needs-confirm signal ──────────────────────────────────────────────────
 * Every mutating operation runs behind the handlers' CONFIRM gate, which passes
 * only when the request carried a fresh admin-confirm (`req.confirmed === true`).
 * The gate lives in the provider/hook layer (`runGated`, T4.5); the adapter just
 * CARRIES the signal. Each confirm-gated method therefore takes a trailing
 * optional {@link ConfirmOpts} — the provider calls the method with
 * `{ confirmed: true }` once the confirm-gate resolves. If the backend's gate
 * still refuses (a stale confirm), the adapter throws {@link NeedsConfirmError}
 * so `runGated` re-prompts and retries exactly once. The fetch adapter maps that
 * signal onto its request (a header/body flag the host route reads back into
 * `req.confirmed`); the MemoryAdapter sets `req.confirmed = opts?.confirmed`.
 *
 * ── 200-on-`ok:false` (REQ-H04) ───────────────────────────────────────────────
 * `simulate`/`executeNow`/`trigger` resolve at HTTP 200 EVEN when the body's own
 * `ok` is false (a chain/build failure rides in the body). The adapter returns
 * that body untouched; callers branch on `result.ok`. Only a real transport
 * error (or the confirm gate) is a thrown/rejected path.
 */
import type {
  CodexCronotonRow,
  CodexCronotonFireRow,
  ManualBatchView,
  RuntimeArgs,
} from "../server/index.js";
import type { CommitBody, CodexSignerDescriptor } from "../handlers/index.js";

// Re-export the single needs-confirm sentinel from its one source
// (`src/handlers/context.ts`) — the client layer throws/catches the SAME class
// the handlers' confirm gate raises, never a private copy (REQ-G01).
export { NeedsConfirmError } from "../handlers/context.js";

// ── Request-side shapes ───────────────────────────────────────────────────────

/**
 * The fresh-confirm carrier threaded to every mutating method. `confirmed:true`
 * means "a fresh admin-confirm accompanied this call" — the provider's
 * confirm-gate sets it after the host's confirm resolves.
 */
export interface ConfirmOpts {
  confirmed?: boolean;
}

/** Optional filters for the cronoton list (all default in the read handler). */
export interface ListCronotonsQuery {
  limit?: number;
  offset?: number;
  status?: CodexCronotonRow["status"];
}

/** The fire-history page request: which cronoton + the offset window. */
export interface FiresQuery {
  id: string;
  limit?: number;
  offset?: number;
}

/** An at-next-fire edit patch — the mutable subset of a {@link CommitBody}. */
export type EditPatch = Partial<CommitBody>;

/**
 * A simulate envelope: the tx parts to preview (`pactCode`, `config`, `payload`,
 * `gasPayer`, `signers`, `scheduleKind`, `serverResolver`). Left structurally
 * loose to mirror the handler, which reads the envelope defensively and fills
 * neutral defaults for any missing optional.
 */
export type SimulateEnvelope = Record<string, unknown>;

// ── Response-body views (what each method resolves to) ────────────────────────
// One `*View` per handler body. Named where the handler body is inline-anonymous
// (`json(200, { ... })`); the row/projection element types are imported from
// `/server`, never redeclared.

/** `GET /` body. */
export interface ListCronotonsView {
  ok: true;
  codexCronotons: CodexCronotonRow[];
}

/** `GET /[id]` body. */
export interface GetCronotonView {
  ok: true;
  codexCronoton: CodexCronotonRow;
}

/** `GET /[id]/fires` body — offset-paged, echoing the queried window. */
export interface FiresView {
  ok: true;
  fires: CodexCronotonFireRow[];
  total: number;
  limit: number;
  offset: number;
}

/** `GET /signers` body — secret-free descriptors. */
export interface SignersView {
  ok: true;
  signers: CodexSignerDescriptor[];
}

/** `POST /` body — the new id + its first scheduled fire. */
export interface CommitView {
  ok: true;
  codexCronotonId: string;
  nextFireAt: string | null;
}

/** `PATCH /[id]` body — the recomputed next fire after the at-next-fire edit. */
export interface EditView {
  ok: true;
  nextFireAt: string | null;
}

/** `PATCH /[id]/pause` + `PATCH /[id]/resume` body — the settled lifecycle state. */
export interface ToggleView {
  ok: true;
  status: CodexCronotonRow["status"];
  nextFireAt: string | null;
}

/** `DELETE /[id]` body. A delete-locked system row is a non-2xx (409) → thrown. */
export interface DeleteView {
  ok: true;
}

/**
 * `POST /simulate` body — the full simulate union (REQ-H11). `ok:false` still
 * resolves at 200 (a chain/build failure rides in `error`); callers read `ok`.
 */
export interface SimulateView {
  ok: boolean;
  calibratedGasLimit?: number;
  gasUsed?: number;
  error?: string;
  rawResult?: unknown;
  postponed?: boolean;
  plannedCount?: number;
  chainData?: unknown;
}

/**
 * `POST /[id]/execute` + `POST /[id]/trigger` body. `ok:false` resolves at 200
 * (the fire failed but was recorded); `queued:true` is the 202 multi-tx path
 * (the row was handed to the consumer's async orchestrator, REQ-H06).
 */
export interface ExecuteView {
  ok: boolean;
  fireId?: string;
  requestKey?: string;
  error?: string;
  queued?: boolean;
}

/** `POST /[id]/execute-batch` body — the freshly-started batch. */
export interface StartBatchView {
  ok: true;
  batch: ManualBatchView;
}

/** `GET /[id]/execute-batch` body — the active batch, or null when idle. */
export interface GetBatchView {
  ok: true;
  batch: ManualBatchView | null;
}

/** `DELETE /[id]/execute-batch` body — `cancelled:false` when already inactive. */
export interface CancelBatchView {
  ok: true;
  cancelled: boolean;
}

/** `POST /[id]/fires/[fireId]/recover` body — the reconciled fire + its key. */
export interface RecoverView {
  ok: true;
  fireId: string;
  requestKey: string;
}

// ── The seam ──────────────────────────────────────────────────────────────────

/**
 * The consumer-facing data seam: one method per Phase-C handler operation. Read
 * methods take no confirm; every mutating method takes a trailing
 * {@link ConfirmOpts} the provider threads the fresh-confirm signal through.
 * A method rejects with {@link NeedsConfirmError} when the backend's confirm gate
 * refuses, and with a plain `Error` for any other non-2xx (the fetch adapter
 * defaults the message to `body.error ?? 'HTTP {status}'`).
 */
export interface KhronotonAdapter {
  // Read tier (confirm-free)
  list(query?: ListCronotonsQuery): Promise<ListCronotonsView>;
  get(id: string): Promise<GetCronotonView>;
  fires(query: FiresQuery): Promise<FiresView>;
  signers(): Promise<SignersView>;

  // Lifecycle tier (confirm-gated)
  commit(body: CommitBody, opts?: ConfirmOpts): Promise<CommitView>;
  edit(id: string, patch: EditPatch, opts?: ConfirmOpts): Promise<EditView>;
  pause(id: string, opts?: ConfirmOpts): Promise<ToggleView>;
  resume(id: string, opts?: ConfirmOpts): Promise<ToggleView>;
  delete(id: string, opts?: ConfirmOpts): Promise<DeleteView>;

  // Execution tier (confirm-gated; simulate/executeNow/trigger are 200-on-ok:false)
  simulate(envelope: SimulateEnvelope, opts?: ConfirmOpts): Promise<SimulateView>;
  executeNow(id: string, opts?: ConfirmOpts): Promise<ExecuteView>;
  trigger(id: string, args: RuntimeArgs, opts?: ConfirmOpts): Promise<ExecuteView>;

  // Manual-batch tier (start confirm-gated; get/cancel confirm-free)
  startBatch(id: string, count: number, opts?: ConfirmOpts): Promise<StartBatchView>;
  getBatch(id: string): Promise<GetBatchView>;
  cancelBatch(id: string): Promise<CancelBatchView>;

  // Recover a stale failed fire (confirm-gated; REQ-G09 wired-through-end)
  recover(
    id: string,
    fireId: string,
    requestKey: string,
    opts?: ConfirmOpts,
  ): Promise<RecoverView>;
}

/** The 16 method names an object must carry to be a {@link KhronotonAdapter}. */
const REQUIRED_METHODS: ReadonlyArray<keyof KhronotonAdapter> = [
  "list",
  "get",
  "fires",
  "signers",
  "commit",
  "edit",
  "pause",
  "resume",
  "delete",
  "simulate",
  "executeNow",
  "trigger",
  "startBatch",
  "getBatch",
  "cancelBatch",
  "recover",
];

/**
 * Runtime guard the provider (T4.5) runs on its `adapter` prop before mounting:
 * throws a clear, method-named error if `x` is not an object carrying all 16
 * operations as functions — so a host that forgot a method fails loudly at
 * mount, not silently at the first call.
 */
export function assertAdapter(x: unknown): asserts x is KhronotonAdapter {
  if (!x || typeof x !== "object") {
    throw new TypeError(
      `KhronotonAdapter must be an object, received ${x === null ? "null" : typeof x}`,
    );
  }
  const candidate = x as Record<string, unknown>;
  for (const method of REQUIRED_METHODS) {
    if (typeof candidate[method] !== "function") {
      throw new TypeError(`KhronotonAdapter is missing method "${method}"`);
    }
  }
}

// ── Empty-state seed ──────────────────────────────────────────────────────────

/**
 * The in-memory seed the MemoryAdapter (T4.4) builds a fresh backend from.
 * Khronoton has no local persisted snapshot like Codex — the backing store is a
 * DB — so the seed is just the cronoton definitions to commit into an empty DB
 * (empty = a blank backend; a demo passes definitions to pre-populate one).
 */
export interface KhronotonSnapshot {
  cronotons: CommitBody[];
}

/** A fresh, independent empty seed (safe to mutate — never aliases a prior call). */
export function emptySnapshot(): KhronotonSnapshot {
  return { cronotons: [] };
}
