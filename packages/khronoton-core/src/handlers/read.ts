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
  listServerResolvers,
  listRunsForCronoton,
  listRunLegs,
  getRun,
  type CodexCronotonRow,
  type CodexCronotonRunLegRow,
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
 * `GET /resolvers` — the server-authoritative resolver registry: every registered
 * server resolver with its `kind` and `evented` flag. Takes no params/query; the
 * Builder consumes it to learn which resolver names are event-driven (scheduleless).
 */
export async function resolversHandler(
  ctx: HandlerContext,
  request: HandlerRequest,
): Promise<HandlerResponse> {
  return withRead(ctx, request, async () => json(200, { ok: true, resolvers: listServerResolvers() }));
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

/** `GET /[id]/runs?limit&offset` — paginated chained-run history for
 * one cronoton. Page size defaults to 20 (matching listRunsForCronoton's
 * own default), distinct from fires' 50-default (REQ-G08 is fires-specific). */
export async function runsHandler(
  ctx: HandlerContext,
  request: HandlerRequest,
): Promise<HandlerResponse> {
  return withRead(ctx, request, async () => {
    const id = request.params?.id ?? "";
    const query = request.query ?? {};
    const limit = clampInt(query.limit, { def: 20, min: 1, max: 100 });
    const offset = clampInt(query.offset, { def: 0, min: 0 });
    const { runs, total } = listRunsForCronoton(id, { limit, offset }, { db: ctx.db });
    return json(200, { ok: true, runs, total, limit, offset });
  });
}

/**
 * Strip `signers` from a leg's stored `definition_json` before it's exposed
 * through the READ tier (not CONFIRM) — a leg's `signers` array can carry a
 * literal Pact CAPABILITY line baked with a real account identifier and a
 * live-balance-derived amount (`stoa-wrap.ts`/`stoa-unwrap.ts`'s own
 * `coin.TRANSFER` capability construction), which is exactly the category of
 * data this codebase otherwise consistently withholds from a weaker-than-
 * confirm gate: `handlers/steps.ts`'s own CONFIRM-gated standalone-fire
 * preview already omits `signers` from its response; `store/fires.ts`'s
 * `listFires` column-allowlists its SELECT and never returns a definition/
 * signer field at all; `store/public.ts`'s `toPublicCronotonView` explicitly
 * documents that `signers_json`/`gas_payer_json` "can never leak through
 * it." `pactCode`/`payload`/`config`/`gasPayer` stay visible — this route's
 * purpose is genuine operational visibility into a stuck or failed run
 * (what a leg DOES), not the literal capability grant backing it.
 *
 * Fails closed, not open: a `definition_json` that doesn't even parse as
 * JSON (never produced by this codebase's own `JSON.stringify` writers, but
 * defensive regardless) returns `"{}"` rather than the raw, unredacted
 * string — suppressing on a redaction failure, never leaking on one.
 */
function redactLegRow(leg: CodexCronotonRunLegRow): CodexCronotonRunLegRow {
  let definitionJson = "{}";
  try {
    const parsed = JSON.parse(leg.definition_json) as Record<string, unknown>;
    const { signers, ...rest } = parsed;
    definitionJson = JSON.stringify(rest);
  } catch {
    // Malformed definition_json — fail closed (see doc comment above).
  }
  return { ...leg, definition_json: definitionJson };
}

/** `GET /[id]/runs/[runId]/legs` — every leg of one specific run,
 * scoped so a runId belonging to a DIFFERENT cronoton 404s rather
 * than leaking that cronoton's leg history. Unpaginated — a single
 * run's legs are bounded by the gas-ceiling-pack algorithm, never
 * realistically more than a few dozen. Each leg's `definition_json` is
 * redacted via {@link redactLegRow} before it leaves this handler. */
export async function runLegsHandler(
  ctx: HandlerContext,
  request: HandlerRequest,
): Promise<HandlerResponse> {
  return withRead(ctx, request, async () => {
    const id = request.params?.id ?? "";
    const runId = request.params?.runId ?? "";
    const run = getRun(runId, { db: ctx.db });
    if (!run || run.codex_cronoton_id !== id) {
      return err(404, "not found");
    }
    const legs = listRunLegs(runId, { db: ctx.db }).map(redactLegRow);
    return json(200, { ok: true, legs });
  });
}
