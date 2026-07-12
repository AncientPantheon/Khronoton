/**
 * Fire history writes/reads for a codex cronoton.
 *
 * Each fire row records ONE dispatch of a cronoton's transaction(s): a
 * single-tx `recordFire`, or a `running` row (`createRunningFire`) that a
 * background worker later grows with per-tx keys (`appendFireTxKeys`) and flips
 * terminal (`finalizeFire`). `listFires` paginates the history newest-first and
 * `recoverFire` reconciles a stale `failure` to its true on-chain `success`.
 *
 * Fire-mode seam (map §8 divergence #1): each fire is badged `test`/`live` at
 * write time. The parent's `fire_mode_override = 'live'` column is the FIRST
 * gate (an operator declaring its transactions real); anything else defers to
 * the injected {@link ResolveFireMode}. The Hub's global
 * `system_state.scoring_live_locked` read is GONE — that signal now lives behind
 * the seam. `ResolveFireMode` is synchronous BY TYPE (better-sqlite3 is a sync
 * driver, so its result binds directly into the INSERT); a consumer needing
 * async fire-mode resolution pre-resolves before invoking the tick.
 */
import { randomUUID } from "node:crypto";

import type {
  CodexCronotonFireRow,
  CodexFireMode,
  FireTxKey,
} from "../types.js";
import {
  type Database,
  type DbDep,
  type ResolveFireMode,
  defaultResolveFireMode,
} from "../seams.js";

/**
 * Carries the injected DB handle plus the optional {@link ResolveFireMode} seam
 * into the fire writes. The tick (Phase 4) threads its context through this
 * shape; an omitted `resolveFireMode` defaults to `() => 'live'` (the REQ-05
 * default — NOT the Hub's implicit `'test'`).
 */
export interface FireDep extends DbDep {
  resolveFireMode?: ResolveFireMode;
}

/** Input to {@link recordFire}. Declared here (the Hub's fires block owns it), not in `../types.js`. */
export interface RecordFireInput {
  codexCronotonId: string;
  jobId: string | null;
  firedAt: string;
  status: "success" | "failure" | "running" | "nothing";
  requestKey?: string;
  chainId?: string;
  errorMessage?: string;
  chainResponse?: unknown;
  definitionFingerprint: string;
  /** Per-tx request keys for a multi-tx fire. */
  txKeys?: FireTxKey[];
}

/**
 * Resolve a fire's mode badge. The parent's `fire_mode_override = 'live'` wins
 * FIRST (the single write site enforcing the `test | live` domain); any other
 * override value defers to the injected, synchronous {@link ResolveFireMode}.
 */
function readFireMode(
  db: Database,
  codexCronotonId: string,
  resolveFireMode: ResolveFireMode,
): CodexFireMode {
  const parent = db
    .prepare(`SELECT fire_mode_override FROM codex_cronotons WHERE id = ?`)
    .get(codexCronotonId) as { fire_mode_override: string | null } | undefined;
  if (parent?.fire_mode_override === "live") return "live";
  return resolveFireMode(codexCronotonId);
}

/** Insert exactly ONE fire row + bump the parent's last_fire_at. */
export function recordFire(input: RecordFireInput, dep: FireDep): string {
  const db = dep.db;
  const fireId = randomUUID();
  const mode = readFireMode(db, input.codexCronotonId, dep.resolveFireMode ?? defaultResolveFireMode);
  db.prepare(
    `INSERT INTO codex_cronoton_fires
       (id, codex_cronoton_id, job_id, fired_at, status, request_key, chain_id,
        error_message, chain_response_json, definition_fingerprint, mode, tx_keys_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fireId,
    input.codexCronotonId,
    input.jobId,
    input.firedAt,
    input.status,
    input.requestKey ?? null,
    input.chainId ?? null,
    input.errorMessage ?? null,
    input.chainResponse !== undefined ? JSON.stringify(input.chainResponse) : null,
    input.definitionFingerprint,
    mode,
    input.txKeys && input.txKeys.length ? JSON.stringify(input.txKeys) : null,
  );
  db.prepare(`UPDATE codex_cronotons SET last_fire_at = ? WHERE id = ?`).run(
    input.firedAt,
    input.codexCronotonId,
  );
  return fireId;
}

/**
 * Open a fire row in the non-terminal `running` state the MOMENT a multi-tx
 * (background-job) fire is dispatched, so the operator sees the entry at once.
 * The worker later appends per-tx keys via {@link appendFireTxKeys} and flips it
 * terminal via {@link finalizeFire}. Mirrors `recordFire`'s last_fire_at bump.
 */
export function createRunningFire(
  input: {
    codexCronotonId: string;
    jobId: string | null;
    firedAt: string;
    definitionFingerprint: string;
  },
  dep: FireDep,
): string {
  const db = dep.db;
  const fireId = randomUUID();
  const mode = readFireMode(db, input.codexCronotonId, dep.resolveFireMode ?? defaultResolveFireMode);
  db.prepare(
    `INSERT INTO codex_cronoton_fires
       (id, codex_cronoton_id, job_id, fired_at, status, definition_fingerprint, mode, tx_keys_json)
       VALUES (?, ?, ?, ?, 'running', ?, ?, '[]')`,
  ).run(fireId, input.codexCronotonId, input.jobId, input.firedAt, input.definitionFingerprint, mode);
  db.prepare(`UPDATE codex_cronotons SET last_fire_at = ? WHERE id = ?`).run(
    input.firedAt,
    input.codexCronotonId,
  );
  return fireId;
}

/** Link a fire row to the background job that executes it (best-effort). */
export function setFireJobId(fireId: string, jobId: string, dep: DbDep): void {
  dep.db
    .prepare(`UPDATE codex_cronoton_fires SET job_id = ? WHERE id = ?`)
    .run(jobId, fireId);
}

/**
 * Append one or more per-tx keys to a fire's `tx_keys_json` (read-modify-write,
 * de-duplicated by requestKey so a resumed/retried leg never double-lists). Safe
 * to call repeatedly during a multi-minute run; the fire history reads the
 * growing array on each refresh. A missing fire is a no-op (never throws).
 */
export function appendFireTxKeys(fireId: string, txKeys: FireTxKey[], dep: DbDep): void {
  if (!txKeys.length) return;
  const db = dep.db;
  const row = db
    .prepare(`SELECT tx_keys_json FROM codex_cronoton_fires WHERE id = ?`)
    .get(fireId) as { tx_keys_json: string | null } | undefined;
  if (!row) return;
  let existing: FireTxKey[] = [];
  try {
    existing = row.tx_keys_json ? (JSON.parse(row.tx_keys_json) as FireTxKey[]) : [];
  } catch {
    existing = [];
  }
  const byKey = new Map(existing.map((t) => [t.requestKey, t]));
  for (const t of txKeys) byKey.set(t.requestKey, t); // upsert: latest ok/state wins
  db.prepare(`UPDATE codex_cronoton_fires SET tx_keys_json = ? WHERE id = ?`).run(
    JSON.stringify([...byKey.values()]),
    fireId,
  );
}

/**
 * Flip a `running` fire to its terminal outcome. Sets status + the headline
 * request key + error + structured chain response, and merges any final tx keys.
 */
export function finalizeFire(
  fireId: string,
  result: {
    status: "success" | "failure" | "nothing";
    requestKey?: string | null;
    chainId?: string | null;
    errorMessage?: string | null;
    chainResponse?: unknown;
    txKeys?: FireTxKey[];
  },
  dep: DbDep,
): void {
  const db = dep.db;
  if (result.txKeys && result.txKeys.length) appendFireTxKeys(fireId, result.txKeys, dep);
  db.prepare(
    `UPDATE codex_cronoton_fires
        SET status = ?, request_key = ?, chain_id = ?, error_message = ?,
            chain_response_json = ?
      WHERE id = ?`,
  ).run(
    result.status,
    result.requestKey ?? null,
    result.chainId ?? null,
    result.errorMessage ?? null,
    result.chainResponse !== undefined ? JSON.stringify(result.chainResponse) : null,
    fireId,
  );
}

/** Parse the stored tx_keys_json into a typed array; tolerate null/garbage. */
function parseTxKeys(json: string | null): FireTxKey[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as FireTxKey[]) : [];
  } catch {
    return [];
  }
}

/** Paginated fire history for a cronoton, newest-first (limit clamped 1..100, default 20). */
export function listFires(
  id: string,
  params: { limit?: number; offset?: number } = {},
  dep: DbDep,
): { fires: CodexCronotonFireRow[]; total: number } {
  const db = dep.db;
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);
  const rows = db
    .prepare(
      `SELECT id, fired_at, status, request_key, chain_id, error_message,
              chain_response_json, definition_fingerprint, mode, recovered_at, tx_keys_json
         FROM codex_cronoton_fires
        WHERE codex_cronoton_id = ?
        ORDER BY fired_at DESC LIMIT ? OFFSET ?`,
    )
    .all(id, limit, offset) as Array<{
    id: string;
    fired_at: string;
    status: "success" | "failure" | "running" | "nothing";
    request_key: string | null;
    chain_id: string | null;
    error_message: string | null;
    chain_response_json: string | null;
    definition_fingerprint: string | null;
    mode: string | null;
    recovered_at: string | null;
    tx_keys_json: string | null;
  }>;
  const totalRow = db
    .prepare("SELECT COUNT(*) AS c FROM codex_cronoton_fires WHERE codex_cronoton_id = ?")
    .get(id) as { c: number } | undefined;

  return {
    fires: rows.map((r) => ({
      id: r.id,
      firedAt: r.fired_at,
      status: r.status,
      requestKey: r.request_key,
      chainId: r.chain_id,
      errorMessage: r.error_message,
      chainResponse: r.chain_response_json ? JSON.parse(r.chain_response_json) : null,
      definitionFingerprint: r.definition_fingerprint,
      mode: r.mode === "live" ? "live" : "test",
      recoveredAt: r.recovered_at,
      txKeys: parseTxKeys(r.tx_keys_json),
    })),
    total: totalRow?.c ?? 0,
  };
}

/**
 * Manual recovery: reconcile a FAILED fire to its true on-chain outcome by
 * attaching the confirmed request key. Flips status failure→success, stamps
 * `recovered_at`, and clears the stale transport error (e.g. an nginx 504 that
 * hid a successful submit). Returns true if a failed row was updated, false if
 * the fire wasn't found OR wasn't in `failure` (idempotent — a second call is a
 * no-op).
 */
export function recoverFire(fireId: string, requestKey: string, dep: DbDep): boolean {
  const res = dep.db
    .prepare(
      `UPDATE codex_cronoton_fires
          SET status = 'success',
              request_key = ?,
              recovered_at = ?,
              error_message = NULL
        WHERE id = ? AND status = 'failure'`,
    )
    .run(requestKey, new Date().toISOString(), fireId);
  return res.changes > 0;
}
