/**
 * `createFetchAdapter` — the fetch-based reference {@link KhronotonAdapter}. It
 * is the CLIENT side of the Phase-C handler contract: each of the 16 seam methods
 * issues the matching `fetch` (verb + path + JSON body) against `baseUrl` — the
 * same routes a consumer wraps its `khronoton-core/handlers` with — and parses
 * every response through the shared {@link parseFetchResponse} status map
 * (2xx → body; 401 `admin_confirm_required` → {@link NeedsConfirmError}; other
 * non-2xx → `Error`). React-free: it only touches `fetch`, so a server route, a
 * worker, or a browser can all use it.
 *
 * ── Confirm threading ─────────────────────────────────────────────────────────
 * The confirm gate lives in the provider/hook layer (`runGated`, T4.5); this
 * adapter only CARRIES the fresh-confirm signal. Each mutating method takes a
 * trailing {@link ConfirmOpts}; when `opts.confirmed === true` the request adds a
 * `{@link CONFIRMED_HEADER}: "1"` header the host route reads back into
 * `req.confirmed`. Read methods send no confirm. `cancelBatch` is a deliberately
 * confirm-free one-click stop (parity §5), so it takes no opts.
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
import type { RuntimeArgs } from "../server/index.js";
import type { CommitBody } from "../handlers/index.js";
import { parseFetchResponse, type FetchResponse } from "./status-map.js";

/**
 * The header the fetch adapter sets to `"1"` on a fresh-confirm mutating request;
 * the consumer's route maps it back to `req.confirmed === true`.
 */
export const CONFIRMED_HEADER = "x-khronoton-confirmed";

/** The minimal request init the adapter builds — a structural subset of the DOM `RequestInit`. */
interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** The injectable `fetch` — the platform `fetch` satisfies it; tests pass a stub. */
export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>;

/** Static headers to merge onto every request: an object or a per-call factory. */
type HeaderSource = Record<string, string> | (() => Record<string, string>);

export interface FetchAdapterOptions {
  /** Override the `fetch` implementation (default: the global `fetch`). */
  fetch?: FetchLike;
  /** Headers merged onto every request (e.g. an auth token) — static or per-call. */
  headers?: HeaderSource;
}

/**
 * Resolve the fetch impl: the injected one, else the platform global. Resolved
 * LAZILY per request, never at construction — a host that builds the adapter at
 * import time (before any global `fetch` exists, or in an environment that only
 * gains one later) must not crash. The missing-fetch error surfaces only when a
 * method is actually invoked.
 */
function resolveFetch(injected?: FetchLike): FetchLike {
  if (injected) {
    return injected;
  }
  const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
  if (!globalFetch) {
    throw new Error("createFetchAdapter: no fetch available — pass opts.fetch");
  }
  return globalFetch;
}

/**
 * Build a fetch-backed {@link KhronotonAdapter} against `baseUrl` (the host's
 * cronoton API base, e.g. `/api/admin/codex-cronotons`). Stateless — safe to
 * construct per render or share.
 */
export function createFetchAdapter(
  baseUrl: string,
  opts: FetchAdapterOptions = {},
): KhronotonAdapter {
  const base = baseUrl.replace(/\/+$/, "");

  function staticHeaders(): Record<string, string> {
    return typeof opts.headers === "function" ? opts.headers() : { ...opts.headers };
  }

  async function request<T>(
    method: string,
    path: string,
    init: { body?: unknown; confirmed?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...staticHeaders() };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    if (init.confirmed === true) {
      headers[CONFIRMED_HEADER] = "1";
    }
    const doFetch = resolveFetch(opts.fetch);
    const res = await doFetch(`${base}${path}`, { method, headers, body });
    return parseFetchResponse<T>(res);
  }

  function firesPath({ id, limit, offset }: FiresQuery): string {
    const params = new URLSearchParams();
    if (limit !== undefined) {
      params.set("limit", String(limit));
    }
    if (offset !== undefined) {
      params.set("offset", String(offset));
    }
    const qs = params.toString();
    return `/${id}/fires${qs ? `?${qs}` : ""}`;
  }

  function listPath(query?: ListCronotonsQuery): string {
    const params = new URLSearchParams();
    if (query?.limit !== undefined) {
      params.set("limit", String(query.limit));
    }
    if (query?.offset !== undefined) {
      params.set("offset", String(query.offset));
    }
    if (query?.status !== undefined) {
      params.set("status", query.status);
    }
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  }

  return {
    // Read tier (confirm-free)
    list(query) {
      return request<ListCronotonsView>("GET", listPath(query));
    },
    get(id) {
      return request<GetCronotonView>("GET", `/${id}`);
    },
    fires(query) {
      return request<FiresView>("GET", firesPath(query));
    },
    signers() {
      return request<SignersView>("GET", "/signers");
    },

    // Lifecycle tier (confirm-gated)
    commit(body: CommitBody, confirm?: ConfirmOpts) {
      return request<CommitView>("POST", "", { body, confirmed: confirm?.confirmed });
    },
    edit(id: string, patch: EditPatch, confirm?: ConfirmOpts) {
      return request<EditView>("PATCH", `/${id}`, { body: patch, confirmed: confirm?.confirmed });
    },
    pause(id: string, confirm?: ConfirmOpts) {
      return request<ToggleView>("PATCH", `/${id}/pause`, { confirmed: confirm?.confirmed });
    },
    resume(id: string, confirm?: ConfirmOpts) {
      return request<ToggleView>("PATCH", `/${id}/resume`, { confirmed: confirm?.confirmed });
    },
    delete(id: string, confirm?: ConfirmOpts) {
      return request<DeleteView>("DELETE", `/${id}`, { confirmed: confirm?.confirmed });
    },

    // Execution tier (confirm-gated; simulate/executeNow/trigger are 200-on-ok:false)
    simulate(envelope: SimulateEnvelope, confirm?: ConfirmOpts) {
      return request<SimulateView>("POST", "/simulate", {
        body: { envelope },
        confirmed: confirm?.confirmed,
      });
    },
    executeNow(id: string, confirm?: ConfirmOpts) {
      return request<ExecuteView>("POST", `/${id}/execute`, { confirmed: confirm?.confirmed });
    },
    trigger(id: string, args: RuntimeArgs, confirm?: ConfirmOpts) {
      return request<ExecuteView>("POST", `/${id}/trigger`, {
        body: { args },
        confirmed: confirm?.confirmed,
      });
    },

    // Manual-batch tier (start confirm-gated; get/cancel confirm-free)
    startBatch(id: string, count: number, confirm?: ConfirmOpts) {
      return request<StartBatchView>("POST", `/${id}/execute-batch`, {
        body: { count },
        confirmed: confirm?.confirmed,
      });
    },
    getBatch(id: string) {
      return request<GetBatchView>("GET", `/${id}/execute-batch`);
    },
    cancelBatch(id: string) {
      return request<CancelBatchView>("DELETE", `/${id}/execute-batch`);
    },

    // Recover a stale failed fire (confirm-gated; REQ-G09)
    recover(id: string, fireId: string, requestKey: string, confirm?: ConfirmOpts) {
      return request<RecoverView>("POST", `/${id}/fires/${fireId}/recover`, {
        body: { requestKey },
        confirmed: confirm?.confirmed,
      });
    },
  };
}
