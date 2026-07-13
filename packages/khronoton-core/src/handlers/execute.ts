/**
 * Execution handlers: `simulateCodexTx`, `executeNow`, `triggerCronoton`,
 * `recoverFire`.
 *
 * These are the mutate-tier route surface that DRIVES the chain: a preview
 * (`simulate`), an on-demand fire (`executeNow`), a runtime-arg fire
 * (`triggerCronoton`), and the recover-a-stale-failure reconciliation
 * (`recoverFire`). All four run behind the CONFIRM gate.
 *
 * ── 200-on-`ok:false` (REQ-H04) ───────────────────────────────────────────────
 * `simulate`/`executeNow`/`triggerCronoton` return HTTP **200** even when the
 * operation's own `ok` is false — a chain/build failure rides in the body
 * (`{ ok:false, error }`) and the caller checks `result.ok`. Only a gate
 * rejection (401) or a request-shape/validation error (400/404) is a non-200.
 *
 * ── 202-queued multi-tx (REQ-H06) ─────────────────────────────────────────────
 * A row bound to a registered **multi-tx** server resolver is NOT fired inline:
 * this package ships no concrete multi-tx orchestrator, so `executeNow` returns
 * **202 `{ ok:true, queued:true }`** and the consumer's resolver runs the async
 * multi-transaction job. Ordinary + single-tx rows fire inline through the shared
 * `fireByServerResolver` + `recordFire` path (mirroring the tick), so a failed
 * fire still records a `failure` row.
 */
import { json, err } from "./http.js";
import type { HandlerContext, Handler } from "./context.js";
import { withConfirm } from "./context.js";
import {
  executeCodexTransaction,
  fireByServerResolver,
  getServerResolver,
  resolveServerVars,
  getCodexCronoton,
  recordFire,
  recoverFire as recoverFireInStore,
  applyTerminalIntent,
  rowToDefinition,
  rowRuntimeArgKeys,
  computeDefinitionFingerprint,
  validateRuntimeArgs,
  applyRuntimeArgs,
  type CodexCronotonRow,
  type CodexTxDefinition,
  type FireResult,
} from "../server/index.js";

/** A landed on-chain request key: 40–48 URL-safe base64 chars. */
const REQUEST_KEY_RE = /^[A-Za-z0-9_-]{40,48}$/;

/** Terminal statuses cannot be fired on demand (their single/spent attempt is done). */
const TERMINAL_STATUSES = new Set<CodexCronotonRow["status"]>(["completed", "error"]);

/**
 * Build the executor definition from a simulate envelope. The envelope carries
 * the same tx parts as a committed row's definition; missing optionals fall back
 * to their neutral defaults so a caller can preview a minimal transaction.
 */
function envelopeToDefinition(envelope: Record<string, unknown>): CodexTxDefinition {
  return {
    pactCode: typeof envelope.pactCode === "string" ? envelope.pactCode : "",
    config: envelope.config as CodexTxDefinition["config"],
    payload: (envelope.payload as Record<string, unknown>) ?? {},
    gasPayer: (envelope.gasPayer as CodexTxDefinition["gasPayer"]) ?? { type: "gas-station" },
    signers: (envelope.signers as CodexTxDefinition["signers"]) ?? [],
    scheduleKind: envelope.scheduleKind as CodexTxDefinition["scheduleKind"],
    serverResolver:
      typeof envelope.serverResolver === "string" ? envelope.serverResolver : undefined,
  };
}

/** The pretty chain payload the detail view renders: `rawResult.data` when present. */
function chainDataFrom(rawResult: unknown): unknown {
  if (rawResult && typeof rawResult === "object" && "data" in rawResult) {
    return (rawResult as { data: unknown }).data;
  }
  return undefined;
}

/**
 * Fire a loaded row inline through the shared dispatcher, record exactly one
 * fire row (success or failure), and apply the one-time terminal transition —
 * the same fire → record → finalize path the tick runs, minus the pre-fire
 * claim (an on-demand fire has no scheduler race to guard against).
 */
async function fireAndRecord(
  ctx: HandlerContext,
  row: CodexCronotonRow,
  definition: CodexTxDefinition,
): Promise<{ result: FireResult; fireId: string }> {
  const result = await fireByServerResolver(definition, row, {
    runtime: ctx.runtime,
    resolver: ctx.resolver,
    config: ctx.config,
    db: ctx.db,
  });
  const fingerprint = computeDefinitionFingerprint(row);
  const fireId = recordFire(
    {
      codexCronotonId: row.id,
      jobId: null,
      firedAt: new Date().toISOString(),
      status: result.ok ? "success" : "failure",
      requestKey: result.requestKey,
      chainId: result.chainId,
      errorMessage: result.error,
      chainResponse: result.rawResult,
      definitionFingerprint: fingerprint,
    },
    { db: ctx.db, resolveFireMode: ctx.resolveFireMode },
  );

  if ((definition.scheduleKind ?? "recurring") === "one-time") {
    applyTerminalIntent(row.id, result.terminalIntent, { db: ctx.db });
  }

  await ctx.onAudit?.({
    action: result.ok ? "codex_cronoton.fire" : "codex_cronoton.fire_failed",
    result: result.ok ? "success" : "failure",
    targetKind: "codex_cronoton",
    targetId: row.id,
    detail: {
      codexCronotonId: row.id,
      fireId,
      requestKey: result.requestKey,
      chainId: result.chainId,
      actor: "ancient",
      definitionFingerprint: fingerprint,
      errorMessage: result.error,
    },
  });

  return { result, fireId };
}

/**
 * Preview a transaction WITHOUT submitting. Returns the full simulate union
 * (REQ-H11) at HTTP 200 even when `ok` is false. When the envelope names a
 * single-tx server resolver, `plannedCount`/`postponed` are derived GENERICALLY
 * from `resolveServerVars` (plan length / empty plan) and the resolved payload
 * is merged so the preview reflects the real fire — never coupled to a name.
 */
export const simulateCodexTx: Handler = (ctx, req) =>
  withConfirm(ctx, req, async () => {
    const body = (req.body ?? {}) as { envelope?: unknown };
    if (!body.envelope || typeof body.envelope !== "object") {
      return err(400, "envelope is required");
    }

    let definition = envelopeToDefinition(body.envelope as Record<string, unknown>);
    let plannedCount: number | undefined;
    let postponed: boolean | undefined;

    if (definition.serverResolver) {
      const resolution = resolveServerVars(definition.serverResolver, { db: ctx.db });
      if (resolution) {
        plannedCount = resolution.plan.length;
        postponed = resolution.plan.length === 0;
        definition = {
          ...definition,
          payload: { ...definition.payload, ...resolution.payload },
        };
      }
    }

    const result = await executeCodexTransaction(definition, "simulate", {
      runtime: ctx.runtime,
      resolver: ctx.resolver,
      config: ctx.config,
    });

    return json(200, {
      ok: result.ok,
      calibratedGasLimit: result.calibratedGasLimit,
      gasUsed: result.gasUsed,
      error: result.error,
      rawResult: result.rawResult,
      postponed,
      plannedCount,
      chainData: chainDataFrom(result.rawResult),
    });
  });

/**
 * Fire a committed cronoton on demand, outside its schedule. A multi-tx
 * server-resolved row is queued (202) rather than fired inline (REQ-H06); every
 * other row fires + records exactly one fire row and returns HTTP 200 with the
 * fire outcome in the body (`ok:false` still 200 — REQ-H04).
 */
export const executeNow: Handler = (ctx, req) =>
  withConfirm(ctx, req, async () => {
    const id = req.params?.id;
    if (!id) return err(400, "cronoton id is required");

    const row = getCodexCronoton(id, { db: ctx.db });
    if (!row) return err(404, "not found");
    if (row.status === "paused") return err(400, "cannot execute a paused cronoton");
    if (TERMINAL_STATUSES.has(row.status)) {
      return err(400, "cannot execute a terminal cronoton");
    }

    const resolverName = row.server_resolver ?? undefined;
    if (resolverName && getServerResolver(resolverName)?.kind === "multi-tx") {
      return json(202, { ok: true, queued: true });
    }

    const { result, fireId } = await fireAndRecord(ctx, row, rowToDefinition(row));
    return json(200, {
      ok: result.ok,
      fireId,
      requestKey: result.requestKey,
      error: result.error,
    });
  });

/**
 * Fire a runtime-arg cronoton with trigger-supplied args. The supplied args must
 * match the row's declared keys exactly (else 400); valid args are merged into
 * the payload before firing, then the shared fire + record path runs (200 on
 * `ok:false`).
 */
export const triggerCronoton: Handler = (ctx, req) =>
  withConfirm(ctx, req, async () => {
    const id = req.params?.id;
    if (!id) return err(400, "cronoton id is required");

    const row = getCodexCronoton(id, { db: ctx.db });
    if (!row) return err(404, "not found");
    if (row.status === "paused") return err(400, "cannot trigger a paused cronoton");
    if (TERMINAL_STATUSES.has(row.status)) {
      return err(400, "cannot trigger a terminal cronoton");
    }

    const args = (req.body as { args?: unknown } | undefined)?.args;
    const validated = validateRuntimeArgs(rowRuntimeArgKeys(row), args);
    if (!validated.ok) return err(400, validated.error);

    const definition = applyRuntimeArgs(rowToDefinition(row), validated.args);
    const { result, fireId } = await fireAndRecord(ctx, row, definition);
    return json(200, {
      ok: result.ok,
      fireId,
      requestKey: result.requestKey,
      error: result.error,
    });
  });

/**
 * Reconcile a stale `failure` fire to its true on-chain `success` by attaching
 * the confirmed request key (e.g. an nginx 504 that hid a landed submit). The
 * key must match the request-key shape (else 400); a fire that is not found or
 * not in `failure` yields 404 `No failed fire to recover`.
 */
export const recoverFire: Handler = (ctx, req) =>
  withConfirm(ctx, req, async () => {
    const fireId = req.params?.fireId;
    if (!fireId) return err(400, "fireId is required");

    const requestKey = (req.body as { requestKey?: unknown } | undefined)?.requestKey;
    if (typeof requestKey !== "string" || !REQUEST_KEY_RE.test(requestKey)) {
      return err(400, "requestKey must be a 40–48 char URL-safe key");
    }

    const recovered = recoverFireInStore(fireId, requestKey, { db: ctx.db });
    if (!recovered) return err(404, "No failed fire to recover");

    await ctx.onAudit?.({
      action: "codex_cronoton.fire_recover",
      result: "success",
      targetKind: "codex_cronoton_fire",
      targetId: fireId,
      detail: { fireId, requestKey, actor: "ancient" },
    });

    return json(200, { ok: true, fireId, requestKey });
  });
