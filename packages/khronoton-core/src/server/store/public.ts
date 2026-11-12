/**
 * public — the public (unauthenticated-by-design) observability surface for a
 * single codex-cronoton: a lazily-minted, stable lookup token, a by-token
 * read gated on `public_observable`, whole-history fire counts, a pure
 * traffic-light health rule, and the sanitizing projector that assembles the
 * client-facing DTO.
 *
 * `toPublicCronotonView` is the ONLY place the privacy guarantee is enforced:
 * it builds a brand-new object field-by-field from the (far more sensitive)
 * `CodexCronotonRow`/`CodexCronotonFireRow` inputs, never spreading either —
 * a raw `pact_code`, JSON config blob, `created_by`, or fire `errorMessage`/
 * `chainResponse` must never ride along by accident.
 */
import crypto from "node:crypto";

import { summariseSchedule, type ScheduleConfig } from "../../schedule.js";
import type { DbDep } from "../seams.js";
import type {
  CodexCronotonFireRow,
  CodexCronotonRow,
} from "../types.js";
import { getCodexCronoton } from "./cronoton.js";
import { CodexCronotonValidationError } from "./errors.js";
import { rowExternalFireable, rowRuntimeArgKeys } from "./mappers.js";

// ── Token toggle + by-token read ─────────────────────────────────────────────

export interface SetPublicObservableOpts {
  observable: boolean;
  /** Force a fresh token even if one already exists. Ignored when `observable` is false. */
  regenerate?: boolean;
}

/**
 * Flip a cronoton's public-observability flag. Minting is lazy and stable:
 * a token is generated ONLY the first time a row is made observable (or when
 * `regenerate: true` is explicitly passed) — disabling then re-enabling
 * reuses the same token, so an embed URL built from it never has to be
 * re-minted. Disabling never touches `public_token`.
 */
export function setPublicObservable(
  id: string,
  opts: SetPublicObservableOpts,
  dep: DbDep,
): { publicToken: string | null; publicObservable: boolean } {
  const db = dep.db;
  const row = getCodexCronoton(id, { db });
  if (!row) throw new CodexCronotonValidationError("not found");

  let nextToken = row.public_token ?? null;
  if (opts.observable && (!nextToken || opts.regenerate === true)) {
    nextToken = crypto.randomBytes(20).toString("base64url");
  }

  db.prepare(
    `UPDATE codex_cronotons SET public_token = ?, public_observable = ?, modified_at = ? WHERE id = ?`,
  ).run(nextToken, opts.observable ? 1 : 0, new Date().toISOString(), id);

  return { publicToken: nextToken, publicObservable: opts.observable };
}

/**
 * Resolve a cronoton by its public token. Returns `null` for an unknown
 * token AND for a known token whose row is currently non-observable — the
 * single query makes the two cases indistinguishable on purpose (the public
 * handler can't leak which one it is).
 */
export function getCodexCronotonByPublicToken(token: string, dep: DbDep): CodexCronotonRow | null {
  const row = dep.db
    .prepare(`SELECT * FROM codex_cronotons WHERE public_token = ? AND public_observable = 1`)
    .get(token) as CodexCronotonRow | undefined;
  return row ?? null;
}

// ── Whole-history fire counts + health ───────────────────────────────────────

export interface CronotonFireCounts {
  fired: number;
  succeeded: number;
  failed: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** Consecutive failures immediately preceding the most recent fire; capped at 1000. */
  currentFailStreak: number;
}

/**
 * Whole-history fire counts for a cronoton. Deliberately independent of any
 * paginated fires window (a page of 20 out of 150 fires would under-report
 * every aggregate): one aggregate query for the totals/last-timestamps, plus
 * a second DESC-ordered scan (capped at 1000 rows) counting leading
 * `'failure'` statuses for `currentFailStreak` — the scan stops at the first
 * non-failure (or the cap), so a success anywhere further back never dilutes
 * the trailing streak.
 */
export function getCronotonFireCounts(id: string, dep: DbDep): CronotonFireCounts {
  const db = dep.db;
  const agg = db
    .prepare(
      `SELECT
         COUNT(*) AS fired,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succeeded,
         SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) AS failed,
         MAX(CASE WHEN status = 'success' THEN fired_at ELSE NULL END) AS lastSuccessAt,
         MAX(CASE WHEN status = 'failure' THEN fired_at ELSE NULL END) AS lastFailureAt
       FROM codex_cronoton_fires
       WHERE codex_cronoton_id = ?`,
    )
    .get(id) as {
    fired: number;
    succeeded: number | null;
    failed: number | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
  };

  const recent = db
    .prepare(
      // Tiebreak on SQLite's implicit `rowid`, NOT the `id` column — `id` is a
      // `crypto.randomUUID()` (fires.ts's recordFire/createRunningFire), with
      // zero correlation to insertion order, so an `id`-based tiebreak would
      // pick "most recent" essentially at random on a genuine fired_at tie.
      // `rowid` is safe here: this table has no `INTEGER PRIMARY KEY`/`WITHOUT
      // ROWID` override, and rows are never deleted standalone (only
      // cascade-deleted with their parent cronoton), so rowid reuse never
      // becomes a factor for a still-alive cronoton's fire history.
      `SELECT status FROM codex_cronoton_fires
        WHERE codex_cronoton_id = ?
        ORDER BY fired_at DESC, rowid DESC LIMIT 1000`,
    )
    .all(id) as Array<{ status: string }>;
  let currentFailStreak = 0;
  for (const r of recent) {
    if (r.status !== "failure") break;
    currentFailStreak += 1;
  }

  return {
    fired: agg.fired,
    succeeded: agg.succeeded ?? 0,
    failed: agg.failed ?? 0,
    lastSuccessAt: agg.lastSuccessAt ?? null,
    lastFailureAt: agg.lastFailureAt ?? null,
    currentFailStreak,
  };
}

export type CronotonHealth = "healthy" | "degraded" | "down";

/**
 * The pure traffic-light health rule: `"down"` once the trailing streak hits
 * 3, `"degraded"` for a 1-2 streak OR an overdue schedule, `"healthy"`
 * otherwise. Exported standalone so a consumer can reason about it without a
 * DB row.
 */
export function deriveCronotonHealth(input: {
  currentFailStreak: number;
  isOverdue: boolean;
}): CronotonHealth {
  if (input.currentFailStreak >= 3) return "down";
  if (input.currentFailStreak >= 1 || input.isOverdue) return "degraded";
  return "healthy";
}

// ── Projector ─────────────────────────────────────────────────────────────

export interface PublicCronotonFireView {
  firedAt: string;
  status: CodexCronotonFireRow["status"];
  chainId: string | null;
  requestKey: string | null;
  txKeys: CodexCronotonFireRow["txKeys"];
  recoveredAt: string | null;
  mode: CodexCronotonFireRow["mode"];
}

export interface PublicCronotonFiresPage {
  fires: CodexCronotonFireRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface PublicCronotonView {
  name: string;
  description: string | null;
  status: CodexCronotonRow["status"];
  schedule: { mode: CodexCronotonRow["schedule_mode"]; humanText: string; cron?: string };
  triggerOnly: boolean;
  nextFireAt: string | null;
  lastFireAt: string | null;
  isOverdue: boolean;
  since: string;
  counts: CronotonFireCounts & { successRatePercent: number | null };
  health: CronotonHealth;
  fires: {
    page: PublicCronotonFireView[];
    total: number;
    limit: number;
    offset: number;
  };
}

/** Best-effort parse of `schedule_config_json`; `null` on malformed/legacy data. */
function parseScheduleConfig(json: string): ScheduleConfig | null {
  try {
    return JSON.parse(json) as ScheduleConfig;
  } catch {
    return null;
  }
}

/**
 * Pure projector (no DB access of its own) from a `CodexCronotonRow` +
 * its `getCronotonFireCounts` result + a `listFires` page onto the sanitized
 * public DTO. Builds the result field-by-field — never spreads the row or a
 * fire — so `pact_code`/`payload_json`/`signers_json`/`gas_payer_json`/
 * `server_resolver`/`created_by`/`config_json`, the internal `id`, and a
 * fire's raw `errorMessage`/`chainResponse` can never leak through it.
 */
export function toPublicCronotonView(
  row: CodexCronotonRow,
  counts: CronotonFireCounts,
  firesPage: PublicCronotonFiresPage,
  now: Date = new Date(),
): PublicCronotonView {
  const parsedConfig = parseScheduleConfig(row.schedule_config_json);
  const humanText = parsedConfig
    ? summariseSchedule(row.schedule_mode, parsedConfig)
    : row.schedule_mode;
  const schedule: PublicCronotonView["schedule"] = {
    mode: row.schedule_mode,
    humanText,
  };
  if (parsedConfig && parsedConfig.mode === "cron-expression") {
    schedule.cron = parsedConfig.expression;
  }

  // A row committed/edited with ONLY `eventDriven: true` (no `externalFireable`,
  // no `evented` server resolver) persists `external_fireable = 0` and
  // `runtime_arg_keys = null` — `next_fire_at === null` is the ONLY signal
  // store/cronoton.ts leaves for it (see editCodexCronoton's own
  // "reliable, column-free marker" comment). But a null `next_fire_at` is ALSO
  // how a spent terminal one-time row looks (applyTerminalIntent clears it on
  // completion/error) despite never being trigger-only — so the null check is
  // gated on the row NOT being terminal.
  //
  // KNOWN LIMITATION (not fully disambiguable without a dedicated persisted
  // column — judged disproportionate for a read-only view's display label):
  // `claimDueCodexCronoton` (./claim.js) ALSO nulls `next_fire_at` on an
  // ORDINARY, non-trigger-only row while leaving `status = 'active'` — (a)
  // transiently, for every one-time row, during the brief window between
  // claim and the eventual terminal-intent write; (b) PERMANENTLY, for a
  // recurring row whose `schedule_config_json` is corrupt (claim.ts's own
  // "F-003" case — the row is stuck `active` with a null `next_fire_at`
  // forever, since the due-query requires `next_fire_at IS NOT NULL`). Both
  // cases read as `triggerOnly: true` here. Accepted: the corrupt-config row
  // is already broken regardless of this label, and the one-time window is
  // bounded and transient.
  const triggerOnly =
    rowExternalFireable(row) ||
    rowRuntimeArgKeys(row).length > 0 ||
    (row.next_fire_at === null && row.status !== "completed" && row.status !== "error");
  const isOverdue =
    row.status === "active" &&
    row.next_fire_at !== null &&
    new Date(row.next_fire_at) < now;

  const successRatePercent =
    counts.fired > 0 ? Math.round((counts.succeeded / counts.fired) * 100) : null;

  return {
    name: row.name,
    description: row.description,
    status: row.status,
    schedule,
    triggerOnly,
    nextFireAt: row.next_fire_at,
    lastFireAt: row.last_fire_at,
    isOverdue,
    since: row.created_at,
    counts: { ...counts, successRatePercent },
    health: deriveCronotonHealth({ currentFailStreak: counts.currentFailStreak, isOverdue }),
    fires: {
      page: firesPage.fires.map((fire) => ({
        firedAt: fire.firedAt,
        status: fire.status,
        chainId: fire.chainId,
        requestKey: fire.requestKey,
        txKeys: fire.txKeys,
        recoveredAt: fire.recoveredAt,
        mode: fire.mode,
      })),
      total: firesPage.total,
      limit: firesPage.limit,
      offset: firesPage.offset,
    },
  };
}
