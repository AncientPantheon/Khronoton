/**
 * Viewer access model + the pure disable-rule predicates every codex-cronoton
 * screen shares.
 *
 * Auth tier is NOT part of the provider config — the provider carries only the
 * confirm-gate. The host resolves roles and passes the resulting {@link Access}
 * down as a page-level prop; the UI renders tiers. Keeping every "is this action
 * allowed, and why" decision here (pure, exhaustively tested) means no screen
 * re-implements the disable/tooltip precedence in JSX — they consume these
 * predicates and render the `{disabled, title}` verbatim.
 */

import type { CodexCronotonRow } from "../server/types.js";

/** logged-out (public read-only) · non-admin (signed in, cannot mutate) · admin. */
export type AccessTier = "logged-out" | "non-admin" | "admin";

/** The viewer's tier plus, when signed in, their email (rendered in footers). */
export interface Access {
  readonly tier: AccessTier;
  readonly email?: string;
}

/** Only the row fields the disable rules read: the status + the resolver lock. */
type RuleRow = Pick<CodexCronotonRow, "status" | "server_resolver">;

/** A button's derived disabled state and the tooltip explaining why (if any). */
export interface DisableState {
  readonly disabled: boolean;
  /** Present only when the disabled state has a user-facing reason to show. */
  readonly title?: string;
}

/** The "+ New Codex Cronoton" control resolves to one of three renderings. */
export type NewCronotonTier =
  | { readonly kind: "link" }
  | { readonly kind: "disabled"; readonly title: string }
  | { readonly kind: "hidden" };

export const ADMIN_ONLY_TITLE = "Ancient admins only";
export const SYSTEM_CRONOTON_DELETE_TITLE =
  "System cronoton — cannot be deleted. Pause it to disable instead.";
export const TERMINAL_PAUSE_RESUME_TITLE =
  "Terminal cronotons cannot be paused or resumed";
export const TERMINAL_EXECUTE_TITLE =
  "Terminal cronotons cannot be executed";
export const BATCH_ACTIVE_TITLE =
  "A batch is running — wait for it to finish or cancel it";

/** Terminal one-time states: a spent cronoton can no longer be paused/resumed. */
const TERMINAL_STATUSES: ReadonlySet<CodexCronotonRow["status"]> = new Set([
  "completed",
  "error",
]);

/** Only the admin tier may mutate; the public and non-admin views are read-only. */
export function canMutate(access: Access): boolean {
  return access.tier === "admin";
}

const ENABLED: DisableState = { disabled: false, title: undefined };
const WORKING: DisableState = { disabled: true, title: undefined };

/**
 * Delete precedence: the server-resolver row lock announces first (a system
 * cronoton can never be deleted, only paused — shown even to an admin), then the
 * access tier, then the in-flight guard.
 */
export function deleteDisabled(
  access: Access,
  row: RuleRow,
  opts: { working?: boolean } = {},
): DisableState {
  if (row.server_resolver) {
    return { disabled: true, title: SYSTEM_CRONOTON_DELETE_TITLE };
  }
  if (!canMutate(access)) {
    return { disabled: true, title: ADMIN_ONLY_TITLE };
  }
  if (opts.working) return WORKING;
  return ENABLED;
}

/**
 * Pause/Resume precedence: the terminal row lock announces first (a spent
 * cronoton has nothing to pause/resume — shown even to an admin), then the
 * access tier, then the in-flight guard.
 */
export function pauseResumeDisabled(
  access: Access,
  row: RuleRow,
  opts: { working: boolean },
): DisableState {
  if (TERMINAL_STATUSES.has(row.status)) {
    return { disabled: true, title: TERMINAL_PAUSE_RESUME_TITLE };
  }
  if (!canMutate(access)) {
    return { disabled: true, title: ADMIN_ONLY_TITLE };
  }
  if (opts.working) return WORKING;
  return ENABLED;
}

/**
 * Execute-Now precedence: the terminal row lock announces first (a spent
 * cronoton can never be fired again — the server rejects it, so the button must
 * not look live even to an admin), then the access tier, then the running-batch
 * block (Execute Now is disabled until the batch finishes or is cancelled), then
 * the in-flight guard.
 */
export function executeDisabled(
  access: Access,
  row: RuleRow,
  opts: { working: boolean; batchActive: boolean },
): DisableState {
  if (TERMINAL_STATUSES.has(row.status)) {
    return { disabled: true, title: TERMINAL_EXECUTE_TITLE };
  }
  if (!canMutate(access)) {
    return { disabled: true, title: ADMIN_ONLY_TITLE };
  }
  if (opts.batchActive) {
    return { disabled: true, title: BATCH_ACTIVE_TITLE };
  }
  if (opts.working) return WORKING;
  return ENABLED;
}

/** "+ New": admin → an enabled link, non-admin → disabled, logged-out → hidden. */
export function newCronotonTier(access: Access): NewCronotonTier {
  switch (access.tier) {
    case "admin":
      return { kind: "link" };
    case "non-admin":
      return { kind: "disabled", title: ADMIN_ONLY_TITLE };
    case "logged-out":
      return { kind: "hidden" };
  }
}
