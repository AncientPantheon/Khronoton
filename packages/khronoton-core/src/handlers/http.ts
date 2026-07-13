/**
 * The framework-agnostic HTTP contract for `@ancientpantheon/khronoton-core/handlers`.
 *
 * A handler never imports an HTTP framework object. The CONSUMER adapts its
 * framework's request/response (Next route handler, Express, Fastify, a test
 * driver, …) into {@link HandlerRequest} / {@link HandlerResponse} at the call
 * boundary: read `params`/`query`/`body` off the incoming request, set the
 * consumer's confirm signal on `confirmed`, then write the returned
 * `{ status, body }` back onto its native response.
 *
 * This module owns the error contract too: {@link mapStoreError} translates the
 * typed store errors from `/server` into the HTTP status the route surface
 * promises, and {@link json} / {@link errorBody} shape a response body. The
 * signer descriptor seam ({@link SignerSource} + {@link CodexSignerDescriptor})
 * lives here as a shared, secret-free contract the read handlers consume.
 */
import {
  CodexCronotonValidationError,
  ManualBatchActiveError,
  TerminalCronotonError,
  type KeyResolver,
} from "../server/index.js";

// ── Normalized request / response (REQ-H02) ──────────────────────────────────

/**
 * A framework-neutral request. The consumer populates it from its own request
 * object: `params` from the route match, `query` from the URL search params,
 * `body` from the parsed JSON payload, and `confirmed` from whatever fresh-admin
 * -confirm signal the consumer's auth flow produced (the auth seam interprets it).
 */
export interface HandlerRequest {
  params?: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  /** The consumer's signal that a fresh admin-confirm accompanied this request. */
  confirmed?: boolean;
}

/** A framework-neutral response the consumer writes back onto its native response. */
export interface HandlerResponse {
  status: number;
  body: unknown;
}

/** Pack a status + body into a {@link HandlerResponse}. */
export function json(status: number, body: unknown): HandlerResponse {
  return { status, body };
}

/**
 * The canonical error body: `{ error }`, defaulting the message to `HTTP {status}`
 * when the caller has none (REQ-H03).
 */
export function errorBody(status: number, message?: string): { error: string } {
  return { error: message ?? `HTTP ${status}` };
}

/** A non-ok response carrying the `{ error }` body — `json` + `errorBody` in one call. */
export function err(status: number, message?: string): HandlerResponse {
  return json(status, errorBody(status, message));
}

// ── Error contract (REQ-H03) ─────────────────────────────────────────────────

/**
 * Translate a thrown store/executor error into the HTTP status the route surface
 * promises, always producing `{ status, body: { error } }`:
 *
 * - `CodexCronotonValidationError` whose message is `not found` → **404**
 * - any other `CodexCronotonValidationError` (incl. `AutoGasGateError`) → **400**
 * - `TerminalCronotonError` → **409**
 * - `ManualBatchActiveError` → **409**
 * - anything else → **500**
 *
 * `ManualBatchActiveError`/`TerminalCronotonError` are checked before
 * `CodexCronotonValidationError` for clarity — they are not subclasses of it, so
 * ordering does not change the result, but `AutoGasGateError` (which IS a
 * subclass) is deliberately caught by the validation arm and kept a 400.
 */
export function mapStoreError(error: unknown): HandlerResponse {
  if (error instanceof ManualBatchActiveError) {
    return json(409, errorBody(409, error.message));
  }
  if (error instanceof TerminalCronotonError) {
    // 409 Conflict (a deliberate improvement over the Hub, which returned 400
    // for pause/resume on a terminal row). A terminal state is a conflict, not a
    // malformed request; the difference is invisible to end users (the UI renders
    // `body.error`). Do NOT "restore" this to 400 in a parity audit.
    return json(409, errorBody(409, error.message));
  }
  if (error instanceof CodexCronotonValidationError) {
    const status = /not found/i.test(error.message) ? 404 : 400;
    return json(status, errorBody(status, error.message));
  }
  const message = error instanceof Error ? error.message : undefined;
  return json(500, errorBody(500, message));
}

// ── Signer descriptor seam (REQ-H10) ─────────────────────────────────────────

/**
 * A secret-free signer projection: only the public key and a coarse provenance
 * label. NEVER carries key material — this is the invariant every
 * {@link SignerSource} implementation must uphold regardless of how much
 * provenance it knows.
 */
export interface CodexSignerDescriptor {
  publicKey: string;
  display: "derived" | "foreign";
}

/** Enumerates the signer descriptors the consumer's key store can sign for. */
export interface SignerSource {
  listSignerDescriptors(): Promise<CodexSignerDescriptor[]>;
}

/** Map a signer's source tag to its display provenance: 'seed' → 'derived', else 'foreign'. */
export function descriptorSourceToDisplay(source: string): "derived" | "foreign" {
  return source === "seed" ? "derived" : "foreign";
}

/**
 * The default signer source: projects the resolver's owned public keys to
 * secret-free descriptors. The `/server` {@link KeyResolver} carries no
 * seed/foreign provenance (only `listCodexPubs()`), so every descriptor is
 * `foreign`; a consumer that knows provenance injects a richer source.
 */
export function defaultSignerSource(resolver: KeyResolver): SignerSource {
  return {
    async listSignerDescriptors(): Promise<CodexSignerDescriptor[]> {
      const pubs = await resolver.listCodexPubs();
      return [...pubs].map((publicKey) => ({ publicKey, display: "foreign" }));
    },
  };
}
