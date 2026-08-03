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
 * and treats a null next-fire as a "no future fires" reject. A SCHEDULER-OFF row
 * (externally fireable, OR declaring runtime args, OR event-driven — a
 * server-resolver the host fires via `executeNow`) carries NO schedule at all —
 * its `next_fire_at` stays NULL and the schedule engine is never consulted for it.
 */
import crypto from "node:crypto";

import {
  computeNextFire,
  InvalidScheduleConfigError,
  type ScheduleConfig,
  type ScheduleMode,
} from "../../schedule.js";
import { runtimeArgKeysCollide } from "../pure/runtime-args.js";
import { getServerResolver } from "../resolvers.js";
import type { DbDep } from "../seams.js";
import type {
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
  /** When true, the row is host-fired on an event (via executeNow) rather than on a
   *  timer — a THIRD trigger-only reason: it commits scheduler-off (next_fire_at NULL). */
  eventDriven?: boolean;
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
  // One-resolver-one-cronoton: a server_resolver may bind AT MOST one cronoton.
  // The finder returns the newest match, so a duplicate would silently shadow the
  // first and fire the wrong template — reject it, naming the existing row.
  if (input.serverResolver) {
    const existing = findCodexCronotonIdByServerResolver(input.serverResolver, {
      db: opts.db,
    });
    if (existing) {
      throw new CodexCronotonValidationError(
        `server resolver "${input.serverResolver}" is already bound to cronoton ${existing} — delete it first`,
      );
    }
  }

  const now = opts.now ?? new Date();
  // A SCHEDULER-OFF cronoton (externally fireable, OR declaring runtime args, OR
  // event-driven — a server-resolver the host fires via `executeNow`) fires on
  // demand, never on a timer — so it carries NO schedule: skip the next-fire
  // computation and store next_fire_at = NULL. The scheduler's
  // `next_fire_at IS NOT NULL` gate then skips it.
  // An EVENTED server resolver (per the registry) is host-fired on an in-process
  // event, never on a timer — the store is authoritative: it forces the row
  // external-fireable (external_fireable = 1) and scheduler-off, regardless of what
  // the client sent, so the guarantee holds for every consumer.
  const evented = getServerResolver(input.serverResolver ?? "")?.evented === true;
  const externalFireable = input.externalFireable === true || evented;
  const triggerOnly =
    externalFireable ||
    runtimeArgKeys.length > 0 ||
    input.eventDriven === true;
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
      externalFireable ? 1 : 0,
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
): CodexCronotonRow[] {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);
  const db = dep.db;
  // Return FULL snake_case rows (`SELECT *`, mirroring `getCodexCronoton`), NOT a
  // hand-picked projection. The read handler types this as `CodexCronotonRow[]`
  // and `CronotonList.tsx` renders full-row fields — `pact_code` (the preview),
  // `schedule_config_json`/`schedule_mode` (the schedule line), `runtime_arg_keys`
  // (trigger-only), `description`, `server_resolver`, `last_fire_at`. The old
  // 9-field camelCase projection returned NONE of those under the names the UI
  // reads, so the list silently rendered blank columns and crashed on the one
  // unguarded string access (`pactPreview(row.pact_code)`). The ≤200-row admin
  // list over-fetching four JSON columns is negligible and buys type-honesty.
  return (
    params.status
      ? db
          .prepare(
            `SELECT * FROM codex_cronotons WHERE status = ?
               ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          )
          .all(params.status, limit, offset)
      : db
          .prepare(
            `SELECT * FROM codex_cronotons
               ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          )
          .all(limit, offset)
  ) as CodexCronotonRow[];
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
  /** When true, force the row scheduler-off (next_fire_at NULL) — an event-driven
   *  edit or a scheduled→event-driven conversion. There is no persisted column, so
   *  the edit path relies on this patch signal (the persisted row can't reveal it). */
  eventDriven?: boolean;
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

  // Derive EVENTED-ness of both the PATCHED (post-edit) resolver and the row's
  // CURRENT (pre-edit) resolver from the registry (authoritative). An edit that
  // repoints onto an evented resolver — even WITHOUT the client eventDriven flag —
  // must force scheduler-off + external-fireable, mirroring commit; an edit that
  // repoints AWAY from an evented resolver must shed the evented-forced
  // external_fireable and re-arm a real schedule.
  const resolverName =
    patch.serverResolver !== undefined ? patch.serverResolver : row.server_resolver;
  const evented = getServerResolver(resolverName ?? "")?.evented === true;
  const prevEvented = getServerResolver(row.server_resolver ?? "")?.evented === true;
  // The row's external_fireable is "genuine" (a user-set HMAC-fire flag to preserve)
  // ONLY when it was NOT forced by a now-departed evented resolver. This lets a plain
  // edit of a genuinely external-fireable row keep its flag, while an evented→
  // non-evented repoint correctly drops the evented-forced flag.
  const genuineExternalFireable = Boolean(rowExternalFireable(row)) && !prevEvented;
  const rowSchedulerOff =
    evented || rowRuntimeArgKeys(row).length > 0 || genuineExternalFireable;
  // A row that just LEFT an evented resolver must re-arm its schedule even if the
  // edit carried no explicit schedule patch (else it would sit external_fireable=0 +
  // next_fire_at=NULL — a dead row that never fires).
  const eventedDeparted = prevEvented && !evented;

  // An event-driven edit forces the row scheduler-off (next_fire_at NULL). There is
  // no persisted event_driven column, so `rowSchedulerOff` can't see the departed
  // case via the row alone — the patch/registry signals above drive this. Marking
  // "schedule" ensures the UPDATE runs even when the next_fire_at change is the only
  // change, so the early-out below doesn't skip the write.
  if (patch.eventDriven === true || evented) {
    if (nextFireAt !== null && !changedFields.includes("schedule")) {
      changedFields.push("schedule");
    }
    nextFireAt = null;
  } else if ((scheduleChanged || eventedDeparted) && !rowSchedulerOff) {
    const next = computeNextOrReject(
      nextScheduleMode,
      JSON.parse(nextScheduleConfigJson) as ScheduleConfig,
      opts.now ?? new Date(),
    );
    nextFireAt = next.toISOString();
    if (!changedFields.includes("schedule")) changedFields.push("schedule");
  }

  if (changedFields.length === 0) {
    return { changedFields, nextFireAt };
  }

  // An evented edit forces external_fireable = 1 (mirroring commit). Otherwise the
  // edit PRESERVES a GENUINE (user-set) external-fireable flag, but DROPS one that
  // was only forced by a now-departed evented resolver — so an evented→non-evented
  // repoint doesn't leave the row permanently external-fireable/scheduler-off.
  const nextExternalFireable = evented ? 1 : genuineExternalFireable ? 1 : 0;

  db.prepare(
    `UPDATE codex_cronotons
        SET name = ?, description = ?, pact_code = ?, config_json = ?,
            payload_json = ?, gas_payer_json = ?, signers_json = ?,
            schedule_mode = ?, schedule_config_json = ?, server_resolver = ?,
            external_fireable = ?, next_fire_at = ?, modified_at = ?
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
    nextExternalFireable,
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
  // A scheduler-off row has no schedule — resume it to 'active' but keep
  // next_fire_at NULL so the scheduler still never picks it up. Every scheduler-off
  // row (externally fireable, runtime-arg, OR event-driven — a server-resolver the
  // host fires via executeNow) is committed with next_fire_at NULL, pause preserves
  // it, and every genuinely-scheduled active row carries a NON-null next_fire_at —
  // so the row's own current next_fire_at is the reliable, column-free marker here.
  // (Event-driven persists no distinguishing column; this is what keeps resume from
  // resurrecting a schedule for it. The edit path keys off the incoming patch signal
  // instead, because an edit may be CONVERTING a row to or from a schedule.)
  const rowSchedulerOff = row.next_fire_at === null;
  const nextFireAt = rowSchedulerOff
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
