/**
 * The six injection seams the server automaton is built against.
 *
 * Every host-specific capability the Hub executor/store reached for directly
 * (`@stoachain/*` runtime, the codex key resolver, the ambient SQLite handle,
 * the audit log, the fire-mode signal, the tuning constants) is inverted here
 * into a narrow, dependency-free contract the consumer injects. This module
 * declares ONLY interfaces, type aliases, and the module-level default
 * constants — no orchestration logic. It imports nothing from `@stoachain/*`
 * and nothing from `better-sqlite3`; the carrier types
 * (`IKadenaKeypair`, `UniversalKeypair`, `IUnsignedCommand`) are genericized
 * and declared here so the emitted `.d.ts` carries zero external module
 * references.
 */

// ── REQ-01: KeyResolver ──────────────────────────────────────────────────────

/**
 * A resolved signing keypair returned by {@link KeyResolver}.
 *
 * `privateKey` here is the raw signing secret (hex). Note the field-name
 * divergence from {@link UniversalKeypair}, whose equivalent field is
 * `secretKey`; a consumer mapping a resolver result into a signer payload must
 * copy `privateKey -> secretKey`. `seedType` is genericized to `string`
 * (the Hub narrowed it to a `@stoachain` seed-type union). The derived-seed
 * WASM-signing path carries `encryptedSecretKey` + `password` through.
 */
export interface IKadenaKeypair {
  publicKey: string;
  privateKey: string;
  seedType: string;
  encryptedSecretKey?: string;
  password?: string;
}

/**
 * Resolves signer public keys to their keypairs and enumerates the pubkeys the
 * backing key store owns. Mirrors the Hub `CodexKeyResolver`: async lookups
 * and a `Set<string>` membership view.
 */
export interface KeyResolver {
  /** Resolve a signer public key to its keypair; rejects if not owned. */
  getKeyPairByPublicKey(publicKey: string): Promise<IKadenaKeypair>;
  /** Enumerate every public key the backing store can sign for. */
  listCodexPubs(): Promise<Set<string>>;
  /**
   * Optional last-resort resolution for a foreign key not in the store. A
   * headless consumer with no interactive prompt may omit this or reject
   * fast — a signer whose pubkey is unknown then fails at build time.
   */
  requestForeignKey?(publicKey: string): Promise<string>;
}

// ── REQ-02: ChainRuntime ─────────────────────────────────────────────────────

/**
 * A signer keypair as consumed by {@link ChainRuntime.universalSignTransaction}.
 *
 * Note `secretKey` here versus `privateKey` on {@link IKadenaKeypair}: the two
 * carriers describe the same secret under different field names, so a consumer
 * bridging resolver output into a signer must remap the field. `seedType` is
 * genericized to `string`.
 */
export interface UniversalKeypair {
  publicKey: string;
  secretKey: string;
  seedType: string;
  encryptedSecretKey?: string;
  password?: string;
}

/**
 * A genericized unsigned Kadena command (the Hub imported this from
 * `@stoachain/kadena-stoic-legacy/types`). Structural shape only, so a real
 * Kadena unsigned command satisfies it without pulling the chain dependency.
 */
export interface IUnsignedCommand {
  cmd: string;
  hash: string;
  sigs: Array<{ sig?: string } | undefined>;
}

/** The dirty-read (local simulation) result from {@link ChainRuntime}. */
export interface DirtyReadResult {
  result: { status: string; error?: { message?: string }; data?: unknown };
  gas?: number;
}

/** The listen (confirmation) result from {@link ChainRuntime}. */
export interface ListenResult {
  result: { status: string; error?: { message?: string } };
  reqKey?: string;
}

/** A network client bound to a single Pact endpoint URL. */
export interface ChainClient {
  dirtyRead(tx: unknown): Promise<DirtyReadResult>;
  submit(tx: unknown): Promise<{ requestKey: string }>;
  listen(desc: unknown): Promise<ListenResult>;
}

/**
 * The transaction gas meta produced by {@link ChainRuntime.gasMeta} — a
 * `creationTime` (unix seconds) and the `gasPrice` (in the chain's own
 * transaction units, NOT ANU) derived from that exact `creationTime`.
 *
 * Both fields come from ONE call, and both must be spread into the same
 * `setMeta`. They are a matched pair: a chain whose minimum gas price rises
 * over time validates a signed transaction's price against the transaction's
 * OWN `creationTime`, so a price derived from a different clock read than the
 * `creationTime` that ships with it can silently fall under the floor when the
 * two reads straddle a tick boundary.
 */
export interface StoaGasMeta {
  /** Unix seconds stamped into the transaction. */
  creationTime: number;
  /** Price for that creationTime, in chain transaction units (e.g. STOA). */
  gasPrice: number;
}

/**
 * The chain runtime seam — every `@stoachain/*` runtime value the executor
 * reaches for, inverted into one injectable object. Ported from the Hub's
 * private `StoachainRuntime` interface, with the ambient constants renamed to
 * seam-neutral names: `KADENA_NETWORK -> networkId`,
 * `STOA_AUTONOMIC_OURONETGASSTATION -> gasStationAccount`,
 * `KADENA_NAMESPACE -> namespace`. Deliberately excludes `pollRequestKeys`
 * (the executor confirms via `listen`, never polls).
 *
 * `gasMeta` is OPTIONAL so this package stays chain-POLYGLOT and
 * `@stoachain/*` stays an optional peer dependency — a runtime for a chain with
 * no rising gas floor simply omits it. It is NOT optional in effect for a
 * StoaChain fire: the executor HARD THROWS when it is absent rather than
 * falling back to the per-cronoton stored price. That fallback is precisely the
 * bug this capability exists to kill — a stored price is captured once at
 * cronoton-creation time and never re-derived, so it drifts below the live
 * floor as the cronoton ages, and nobody is watching a 3am tick fire to notice
 * the rejection. Failing loudly on an un-upgraded runtime adapter is the point.
 *
 * `floorAnu` is the caller's stored price in ANU, treated as a floor an
 * operator may raise ABOVE the live minimum, never a cap that can hold a
 * transaction below it. Implementations return
 * `max(floorAnu, liveFloor(creationTime))`, converted to chain units.
 * See `blockchain/stoachain.ts` for the StoaChain implementation.
 *
 * `bufferAnu` (default 0) is added to `floorAnu` **in ANU**, before the
 * implementation's one `anuToStoaNumber` conversion — summing two
 * independently-converted STOA numbers instead produces a different
 * serialized value in roughly 1 in 5 floor/buffer pairs (verified:
 * `anuToStoaNumber(11569) + anuToStoaNumber(500)` !== `anuToStoaNumber(12069)`
 * as JSON strings), which is exactly the class of bug `anuToStoaNumber`
 * exists to prevent.
 */
export interface ChainRuntime {
  Pact: { builder: { execution(code: string): unknown } };
  createClient(url: string): ChainClient;
  isSignedTransaction(tx: unknown): boolean;
  universalSignTransaction(
    tx: IUnsignedCommand,
    keypairs: UniversalKeypair[],
  ): Promise<unknown>;
  calculateAutoGasLimit(gas: number): number;
  anuToStoa(anu: number): number;
  gasMeta?(floorAnu: number, bufferAnu?: number): StoaGasMeta;
  getPactUrl(chainId: string): string;
  networkId: string;
  namespace: string;
  gasStationAccount: string;
}

// ── REQ-03: Database / DbDep ─────────────────────────────────────────────────

/**
 * A prepared statement — the subset of the better-sqlite3 `Statement` surface
 * the store actually calls. Declared structurally (owned here, NOT re-exported
 * from `better-sqlite3`) so the emitted `.d.ts` references no external DB
 * module; a real better-sqlite3 `Statement` satisfies it.
 */
export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * The minimal synchronous SQL handle the store and `installSchema` require —
 * `exec` for DDL, `prepare(...)` for parameterized reads/writes. A real
 * better-sqlite3 `Database` instance structurally satisfies this, so no
 * `better-sqlite3` import (or `@types/better-sqlite3` dependency) leaks into
 * the public `/server` surface. `pragma`/`transaction` are intentionally
 * omitted — no store function needs them.
 */
export interface Database {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
}

/**
 * Carries the injected DB handle into store calls.
 *
 * Divergence from the Hub's `resolveDb(dep) = dep?.db ?? getDb()`: this package
 * has no ambient `getDb()` fallback, so the handle is REQUIRED — the consumer
 * always injects a handle at the call boundary.
 */
export interface DbDep {
  db: Database;
}

// ── REQ-04: OnAudit ──────────────────────────────────────────────────────────

/** The structured event passed to an {@link OnAudit} sink. */
export interface AuditEvent {
  action: string;
  result: string;
  targetKind: string;
  targetId: string;
  detail: unknown;
}

/**
 * Audit sink invoked on each mutating action. May be sync or async. The
 * default is a no-op: `() => {}` — a consumer wanting an audit trail injects
 * its own writer.
 */
export type OnAudit = (event: AuditEvent) => void | Promise<void>;

/** The documented no-op default for {@link OnAudit}. */
export const defaultOnAudit: OnAudit = () => {};

// ── REQ-05: ResolveFireMode ──────────────────────────────────────────────────

/**
 * Resolves a cronoton id to its effective fire mode. Strictly SYNCHRONOUS (no
 * `Promise` in the union): better-sqlite3 is a synchronous driver and the store
 * binds the result directly into the fire-record INSERT. A consumer needing
 * async fire-mode resolution pre-resolves before invoking the tick.
 *
 * The default resolves to `'live'`. A consumer may honor a per-row
 * `fire_mode_override = 'live'` first, then fall back to a global signal.
 */
export type ResolveFireMode = (cronotonId: string) => 'test' | 'live';

/** The documented default for {@link ResolveFireMode}: always `'live'`. */
export const defaultResolveFireMode: ResolveFireMode = () => 'live';

// ── REQ-06: Config ───────────────────────────────────────────────────────────

/**
 * Tuning knobs for the automaton. Every field maps to a module-level default
 * constant below; a consumer passes a `Partial<Config>` and each consumer site
 * reads `config?.<field> ?? <MODULE_DEFAULT>`, so an injected value takes
 * effect and an omitted one falls back.
 *
 * `gasPriceFloor` and `ttl` are intentionally absent: the Hub never clamped
 * gasPrice/ttl (the executor uses the per-cronoton `definition.config` values
 * directly), so exposing them as injectable would misrepresent the behavior.
 */
export interface Config {
  tickIntervalMs: number;
  listenTimeoutMs: number;
  autoGasCeiling: number;
  singleTxGasGuard: number;
  tickBatchLimit: number;
  manualBatch: { min: number; max: number; intervalSeconds: number };
}

/** Default tick cadence (30s) — {@link Config.tickIntervalMs}. */
export const TICK_INTERVAL_MS = 30_000;
/** Default listen (confirmation) timeout: 5 minutes — {@link Config.listenTimeoutMs}. */
export const LISTEN_TIMEOUT_MS = 300_000;
/** Default auto-gas simulation ceiling — {@link Config.autoGasCeiling}. */
export const AUTO_GAS_CEILING = 2_000_000;
/** Default single-transaction gas guard — {@link Config.singleTxGasGuard}. */
export const SINGLE_TX_GAS_GUARD = 1_600_000;
/** Default max cronotons processed per tick — {@link Config.tickBatchLimit}. */
export const TICK_BATCH_LIMIT = 100;
/** Default manual-batch minimum size — {@link Config.manualBatch}.min. */
export const MANUAL_BATCH_MIN = 2;
/** Default manual-batch maximum size — {@link Config.manualBatch}.max. */
export const MANUAL_BATCH_MAX = 60;
/** Default manual-batch inter-fire interval (seconds) — {@link Config.manualBatch}.intervalSeconds. */
export const MANUAL_BATCH_INTERVAL_SECONDS = 60;
