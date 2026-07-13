/**
 * `createMemoryAdapter` — the in-process reference {@link KhronotonAdapter}. It is
 * the SAME client seam the fetch adapter implements, but with NO network: instead
 * of issuing HTTP against a host's routes, each method drives the corresponding
 * Phase-C `/handlers` function DIRECTLY over an internal {@link HandlerContext}
 * (an in-memory `better-sqlite3` DB + `installSchema`, an injectable
 * `ChainRuntime`/`KeyResolver`, and {@link defaultOpenAuth}). It is the
 * "in-process handler driver" for tests, SSR-seed, and demos — not a
 * browser-localStorage store.
 *
 * ── The DB is the seam ────────────────────────────────────────────────────────
 * `better-sqlite3` is an optional/dev dependency (native, Node-only), so the
 * adapter never imports it — the CONSUMER injects a `db` handle. In a browser
 * demo where `better-sqlite3` is unavailable, a consumer supplies its own
 * `Database`-shaped handle; the adapter installs the schema on it by default
 * (idempotent `IF NOT EXISTS` DDL) so a fresh `:memory:` db works out of the box.
 * A pre-migrated/pre-seeded demo db passes `migrate: false`. The caller OWNS the
 * db lifecycle (the adapter never closes an injected handle).
 *
 * ── Confirm threading (parity with the fetch adapter) ─────────────────────────
 * The confirm gate lives in the provider/hook layer (`runGated`, T4.5); this
 * adapter only CARRIES the signal. Each mutating method threads
 * `opts?.confirmed` onto `req.confirmed`, so `defaultOpenAuth.requireConfirm`
 * passes only when a fresh confirm accompanied the call — exactly like the fetch
 * adapter's header. Read methods (and the confirm-free `getBatch`/`cancelBatch`)
 * set no confirm. Every handler's `{ status, body }` envelope runs through the
 * SHARED {@link parseHandlerResult} (2xx → body; 401 `admin_confirm_required` →
 * {@link NeedsConfirmError}; other non-2xx → `Error`), so the memory + fetch
 * adapters map outcomes identically — no drift.
 */
import type {
  CancelBatchView,
  CommitView,
  ConfirmOpts,
  DeleteView,
  EditPatch,
  EditView,
  ExecuteView,
  FiresQuery,
  FiresView,
  GetBatchView,
  GetCronotonView,
  KhronotonAdapter,
  ListCronotonsQuery,
  ListCronotonsView,
  RecoverView,
  SignersView,
  SimulateEnvelope,
  SimulateView,
  StartBatchView,
  ToggleView,
} from "./adapter.js";
import { parseHandlerResult } from "./status-map.js";
import type { CommitBody } from "../handlers/index.js";
import {
  cancelExecuteBatch,
  commitCodexCronoton,
  deleteCodexCronoton,
  editCodexCronoton,
  executeNow,
  fetchFires,
  fetchSigners,
  getCodexCronoton,
  getExecuteBatch,
  listCodexCronotons,
  pauseCodexCronoton,
  recoverFire,
  resumeCodexCronoton,
  simulateCodexTx,
  startExecuteBatch,
  triggerCronoton,
  defaultOpenAuth,
  type AuthSeam,
  type ChainRuntime,
  type Config,
  type Handler,
  type HandlerContext,
  type HandlerRequest,
  type KeyResolver,
  type OnAudit,
  type ResolveFireMode,
  type SignerSource,
} from "../handlers/index.js";
import { installSchema, type Database, type RuntimeArgs } from "../server/index.js";

/** The seams a consumer injects when building an in-process adapter. */
export interface MemoryAdapterOptions {
  /**
   * The in-process store handle — a `better-sqlite3` `Database` in Node, or any
   * `Database`-shaped handle a consumer supplies (the adapter never imports
   * `better-sqlite3` itself, keeping the module browser-safe).
   */
  db: Database;
  /** Run `installSchema` on `db` before first use (default `true`; `false` for a pre-migrated db). */
  migrate?: boolean;
  /**
   * The chain runtime the execution handlers drive. Default: a throwing stub —
   * read/lifecycle/batch ops never touch it, but `simulate`/`executeNow`/
   * `trigger` require a real (or mock) runtime, so inject one to exercise them.
   */
  runtime?: ChainRuntime;
  /** The key resolver the signer projection reads. Default: an empty (no-signer) resolver. */
  resolver?: KeyResolver;
  resolveFireMode?: ResolveFireMode;
  onAudit?: OnAudit;
  config?: Partial<Config>;
  /** The auth/confirm seam. Default {@link defaultOpenAuth} (trusted single-tenant). */
  auth?: AuthSeam;
  /** A richer signer source (else the default reads the resolver's owned pubs). */
  signers?: SignerSource;
}

/** An empty resolver: owns no signer pubs; returns a neutral keypair on demand. */
function emptyResolver(): KeyResolver {
  return {
    getKeyPairByPublicKey: async (publicKey: string) => ({
      publicKey,
      privateKey: "",
      seedType: "seed",
    }),
    listCodexPubs: async () => new Set<string>(),
  };
}

/**
 * A runtime stub whose chain methods throw a clear, actionable error. The read,
 * lifecycle, and manual-batch tiers never invoke the runtime, so the default is
 * enough for the whole non-execution surface; only `simulate`/`executeNow`/
 * `trigger` reach it, and they demand a real injected runtime.
 */
function throwingRuntime(): ChainRuntime {
  const notWired = (): never => {
    throw new Error(
      "MemoryAdapter: no ChainRuntime injected — pass opts.runtime to run " +
        "simulate/executeNow/trigger. Read, lifecycle, and batch ops need none.",
    );
  };
  return {
    Pact: { builder: { execution: notWired } },
    createClient: notWired,
    isSignedTransaction: notWired,
    universalSignTransaction: notWired,
    calculateAutoGasLimit: notWired,
    anuToStoa: notWired,
    getPactUrl: notWired,
    networkId: "memory",
    namespace: "memory-ns",
    gasStationAccount: "c:MEMORY",
  } as unknown as ChainRuntime;
}

/** Serialize a scalar query value; skip `undefined` so absent keys hit handler defaults. */
function scalarQuery(entries: Record<string, string | number | undefined>): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) {
      query[key] = String(value);
    }
  }
  return query;
}

/**
 * Build an in-process {@link KhronotonAdapter}. Constructing it touches neither
 * `window` nor the network, so it is safe to build during a server render, a
 * test, or an SSR seed. The returned adapter shares one {@link HandlerContext}:
 * every method assembles the matching {@link HandlerRequest} and calls the real
 * handler, then maps `{ status, body }` through {@link parseHandlerResult}.
 */
export function createMemoryAdapter(opts: MemoryAdapterOptions): KhronotonAdapter {
  const { db } = opts;
  if (opts.migrate !== false) {
    installSchema(db);
  }

  const ctx: HandlerContext = {
    db,
    runtime: opts.runtime ?? throwingRuntime(),
    resolver: opts.resolver ?? emptyResolver(),
    resolveFireMode: opts.resolveFireMode ?? (() => "live"),
    onAudit: opts.onAudit,
    config: opts.config,
    auth: opts.auth ?? defaultOpenAuth,
    signers: opts.signers,
  };

  async function call<T>(handler: Handler, req: HandlerRequest): Promise<T> {
    const { status, body } = await handler(ctx, req);
    return parseHandlerResult<T>({ status, body });
  }

  return {
    // Read tier (confirm-free)
    list(query?: ListCronotonsQuery) {
      return call<ListCronotonsView>(listCodexCronotons, {
        query: scalarQuery({ limit: query?.limit, offset: query?.offset, status: query?.status }),
      });
    },
    get(id: string) {
      return call<GetCronotonView>(getCodexCronoton, { params: { id } });
    },
    fires({ id, limit, offset }: FiresQuery) {
      return call<FiresView>(fetchFires, { params: { id }, query: scalarQuery({ limit, offset }) });
    },
    signers() {
      return call<SignersView>(fetchSigners, {});
    },

    // Lifecycle tier (confirm-gated)
    commit(body: CommitBody, confirm?: ConfirmOpts) {
      return call<CommitView>(commitCodexCronoton, { body, confirmed: confirm?.confirmed });
    },
    edit(id: string, patch: EditPatch, confirm?: ConfirmOpts) {
      return call<EditView>(editCodexCronoton, {
        params: { id },
        body: patch,
        confirmed: confirm?.confirmed,
      });
    },
    pause(id: string, confirm?: ConfirmOpts) {
      return call<ToggleView>(pauseCodexCronoton, { params: { id }, confirmed: confirm?.confirmed });
    },
    resume(id: string, confirm?: ConfirmOpts) {
      return call<ToggleView>(resumeCodexCronoton, { params: { id }, confirmed: confirm?.confirmed });
    },
    delete(id: string, confirm?: ConfirmOpts) {
      return call<DeleteView>(deleteCodexCronoton, { params: { id }, confirmed: confirm?.confirmed });
    },

    // Execution tier (confirm-gated; simulate/executeNow/trigger are 200-on-ok:false)
    simulate(envelope: SimulateEnvelope, confirm?: ConfirmOpts) {
      return call<SimulateView>(simulateCodexTx, {
        body: { envelope },
        confirmed: confirm?.confirmed,
      });
    },
    executeNow(id: string, confirm?: ConfirmOpts) {
      return call<ExecuteView>(executeNow, { params: { id }, confirmed: confirm?.confirmed });
    },
    trigger(id: string, args: RuntimeArgs, confirm?: ConfirmOpts) {
      return call<ExecuteView>(triggerCronoton, {
        params: { id },
        body: { args },
        confirmed: confirm?.confirmed,
      });
    },

    // Manual-batch tier (start confirm-gated; get/cancel confirm-free)
    startBatch(id: string, count: number, confirm?: ConfirmOpts) {
      return call<StartBatchView>(startExecuteBatch, {
        params: { id },
        body: { count },
        confirmed: confirm?.confirmed,
      });
    },
    getBatch(id: string) {
      return call<GetBatchView>(getExecuteBatch, { params: { id } });
    },
    cancelBatch(id: string) {
      return call<CancelBatchView>(cancelExecuteBatch, { params: { id } });
    },

    // Recover a stale failed fire (confirm-gated; REQ-G09)
    recover(id: string, fireId: string, requestKey: string, confirm?: ConfirmOpts) {
      return call<RecoverView>(recoverFire, {
        params: { id, fireId },
        body: { requestKey },
        confirmed: confirm?.confirmed,
      });
    },
  };
}
