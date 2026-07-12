/**
 * The consolidated DDL installer for the three codex-cronoton tables.
 *
 * This folds the Hub's incremental migration chain (base tables + a dozen later
 * ALTERs) into the FINAL column shapes, emitted in a single idempotent call.
 * Every statement uses `IF NOT EXISTS`, so re-running the installer on an
 * already-provisioned database is a no-op.
 *
 * Genericization deltas from the Hub schema (this package carries no host FKs
 * and owns no status domain):
 *   - `codex_cronoton_fires.job_id` is a plain nullable `TEXT` column — the Hub's
 *     `REFERENCES jobs(id)` FK is dropped, since a generic host has no `jobs`
 *     table.
 *   - `codex_cronoton_fires.status` has NO CHECK constraint — the application is
 *     the single writer and owns the value domain (success/failure/running/
 *     nothing/…), so widening a CHECK per new outcome is avoided.
 *
 * The installer is driver-free: it only calls `db.exec(...)` on the injected
 * {@link Database} handle, so it never imports `better-sqlite3` at runtime and
 * works against any backend that structurally satisfies the seam.
 */
import type { Database } from "./seams.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_cronotons (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  description          TEXT,
  pact_code            TEXT NOT NULL,
  config_json          TEXT NOT NULL,
  payload_json         TEXT,
  gas_payer_json       TEXT NOT NULL,
  signers_json         TEXT NOT NULL,
  schedule_mode        TEXT NOT NULL CHECK (schedule_mode IN (
    'daily-at-utc',
    'every-n-minutes',
    'weekly',
    'monthly',
    'cron-expression',
    'one-time',
    'several-times-per-day'
  )),
  schedule_config_json TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active',
    'paused',
    'completed',
    'error'
  )),
  next_fire_at         TEXT,
  last_fire_at         TEXT,
  created_at           TEXT NOT NULL,
  modified_at          TEXT NOT NULL,
  created_by           TEXT NOT NULL,
  server_resolver      TEXT,
  fire_mode_override   TEXT,
  external_fireable    INTEGER NOT NULL DEFAULT 0,
  runtime_arg_keys     TEXT
);

CREATE INDEX IF NOT EXISTS idx_codex_cronotons_next_fire
  ON codex_cronotons(status, next_fire_at);

CREATE TABLE IF NOT EXISTS codex_cronoton_fires (
  id                     TEXT PRIMARY KEY,
  codex_cronoton_id      TEXT NOT NULL REFERENCES codex_cronotons(id) ON DELETE CASCADE,
  job_id                 TEXT,
  fired_at               TEXT NOT NULL,
  status                 TEXT NOT NULL,
  request_key            TEXT,
  chain_id               TEXT,
  error_message          TEXT,
  chain_response_json    TEXT,
  definition_fingerprint TEXT,
  mode                   TEXT NOT NULL DEFAULT 'test',
  recovered_at           TEXT,
  tx_keys_json           TEXT
);

CREATE INDEX IF NOT EXISTS idx_codex_fires_cronoton
  ON codex_cronoton_fires(codex_cronoton_id, fired_at DESC);

CREATE TABLE IF NOT EXISTS codex_cronoton_manual_batches (
  id                TEXT PRIMARY KEY,
  codex_cronoton_id TEXT NOT NULL REFERENCES codex_cronotons(id) ON DELETE CASCADE,
  total             INTEGER NOT NULL,
  completed         INTEGER NOT NULL DEFAULT 0,
  interval_seconds  INTEGER NOT NULL DEFAULT 60,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active',
    'completed',
    'cancelled'
  )),
  next_at           TEXT,
  created_at        TEXT NOT NULL,
  modified_at       TEXT NOT NULL,
  created_by        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_codex_manual_batches_due
  ON codex_cronoton_manual_batches(status, next_at);

CREATE INDEX IF NOT EXISTS idx_codex_manual_batches_cronoton
  ON codex_cronoton_manual_batches(codex_cronoton_id);
`;

/**
 * Installs the three codex-cronoton tables and their indexes on the injected DB
 * handle in a single idempotent call. Safe to re-run: every statement is guarded
 * with `IF NOT EXISTS`.
 *
 * @param db - Any handle satisfying the {@link Database} seam (a real
 *   `better-sqlite3` instance qualifies). Only `db.exec` is used.
 */
export function installSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
}
