/**
 * The per-request handler context + the injectable auth/confirm seam + the two
 * gate wrappers.
 *
 * The consumer supplies a {@link HandlerContext} on every call: the injected DB
 * handle, chain runtime, key resolver, and the seams the store/executor already
 * defined in `/server` (all re-exported below so a consumer imports the whole
 * handler contract from one entry — never redeclared here). The {@link AuthSeam}
 * genericizes the Hub's role + fresh-confirm model into two gates: a READ gate
 * (list/get/fires/signers + the batch stop path) and a CONFIRM gate (every
 * mutating handler). {@link withRead} / {@link withConfirm} run the appropriate
 * gate, short-circuit on denial, otherwise invoke the handler body and translate
 * any thrown store error through {@link mapStoreError}.
 */
import {
  json,
  mapStoreError,
  type HandlerRequest,
  type HandlerResponse,
  type SignerSource,
} from "./http.js";
import type {
  ChainRuntime,
  Config,
  Database,
  KeyResolver,
  OnAudit,
  ResolveFireMode,
} from "../server/index.js";

// ── Re-exported `/server` seam types (single-entry handler contract) ──────────
// So a consumer imports `HandlerContext` + the seam types it references from one
// place, without reaching into `/server`. These are the SAME symbols — never a
// private copy (REQ-G01).
export type {
  ChainRuntime,
  Config,
  Database,
  KeyResolver,
  OnAudit,
  ResolveFireMode,
} from "../server/index.js";

// ── Auth / confirm seam (REQ-H09, REQ-G01) ───────────────────────────────────

/** The (optional) identity a passing gate attaches for the handler body to attribute writes to. */
export interface AuthIdentity {
  id?: string;
  email?: string;
}

/**
 * A gate outcome: either a pass carrying an optional identity, or a block
 * carrying the exact {@link HandlerResponse} the wrapper returns verbatim (a 401
 * `admin_confirm_required` for a stale/absent confirm, a 403 for a non-admin).
 */
export type AuthResult =
  | { ok: true; identity?: AuthIdentity }
  | { ok: false; response: HandlerResponse };

/**
 * The injectable auth/confirm contract. A trusted single-tenant consumer uses
 * {@link defaultOpenAuth}; a stricter consumer implements both gates against its
 * own role + confirm-modal flow. Each gate may be sync or async.
 */
export interface AuthSeam {
  /** Read tier: list/get/fires/signers + the batch get/cancel stop path. */
  requireRead(req: HandlerRequest): AuthResult | Promise<AuthResult>;
  /** Mutate tier: demands a fresh admin-confirm; blocks with 401/403 otherwise. */
  requireConfirm(req: HandlerRequest): AuthResult | Promise<AuthResult>;
}

/**
 * A sentinel a strict consumer's confirm gate (or a handler body) may THROW to
 * signal a stale/absent confirm; the gate wrappers translate it to the canonical
 * 401 `admin_confirm_required`. The gate may equally RETURN a blocking
 * {@link AuthResult} — this class is the throw-based alternative.
 */
export class NeedsConfirmError extends Error {
  readonly code = "admin_confirm_required";
  constructor(message = "admin_confirm_required") {
    super(message);
    this.name = "NeedsConfirmError";
  }
}

/**
 * The trusted single-tenant default: the read gate always passes; the confirm
 * gate passes only when `req.confirmed === true`, else it blocks with 401
 * `admin_confirm_required` so the consumer's confirm flow still round-trips.
 */
export const defaultOpenAuth: AuthSeam = {
  requireRead(): AuthResult {
    return { ok: true, identity: {} };
  },
  requireConfirm(req: HandlerRequest): AuthResult {
    if (req.confirmed === true) {
      return { ok: true, identity: {} };
    }
    return { ok: false, response: json(401, { error: "admin_confirm_required" }) };
  },
};

// ── Handler context (REQ-H02, REQ-G01) ───────────────────────────────────────

/**
 * Everything a handler needs, injected per request. Store calls receive `{ db }`;
 * executor calls receive `{ runtime, resolver, config }`; fire-recording receives
 * `{ db, resolveFireMode }`. `auth` is required (use {@link defaultOpenAuth} for
 * a trusted single-tenant); the rest of the automaton seams carry their
 * documented `/server` defaults when omitted.
 */
export interface HandlerContext {
  db: Database;
  runtime: ChainRuntime;
  resolver: KeyResolver;
  resolveFireMode?: ResolveFireMode;
  onAudit?: OnAudit;
  config?: Partial<Config>;
  auth: AuthSeam;
  signers?: SignerSource;
}

/** A framework-agnostic route handler over the injected {@link HandlerContext}. */
export type Handler = (
  ctx: HandlerContext,
  req: HandlerRequest,
) => Promise<HandlerResponse>;

// ── Gate wrappers ────────────────────────────────────────────────────────────

type HandlerBody = (identity: AuthIdentity | undefined) => Promise<HandlerResponse>;

async function runGated(
  gate: AuthResult,
  fn: HandlerBody,
): Promise<HandlerResponse> {
  if (!gate.ok) {
    return gate.response;
  }
  try {
    return await fn(gate.identity);
  } catch (error) {
    if (error instanceof NeedsConfirmError) {
      return json(401, { error: error.code });
    }
    return mapStoreError(error);
  }
}

/**
 * Run `fn` behind the READ gate: short-circuit with the gate's response on
 * denial, otherwise invoke `fn(identity)` and translate any thrown store error
 * through {@link mapStoreError} (an unexpected throw becomes a 500).
 */
export async function withRead(
  ctx: HandlerContext,
  req: HandlerRequest,
  fn: HandlerBody,
): Promise<HandlerResponse> {
  return runGated(await ctx.auth.requireRead(req), fn);
}

/**
 * Run `fn` behind the CONFIRM gate: a stale/absent confirm short-circuits with
 * the gate's 401 `admin_confirm_required` (or a 403 for a non-admin) before `fn`
 * runs; a passing gate invokes `fn(identity)` and translates a thrown store error
 * through {@link mapStoreError}.
 */
export async function withConfirm(
  ctx: HandlerContext,
  req: HandlerRequest,
  fn: HandlerBody,
): Promise<HandlerResponse> {
  return runGated(await ctx.auth.requireConfirm(req), fn);
}
