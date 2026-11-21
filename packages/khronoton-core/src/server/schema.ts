/**
 * The consolidated DDL installer for the seven codex-cronoton tables: the
 * original three (`codex_cronotons`, `codex_cronoton_fires`,
 * `codex_cronoton_manual_batches`) plus the chained-runs tables
 * (`codex_cronoton_steps`, `codex_cronoton_runs`, `codex_cronoton_run_legs`)
 * plus the step-to-step yield carry table (`codex_cronoton_run_yields`).
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

CREATE TABLE IF NOT EXISTS codex_cronoton_steps (
  id                  TEXT PRIMARY KEY,
  codex_cronoton_id   TEXT NOT NULL REFERENCES codex_cronotons(id) ON DELETE CASCADE,
  step_index          INTEGER NOT NULL,
  mode                TEXT NOT NULL CHECK (mode IN ('single', 'planner')),
  pact_code           TEXT,
  config_json         TEXT,
  payload_json        TEXT,
  gas_payer_json      TEXT,
  signers_json        TEXT,
  planner_name        TEXT,
  planner_params_json TEXT,
  idempotent          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  modified_at         TEXT NOT NULL,
  CHECK (
    (mode = 'single' AND pact_code IS NOT NULL) OR
    (mode = 'planner' AND planner_name IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_cronoton_steps_order
  ON codex_cronoton_steps(codex_cronoton_id, step_index);

CREATE TABLE IF NOT EXISTS codex_cronoton_runs (
  id                TEXT PRIMARY KEY,
  codex_cronoton_id TEXT NOT NULL REFERENCES codex_cronotons(id) ON DELETE CASCADE,
  fire_id           TEXT REFERENCES codex_cronoton_fires(id),
  status            TEXT NOT NULL DEFAULT 'planning' CHECK (status IN (
    'planning', 'awaiting', 'advancing', 'succeeded', 'failed', 'abandoned'
  )),
  step_index        INTEGER NOT NULL DEFAULT 0,
  step_count        INTEGER NOT NULL,
  started_at        TEXT NOT NULL,
  modified_at       TEXT NOT NULL,
  deadline_at       TEXT,
  attempt           INTEGER NOT NULL DEFAULT 0,
  context_json      TEXT
);
CREATE INDEX IF NOT EXISTS idx_codex_cronoton_runs_due
  ON codex_cronoton_runs(status, modified_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_cronoton_runs_self_block
  ON codex_cronoton_runs(codex_cronoton_id)
  WHERE status IN ('planning', 'awaiting', 'advancing');

CREATE TABLE IF NOT EXISTS codex_cronoton_run_legs (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES codex_cronoton_runs(id) ON DELETE CASCADE,
  step_index      INTEGER NOT NULL,
  leg_index       INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'submitted', 'confirmed', 'failed'
  )),
  request_key     TEXT,
  chain_id        TEXT,
  definition_json TEXT NOT NULL,
  error_message   TEXT,
  submitted_at    TEXT,
  confirmed_at    TEXT,
  attempt         INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_cronoton_run_legs_slot
  ON codex_cronoton_run_legs(run_id, step_index, leg_index);
CREATE INDEX IF NOT EXISTS idx_codex_cronoton_run_legs_barrier
  ON codex_cronoton_run_legs(run_id, step_index, status);

CREATE TABLE IF NOT EXISTS codex_cronoton_run_yields (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES codex_cronoton_runs(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  value_json TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_cronoton_run_yields_name
  ON codex_cronoton_run_yields(run_id, name);
`;

/**
 * Idempotently ensures `column` exists on `table`, adding it via `ALTER TABLE
 * ... ADD COLUMN` when absent. SQLite (3.53.2, bundled via better-sqlite3)
 * does not support `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (syntax error),
 * so the check-then-add via `PRAGMA table_info` is the idiomatic idempotent
 * pattern — this is the single mechanism both a fresh install (the column is
 * absent from the `CREATE TABLE` literal, so this always adds it) and an
 * already-provisioned database (a second call is a no-op) go through.
 *
 * @param db - Any handle satisfying the {@link Database} seam.
 * @param table - The table to inspect/alter.
 * @param column - The column name to ensure exists.
 * @param columnDefSql - The column's type/constraint SQL (e.g. `"TEXT"`),
 *   appended verbatim after the column name in the `ADD COLUMN` clause.
 */
function ensureColumn(db: Database, table: string, column: string, columnDefSql: string): void {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const hasColumn = existing.some((c) => c.name === column);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDefSql}`);
  }
}

/**
 * Installs the seven codex-cronoton tables and their indexes on the injected DB
 * handle in a single idempotent call. Safe to re-run: every statement is guarded
 * with `IF NOT EXISTS`.
 *
 * After the base DDL, ensures the `public_token`/`public_observable` columns
 * on `codex_cronotons` via {@link ensureColumn} — this covers both a fresh
 * install (absent from the `CREATE TABLE` literal) and an existing database
 * that predates these columns, through the one code path. `public_token`
 * then gets a unique index; SQLite's unique index already permits multiple
 * `NULL`s, so non-observable rows with no token never collide.
 *
 * @param db - Any handle satisfying the {@link Database} seam (a real
 *   `better-sqlite3` instance qualifies). Only `db.exec` is used.
 */
export function installSchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  ensureColumn(db, "codex_cronotons", "public_token", "TEXT");
  ensureColumn(db, "codex_cronotons", "public_observable", "INTEGER NOT NULL DEFAULT 0");
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_cronotons_public_token ON codex_cronotons(public_token)`,
  );
  // Phase 5 fix: a real claim-before-submit marker for `codex_cronoton_run_legs`,
  // closing the concurrency gap `runs-driver.ts`'s `handleSubmitLeg` doc
  // previously deferred ("adding one changes the leg status enum, which is
  // schema scope beyond this phase") — additive via `ensureColumn`, NOT a new
  // status enum value, so the existing CHECK constraint is untouched. See
  // `store/runs.ts`'s `claimLegForSubmit`/`releaseLegClaim`.
  ensureColumn(db, "codex_cronoton_run_legs", "claimed_at", "TEXT");
  // Step-to-step yield carry: the NAME a step's confirmed on-chain return
  // value (mode:'single') or planner-returned yield (mode:'planner') gets
  // stored under in `codex_cronoton_run_yields`. Additive via `ensureColumn`,
  // covering both a fresh install and an already-provisioned database.
  ensureColumn(db, "codex_cronoton_steps", "yield_as", "TEXT");
  // Opt-in single-tx-first chain variant (docs/work/khronoton-single-tx-custom):
  // `try_single_tx_first` gates the simulate-then-decide orchestration ahead of
  // the chained-run machinery; `single_tx_mode` (meaningful only when the flag
  // is on) selects how the single-tx Pact code was produced. The CHECK is
  // vacuously satisfied by NULL (mirrors `codex_cronoton_steps.yield_as`'s own
  // nullable-no-CHECK precedent, just with a value whitelist added), so a row
  // can leave `single_tx_mode` unset without an explicit `OR ... IS NULL` clause.
  ensureColumn(db, "codex_cronotons", "try_single_tx_first", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(
    db,
    "codex_cronotons",
    "single_tx_mode",
    "TEXT CHECK (single_tx_mode IN ('custom', 'default'))",
  );
}
