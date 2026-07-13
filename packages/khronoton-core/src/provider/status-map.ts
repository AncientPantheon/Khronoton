/**
 * The shared status → seam-return mapping — the CLIENT half of the Phase-C
 * handler response contract, factored out so BOTH client adapters translate a
 * handler outcome identically (no drift): the fetch adapter (T4.3) parses a real
 * HTTP {@link FetchResponse} through it; the in-process MemoryAdapter (T4.4)
 * feeds it the handler's `{ status, body }` envelope directly.
 *
 * The contract (mirrors the Hub `client.ts` `parse`, parity §4):
 *  - **2xx** → resolve with the body untouched (the seam's `*View` shape). This
 *    includes the 200-on-`ok:false` path (REQ-H04): `simulate`/`executeNow`/
 *    `trigger` succeed at HTTP 200 even when the body's own `ok` is false — a
 *    chain/build failure rides in the body, it is NOT a thrown error.
 *  - **401 `admin_confirm_required`** → throw {@link NeedsConfirmError} so the
 *    provider's confirm-gate (`runGated`, T4.5) re-prompts and retries once.
 *  - **any other non-2xx** → throw `Error(body.error ?? 'HTTP {status}')`.
 */
import { NeedsConfirmError } from "../handlers/context.js";

/**
 * The minimal HTTP-response surface the fetch adapter needs — a status plus a
 * JSON body reader. Defined structurally (not as the DOM `Response`) so the
 * package typechecks without `lib:["DOM"]` and a test can inject a plain stub;
 * the platform `fetch`'s `Response` satisfies it.
 */
export interface FetchResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

/** A decoded handler outcome: the HTTP status paired with the parsed JSON body. */
export interface StatusResult {
  status: number;
  body: unknown;
}

/** Pull a string `error` code off a handler body, or `undefined` when absent. */
function errorCode(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const value = (body as { error?: unknown }).error;
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

/**
 * Translate a `{ status, body }` handler outcome into the seam's return value:
 * resolve the body on 2xx, throw {@link NeedsConfirmError} on a 401
 * `admin_confirm_required`, throw `Error(body.error ?? 'HTTP {status}')`
 * otherwise. Shared by the fetch + memory adapters so their error mapping never
 * drifts.
 */
export function parseHandlerResult<T>({ status, body }: StatusResult): T {
  if (status >= 200 && status < 300) {
    return body as T;
  }
  const code = errorCode(body);
  if (status === 401 && code === "admin_confirm_required") {
    throw new NeedsConfirmError();
  }
  throw new Error(code ?? `HTTP ${status}`);
}

/**
 * Read a {@link FetchResponse}'s JSON body and run it through
 * {@link parseHandlerResult}. A body that fails to parse (an empty/non-JSON
 * error page) is treated as `{}` so the status still maps to the right error.
 */
export async function parseFetchResponse<T>(res: FetchResponse): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return parseHandlerResult<T>({ status: res.status, body });
}
