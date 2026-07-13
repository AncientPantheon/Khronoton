/**
 * The read-tier route surface: `list`, `get`, `signers`, `fires`. Every one runs
 * behind the READ gate ({@link withRead}) — no fresh-confirm is demanded, so a
 * plain viewer can observe the codex-cronoton state (matching the Hub's
 * SSR-public list/detail). These handlers ORCHESTRATE the `/server` store; they
 * do not reimplement any query.
 *
 * The two pieces of branching that live in THIS layer (not the store) are the
 * defensive query parsing — NaN/garbage falls back to a default, and every value
 * is clamped to the store's own bounds so the echoed page window matches what was
 * used — and the fire page-size default of 50 (REQ-G08/REQ-H07), which overrides
 * the store's own default of 20. The signer projection stays SECRET-FREE
 * (REQ-H10): only `publicKey` + a coarse `display`, never key material.
 */
import {
  json,
  err,
  defaultSignerSource,
  type HandlerResponse,
} from "./http.js";
import { withRead, type HandlerContext } from "./context.js";
import type { HandlerRequest } from "./http.js";
import {
  listCodexCronotons,
  getCodexCronoton,
  listFires,
  type CodexCronotonRow,
} from "../server/index.js";

// ── Defensive query parsing ───────────────────────────────────────────────────

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

const CRONOTON_STATUSES: ReadonlySet<CodexCronotonRow["status"]> = new Set([
  "active",
  "paused",
  "completed",
  "error",
]);

/** Narrow a raw query status to the row union, or `undefined` for an unknown value. */
function parseStatus(raw: QueryValue): CodexCronotonRow["status"] | undefined {
  const scalar = firstScalar(raw);
  return scalar !== undefined && CRONOTON_STATUSES.has(scalar as CodexCronotonRow["status"])
    ? (scalar as CodexCronotonRow["status"])
    : undefined;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/** `GET /` — the newest-first cronoton list (store clamps limit 1..200). */
export async function listHandler(
  ctx: HandlerContext,
  request: HandlerRequest,
): Promise<HandlerResponse> {
  return withRead(ctx, request, async () => {
    const query = request.query ?? {};
    const codexCronotons = listCodexCronotons(
      {
        limit: clampInt(query.limit, { def: 50, min: 1, max: 200 }),
        offset: clampInt(query.offset, { def: 0, min: 0 }),
        status: parseStatus(query.status),
      },
      { db: ctx.db },
    );
    return json(200, { ok: true, codexCronotons });
  });
}

/** `GET /[id]` — the single cronoton row, or 404 when absent. */
export async function getHandler(
  ctx: HandlerContext,
  request: HandlerRequest,
): Promise<HandlerResponse> {
  return withRead(ctx, request, async () => {
    const id = request.params?.id ?? "";
    const codexCronoton = getCodexCronoton(id, { db: ctx.db });
    if (!codexCronoton) {
      return err(404, "not found");
    }
    return json(200, { ok: true, codexCronoton });
  });
}

/** `GET /signers` — the SECRET-FREE signer descriptors (never key material). */
export async function signersHandler(
  ctx: HandlerContext,
  request: HandlerRequest,
): Promise<HandlerResponse> {
  return withRead(ctx, request, async () => {
    const source = ctx.signers ?? defaultSignerSource(ctx.resolver);
    const signers = await source.listSignerDescriptors();
    return json(200, { ok: true, signers });
  });
}

/**
 * `GET /[id]/fires?limit&offset` — paginated fire history. The page size defaults
 * to 50 (REQ-G08) — overriding the store's own default of 20 — and both echoed
 * values reflect the window actually queried.
 */
export async function firesHandler(
  ctx: HandlerContext,
  request: HandlerRequest,
): Promise<HandlerResponse> {
  return withRead(ctx, request, async () => {
    const id = request.params?.id ?? "";
    const query = request.query ?? {};
    const limit = clampInt(query.limit, { def: 50, min: 1, max: 100 });
    const offset = clampInt(query.offset, { def: 0, min: 0 });
    const { fires, total } = listFires(id, { limit, offset }, { db: ctx.db });
    return json(200, { ok: true, fires, total, limit, offset });
  });
}
