/**
 * Generic server-resolver registry + the kind-routed fire dispatcher.
 *
 * A "server resolver" is a named hook consulted at fire time. Two kinds are
 * distinguished by a `kind` discriminator so the tick can route each to the
 * right execution path:
 *
 *   - 'single-tx' — fills designated payload keys from live server data, merges
 *     them into ONE {@link CodexTxDefinition}, runs a safety-guard simulate,
 *     fires ONE transaction, then settles the server ledger. Dispatched through
 *     {@link fireWithServerResolver} (resolve → simulate-guard → fire → settle).
 *
 *   - 'multi-tx' — an orchestrator that owns its own fire cardinality and guard
 *     (N independent fires). It does NOT ride the single-merge fire path; it is
 *     dispatched to its own `run` orchestrator via {@link dispatchMultiTxResolver}.
 *     The `run` implementation is supplied by the registering module.
 *
 * This module carries NO consumer-domain coupling: the concrete resolvers and
 * their settlement-event sinks belong to the host, which registers them and may
 * observe settlement outcomes through the optional `onEvent` hook on the fire
 * opts. The only runtime dependency is the Phase-3 executor, bound at the
 * dispatch boundary via an injectable `exec` seam (default: a ctx-bound closure).
 */

import { executeCodexTransaction } from "./executor.js";
import type { ExecutorCtx } from "./executor.js";
import type { ChainRuntime, Config, Database, DbDep, KeyResolver } from "./seams.js";
import { SINGLE_TX_GAS_GUARD } from "./seams.js";
import type {
  CodexTxDefinition,
  ExecutorMode,
  FireResult,
  SimulateResult,
} from "./types.js";

/** The plan + payload a single-tx resolver produces for one fire. */
export interface ServerResolverResolution {
  /** Opaque per-entry settlement plan, forwarded verbatim to `settle`. */
  plan: unknown[];
  /** Payload keys merged into the fired definition before simulate/fire. */
  payload: Record<string, unknown>;
}

/** Opts passed to a single-tx resolver's `settle` after a successful fire. */
export interface SettleOpts {
  db?: Database;
  /** The landed on-chain request key, so the ledger write links to the tx. */
  requestKey?: string;
}

/**
 * A single-tx server resolver: how to fill the payload + how to settle on
 * success. The resolve/settle pair is consumed by {@link fireWithServerResolver}.
 */
export interface SingleTxResolver {
  kind: "single-tx";
  resolve(dep?: DbDep): ServerResolverResolution;
  settle(plan: unknown[], opts?: SettleOpts): void;
}

/**
 * A multi-tx server resolver: a net-new orchestrator that owns its own fire
 * cardinality and guard. `run` is the seam the tick dispatches to; its concrete
 * signature/return is defined by the orchestrator that registers it. The
 * registry only knows it is an async orchestrator taking an injected opts bag.
 */
export interface MultiTxResolver {
  kind: "multi-tx";
  run(opts: unknown): Promise<unknown>;
}

/** Either resolver kind; the `kind` field discriminates the union. */
export type ServerResolver = SingleTxResolver | MultiTxResolver;

/** Registry of server resolvers keyed by `serverResolver` name. */
const SERVER_RESOLVERS: Record<string, ServerResolver> = {};

/**
 * Register (or replace) a named server resolver. A module that owns a resolver
 * calls this at module-eval time so the registry is populated by the time the
 * tick consults it.
 */
export function registerServerResolver(name: string, resolver: ServerResolver): void {
  SERVER_RESOLVERS[name] = resolver;
}

/** Read a registered resolver entry (with its `kind`) by name, or `undefined`. */
export function getServerResolver(name: string): ServerResolver | undefined {
  return SERVER_RESOLVERS[name];
}

/**
 * Resolve a named SINGLE-TX resolver's plan + payload WITHOUT firing — used by a
 * simulate/preview endpoint to show what a fire would produce. Returns `null`
 * for an unknown name OR for a multi-tx resolver (which has no single-tx payload
 * to preview).
 */
export function resolveServerVars(
  name: string,
  dep?: DbDep,
): ServerResolverResolution | null {
  const r = SERVER_RESOLVERS[name];
  return r && r.kind === "single-tx" ? r.resolve(dep) : null;
}

/**
 * Dispatch a registered MULTI-TX resolver's orchestrator. The tick routes a
 * multi-tx `serverResolver` here instead of through {@link fireWithServerResolver}.
 * Throws for an unknown name, or for a name registered as single-tx (routing it
 * here would force its merge through the wrong path).
 */
export async function dispatchMultiTxResolver(name: string, opts: unknown): Promise<unknown> {
  const r = SERVER_RESOLVERS[name];
  if (!r) throw new Error(`unknown server resolver: ${name}`);
  if (r.kind !== "multi-tx") {
    throw new Error(`server resolver "${name}" is not a multi-tx resolver (kind=${r.kind})`);
  }
  return r.run(opts);
}

/**
 * The two-arg executor seam. Defaults to a ctx-bound closure over the Phase-3
 * {@link executeCodexTransaction}; a test may inject a `vi.fn()` in its place.
 * The overloads preserve the mode→result discrimination so `exec(def,'fire')`
 * yields a {@link FireResult} and `exec(def,'simulate')` a {@link SimulateResult}.
 */
interface ExecFn {
  (definition: CodexTxDefinition, mode: "simulate"): Promise<SimulateResult>;
  (definition: CodexTxDefinition, mode: "fire"): Promise<FireResult>;
}

/**
 * An optional settlement-observation hook. Replaces the Hub's stoicism-specific
 * `recordStoicismEvent` coupling: a resolver that wants its own settlement
 * telemetry passes `onEvent`; the default is a no-op and no host module is wired.
 */
export type OnResolverEvent = (event: unknown) => void;

/** Injectable seams for the single-tx fire path (default to the registry/executor). */
export interface FireOpts {
  /** Executor seam; default binds `runtime`+`resolver`+`config` into the Phase-3 executor. */
  exec?: ExecFn;
  runtime?: ChainRuntime;
  resolver?: KeyResolver;
  config?: Partial<Config>;
  db?: Database;
  /** Override the single-tx resolve (else the registered resolver's). */
  resolve?: (dep?: DbDep) => ServerResolverResolution;
  /** Override the single-tx settle (else the registered resolver's). */
  settle?: (plan: unknown[], opts?: SettleOpts) => void;
  /** Optional settlement-observation hook (no-op default). */
  onEvent?: OnResolverEvent;
}

/** Opts for the top-level fire dispatcher: {@link FireOpts} plus multi-tx `deps`. */
export interface FireByServerResolverOpts extends FireOpts {
  /** Orchestrator opts forwarded verbatim to a multi-tx resolver's `run`. */
  deps?: unknown;
}

function postponed(error: string): FireResult {
  return { ok: false, mode: "fire", error, terminalIntent: null };
}

/**
 * Adapt a multi-tx orchestrator's run summary to a {@link FireResult} so the tick
 * records one observable fire row for the run. A returned summary always means
 * the run COMPLETED (`ok:true`); the summary is stashed in `rawResult` and the
 * first batch's request key (when present) is surfaced so the fire row links to
 * the on-chain batch.
 */
function adaptMultiTxSummary(summary: unknown): FireResult {
  const s = (summary ?? {}) as { batches?: Array<{ requestKey?: string }> };
  const firstBatchKey =
    Array.isArray(s.batches) && s.batches.length > 0 ? s.batches[0]?.requestKey : undefined;
  return {
    ok: true,
    mode: "fire",
    requestKey: firstBatchKey,
    rawResult: summary,
    terminalIntent: null,
  };
}

/**
 * Build the executor seam: the injected `exec` override if present, else a
 * ctx-bound closure that threads `runtime`+`resolver`+`config` into the Phase-3
 * executor so its Config reads (`listenTimeoutMs`/`autoGasCeiling`) see the
 * injected tuning.
 */
function resolveExec(opts: FireOpts): ExecFn {
  if (opts.exec) return opts.exec;
  const ctx: ExecutorCtx = {
    runtime: opts.runtime as ChainRuntime,
    resolver: opts.resolver as KeyResolver,
    config: opts.config,
  };
  const bound = (definition: CodexTxDefinition, mode: ExecutorMode) =>
    mode === "simulate"
      ? executeCodexTransaction(definition, "simulate", ctx)
      : executeCodexTransaction(definition, "fire", ctx);
  return bound as ExecFn;
}

/**
 * The single fire-time dispatcher the tick calls for EVERY row. Routes by kind:
 *   - no `serverResolver` → executor `fire` (pass-through);
 *   - registered `multi-tx` → {@link dispatchMultiTxResolver} + summary adapt;
 *   - otherwise → {@link fireWithServerResolver} (the single-tx merge path).
 *
 * NEVER throws out: a multi-tx orchestrator throw becomes a `postponed`
 * FireResult so the tick records a single failure fire row rather than aborting.
 */
export async function fireByServerResolver(
  definition: CodexTxDefinition,
  row: unknown,
  opts: FireByServerResolverOpts = {},
): Promise<FireResult> {
  if (!definition.serverResolver) {
    const exec = resolveExec(opts);
    return exec(definition, "fire");
  }

  const registered = SERVER_RESOLVERS[definition.serverResolver];

  if (registered && registered.kind === "multi-tx") {
    try {
      const dispatchOpts = opts.deps ?? (opts.db ? { db: opts.db } : {});
      const summary = await dispatchMultiTxResolver(definition.serverResolver, dispatchOpts);
      return adaptMultiTxSummary(summary);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return postponed(`multi-tx dispatch error: ${message}`);
    }
  }

  // No registered entry, or a single-tx entry → the single-tx fire path (which
  // itself postpones an unknown name and handles the pass-through case).
  return fireWithServerResolver(definition, row, opts);
}

/**
 * Single-tx fire-time wrapper. For an ordinary row (no `serverResolver`) this is
 * a pure pass-through to `exec(def,'fire')`. For a single-tx server-resolved row
 * it resolves the payload → runs a SAFETY-GUARD simulate (postpone on failure or
 * over-budget gas) → fires → settles on success. A settlement failure AFTER a
 * successful fire NEVER marks the fire failed (the tx already landed; settlement
 * is idempotent) — it is surfaced via the optional `onEvent` hook.
 *
 * A multi-tx resolver name is REFUSED here (postponed): it must be dispatched via
 * {@link dispatchMultiTxResolver}, never merged+fired through this single path.
 */
export async function fireWithServerResolver(
  definition: CodexTxDefinition,
  _row: unknown,
  opts: FireOpts = {},
): Promise<FireResult> {
  const exec = resolveExec(opts);

  if (!definition.serverResolver) {
    return exec(definition, "fire");
  }

  const registered = SERVER_RESOLVERS[definition.serverResolver];

  if (registered && registered.kind !== "single-tx") {
    return postponed(
      `server resolver "${definition.serverResolver}" is multi-tx — dispatch via the orchestrator, not the single-tx fire path`,
    );
  }

  const resolve = opts.resolve ?? registered?.resolve;
  const settle = opts.settle ?? registered?.settle;
  if (!resolve || !settle) {
    return postponed(`unknown server resolver: ${definition.serverResolver}`);
  }

  const { plan, payload } = resolve(opts.db ? { db: opts.db } : undefined);

  // An empty plan is NOT a postpone: a resolver may legitimately fire an empty
  // definition (an on-chain "nothing to do" record) and settle to a no-op. Only
  // genuine can't-fire cases below (simulate failure, gas over guard) postpone.
  const fired: CodexTxDefinition = {
    ...definition,
    payload: { ...definition.payload, ...payload },
  };

  // SAFETY GUARD: a single simulate confirms the tx lands at today's volume. If
  // it can't (sim failed, or gas over the single-tx ceiling), postpone rather
  // than burn gas on a tx that cannot succeed.
  const sim = await exec(fired, "simulate");
  if (!sim.ok) {
    opts.onEvent?.({ kind: "postponed", reason: "simulate failed", error: sim.error });
    return postponed(`postponed: simulate failed: ${sim.error ?? "unknown"}`);
  }
  const guard = opts.config?.singleTxGasGuard ?? SINGLE_TX_GAS_GUARD;
  const gasUsed = sim.gasUsed ?? 0;
  if (gasUsed > guard) {
    opts.onEvent?.({ kind: "postponed", reason: "gas over single-tx guard", gasUsed, guard });
    return postponed(
      `postponed: gas ${gasUsed} exceeds single-tx guard ${guard} (multi-tx split deferred)`,
    );
  }

  const result = await exec(fired, "fire");

  if (result.ok) {
    try {
      settle(plan, { db: opts.db, requestKey: result.requestKey });
      opts.onEvent?.({ kind: "settled", count: plan.length, requestKey: result.requestKey });
    } catch (err) {
      // The tx LANDED on-chain — a settlement write failure must NOT mark the
      // fire failed. Surface it for follow-up; settlement is idempotent.
      const message = err instanceof Error ? err.message : String(err);
      opts.onEvent?.({
        kind: "settlement-needs-attention",
        error: message,
        requestKey: result.requestKey,
      });
    }
  }

  return result;
}
