/**
 * The public (unauthenticated-by-design) observability route: `GET
 * /public/[token]`. A DIFFERENT trust tier than the admin `AuthSeam` governs —
 * gating is purely "does this token resolve to an observable row," independent
 * of whatever the host's admin auth would otherwise require — so this handler
 * deliberately never calls `withRead`/`withConfirm`/`ctx.auth` at all. An
 * unknown token and a known token whose row has `public_observable = 0` are
 * made INDISTINGUISHABLE (identical 404), matching
 * `getCodexCronotonByPublicToken`'s own "never 403, never leak which" contract
 * one layer down.
 *
 * `limit`/`offset` get the SAME defensive clamp `read.ts`'s `firesHandler`
 * applies (1..100, default 50 — REQ-G08/REQ-H07's override of the store's own
 * default of 20) — duplicated here as a local, file-private copy rather than
 * imported across handler files, since `read.ts`'s `clampInt`/`firstScalar`
 * are module-private by design.
 *
 * The host is responsible for transport concerns this package's `{status,
 * body}` contract doesn't carry: set `Cache-Control: public, max-age=30` and
 * whatever CORS policy fits the deployment (mirroring the hub's own
 * `pythia-odometer.ts` precedent).
 */
import { json, err, mapStoreError, type HandlerResponse } from "./http.js";
import type { HandlerContext } from "./context.js";
import type { HandlerRequest } from "./http.js";
import {
  getCodexCronotonByPublicToken,
  getCronotonFireCounts,
  listFires,
  toPublicCronotonView,
} from "../server/index.js";

// ── Defensive query parsing (file-private copy of read.ts's clampInt) ─────────

type QueryValue = string | string[] | undefined;

/** First scalar of a query value (a repeated key arrives as an array); `undefined` if empty. */
function firstScalar(raw: QueryValue): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value === null || value === "" ? undefined : value;
}

/**
 * Parse a query int, falling back to `def` for absent/NaN input, then clamp into
 * `[min, max]`. Clamping in the handler (not only in the store) keeps the echoed
 * `limit`/`offset` equal to the window actually queried.
 */
function clampInt(
  raw: QueryValue,
  { def, min, max }: { def: number; min: number; max?: number },
): number {
  const scalar = firstScalar(raw);
  const parsed = scalar === undefined ? Number.NaN : Number.parseInt(scalar, 10);
  const base = Number.isNaN(parsed) ? def : parsed;
  const lowerBounded = Math.max(base, min);
  return max === undefined ? lowerBounded : Math.min(lowerBounded, max);
}

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * `GET /public/[token]` — the sanitized public view for one codex-cronoton, or
 * a 404 for an unknown/non-observable token (the two are indistinguishable by
 * design). Never runs `ctx.auth` — this route's trust tier is the token
 * itself, not the host's admin `AuthSeam`.
 *
 * Wrapped in try/catch -> `mapStoreError`, matching the error-translation
 * idiom every other handler gets for free from `withRead`/`withConfirm`'s
 * shared `runGated` wrapper — this route can't use that wrapper (it would
 * reintroduce the `ctx.auth` call this handler exists to bypass), but it
 * still owes the same "{status, body:{error}}` for any failure" guarantee
 * (e.g. `listFires`'s `JSON.parse(chain_response_json)` throwing on a
 * malformed/legacy row). The explicit 404 `return` below is unaffected by
 * the wrapping `try` — it exits before the `catch` could ever see it.
 */
export async function publicCronotonHandler(
  ctx: HandlerContext,
  request: HandlerRequest,
): Promise<HandlerResponse> {
  try {
    const token = request.params?.token ?? "";
    const row = getCodexCronotonByPublicToken(token, { db: ctx.db });
    if (!row) {
      return err(404, "not found");
    }

    const query = request.query ?? {};
    const limit = clampInt(query.limit, { def: 50, min: 1, max: 100 });
    const offset = clampInt(query.offset, { def: 0, min: 0 });

    const counts = getCronotonFireCounts(row.id, { db: ctx.db });
    const { fires, total } = listFires(row.id, { limit, offset }, { db: ctx.db });

    return json(200, {
      ok: true,
      ...toPublicCronotonView(row, counts, { fires, total, limit, offset }, new Date()),
    });
  } catch (error) {
    return mapStoreError(error);
  }
}
