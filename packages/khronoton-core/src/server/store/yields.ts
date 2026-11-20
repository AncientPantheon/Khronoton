/**
 * yields — the decision-free CRUD layer for `codex_cronoton_run_yields`, the
 * flat named-yield pool a chained run's steps write to and read from (per
 * `docs/work/khronoton-step-yield-carry/design.md`). Mirrors `./runs.ts`'s
 * own style (`crypto.randomUUID()` ids, a `DbDep`-shaped second arg) rather
 * than introducing a new idiom for this one table.
 *
 * No resolution/validation logic lives here — "does a referenced yield name
 * exist" (`YieldNotFoundError`) is `pure/yields.ts`'s job (Wave 2's T2), not
 * this layer's; this file only ever does the mechanical read/write.
 */
import crypto from "node:crypto";

import type { DbDep } from "../seams.js";

/**
 * Insert-or-overwrite one named yield for a run. `ON CONFLICT(run_id, name)
 * DO UPDATE` is the design's stated overwrite semantics (design.md's
 * "Storage" section): a replanned step's freshest computed value always
 * wins, with no separate invalidation step needed since nothing downstream
 * of an unconfirmed step ever runs yet. `value` is JSON-stringified so any
 * JSON-serializable on-chain return value (string, number, object) round-trips.
 *
 * `input.value` is normalized to `null` first when it is `undefined` —
 * `JSON.stringify(undefined)` returns the JS value `undefined`, not a
 * string, which `better-sqlite3`'s `.run()` refuses to bind (it only
 * accepts numbers/bigints/strings/buffers/`null`) and throws. A caller can
 * legitimately hit this: `runs-driver.ts`'s single-mode confirm path stores
 * whatever on-chain return value a `ListenResult` carries, and that `data`
 * field is optional on the wire — a real review finding caught this
 * crashing AFTER the leg's `markLegConfirmed` write had already committed,
 * permanently stranding an otherwise-successful run with no yield ever
 * recorded. `null` round-trips through `value_json`/`getYieldPool` like any
 * other JSON value, so a caller that legitimately yields `null` is
 * unaffected — this only changes what an absent/`undefined` value becomes.
 */
export function upsertYield(
  input: { runId: string; name: string; value: unknown; stepIndex: number },
  dep: DbDep,
): void {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const value = input.value === undefined ? null : input.value;
  dep.db
    .prepare(
      `INSERT INTO codex_cronoton_run_yields (id, run_id, name, value_json, step_index, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, name) DO UPDATE SET
           value_json = excluded.value_json,
           step_index = excluded.step_index,
           created_at = excluded.created_at`,
    )
    .run(id, input.runId, input.name, JSON.stringify(value), input.stepIndex, now);
}

/**
 * The full `{name: value}` map for a run — `{}` for a run with zero yields.
 * Every `value_json` is parsed back into its original JSON value, so a
 * caller resolving a `{"$yield": "<name>"}` placeholder (`pure/yields.ts`)
 * reads the same shape that was originally passed to {@link upsertYield}.
 *
 * Built via `Object.create(null)`, NOT a `{}` literal — a plain object
 * literal inherits `Object.prototype`, so `pure/yields.ts`'s own
 * `name in pool` membership check (which walks the prototype chain) would
 * otherwise treat `"toString"`/`"constructor"`/`"hasOwnProperty"`/etc. as
 * present even for an empty pool, silently resolving a `$yield` reference
 * to a built-in function instead of throwing `YieldNotFoundError` — exactly
 * the "never silently guess" invariant this feature is built around. A
 * prototype-less object also makes a yield legitimately named `"__proto__"`
 * store as an ordinary own property instead of reassigning the object's own
 * prototype (which a `{}` literal's special `__proto__` setter would do).
 */
export function getYieldPool(runId: string, dep: DbDep): Record<string, unknown> {
  const rows = dep.db
    .prepare(`SELECT name, value_json FROM codex_cronoton_run_yields WHERE run_id = ?`)
    .all(runId) as Array<{ name: string; value_json: string }>;
  const pool: Record<string, unknown> = Object.create(null);
  for (const row of rows) {
    pool[row.name] = JSON.parse(row.value_json);
  }
  return pool;
}
