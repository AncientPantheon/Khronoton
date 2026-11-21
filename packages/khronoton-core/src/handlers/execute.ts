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
  getServerResolver,
  resolveServerVars,
  getCodexCronoton,
  recoverFire as recoverFireInStore,
  rowToDefinition,
  rowRuntimeArgKeys,
  validateRuntimeArgs,
  applyRuntimeArgs,
  listStepsForCronoton,
  createRun,
  getRun,
  driveRunOnce,
  defaultOnAudit,
  RunAlreadyInFlightError,
  type CodexCronotonRow,
  type CodexTxDefinition,
  type FireResult,
  type RunsDriverCtx,
} from "../server/index.js";
import { attemptSingleTxFirst } from "../server/single-tx.js";
import { fireAndRecord as sharedFireAndRecord } from "../server/fire-and-record.js";

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
 * fire row, and apply the one-time terminal transition. A thin wrapper over
 * the shared `fireAndRecord` (`server/fire-and-record.ts`) that only pins
 * this handler's own `actor: "ancient"` audit-detail field — a review
 * finding caught this handler and `single-tx.ts` each independently
 * re-deriving the identical fire→record→finalize sequence by hand.
 */
async function fireAndRecord(
  ctx: HandlerContext,
  row: CodexCronotonRow,
  definition: CodexTxDefinition,
): Promise<{ result: FireResult; fireId: string }> {
  return sharedFireAndRecord(ctx, row, definition, { auditDetailExtra: { actor: "ancient" } });
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
 * Fire a committed cronoton on demand, outside its schedule. A CHAINED row
 * (>=1 `codex_cronoton_steps` row) starts a real run instead — mirroring
 * `tick.ts`'s own branch (design.md §A) rather than reinventing it: it never
 * reaches the flat-definition/multi-tx paths below, since a chained row
 * doesn't carry a meaningful `server_resolver`. Unlike the scheduler's tick
 * (which silently skips a self-blocked cronoton to retry next pass), this is
 * an explicit on-demand request — a non-terminal run already in flight for
 * the SAME cronoton surfaces as a real 409, not a silent no-op. A multi-tx
 * server-resolved PLAIN row is queued (202) rather than fired inline
 * (REQ-H06); every other plain row fires + records exactly one fire row and
 * returns HTTP 200 with the fire outcome in the body (`ok:false` still
 * 200 — REQ-H04).
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

    // Ahead of the chained/plain decision below: an opt-in single-tx-first row
    // (docs/work/khronoton-single-tx-custom) gets one more decision first — fire
    // the row's own top-level definition inline when it fits under the gas
    // ceiling, falling through to the existing chained/plain path unchanged
    // when it's specifically gas-refused (or when the flag is off at all).
    // `ctx` (a `HandlerContext`) already satisfies `SingleTxAttemptCtx`
    // structurally with no adaptation needed — a review finding caught this
    // call site hand-rebuilding an equivalent object instead of passing `ctx`
    // straight through, the idiom every other `attemptSingleTxFirst`/
    // `fireByServerResolver` call site in this feature already uses.
    const attempt = await attemptSingleTxFirst(row, ctx, { auditDetailExtra: { actor: "ancient" } });
    if (attempt.fired) {
      return json(200, {
        ok: attempt.result!.ok,
        fireId: attempt.fireId,
        requestKey: attempt.result!.requestKey,
        error: attempt.result!.error,
      });
    }

    const steps = listStepsForCronoton(row.id, { db: ctx.db });
    if (steps.length > 0) {
      try {
        const runId = createRun(
          { codexCronotonId: row.id, stepCount: steps.length },
          { db: ctx.db },
        );
        const driverCtx: RunsDriverCtx = {
          db: ctx.db,
          runtime: ctx.runtime,
          resolver: ctx.resolver,
          config: ctx.config,
          onAudit: ctx.onAudit ?? defaultOnAudit,
        };
        await driveRunOnce(runId, new Date(), driverCtx);
        await ctx.onAudit?.({
          action: "codex_cronoton.run_started",
          result: "success",
          targetKind: "codex_cronoton",
          targetId: row.id,
          detail: { codexCronotonId: row.id, runId, stepCount: steps.length, actor: "ancient" },
        });
        const run = getRun(runId, { db: ctx.db });
        return json(200, { ok: true, runId, status: run?.status ?? null });
      } catch (e) {
        if (e instanceof RunAlreadyInFlightError) {
          return err(409, "a run is already in flight for this cronoton");
        }
        throw e;
      }
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
