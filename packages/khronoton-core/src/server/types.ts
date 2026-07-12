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

/** Run mode: `simulate` signs + dirty-reads but never submits; `fire` submits. */
export type ExecutorMode = "simulate" | "fire";

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
  /** Gas price in ANU (converted to STOA via `anuToStoa` at build time). */
  readonly gasPrice: number;
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
}

export type ExecutorResult = SimulateResult | FireResult;

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
  status: "active" | "paused" | "completed" | "error";
  next_fire_at: string | null;
  last_fire_at: string | null;
  created_at: string;
  modified_at: string;
  created_by: string;
}

/** The list/limbo projection the route attaches `scheduleSummary` to. */
export interface CodexCronotonListItem {
  id: string;
  name: string;
  scheduleMode: ScheduleMode;
  status: CodexCronotonRow["status"];
  nextFireAt: string | null;
  lastFireAt: string | null;
  createdAt: string;
  modifiedAt: string;
  createdBy: string;
}

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
