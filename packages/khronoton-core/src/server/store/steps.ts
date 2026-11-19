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
 */
import crypto from "node:crypto";

import type { DbDep } from "../seams.js";
import { isUniqueConstraintError, StepAlreadyExistsError } from "./errors.js";

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
    dep.db
      .prepare(
        `INSERT INTO codex_cronoton_steps
           (id, codex_cronoton_id, step_index, mode, pact_code, config_json,
            payload_json, gas_payer_json, signers_json, planner_name,
            planner_params_json, idempotent, created_at, modified_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
