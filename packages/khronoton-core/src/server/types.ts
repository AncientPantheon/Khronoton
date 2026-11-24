/**
 * Shared domain types for the Khronoton server-side executor and store.
 *
 * `CodexTxDefinition` is the single constructed-tx shape every caller
 * (simulate API, manual-fire API, scheduled-fire worker tick) passes to the
 * executor. The result + terminal-intent types are imported by those same
 * callers so the executor stays the single source of truth for the contract.
 *
 * The DB row types + their client-facing projections describe the three
 * server tables (`codex_cronotons`, `codex_cronoton_fires`,
 * `codex_cronoton_manual_batches`). JSON columns are raw strings at the row
 * layer; higher layers parse them into the structured types above.
 */

import type { ScheduleMode } from "../schedule.js";

/**
 * Opaque chain identifier. Genericized to `string` — this package carries no
 * chain dependency (the source Hub imported a concrete `ChainId`).
 */
export type ChainId = string;

/**
 * Run mode: `simulate` never submits — MANUAL-gas signs first, then
 * dirty-reads the signed command; AUTO-gas never signs at all, preflighting
 * the unsigned build directly (a review finding caught `executor.ts`'s own
 * `calibrateAutoGas` calibration depending on an unsigned reading, so
 * signing before preflight would be wasted work with no reader of its
 * result). `fire` submits AND awaits confirmation (listen); `submit`
 * submits but does NOT await confirmation — the caller polls it separately
 * (see {@link SubmitResult} and `ChainClient.pollRequestKeys`), which is
 * what lets a chained, multi-leg run avoid blocking the scheduler on a
 * 5-minute listen per leg.
 */
export type ExecutorMode = "simulate" | "fire" | "submit";

/** One-time entries terminate after a single fire; recurring re-fire on schedule. */
export type ScheduleKind = "one-time" | "recurring";

/** Capability scoping for a signer: `pure` (unrestricted) or `scoped` (capped). */
export type CapabilityMode = "pure" | "scoped";

/** A signer reference — pubkey + how its signature is scoped. Codex-only: no secrets. */
export interface CodexSigner {
  /** 64-hex Ed25519 public key (no `k:` prefix). Must be resolvable by the codex. */
  readonly publicKey: string;
  readonly capabilityMode: CapabilityMode;
  /** Newline-separated capability lines (e.g. `(coin.GAS)`). Empty for pure signers. */
  readonly capabilities: string;
}

/** Gas-payer reference: the protocol gas station, or a codex `k:` account. */
export interface CodexGasPayer {
  readonly type: "codex" | "gas-station";
  /** Codex gas-payer pubkey/address (the `k:` is derived). Absent for gas-station. */
  readonly address?: string;
  /**
   * The codex public key that signs the gas station's `DALOS.GAS_PAYER`
   * capability. Required (and only meaningful) for `type:'gas-station'`: the
   * executor synthesizes a scoped GAS_PAYER signer for this key, so the gas
   * station pays while this codex key authorizes the payment. The `coin.GAS`
   * for a codex gas-payer rides on `address`, not here.
   */
  readonly gasStationSignerKey?: string;
}

/** Transaction config — chain, gas, ttl. `gasPrice` is in ANU. */
export interface CodexTxConfig {
  readonly chainId: string;
  /**
   * @deprecated Superseded by `gasPriceBufferAnu`. Kept only so historical rows'
   * `config_json` still parses; no longer used to price new fires — see
   * `server/executor.ts`'s `buildTransaction`, which always prices from the live
   * network floor plus `gasPriceBufferAnu`.
   */
  readonly gasPrice: number;
  /**
   * ANU to pay ABOVE the live network floor at fire time. 0 (default, and the
   * value used when absent — e.g. every pre-migration row) = exactly the floor.
   * The only gas-price knob an operator sets — never an absolute price, since
   * the floor rises roughly every 3h and any absolute number set today is
   * guaranteed to go stale. Absence self-heals a historical row with no DB
   * migration.
   */
  readonly gasPriceBufferAnu?: number;
  readonly gasLimit: number;
  /** When true, the executor calibrates the gas limit from a dirty-read. */
  readonly autoGasLimit: boolean;
  /** Time-to-live in seconds. */
  readonly ttl: number;
}

/** The full constructed-tx definition — the one shape all callers pass. */
export interface CodexTxDefinition {
  readonly pactCode: string;
  readonly config: CodexTxConfig;
  /** env-data + keysets: each key becomes one `addData(key, value)`. */
  readonly payload: Record<string, unknown>;
  readonly gasPayer: CodexGasPayer;
  readonly signers: CodexSigner[];
  /** Drives terminal-intent computation. Defaults to `recurring` when absent. */
  readonly scheduleKind?: ScheduleKind;
  /**
   * Names a server-side payload resolver (e.g. `'stoicism-mint'`). When set, the
   * fire-time wrapper fills designated payload keys from live server data and
   * settles server balances after a successful on-chain submit. Absent for
   * ordinary cronotons, which fire through the executor unchanged.
   */
  readonly serverResolver?: string;
}

/**
 * Terminal-transition INTENT for a one-time entry, COMPUTED (not persisted) by
 * the executor. The caller reads this off the result and writes the table +
 * clears the next-fire time. `null` for recurring entries and all simulate runs.
 */
export interface TerminalIntent {
  readonly status: "completed" | "error";
  /** Always true for one-time terminal transitions — its single attempt is spent. */
  readonly clearNextFire: true;
}

/** Result of a `simulate` run. Never submits. */
export interface SimulateResult {
  readonly ok: boolean;
  readonly mode: "simulate";
  /** Present when `autoGasLimit` and the dirty-read returned a gas figure. */
  readonly calibratedGasLimit?: number;
  readonly gasUsed?: number;
  readonly rawResult?: unknown;
  readonly error?: string;
  /** Always `null` for simulate. */
  readonly terminalIntent: null;
}

/** Result of a `fire` run. Submits (unless pre-flight fails). */
export interface FireResult {
  readonly ok: boolean;
  readonly mode: "fire";
  readonly requestKey?: string;
  readonly chainId?: string;
  readonly rawResult?: unknown;
  readonly error?: string;
  /** Computed one-time terminal intent; `null` for recurring. */
  readonly terminalIntent: TerminalIntent | null;
  /**
   * `true` only for `resolvers.ts`'s own `postponed(...)` results — a
   * server-resolver-routed fire that was NEVER submitted to chain at all
   * (a dispatch error, an unknown/multi-tx-mismatched resolver name, a
   * resolver-side safety-guard simulate failure, or its gas guard being
   * tripped). Absent/`undefined` for every other `FireResult`, including a
   * GENUINE on-chain fire failure — the two are otherwise structurally
   * identical (`ok: false`, `terminalIntent: null` for a recurring row
   * either way), which is exactly the ambiguity this field exists to
   * resolve: a caller deciding whether "didn't fire" should fall back to
   * an alternate path (as `single-tx.ts`'s `attemptSingleTxFirst` does)
   * must be able to tell the two apart without parsing `error` text.
   */
  readonly postponed?: boolean;
}

/**
 * Result of a `submit` run. Builds, signs, pre-flights, and submits — never
 * calls `listenWithTimeout`. `ok: true` with a `requestKey` means "submitted,"
 * not "confirmed"; confirmation is a separate poll (Phase 3), not this result.
 * No `terminalIntent`: submit never resolves a one-time row's terminal state.
 *
 * A SHARPER caveat than "not confirmed yet": `ok: true` is not even proof the
 * transaction reached the chain. The shared build-through-submit helper
 * (`executor.ts`'s `submitTransaction`) treats ANY throw from the chain
 * client's submit call as the ambiguous "lost the HTTP response, but the node
 * may have already accepted it" case (REQ-23) whenever a request key can be
 * derived from the signed command — which is unconditional, since that key is
 * just the signed command's own hash, computed before the network call ever
 * happens. For `fire` mode this is safe because the subsequent `listen` call
 * eventually distinguishes a genuine rejection from a real confirmation; for
 * `submit` mode there is no such follow-up inside this call. A caller polling
 * a `requestKey` this result returns must be prepared for it to never
 * confirm — that is an expected outcome requiring a bounded deadline + re-plan
 * or fail-the-run response (see the chained-runs design's §5.5/§5.7), not a
 * bug to work around by re-submitting (re-submitting a leg that already has a
 * request key is exactly the unsafe case the "never re-submit, only poll"
 * invariant exists to forbid).
 */
export interface SubmitResult {
  readonly ok: boolean;
  readonly mode: "submit";
  readonly requestKey?: string;
  readonly chainId?: string;
  readonly networkId?: string;
  /** The preflight read, present on a pre-submit failure. */
  readonly rawResult?: unknown;
  readonly error?: string;
}

export type ExecutorResult = SimulateResult | FireResult | SubmitResult;

/** The raw `codex_cronotons` row shape (JSON columns are still strings here). */
export interface CodexCronotonRow {
  id: string;
  name: string;
  description: string | null;
  pact_code: string;
  config_json: string;
  payload_json: string | null;
  gas_payer_json: string;
  signers_json: string;
  schedule_mode: ScheduleMode;
  schedule_config_json: string;
  /**
   * Name of the fire-time server payload resolver, or null/absent for ordinary
   * rows. Optional so pre-migration row doubles (test fixtures) typecheck; real
   * rows from `SELECT *` carry the column (value may be null).
   */
  server_resolver?: string | null;
  /**
   * When 1, this cronoton may be fired by the external HMAC endpoint. Optional
   * so pre-migration row doubles (test fixtures) typecheck; real rows carry it.
   */
  external_fireable?: number;
  /**
   * JSON string[] of env-data keys a trigger supplies at fire time; null/absent
   * = an ordinary fixed-definition cronoton. Optional so pre-migration row
   * doubles (test fixtures) typecheck.
   */
  runtime_arg_keys?: string | null;
  /**
   * Stable, URL-safe public lookup token; null/absent until the row is first
   * made observable. Optional so pre-migration row doubles (test fixtures)
   * typecheck; real rows from `SELECT *` carry the column (value may be null).
   */
  public_token?: string | null;
  /**
   * When 1, this cronoton's sanitized state is readable via the public
   * by-token endpoint, bypassing admin auth entirely. Optional so
   * pre-migration row doubles (test fixtures) typecheck; real rows from
   * `SELECT *` carry the column.
   */
  public_observable?: number;
  /**
   * When 1, a chained row attempts a single-transaction variant of its own
   * work (via `pact_code`/`payload_json`/`config_json`/`gas_payer_json`/
   * `signers_json`, reinterpreted) before falling through to the step-by-step
   * chain. Optional so pre-existing hand-constructed row doubles (test
   * fixtures across the package, predating this column) still typecheck;
   * real rows from `SELECT *` carry the column (value is never actually
   * undefined at runtime — `installSchema`'s `ensureColumn` backfills
   * `NOT NULL DEFAULT 0` on every row).
   */
  try_single_tx_first?: number;
  /**
   * Meaningful only when `try_single_tx_first` is 1: how the single-tx Pact
   * code was produced. `null`/absent when unset. Optional for the same
   * pre-existing-fixture-compatibility reason as `try_single_tx_first`.
   */
  single_tx_mode?: "custom" | "default" | null;
  status: "active" | "paused" | "completed" | "error";
  next_fire_at: string | null;
  last_fire_at: string | null;
  created_at: string;
  modified_at: string;
  created_by: string;
}

/**
 * @deprecated `listCodexCronotons` now returns full {@link CodexCronotonRow}s
 * (snake_case, `SELECT *`) so the list projection matches the read-handler's
 * declared `CodexCronotonRow[]` response and the fields `CronotonList` actually
 * renders (`pact_code`, `schedule_config_json`, `description`, `server_resolver`,
 * …). This 9-field camelCase projection was the source of the CronotonList crash
 * (0.6.0 and earlier); kept as an alias only so any external importer still
 * resolves. Prefer {@link CodexCronotonRow}.
 */
export type CodexCronotonListItem = CodexCronotonRow;

/**
 * Launch-state provenance of a fire — 'test' pre-lock, 'live' once the
 * consumer's live state is locked.
 */
export type CodexFireMode = "test" | "live";

/**
 * One on-chain transaction recorded under a single fire. A multi-tx fire (e.g.
 * a pool payout) spans many: cross-chain burns + SPV continuations + the bulk
 * transfer. The worker appends one of these as each tx lands; the fire history
 * surfaces a count badge that expands to a per-tx explorer link.
 */
export interface FireTxKey {
  /** 'burn' (source→0 initiate) | 'continuation' (SPV step on 0) | 'bulk' (payout transfer). */
  kind: "burn" | "continuation" | "bulk";
  /** Source chain for burn/continuation; '0' for the bulk transfer. */
  chainId: string;
  requestKey: string;
  /** Whether the tx confirmed ok (best-effort; absent = unknown/in-flight). */
  ok?: boolean;
}

/** The client-facing projection of a `codex_cronoton_fires` row. */
export interface CodexCronotonFireRow {
  id: string;
  firedAt: string;
  status: "success" | "failure" | "running" | "nothing";
  requestKey: string | null;
  chainId: string | null;
  errorMessage: string | null;
  chainResponse: unknown;
  definitionFingerprint: string | null;
  mode: CodexFireMode;
  /** Timestamp a failed fire was reconciled to success via `recoverFire`; null for natively-successful or never-recovered fires. */
  recoveredAt: string | null;
  /** Per-tx request keys for a multi-tx fire (empty for ordinary single-tx fires). */
  txKeys: FireTxKey[];
}

/** Raw `codex_cronoton_manual_batches` row. */
export interface CodexManualBatchRow {
  id: string;
  codex_cronoton_id: string;
  total: number;
  completed: number;
  interval_seconds: number;
  status: "active" | "completed" | "cancelled";
  next_at: string | null;
  created_at: string;
  modified_at: string;
  created_by: string;
}

/** Client-facing projection of a batch (progress + schedule). */
export interface ManualBatchView {
  id: string;
  codexCronotonId: string;
  total: number;
  completed: number;
  remaining: number;
  intervalSeconds: number;
  status: "active" | "completed" | "cancelled";
  nextAt: string | null;
  createdBy: string;
  createdAt: string;
}
