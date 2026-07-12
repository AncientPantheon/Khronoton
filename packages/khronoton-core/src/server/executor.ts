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
 *     dirty-read-derived limit;
 *   - the 504/derived-request-key recovery (REQ-23) — the request key is derived
 *     from the signed command hash UP FRONT so a lost submit response or a listen
 *     timeout never discards a tx that may already be on-chain.
 */

import type {
  ChainRuntime,
  KeyResolver,
  Config,
  UniversalKeypair,
  IUnsignedCommand,
  ListenResult,
} from "./seams.js";
import { LISTEN_TIMEOUT_MS, AUTO_GAS_CEILING } from "./seams.js";
import { parseCapabilityLine, computeTerminalIntent } from "./pure/capability.js";
import { effectiveSigners, deriveSenderAccount } from "./executor-signers.js";
import type {
  CodexTxDefinition,
  ExecutorMode,
  ExecutorResult,
  FireResult,
  SimulateResult,
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
 * the payload + pure-vs-scoped `addSigner`. Throws if no signers.
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

  builder
    .setMeta({
      senderAccount,
      chainId: definition.config.chainId,
      gasLimit: gasLimitOverride ?? definition.config.gasLimit,
      gasPrice: runtime.anuToStoa(definition.config.gasPrice),
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
  const ceiling = ctx.config?.autoGasCeiling ?? AUTO_GAS_CEILING;
  const { autoGasLimit } = definition.config;

  const tx = buildTransaction(
    runtime,
    definition,
    signers,
    autoGasLimit ? ceiling : undefined,
  );
  const signed = await signTransaction(runtime, resolver, signers, tx);

  const { dirtyRead } = runtime.createClient(
    runtime.getPactUrl(definition.config.chainId),
  );
  const simulation = await dirtyRead(signed);

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
  const calibratedGasLimit =
    autoGasLimit && gasUsed > 0
      ? runtime.calculateAutoGasLimit(gasUsed)
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

async function runFire(
  ctx: ExecutorCtx,
  definition: CodexTxDefinition,
  signers: CodexTxDefinition["signers"],
): Promise<FireResult> {
  const { runtime, resolver } = ctx;
  const ceiling = ctx.config?.autoGasCeiling ?? AUTO_GAS_CEILING;
  const listenMs = ctx.config?.listenTimeoutMs ?? LISTEN_TIMEOUT_MS;
  const { chainId, autoGasLimit } = definition.config;
  const client = runtime.createClient(runtime.getPactUrl(chainId));

  // Build + sign for the pre-flight dirty-read.
  let tx = buildTransaction(
    runtime,
    definition,
    signers,
    autoGasLimit ? ceiling : undefined,
  );
  let signed = await signTransaction(runtime, resolver, signers, tx);

  // (F-001) Pre-submit dirty-read pre-flight — never submit a tx a pre-flight
  // would catch (saves a one-time terminal fire + gas).
  const preflight = await client.dirtyRead(signed);
  if (preflight.result.status === "failure") {
    return {
      ok: false,
      mode: "fire",
      chainId,
      error: dirtyReadError(preflight.result),
      rawResult: preflight.result,
      terminalIntent: computeTerminalIntent(definition.scheduleKind, "fire", false),
    };
  }

  // Auto-gas: rebuild + re-sign with the calibrated limit from the dirty-read.
  if (autoGasLimit && (preflight.gas || 0) > 0) {
    const calibrated = runtime.calculateAutoGasLimit(preflight.gas || 0);
    tx = buildTransaction(runtime, definition, signers, calibrated);
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

  // Listen, but NEVER let a timeout/error throw the request key away — a tx
  // whose confirmation we couldn't observe may still be on-chain, so return a
  // failure that PRESERVES the key for recovery instead of recording it NULL.
  let result: ListenResult;
  try {
    result = await listenWithTimeout(client.listen, submitResult, listenMs);
  } catch (listenErr) {
    return {
      ok: false,
      mode: "fire",
      chainId,
      requestKey: submitResult.requestKey,
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
      chainId,
      requestKey: result.reqKey || submitResult.requestKey,
      error: result.result.error?.message || "Transaction failed on-chain.",
      rawResult: result.result,
      terminalIntent: computeTerminalIntent(definition.scheduleKind, "fire", false),
    };
  }

  return {
    ok: true,
    mode: "fire",
    chainId,
    requestKey: result.reqKey || submitResult.requestKey,
    rawResult: result.result,
    terminalIntent: computeTerminalIntent(definition.scheduleKind, "fire", true),
  };
}

/**
 * Execute a codex transaction in `simulate` (sign + dirty-read, NO submit) or
 * `fire` (pre-flight dirty-read → submit → listen) mode against the injected
 * {@link ExecutorCtx}.
 *
 * `fire` mode NEVER throws on chain/sign/decrypt failure (F-002): every failure
 * mode — dirty-read failure, sign-incompletion, submit error, listen timeout,
 * and resolver/decrypt rejection — returns a structured
 * `{ ok: false, error, terminalIntent }`. A one-time entry whose fire threw
 * would otherwise get no terminalIntent and re-fire on the next tick.
 *
 * `simulate` mode surfaces build errors (zero signers, gas-station with no
 * signing key) as throws to the caller, but converts chain-side dirty-read
 * failures into structured results.
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
    const error =
      (e instanceof Error ? e.message : String(e)) ||
      (e instanceof Error ? `${e.name} (no message)` : "unknown fire error");
    return {
      ok: false,
      mode: "fire",
      chainId: definition.config.chainId,
      error,
      terminalIntent: computeTerminalIntent(definition.scheduleKind, "fire", false),
    };
  }
}
