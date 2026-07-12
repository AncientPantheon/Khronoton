/**
 * cronoton — the commit/read/find/list/edit/pause/resume/delete lifecycle for
 * `codex_cronotons`.
 *
 * This is the plain (non-claim) CRUD half of the store: it validates and writes
 * a definition, projects rows for the list view, applies at-next-fire edits, and
 * moves a row through the pause/resume/delete transitions. The atomic
 * claim-before-fire lives in `./claim.js`.
 *
 * Schedule math is imported, never reimplemented (REQ-16): {@link computeNextFire}
 * runs at commit/edit/resume time through {@link computeNextOrReject}, which maps
 * an {@link InvalidScheduleConfigError} to a typed {@link CodexCronotonValidationError}
 * and treats a null next-fire as a "no future fires" reject. A TRIGGER-ONLY row
 * (externally fireable OR declaring runtime args) carries NO schedule at all — its
 * `next_fire_at` stays NULL and the schedule engine is never consulted for it.
 */
import crypto from "node:crypto";

import {
  computeNextFire,
  InvalidScheduleConfigError,
  type ScheduleConfig,
  type ScheduleMode,
} from "../../schedule.js";
import { runtimeArgKeysCollide } from "../pure/runtime-args.js";
import type { DbDep } from "../seams.js";
import type {
  CodexCronotonListItem,
  CodexCronotonRow,
  CodexTxConfig,
  CodexTxDefinition,
} from "../types.js";
import { CodexCronotonValidationError, TerminalCronotonError } from "./errors.js";
import {
  assertAutoGasGate,
  rowExternalFireable,
  rowRuntimeArgKeys,
} from "./mappers.js";

// ── Commit / read / list / edit ──────────────────────────────────────────────

export interface CommitCodexCronotonInput {
  name: string;
  description: string | null;
  pactCode: string;
  config: CodexTxConfig;
  payload: Record<string, unknown>;
  gasPayer: CodexTxDefinition["gasPayer"];
  signers: CodexTxDefinition["signers"];
  scheduleMode: ScheduleMode;
  scheduleConfig: ScheduleConfig;
  createdBy: string;
  /** Optional fire-time server payload resolver name (e.g. 'stoicism-mint'). */
  serverResolver?: string;
  /** When true, the row may be fired by the external HMAC endpoint (default false). */
  externalFireable?: boolean;
  /** env-data keys supplied by a trigger at fire time (default none). Must be
   *  DISJOINT from the fixed payload keys — a runtime arg must never override a keyset. */
  runtimeArgKeys?: string[];
}

interface CommitOpts extends DbDep {
  now?: Date;
}

/** Compute the first next-fire, mapping engine errors to a typed reject. */
function computeNextOrReject(
  mode: ScheduleMode,
  config: ScheduleConfig,
  now: Date,
): Date {
  let next: Date | null;
  try {
    next = computeNextFire(mode, config, now);
  } catch (err) {
    if (err instanceof InvalidScheduleConfigError) {
      throw new CodexCronotonValidationError(err.message);
    }
    throw err;
  }
  if (!next) {
    throw new CodexCronotonValidationError("schedule has no future fires");
  }
  return next;
}

export function commitCodexCronoton(
  input: CommitCodexCronotonInput,
  opts: CommitOpts,
): { id: string; nextFireAt: string | null } {
  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw new CodexCronotonValidationError("name must be a non-empty string");
  }
  if (typeof input.pactCode !== "string") {
    throw new CodexCronotonValidationError("pactCode must be a string");
  }
  if (!input.config || typeof input.config.chainId !== "string") {
    throw new CodexCronotonValidationError("config.chainId must be a string");
  }
  if (!Array.isArray(input.signers)) {
    throw new CodexCronotonValidationError("signers must be an array");
  }
  if (!input.gasPayer || typeof input.gasPayer.type !== "string") {
    throw new CodexCronotonValidationError("gasPayer.type must be a string");
  }

  assertAutoGasGate(input.config);

  // Runtime-arg keys must be DISJOINT from the fixed payload — a trigger-supplied
  // arg must never be able to clobber a fixed key (e.g. a keyset).
  const runtimeArgKeys = input.runtimeArgKeys ?? [];
  if (runtimeArgKeysCollide(input.payload ?? {}, runtimeArgKeys)) {
    throw new CodexCronotonValidationError(
      "runtimeArgKeys must be disjoint from payload keys",
    );
  }
  // Runtime-arg + server-resolver are mutually exclusive: both inject payload at
  // fire time, so a server-resolver row can never also carry runtime args.
  if (input.serverResolver && runtimeArgKeys.length > 0) {
    throw new CodexCronotonValidationError(
      "server-resolver rows cannot declare runtime args",
    );
  }

  const now = opts.now ?? new Date();
  // A TRIGGER-ONLY cronoton (externally fireable OR declaring runtime args) fires
  // on demand — never on a timer — so it carries NO schedule: skip the next-fire
  // computation and store next_fire_at = NULL. The scheduler's
  // `next_fire_at IS NOT NULL` gate then skips it.
  const triggerOnly = input.externalFireable === true || runtimeArgKeys.length > 0;
  const nextFireAt = triggerOnly
    ? null
    : computeNextOrReject(input.scheduleMode, input.scheduleConfig, now).toISOString();

  const id = crypto.randomUUID();
  const nowIso = now.toISOString();
  opts.db
    .prepare(
      `INSERT INTO codex_cronotons
         (id, name, description, pact_code, config_json, payload_json,
          gas_payer_json, signers_json, schedule_mode, schedule_config_json,
          server_resolver, external_fireable, runtime_arg_keys, status,
          next_fire_at, last_fire_at, created_at, modified_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, ?)`,
    )
    .run(
      id,
      input.name.trim(),
      input.description,
      input.pactCode,
      JSON.stringify(input.config),
      input.payload ? JSON.stringify(input.payload) : null,
      JSON.stringify(input.gasPayer),
      JSON.stringify(input.signers),
      input.scheduleMode,
      JSON.stringify(input.scheduleConfig),
      input.serverResolver ?? null,
      input.externalFireable ? 1 : 0,
      runtimeArgKeys.length > 0 ? JSON.stringify(runtimeArgKeys) : null,
      nextFireAt,
      nowIso,
      nowIso,
      input.createdBy,
    );

  return { id, nextFireAt };
}

export function getCodexCronoton(id: string, dep: DbDep): CodexCronotonRow | null {
  const row = dep.db
    .prepare("SELECT * FROM codex_cronotons WHERE id = ?")
    .get(id) as CodexCronotonRow | undefined;
  return row ?? null;
}

/**
 * Find the id of the (single) cronoton bound to a given `server_resolver` name,
 * or null. A provisioner for a server-resolved cronoton uses this for its
 * idempotency key: a second provision finds the existing row instead of
 * inserting a duplicate. Returns the most-recently-created match if (unexpectedly)
 * more than one exists.
 */
export function findCodexCronotonIdByServerResolver(
  serverResolver: string,
  dep: DbDep,
): string | null {
  const row = dep.db
    .prepare(
      `SELECT id FROM codex_cronotons WHERE server_resolver = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(serverResolver) as { id: string } | undefined;
  return row?.id ?? null;
}

export function listCodexCronotons(
  params: { limit?: number; offset?: number; status?: CodexCronotonRow["status"] },
  dep: DbDep,
): CodexCronotonListItem[] {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);
  const db = dep.db;
  const rows = (
    params.status
      ? db
          .prepare(
            `SELECT id, name, schedule_mode, status, next_fire_at, last_fire_at,
                    created_at, modified_at, created_by
               FROM codex_cronotons WHERE status = ?
               ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          )
          .all(params.status, limit, offset)
      : db
          .prepare(
            `SELECT id, name, schedule_mode, status, next_fire_at, last_fire_at,
                    created_at, modified_at, created_by
               FROM codex_cronotons
               ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          )
          .all(limit, offset)
  ) as Array<{
    id: string;
    name: string;
    schedule_mode: ScheduleMode;
    status: CodexCronotonRow["status"];
    next_fire_at: string | null;
    last_fire_at: string | null;
    created_at: string;
    modified_at: string;
    created_by: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    scheduleMode: r.schedule_mode,
    status: r.status,
    nextFireAt: r.next_fire_at,
    lastFireAt: r.last_fire_at,
    createdAt: r.created_at,
    modifiedAt: r.modified_at,
    createdBy: r.created_by,
  }));
}

export interface EditCodexCronotonPatch {
  name?: string;
  description?: string | null;
  pactCode?: string;
  config?: CodexTxConfig;
  payload?: Record<string, unknown> | null;
  gasPayer?: CodexTxDefinition["gasPayer"];
  signers?: CodexTxDefinition["signers"];
  scheduleMode?: ScheduleMode;
  scheduleConfig?: ScheduleConfig;
  /** Set/clear the fire-time server resolver. `null` clears it. */
  serverResolver?: string | null;
}

/**
 * Apply-at-next-fire edit. Recomputes next_fire_at when the schedule changes,
 * re-gates AUTO-gas when config changes, and NEVER touches status (an edit
 * never pauses or resumes). Returns the changed-field list + the (possibly
 * recomputed) nextFireAt.
 */
export function editCodexCronoton(
  id: string,
  patch: EditCodexCronotonPatch,
  opts: CommitOpts,
): { changedFields: string[]; nextFireAt: string | null } {
  const db = opts.db;
  const row = getCodexCronoton(id, { db });
  if (!row) throw new CodexCronotonValidationError("not found");

  const changedFields: string[] = [];
  let nextName = row.name;
  let nextDescription = row.description;
  let nextPactCode = row.pact_code;
  let nextConfigJson = row.config_json;
  let nextPayloadJson = row.payload_json;
  let nextGasPayerJson = row.gas_payer_json;
  let nextSignersJson = row.signers_json;
  let nextScheduleMode = row.schedule_mode;
  let nextScheduleConfigJson = row.schedule_config_json;
  let nextServerResolver = row.server_resolver;
  let nextFireAt = row.next_fire_at;

  if (
    typeof patch.name === "string" &&
    patch.name.trim() !== "" &&
    patch.name.trim() !== row.name
  ) {
    nextName = patch.name.trim();
    changedFields.push("name");
  }
  if (patch.description !== undefined && patch.description !== row.description) {
    nextDescription = patch.description;
    changedFields.push("description");
  }
  if (typeof patch.pactCode === "string" && patch.pactCode !== row.pact_code) {
    nextPactCode = patch.pactCode;
    changedFields.push("pactCode");
  }
  if (patch.config) {
    assertAutoGasGate(patch.config);
    nextConfigJson = JSON.stringify(patch.config);
    changedFields.push("config");
  }
  if (patch.payload !== undefined) {
    // Re-assert the runtime-arg disjointness invariant at EDIT time (mirrors
    // commit). runtime_arg_keys is immutable via edit, but payload is mutable —
    // without this, a payload key equal to a declared runtime-arg key could slip
    // in and make every fire throw at applyRuntimeArgs.
    if (runtimeArgKeysCollide(patch.payload ?? {}, rowRuntimeArgKeys(row))) {
      throw new CodexCronotonValidationError(
        "payload keys must be disjoint from runtimeArgKeys",
      );
    }
    nextPayloadJson = patch.payload ? JSON.stringify(patch.payload) : null;
    changedFields.push("payload");
  }
  if (patch.gasPayer) {
    nextGasPayerJson = JSON.stringify(patch.gasPayer);
    changedFields.push("gasPayer");
  }
  if (patch.signers) {
    nextSignersJson = JSON.stringify(patch.signers);
    changedFields.push("signers");
  }
  if (patch.serverResolver !== undefined) {
    nextServerResolver = patch.serverResolver;
    changedFields.push("serverResolver");
  }

  let scheduleChanged = false;
  if (patch.scheduleMode && patch.scheduleConfig) {
    nextScheduleMode = patch.scheduleMode;
    nextScheduleConfigJson = JSON.stringify(patch.scheduleConfig);
    scheduleChanged = true;
    changedFields.push("schedule");
  }

  // A trigger-only row (externally fireable OR runtime-arg) has NO schedule (its
  // next_fire_at is NULL and the scheduler skips it) — never resurrect a next-fire
  // for it, even if a schedule patch slips through. Keep next_fire_at as-is (NULL).
  const rowTriggerOnly =
    rowExternalFireable(row) || rowRuntimeArgKeys(row).length > 0;
  if (scheduleChanged && !rowTriggerOnly) {
    const next = computeNextOrReject(
      nextScheduleMode,
      JSON.parse(nextScheduleConfigJson) as ScheduleConfig,
      opts.now ?? new Date(),
    );
    nextFireAt = next.toISOString();
  }

  if (changedFields.length === 0) {
    return { changedFields, nextFireAt };
  }

  db.prepare(
    `UPDATE codex_cronotons
        SET name = ?, description = ?, pact_code = ?, config_json = ?,
            payload_json = ?, gas_payer_json = ?, signers_json = ?,
            schedule_mode = ?, schedule_config_json = ?, server_resolver = ?,
            next_fire_at = ?, modified_at = ?
      WHERE id = ?`,
  ).run(
    nextName,
    nextDescription,
    nextPactCode,
    nextConfigJson,
    nextPayloadJson,
    nextGasPayerJson,
    nextSignersJson,
    nextScheduleMode,
    nextScheduleConfigJson,
    nextServerResolver,
    nextFireAt,
    (opts.now ?? new Date()).toISOString(),
    id,
  );

  return { changedFields, nextFireAt };
}

// ── Pause / resume / delete ──────────────────────────────────────────────────

function assertNotTerminal(row: CodexCronotonRow): void {
  if (row.status === "completed" || row.status === "error") {
    throw new TerminalCronotonError(row.status);
  }
}

export function pauseCodexCronoton(
  id: string,
  dep: DbDep,
): { status: "paused"; nextFireAt: string | null } {
  const db = dep.db;
  const row = getCodexCronoton(id, { db });
  if (!row) throw new CodexCronotonValidationError("not found");
  assertNotTerminal(row);

  db.prepare(
    `UPDATE codex_cronotons SET status = 'paused', modified_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), id);
  return { status: "paused", nextFireAt: row.next_fire_at };
}

/** Resume recomputes next_fire_at from NOW so a stale paused row never fire-storms. */
export function resumeCodexCronoton(
  id: string,
  opts: CommitOpts,
): { status: "active"; nextFireAt: string | null } {
  const db = opts.db;
  const row = getCodexCronoton(id, { db });
  if (!row) throw new CodexCronotonValidationError("not found");
  assertNotTerminal(row);

  const now = opts.now ?? new Date();
  // A trigger-only row (externally fireable OR runtime-arg) has no schedule — resume
  // it to 'active' but keep next_fire_at NULL so the scheduler still never picks it up.
  const rowTriggerOnly =
    rowExternalFireable(row) || rowRuntimeArgKeys(row).length > 0;
  const nextFireAt = rowTriggerOnly
    ? null
    : computeNextOrReject(
        row.schedule_mode,
        JSON.parse(row.schedule_config_json) as ScheduleConfig,
        now,
      ).toISOString();
  db.prepare(
    `UPDATE codex_cronotons SET status = 'active', next_fire_at = ?, modified_at = ? WHERE id = ?`,
  ).run(nextFireAt, now.toISOString(), id);
  return { status: "active", nextFireAt };
}

export function deleteCodexCronoton(
  id: string,
  dep: DbDep,
): { fireCountAtDelete: number } {
  const db = dep.db;
  const countRow = db
    .prepare(
      "SELECT COUNT(*) AS c FROM codex_cronoton_fires WHERE codex_cronoton_id = ?",
    )
    .get(id) as { c: number } | undefined;
  const fireCountAtDelete = countRow?.c ?? 0;
  db.prepare("DELETE FROM codex_cronotons WHERE id = ?").run(id);
  return { fireCountAtDelete };
}
