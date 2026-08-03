/**
 * Shared row-derived predicates for the codex-cronoton screens.
 *
 * A single source of truth for "does this row fire on a trigger/event, not a
 * clock?" — used by BOTH the list's next-fire cell and the detail's Schedule cell
 * so the two can never drift (the drift this module fixes: Detail once ignored
 * `external_fireable` and showed a stored schedule for an evented row).
 */
import type { CodexCronotonRow } from "../server/types.js";
import { parseRuntimeArgKeys } from "../server/pure/runtime-args.js";

/**
 * A cronoton fires on a trigger/event, not a clock: it is external-fireable OR it
 * carries runtime-arg keys. Its next-fire/schedule read "Evented", never a time.
 */
export function isTriggerOnly(row: CodexCronotonRow): boolean {
  return row.external_fireable === 1 || parseRuntimeArgKeys(row.runtime_arg_keys).length > 0;
}
