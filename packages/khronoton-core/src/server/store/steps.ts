/**
 * steps — the decision-free CRUD layer for `codex_cronoton_steps`, the STATIC
 * step definitions of a chained cronoton (design.md's Phase 1): step 0 might be
 * a plain pact-code transaction (`mode: 'single'`), step 1 a registered planner
 * that builds N legs at run time (`mode: 'planner'`, the planner registry
 * itself a LATER phase, out of scope here).
 *
 * Purely mechanical, mirroring `./fires.ts`'s own level of ambition: no
 * validation of step sequencing, no planner-registry lookup, no "is this the
 * right next step" decision logic — that's explicitly Phase 2's job
 * (`pure/run-advance.ts`), not this layer's.
 *
 * `yieldAs`/`yield_as` (step-to-step yield carry, per
 * `docs/work/khronoton-step-yield-carry/design.md`) applies uniformly to
 * BOTH step modes: for `mode:'single'` it names what to store the confirmed
 * leg's on-chain return value as; for `mode:'planner'` it names what to
 * store the planner's returned yield value as. The step row itself owns the
 * yield's NAME either way — never the planner, never hard-coded elsewhere.
 */
import crypto from "node:crypto";

import type { Database, DbDep, Statement } from "../seams.js";
import { isUniqueConstraintError, StepAlreadyExistsError } from "./errors.js";

const INSERT_STEP_SQL = `INSERT INTO codex_cronoton_steps
           (id, codex_cronoton_id, step_index, mode, pact_code, config_json,
            payload_json, gas_payer_json, signers_json, planner_name,
            planner_params_json, idempotent, created_at, modified_at, yield_as)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * `insertStep`'s prepared INSERT statement, cached per `db` instance so a
 * chained-cronoton commit (`chain.ts`'s `commitChainedCronoton`, looping
 * `insertStep` once per step) doesn't re-parse the identical SQL on every
 * call — better-sqlite3 has no implicit statement cache of its own. Keyed by
 * the `Database` instance (not a bare module-level statement) since
 * different callers — e.g. tests vs. production — pass different instances.
 */
const insertStepStatements = new WeakMap<Database, Statement>();

function getInsertStepStatement(db: Database): Statement {
  let statement = insertStepStatements.get(db);
  if (!statement) {
    statement = db.prepare(INSERT_STEP_SQL);
    insertStepStatements.set(db, statement);
  }
  return statement;
}

export interface InsertStepInput {
  codexCronotonId: string;
  stepIndex: number;
  mode: "single" | "planner";
  pactCode?: string;
  config?: unknown;
  payload?: unknown;
  gasPayer?: unknown;
  signers?: unknown;
  plannerName?: string;
  plannerParams?: unknown;
  idempotent?: boolean;
  yieldAs?: string;
}

export interface CodexCronotonStepRow {
  id: string;
  codex_cronoton_id: string;
  step_index: number;
  mode: "single" | "planner";
  pact_code: string | null;
  config_json: string | null;
  payload_json: string | null;
  gas_payer_json: string | null;
  signers_json: string | null;
  planner_name: string | null;
  planner_params_json: string | null;
  idempotent: number;
  created_at: string;
  modified_at: string;
  yield_as: string | null;
}

/**
 * Insert one step row. Returns the new row's id.
 *
 * Lets the unique index on `(codex_cronoton_id, step_index)` (`schema.ts`)
 * be the actual enforcement, mirroring `runs.ts`'s `createRun`: a duplicate
 * step index for the same cronoton throws a UNIQUE-constraint `SqliteError`,
 * caught here and re-thrown as the typed {@link StepAlreadyExistsError} —
 * never a raw driver error escaping the store layer.
 */
export function insertStep(input: InsertStepInput, dep: DbDep): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    getInsertStepStatement(dep.db).run(
      id,
      input.codexCronotonId,
      input.stepIndex,
      input.mode,
      input.pactCode ?? null,
      input.config !== undefined ? JSON.stringify(input.config) : null,
      input.payload !== undefined ? JSON.stringify(input.payload) : null,
      input.gasPayer !== undefined ? JSON.stringify(input.gasPayer) : null,
      input.signers !== undefined ? JSON.stringify(input.signers) : null,
      input.plannerName ?? null,
      input.plannerParams !== undefined ? JSON.stringify(input.plannerParams) : null,
      input.idempotent ? 1 : 0,
      now,
      now,
      input.yieldAs ?? null,
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new StepAlreadyExistsError(input.codexCronotonId, input.stepIndex);
    }
    throw error;
  }
  return id;
}

/** Full raw snake_case rows for a cronoton's steps, ordered by step_index ASC. */
export function listStepsForCronoton(
  codexCronotonId: string,
  dep: DbDep,
): CodexCronotonStepRow[] {
  return dep.db
    .prepare(
      `SELECT * FROM codex_cronoton_steps
        WHERE codex_cronoton_id = ?
        ORDER BY step_index ASC`,
    )
    .all(codexCronotonId) as CodexCronotonStepRow[];
}

/**
 * One step row at a specific `(codexCronotonId, stepIndex)` slot, or `null`.
 * A direct point lookup hitting `idx_codex_cronoton_steps_order` (the
 * existing unique index on exactly this pair, `schema.ts`), instead of a
 * caller fetching every step for the cronoton via {@link listStepsForCronoton}
 * and filtering client-side for one row — a confirmed LOW performance
 * finding from `handlers/steps.ts`'s standalone fire/simulate route, which
 * only ever needs one step per request.
 */
export function getStepByIndex(
  codexCronotonId: string,
  stepIndex: number,
  dep: DbDep,
): CodexCronotonStepRow | null {
  const row = dep.db
    .prepare(
      `SELECT * FROM codex_cronoton_steps
        WHERE codex_cronoton_id = ? AND step_index = ?`,
    )
    .get(codexCronotonId, stepIndex) as CodexCronotonStepRow | undefined;
  return row ?? null;
}
