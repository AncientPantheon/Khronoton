/**
 * The headless single-transaction codex executor.
 *
 * Lifted from the AncientHoldings hub (`lib/codex-cronoton/executor.ts`,
 * single-tx path) behind the Phase-1 seams: every `@stoachain/*` runtime value
 * arrives through the injected {@link ChainRuntime} and every keypair through
 * the injected {@link KeyResolver}. This module pulls NO `@stoachain/*` symbol,
 * does NO dynamic `import()`, and never constructs a concrete key resolver — the
 * two-line hub bootstrap (`loadRuntime()` + `new CodexKeyResolver()`) is
 * replaced by a caller-supplied {@link ExecutorCtx}.
 *
 * Four load-bearing invariants are preserved verbatim:
 *   - fire NEVER throws (F-002) — every failure returns a structured result;
 *   - the dirty-read pre-flight gate (F-001) — a failing pre-flight never submits;
 *   - AUTO-gas calibrate — build at the ceiling, rebuild + re-sign at the
 *     preflight-derived limit;
 *   - the 504/derived-request-key recovery (REQ-23) — the request key is derived
 *     from the signed command hash UP FRONT so a lost submit response or a listen
 *     timeout never discards a tx that may already be on-chain.
 *
 * Auto self-calibrating gas (khronoton-auto-gas) adds three more:
 *   - AUTO-gas calibration sources its measurement from `ChainClient.preflightRead`
 *     (the TRUE gas, including the transaction-size charge) instead of the plain
 *     `dirtyRead` (execution gas only) — the executor HARD THROWS when
 *     `autoGasLimit` is true and `preflightRead` is absent from the injected
 *     runtime, mirroring the `gasMeta` hard-throw precedent above. A MANUAL-gas
 *     fire never needs this and stays on `dirtyRead`, unaffected by its absence;
 *   - the simulate/fire ceiling is resolved live via `resolveCeiling`: an
 *     explicit `config.autoGasCeiling` override wins outright, else a
 *     best-effort `client.getBlockGasLimit()` read, else the static
 *     `AUTO_GAS_CEILING` fallback;
 *   - refuse-unmineable — a transaction whose measured gas exceeds the resolved
 *     ceiling is refused with a structured `{ ok: false, error }` (never a
 *     throw, matching F-002) BEFORE any calibration/rebuild or submit, for both
 *     AUTO and MANUAL fires.
 */

import type {
  ChainRuntime,
  ChainClient,
  KeyResolver,
  Config,
  UniversalKeypair,
  IUnsignedCommand,
  ListenResult,
  DirtyReadResult,
} from "./seams.js";
import { LISTEN_TIMEOUT_MS, AUTO_GAS_CEILING } from "./seams.js";
import { parseCapabilityLine, computeTerminalIntent } from "./pure/capability.js";
import { declareGasLimit } from "./pure/gas-declaration.js";
import { effectiveSigners, deriveSenderAccount } from "./executor-signers.js";
import type {
  CodexTxDefinition,
  ExecutorMode,
  ExecutorResult,
  FireResult,
  SimulateResult,
  SubmitResult,
} from "./types.js";

/** Listen (confirmation) timeout default: 5 minutes. Overridable via `ctx.config.listenTimeoutMs`. */
export { LISTEN_TIMEOUT_MS } from "./seams.js";

/**
 * The injected dependencies the executor runs against. `config` is OPTIONAL —
 * when omitted the module-constant defaults apply. This is a superset-compatible
 * shape: Phase 4's fuller tick ctx (`{ db, resolver, runtime, onAudit,
 * resolveFireMode, config }`) structurally satisfies it, so a tick passes its
 * ctx straight through.
 */
export interface ExecutorCtx {
  runtime: ChainRuntime;
  resolver: KeyResolver;
  config?: Partial<Config>;
}

/** A ceiling value is only trusted if it's a genuine positive number — `NaN`
 * passes `typeof === "number"` but every `gasUsed > ceiling` comparison
 * against it is `false`, which would silently defeat the refuse-unmineable
 * check below rather than falling back as documented. Applied uniformly to
 * BOTH the config override and the live-fetched value: `ChainClient` is an
 * injectable, chain-polyglot seam (per `seams.ts`'s own "BEST-EFFORT" doc on
 * `getBlockGasLimit`), so the executor must not trust an adapter — any
 * adapter, not just the one shipped in `blockchain/stoachain.ts` — to hand
 * back a sane number unchecked. */
function isSaneCeiling(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Live block-gas-limit cache, keyed by chain id — closes a cross-phase-
 * review-found performance gap: `resolveCeiling` used to re-fetch on EVERY
 * simulate/fire/submit call with no caching at all, including every leg of
 * a fanned-out step (`ouronet.aqp-evict`/`ouronet.aqp-unstall` can produce
 * dozens) and every probe of `split-plan.ts`'s own multi-probe sizing pass
 * (up to ~7 per planning pass) — all serially (`driveRunOnce`'s own
 * `for...of`+`await` submit loop is deliberate, never `Promise.all`), within
 * ONE tick pass that `loop.ts`'s single `running` boolean gates for EVERY
 * other in-flight run and due cronoton that tick. The block gas limit
 * changes rarely, so a SHORT TTL (not a permanent cache, which could serve
 * a stale value indefinitely in a long-running process) eliminates the
 * redundant network chatter within one pass without that risk.
 */
const CEILING_CACHE_TTL_MS = 30_000;
const ceilingCache = new Map<string, { value: number; expiresAt: number }>();

/**
 * TEST-ONLY: clears the live ceiling cache. A test suite that exercises
 * multiple scenarios against the SAME chain id with DIFFERENT mocked
 * `getBlockGasLimit` return values (e.g. `executor.test.ts`'s own
 * "live block gas limit" cases) would otherwise leak a cached value from
 * an earlier test into a later one, since the cache above is genuine
 * module-level state that persists across test cases within one file run.
 * Not part of the public `/server` surface (not re-exported from
 * `server/index.ts`) — import it directly from `./executor.js` in a test's
 * own `beforeEach`.
 */
export function __clearCeilingCacheForTests(): void {
  ceilingCache.clear();
}

/** Resolves the effective simulate/fire ceiling: an explicit config override
 * wins outright (no network call, no cache lookup); else a cached recent
 * value for this chain when still fresh; else a best-effort live fetch off
 * the ALREADY-CONSTRUCTED client for this fire's own chain, cached for
 * {@link CEILING_CACHE_TTL_MS}; else the static fallback. Never throws —
 * `getBlockGasLimit` failures are absorbed by the adapter itself (see
 * `blockchain/stoachain.ts`), and an out-of-range value from EITHER source
 * falls back to `AUTO_GAS_CEILING` rather than being trusted verbatim (and
 * is never cached as a sane value in that case — `AUTO_GAS_CEILING` itself
 * IS cached, so a chain whose adapter keeps failing doesn't re-attempt the
 * live fetch on every single call either). */
export async function resolveCeiling(ctx: ExecutorCtx, client: ChainClient, chainId: string): Promise<number> {
  if (isSaneCeiling(ctx.config?.autoGasCeiling)) return ctx.config.autoGasCeiling;

  const now = Date.now();
  const cached = ceilingCache.get(chainId);
  if (cached && cached.expiresAt > now) return cached.value;

  const live = await client.getBlockGasLimit?.();
  const resolved = isSaneCeiling(live) ? live : AUTO_GAS_CEILING;
  ceilingCache.set(chainId, { value: resolved, expiresAt: now + CEILING_CACHE_TTL_MS });
  return resolved;
}

/** The mutable Pact builder surface `buildTransaction` drives. */
interface PactBuilder {
  setMeta(meta: unknown): PactBuilder;
  setNetworkId(net: string): PactBuilder;
  addData(key: string, value: unknown): PactBuilder;
  addSigner(
    pub: string,
    capFn?: (
      withCapability: (name: string, ...args: unknown[]) => unknown,
    ) => unknown[],
  ): PactBuilder;
  createTransaction(): IUnsignedCommand;
}

/**
 * Build a Pact transaction from the definition:
 * `Pact.builder.execution().setMeta().setNetworkId()` + an `addData` loop over
 * the payload + pure-vs-scoped `addSigner`. Throws if no signers, and throws if
 * the injected runtime cannot supply gas meta (see {@link ChainRuntime.gasMeta}).
 *
 * Every fire prices at the chain's live network floor plus
 * `config.gasPriceBufferAnu` (default 0, ANU above the floor). `floorAnu` is
 * always passed as `0` — there is no more stored absolute value to raise to a
 * floor; the deprecated `config.gasPrice` is never read here at all. This is
 * what lets a cronoton stored years ago at the genesis default still fire
 * today with no database migration.
 */
function buildTransaction(
  runtime: ChainRuntime,
  definition: CodexTxDefinition,
  signers: CodexTxDefinition["signers"],
  gasLimitOverride?: number,
): IUnsignedCommand {
  if (signers.length === 0) {
    throw new Error(
      "At least one signer is required to build a codex transaction.",
    );
  }

  const senderAccount = deriveSenderAccount(
    definition.gasPayer,
    runtime.gasStationAccount,
  );

  const builder = runtime.Pact.builder.execution(
    definition.pactCode,
  ) as PactBuilder;

  // Gas meta is derived HERE, once per build, and never hoisted out or cached
  // by a caller: the AUTO-gas path calls this function a SECOND time to rebuild
  // and re-sign at the calibrated limit, and that rebuild must re-derive both
  // fields fresh. Reusing the pre-flight build's values would let creationTime
  // and gasPrice drift apart across a tick boundary — underpricing the very
  // transaction that gets submitted.
  if (!runtime.gasMeta) {
    throw new Error(
      "ChainRuntime.gasMeta is required to price a transaction: without it the " +
        "per-cronoton stored gasPrice would be used verbatim, which drifts below " +
        "the chain's rising minimum as a cronoton ages and gets the fire rejected. " +
        "Upgrade the injected runtime adapter (see blockchain/stoachain.ts).",
    );
  }
  const { creationTime, gasPrice } = runtime.gasMeta(
    0,
    definition.config.gasPriceBufferAnu ?? 0,
  );

  builder
    .setMeta({
      senderAccount,
      chainId: definition.config.chainId,
      gasLimit: gasLimitOverride ?? definition.config.gasLimit,
      gasPrice,
      // Stamped EXPLICITLY, from the same call that produced gasPrice. Left
      // unset, the Pact builder auto-stamps its own creationTime at
      // createTransaction() — a second, independent clock read that the price
      // above would then no longer correspond to.
      creationTime,
      ttl: definition.config.ttl,
    })
    .setNetworkId(runtime.networkId);

  for (const [key, value] of Object.entries(definition.payload)) {
    builder.addData(key, value);
  }

  for (const signer of signers) {
    if (signer.capabilityMode === "pure") {
      builder.addSigner(signer.publicKey);
    } else {
      builder.addSigner(signer.publicKey, (withCapability) => {
        const caps: unknown[] = [];
        for (const line of (signer.capabilities || "").split("\n")) {
          const parsed = parseCapabilityLine(line);
          if (parsed) caps.push(withCapability(parsed.name, ...parsed.args));
        }
        return caps;
      });
    }
  }

  return builder.createTransaction();
}

/**
 * Resolve + build the `UniversalKeypair[]` for all signers via the injected
 * resolver, then sign. `IKadenaKeypair.privateKey` maps to
 * `UniversalKeypair.secretKey`; the derived-seed WASM-path fields
 * (`encryptedSecretKey`, `password`) are carried through (F-004). Asserts the
 * result is a fully signed transaction or throws.
 */
async function signTransaction(
  runtime: ChainRuntime,
  resolver: KeyResolver,
  signers: CodexTxDefinition["signers"],
  tx: IUnsignedCommand,
): Promise<unknown> {
  const keypairs: UniversalKeypair[] = [];
  for (const signer of signers) {
    const kp = await resolver.getKeyPairByPublicKey(signer.publicKey);
    keypairs.push({
      publicKey: kp.publicKey,
      secretKey: kp.privateKey,
      seedType: kp.seedType,
      encryptedSecretKey: kp.encryptedSecretKey,
      password: kp.password,
    });
  }

  const signed = await runtime.universalSignTransaction(tx, keypairs);
  if (!runtime.isSignedTransaction(signed)) {
    throw new Error(
      "Signing incomplete: one or more signatures are missing after universalSignTransaction.",
    );
  }
  return signed;
}

/** Extract a human-readable error from a dirty-read/failure result. */
function dirtyReadError(result: { error?: { message?: string } }): string {
  return result.error?.message || "Transaction simulation failed on-chain.";
}

/**
 * The AUTO-gas calibration call, shared by `runSimulate`'s preview and
 * `submitTransaction`'s real declaration — a review finding caught these
 * two independently constructing the identical `declareGasLimit` call,
 * which is exactly the kind of drift that let the preview and the real
 * declaration disagree in the first place (the bug this helper's own
 * extraction was prompted by fixing). `tx.cmd`'s byte length is measured
 * against the SAME unsigned `tx` both callers preflight — see each call
 * site's own doc comment for why that must be unsigned, not `signed`.
 */
function calibrateAutoGas(
  runtime: ChainRuntime,
  tx: IUnsignedCommand,
  gasUsed: number,
  signers: CodexTxDefinition["signers"],
  ceiling: number,
): number {
  return declareGasLimit(
    {
      simulatedGas: gasUsed,
      simIncludesSize: true,
      cmdBytes: Buffer.byteLength(tx.cmd, "utf8"),
      ed25519Signers: signers.length,
      ceiling,
    },
    (g) => runtime.calculateAutoGasLimit(g),
  ).gasLimit;
}

/**
 * Describe a caught throw for a structured `{ ok: false, error }` result —
 * shared by the `submit` and `fire` catch branches of
 * {@link executeCodexTransaction} so a future change to how a thrown error is
 * rendered (e.g. handling `AggregateError`) is made once, not twice.
 * `fallbackLabel` names the mode for the truly-no-message case only.
 */
function describeThrown(e: unknown, fallbackLabel: string): string {
  return (
    (e instanceof Error ? e.message : String(e)) ||
    (e instanceof Error ? `${e.name} (no message)` : `unknown ${fallbackLabel} error`)
  );
}

/** Listen with a timeout (`Promise.race`, `clearTimeout` cleanup). */
async function listenWithTimeout(
  listen: (descriptor: unknown) => Promise<ListenResult>,
  descriptor: unknown,
  timeoutMs: number,
): Promise<ListenResult> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      listen(descriptor).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(
              new Error(
                "Transaction confirmation timed out. Check explorer with the request key.",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function runSimulate(
  ctx: ExecutorCtx,
  definition: CodexTxDefinition,
  signers: CodexTxDefinition["signers"],
): Promise<SimulateResult> {
  const { runtime, resolver } = ctx;
  const { autoGasLimit } = definition.config;
  const client = runtime.createClient(runtime.getPactUrl(definition.config.chainId));
  const ceiling = await resolveCeiling(ctx, client, definition.config.chainId);

  const tx = buildTransaction(
    runtime,
    definition,
    signers,
    autoGasLimit ? ceiling : undefined,
  );

  if (autoGasLimit && !client.preflightRead) {
    throw new Error(
      "ChainRuntime.preflightRead is required to auto-size gas for an AUTO-gas " +
        "transaction: without it the calibration would use dirtyRead's execution-" +
        "only gas figure, which omits the transaction-size charge and reproduces " +
        "the exact over-reservation bug this capability exists to fix. Upgrade the " +
        "injected runtime adapter (see blockchain/stoachain.ts), or switch this " +
        "cronoton to manual gas.",
    );
  }
  // Preflight the UNSIGNED `tx`, never `signed`, for the AUTO-gas branch —
  // a review finding caught this previously preflighting the already-signed
  // artifact, which makes `declareGasLimit`'s `simIncludesSize`+signature-byte
  // correction genuinely ambiguous (is the real signature-byte cost already
  // counted by a preflight of a fully-signed command, or not? — not
  // something to guess at). Matches `submitTransaction`'s own identical fix
  // for the same reason. A second review finding caught the sign call
  // ALSO still running unconditionally even though the AUTO-gas branch
  // never reads `signed` at all — wasted resolver/sign work on every
  // AUTO-gas simulate, and (since it ran before the `preflightRead`
  // availability check above) capable of masking that check's own clearer
  // error behind an unrelated signing failure. Only the MANUAL-gas branch
  // signs now, exactly mirroring `submitTransaction`'s own `if`/`else`.
  const simulation = autoGasLimit
    ? await client.preflightRead!(tx)
    : await client.dirtyRead(await signTransaction(runtime, resolver, signers, tx));

  if (simulation.result.status === "failure") {
    return {
      ok: false,
      mode: "simulate",
      error: dirtyReadError(simulation.result),
      rawResult: simulation.result,
      terminalIntent: null,
    };
  }

  const gasUsed = simulation.gas || 0;
  if (gasUsed > ceiling) {
    return {
      ok: false,
      mode: "simulate",
      gasUsed,
      error: `Transaction needs ${gasUsed} gas, over the block limit of ${ceiling} — no gas setting can mine it. Reduce the transaction's size or complexity.`,
      rawResult: simulation.result,
      terminalIntent: null,
    };
  }
  // Routed through the shared `calibrateAutoGas` (not the old
  // `calculateAutoGasLimit` ladder directly) — a review finding caught this
  // preview diverging from what `submitTransaction` actually declares at
  // fire time, once that path was ported; a second finding caught the fix
  // re-duplicating the same call construction in both places instead of
  // sharing it, reopening the exact drift risk the first fix closed.
  const calibratedGasLimit =
    autoGasLimit && gasUsed > 0
      ? calibrateAutoGas(runtime, tx, gasUsed, signers, ceiling)
      : undefined;

  return {
    ok: true,
    mode: "simulate",
    gasUsed,
    calibratedGasLimit,
    rawResult: simulation.result,
    terminalIntent: null,
  };
}

/**
 * The build-through-submit outcome shared by `fire` and `submit`: build
 * (ceiling-limited if `autoGasLimit`), sign, the `preflightRead`-availability
 * throw-check, the preflight/refuse-unmineable checks, the AUTO-gas
 * rebuild+resign, request-key derivation, and the submit-with-504-recovery
 * try/catch (REQ-23). NOT exported — `runFire`/`runSubmit` are the only
 * callers, and each maps this onto its own result shape.
 */
type SubmitOutcome =
  | { ok: true; chainId: string; requestKey: string; networkId?: string }
  | { ok: false; chainId: string; error: string; rawResult?: unknown; gasUsed?: number };

async function submitTransaction(
  ctx: ExecutorCtx,
  definition: CodexTxDefinition,
  signers: CodexTxDefinition["signers"],
  client: ChainClient,
  ceiling: number,
): Promise<SubmitOutcome> {
  const { runtime, resolver } = ctx;
  const { chainId, autoGasLimit } = definition.config;

  // Build at the resolved ceiling — UNSIGNED. An AUTO-gas fire preflights
  // this build directly, before any signing; a MANUAL-gas fire signs it
  // immediately below, unchanged.
  let tx = buildTransaction(
    runtime,
    definition,
    signers,
    autoGasLimit ? ceiling : undefined,
  );

  if (autoGasLimit && !client.preflightRead) {
    throw new Error(
      "ChainRuntime.preflightRead is required to auto-size gas for an AUTO-gas " +
        "transaction: without it the calibration would use dirtyRead's execution-" +
        "only gas figure, which omits the transaction-size charge and reproduces " +
        "the exact over-reservation bug this capability exists to fix. Upgrade the " +
        "injected runtime adapter (see blockchain/stoachain.ts), or switch this " +
        "cronoton to manual gas.",
    );
  }

  // (F-001) Pre-submit pre-flight — never submit a tx a pre-flight would
  // catch (saves a one-time terminal fire + gas). AUTO-gas fires preflight
  // the UNSIGNED build directly off `buildTransaction`: `declareGasLimit`'s
  // size-charge-delta correction below is derived against reading the
  // UNSIGNED command, so preflighting an already-signed artifact instead
  // would make "is the signature byte cost already counted" ambiguous (see
  // docs/work/ouronet-gas-declaration-port/design.md). MANUAL-gas fires sign
  // first, unchanged, and stay on `dirtyRead` of the signed tx.
  let signed: unknown;
  let preflight: DirtyReadResult;
  if (autoGasLimit) {
    preflight = await client.preflightRead!(tx);
  } else {
    signed = await signTransaction(runtime, resolver, signers, tx);
    preflight = await client.dirtyRead(signed);
  }
  if (preflight.result.status === "failure") {
    return {
      ok: false,
      chainId,
      error: dirtyReadError(preflight.result),
      rawResult: preflight.result,
    };
  }

  // Refuse the unmineable case BEFORE any rebuild/resubmit — a transaction
  // whose measured gas exceeds the resolved block ceiling can never mine, for
  // either an AUTO-gas or a manually-set-limit fire.
  const gasUsed = preflight.gas || 0;
  if (gasUsed > ceiling) {
    return {
      ok: false,
      chainId,
      error: `Transaction needs ${gasUsed} gas, over the block limit of ${ceiling} — no gas setting can mine it. Reduce the transaction's size or complexity.`,
      rawResult: preflight.result,
      gasUsed,
    };
  }

  // Auto-gas: calibrate from the unsigned preflight read via the closed-form
  // declaration model (below EVIDENCE_FLOOR this defers unchanged to the
  // legacy ladder), rebuild at the calibrated limit if calibration ran, then
  // sign — the ONLY sign call this branch makes, win or lose on calibration.
  if (autoGasLimit) {
    if (gasUsed > 0) {
      // Shared with `runSimulate`'s identical preview calibration — see
      // `calibrateAutoGas`'s own doc comment for why this must not be
      // re-duplicated here by hand.
      const calibrated = calibrateAutoGas(runtime, tx, gasUsed, signers, ceiling);
      tx = buildTransaction(runtime, definition, signers, calibrated);
    }
    signed = await signTransaction(runtime, resolver, signers, tx);
  }

  // The request key is the DETERMINISTIC hash of the signed command, so derive
  // it (and the networkId) from `signed` UP FRONT. A lost or timed-out submit
  // RESPONSE — e.g. an nginx 504 returned while the node had ALREADY accepted
  // the tx into its mempool — must never discard a key we can compute ourselves.
  const signedAny = signed as { hash?: unknown; cmd?: unknown };
  const derivedRequestKey =
    typeof signedAny.hash === "string" ? signedAny.hash : null;
  let derivedNetworkId: string | undefined;
  try {
    const parsed = JSON.parse(
      typeof signedAny.cmd === "string" ? signedAny.cmd : "{}",
    ) as { networkId?: string };
    if (typeof parsed.networkId === "string") derivedNetworkId = parsed.networkId;
  } catch {
    /* cmd not JSON-parseable — leave networkId undefined */
  }

  let submitResult: { requestKey: string };
  try {
    submitResult = await client.submit(signed);
  } catch (submitErr) {
    // Ambiguous submit: the node may have accepted the tx even though the HTTP
    // response was lost. If we have the derived key, rebuild the listen
    // descriptor and poll the chain by it — a tx that actually landed recovers
    // as success; one that never sent times out below as a genuine failure
    // (with the key preserved).
    if (!derivedRequestKey) throw submitErr;
    const descriptor: Record<string, unknown> = {
      requestKey: derivedRequestKey,
      chainId,
    };
    if (derivedNetworkId) descriptor.networkId = derivedNetworkId;
    submitResult = descriptor as { requestKey: string };
  }

  return {
    ok: true,
    chainId,
    requestKey: submitResult.requestKey,
    networkId: derivedNetworkId,
  };
}

async function runFire(
  ctx: ExecutorCtx,
  definition: CodexTxDefinition,
  signers: CodexTxDefinition["signers"],
): Promise<FireResult> {
  const { runtime } = ctx;
  const listenMs = ctx.config?.listenTimeoutMs ?? LISTEN_TIMEOUT_MS;
  const { chainId } = definition.config;
  const client = runtime.createClient(runtime.getPactUrl(chainId));
  const ceiling = await resolveCeiling(ctx, client, chainId);

  const outcome = await submitTransaction(ctx, definition, signers, client, ceiling);
  if (!outcome.ok) {
    return {
      ok: false,
      mode: "fire",
      chainId: outcome.chainId,
      error: outcome.error,
      rawResult: outcome.rawResult,
      terminalIntent: computeTerminalIntent(definition.scheduleKind, "fire", false),
    };
  }

  // Listen, but NEVER let a timeout/error throw the request key away — a tx
  // whose confirmation we couldn't observe may still be on-chain, so return a
  // failure that PRESERVES the key for recovery instead of recording it NULL.
  let result: ListenResult;
  try {
    result = await listenWithTimeout(
      client.listen,
      { requestKey: outcome.requestKey, chainId: outcome.chainId, networkId: outcome.networkId },
      listenMs,
    );
  } catch (listenErr) {
    return {
      ok: false,
      mode: "fire",
      chainId: outcome.chainId,
      requestKey: outcome.requestKey,
      error:
        listenErr instanceof Error
          ? listenErr.message
          : "Transaction confirmation could not be observed.",
      terminalIntent: computeTerminalIntent(definition.scheduleKind, "fire", false),
    };
  }

  if (result.result.status === "failure") {
    return {
      ok: false,
      mode: "fire",
      chainId: outcome.chainId,
      requestKey: result.reqKey || outcome.requestKey,
      error: result.result.error?.message || "Transaction failed on-chain.",
      rawResult: result.result,
      terminalIntent: computeTerminalIntent(definition.scheduleKind, "fire", false),
    };
  }

  return {
    ok: true,
    mode: "fire",
    chainId: outcome.chainId,
    requestKey: result.reqKey || outcome.requestKey,
    rawResult: result.result,
    terminalIntent: computeTerminalIntent(definition.scheduleKind, "fire", true),
  };
}

/**
 * `submit` builds, signs, pre-flights, and submits — exactly what `fire` does
 * up through the submit-with-504-recovery step — but NEVER calls `listen`.
 * Confirmation is a separate poll (Phase 3's driver), not this call's job.
 */
async function runSubmit(
  ctx: ExecutorCtx,
  definition: CodexTxDefinition,
  signers: CodexTxDefinition["signers"],
): Promise<SubmitResult> {
  const { runtime } = ctx;
  const { chainId } = definition.config;
  const client = runtime.createClient(runtime.getPactUrl(chainId));
  const ceiling = await resolveCeiling(ctx, client, chainId);

  const outcome = await submitTransaction(ctx, definition, signers, client, ceiling);
  if (!outcome.ok) {
    return {
      ok: false,
      mode: "submit",
      chainId: outcome.chainId,
      error: outcome.error,
      rawResult: outcome.rawResult,
    };
  }

  return {
    ok: true,
    mode: "submit",
    requestKey: outcome.requestKey,
    chainId: outcome.chainId,
    networkId: outcome.networkId,
  };
}

/**
 * Execute a codex transaction in `simulate` (sign + pre-submit read, NO
 * submit) or `fire` (pre-flight read → submit → listen) mode against the
 * injected {@link ExecutorCtx}. That pre-submit/pre-flight read is
 * `ChainClient.preflightRead` for an AUTO-gas transaction (accurate gas,
 * including the transaction-size charge) and plain `ChainClient.dirtyRead`
 * for a MANUAL-gas one (see the module doc above for why) — both modes
 * inherit whichever the definition's `autoGasLimit` selects.
 *
 * `fire` mode NEVER throws on chain/sign/decrypt failure (F-002): every failure
 * mode — pre-flight-read failure, sign-incompletion, submit error, listen
 * timeout, and resolver/decrypt rejection — returns a structured
 * `{ ok: false, error, terminalIntent }`. A one-time entry whose fire threw
 * would otherwise get no terminalIntent and re-fire on the next tick.
 *
 * `simulate` mode surfaces build errors (zero signers, gas-station with no
 * signing key) as throws to the caller, but converts chain-side pre-submit-
 * read failures into structured results.
 */
export function executeCodexTransaction(
  definition: CodexTxDefinition,
  mode: "simulate",
  ctx: ExecutorCtx,
): Promise<SimulateResult>;
export function executeCodexTransaction(
  definition: CodexTxDefinition,
  mode: "fire",
  ctx: ExecutorCtx,
): Promise<FireResult>;
export function executeCodexTransaction(
  definition: CodexTxDefinition,
  mode: "submit",
  ctx: ExecutorCtx,
): Promise<SubmitResult>;
export async function executeCodexTransaction(
  definition: CodexTxDefinition,
  mode: ExecutorMode,
  ctx: ExecutorCtx,
): Promise<ExecutorResult> {
  const { runtime } = ctx;

  if (mode === "simulate") {
    // Build-shape + gas-payer contract validation runs eagerly so callers see
    // contract violations (zero signers, gas-station with no signing key) as a
    // throw in simulate.
    const signers = effectiveSigners(definition, runtime.namespace);
    if (signers.length === 0) {
      throw new Error(
        "At least one signer is required to build a codex transaction.",
      );
    }
    return runSimulate(ctx, definition, signers);
  }

  if (mode === "submit") {
    // Submit NEVER throws, same F-002 guarantee `fire` has: it's a step
    // toward on-chain submission, not a dry-run like `simulate`, so it
    // inherits `fire`'s never-throws contract rather than `simulate`'s
    // surface-build-errors contract.
    try {
      const signers = effectiveSigners(definition, runtime.namespace);
      if (signers.length === 0) {
        throw new Error(
          "At least one signer is required to build a codex transaction.",
        );
      }
      return await runSubmit(ctx, definition, signers);
    } catch (e) {
      const error = describeThrown(e, "submit");
      return {
        ok: false,
        mode: "submit",
        chainId: definition.config.chainId,
        error,
      };
    }
  }

  // Fire NEVER throws (F-002): every failure — including a gas-station signer
  // contract violation — returns a structured result so a one-time entry's spent
  // attempt is recorded instead of silently re-firing on the next tick.
  try {
    const signers = effectiveSigners(definition, runtime.namespace);
    if (signers.length === 0) {
      throw new Error(
        "At least one signer is required to build a codex transaction.",
      );
    }
    return await runFire(ctx, definition, signers);
  } catch (e) {
    const error = describeThrown(e, "fire");
    return {
      ok: false,
      mode: "fire",
      chainId: definition.config.chainId,
      error,
      terminalIntent: computeTerminalIntent(definition.scheduleKind, "fire", false),
    };
  }
}

/** The outcome of {@link dirtyReadPlan} — never a throw on a chain-side read failure. */
export type DirtyReadPlanResult = { ok: true; data: unknown } | { ok: false; error: string };

/**
 * Execute a PURE on-chain read as an unsigned, zero-signer `ChainRuntime.dirtyRead`
 * — never through {@link executeCodexTransaction}'s simulate path, and never
 * `preflightRead`.
 *
 * Why this exists (see `docs/work/aqp-planners-talos-routing/design.md`): every
 * AQP step planner's "plan read" (e.g. `URH_FvtStalePresentUsers`,
 * `URHC_BuildEvictPlans`, a live `coin.get-balance` probe) used to go through
 * `executeCodexTransaction(leg, "simulate", ctx)`, inheriting the STEP's own
 * `autoGasLimit` config verbatim. Under AUTO gas, `runSimulate` calls
 * `client.preflightRead(tx)` — Kadena's `/local` preflight mode runs the FULL
 * submission pipeline, including the coin contract's `buy-gas`/`redeem-gas`,
 * which enforces `GAS_PAYER`'s payable-module whitelist even though nothing is
 * actually being submitted. A pure read has no business triggering a gas-buy
 * check at all; switching the step to MANUAL gas doesn't fix this properly
 * either — it happens to land on `dirtyRead` today only as a side effect of
 * `runSimulate`'s own AUTO/MANUAL branch, not because anything here actually
 * decided a read should never consult the gas station.
 *
 * Builds the bare minimum transaction — `Pact.builder.execution(pactCode)` +
 * `setMeta({chainId})` + `setNetworkId` + an `addData` loop over `payload` —
 * with NO signer, NO gas meta, NO gas payer at all (mirrors `tx-size.ts`'s own
 * `estimateTxSize`, which already proves the SDK's builder accepts a
 * zero-signer `createTransaction()` for an unrelated purpose). `dirtyRead` never
 * runs `buy-gas`/`redeem-gas`, so a read built and executed this way can never
 * hit the payable-module gate, regardless of the caller's own gas mode.
 */
export async function dirtyReadPlan(
  runtime: ChainRuntime,
  chainId: string,
  pactCode: string,
  payload: Record<string, unknown>,
): Promise<DirtyReadPlanResult> {
  const builder = runtime.Pact.builder.execution(pactCode) as PactBuilder;
  builder.setMeta({ chainId }).setNetworkId(runtime.networkId);
  for (const [key, value] of Object.entries(payload)) {
    builder.addData(key, value);
  }
  const tx = builder.createTransaction();
  const client = runtime.createClient(runtime.getPactUrl(chainId));
  const read = await client.dirtyRead(tx);
  if (read.result.status === "failure") {
    return { ok: false, error: read.result.error?.message ?? "dirty read failed" };
  }
  return { ok: true, data: read.result.data };
}
