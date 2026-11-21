## Wave 1
- [x] T1: Add the two new `codex_cronotons` columns, widen the row type, and
      validate them in `commitCodexCronoton`/`editCodexCronoton` — done
      when: `npx vitest run src/server/schema.test.ts` passes with a new
      test asserting (a) `codex_cronotons` has a `try_single_tx_first
      INTEGER NOT NULL DEFAULT 0` column and a nullable `single_tx_mode
      TEXT` column with a CHECK restricting it to `'custom'`/`'default'`
      (or `NULL`), both confirmed via `PRAGMA table_info` on a fresh
      install AND on a re-run against an already-provisioned DB
      (idempotent, matching the existing `public_token`/`yield_as`
      `ensureColumn` precedent); AND `npx vitest run
      src/server/store/cronoton.test.ts` passes with new tests proving:
      (1) `commitCodexCronoton({..., trySingleTxFirst: true})` always
      throws `CodexCronotonValidationError` — a brand-new row can never
      have `codex_cronoton_steps` rows yet (they're inserted via a
      separate, later `insertStep` call), so there is never a fallback
      chain to justify the flag at commit time; (2)
      `commitCodexCronoton({..., singleTxMode: 'default'})` always throws
      `CodexCronotonValidationError` (not yet supported — reserved for a
      later topic); (3) `editCodexCronoton(id, { trySingleTxFirst: true,
      singleTxMode: 'custom' })` against a row with zero
      `codex_cronoton_steps` rows throws `CodexCronotonValidationError`
      naming the missing chain; (4) the identical edit against a row that
      already has ≥1 step row succeeds, and `getCodexCronoton(id,
      {db}).try_single_tx_first`/`.single_tx_mode` reflect the new values;
      (5) `editCodexCronoton(id, { singleTxMode: 'default' })` always
      throws regardless of step count; (6) omitting both fields on commit
      and on edit leaves `try_single_tx_first: 0`/`single_tx_mode: null` —
      byte-identical to every existing test in this file, which must all
      still pass unmodified.
  - files: `packages/khronoton-core/src/server/schema.ts`,
    `packages/khronoton-core/src/server/schema.test.ts`,
    `packages/khronoton-core/src/server/types.ts`,
    `packages/khronoton-core/src/server/store/cronoton.ts`,
    `packages/khronoton-core/src/server/store/cronoton.test.ts`
  - Implementation: in `schema.ts`'s `installSchema`, add
    `ensureColumn(db, "codex_cronotons", "try_single_tx_first", "INTEGER
    NOT NULL DEFAULT 0")` and `ensureColumn(db, "codex_cronotons",
    "single_tx_mode", "TEXT CHECK (single_tx_mode IN ('custom',
    'default'))")` alongside the existing `ensureColumn` calls (SQLite
    CHECK constraints are vacuously satisfied by `NULL`, so this allows
    `single_tx_mode` to stay unset without an explicit `OR ... IS NULL`
    clause — matches `codex_cronoton_steps.yield_as`'s own nullable-no-
    CHECK precedent, just with a value whitelist added). In `types.ts`,
    add `try_single_tx_first: number;` and `single_tx_mode: 'custom' |
    'default' | null;` to `CodexCronotonRow` (both required/non-optional,
    matching every OTHER post-migration column on that row — e.g.
    `status`, not the `server_resolver?`-style optional columns reserved
    for pre-migration test-fixture compatibility, since this is a
    brand-new column with no pre-existing fixtures to support). In
    `store/cronoton.ts`: add `trySingleTxFirst?: boolean;` and
    `singleTxMode?: 'custom' | 'default';` to `CommitCodexCronotonInput`,
    with a doc comment stating the commit-time rule (always rejected —
    see below); in `commitCodexCronoton`, after the existing validation
    block, add: `if (input.singleTxMode === 'default') throw new
    CodexCronotonValidationError("singleTxMode 'default' is not yet
    supported");` and `if (input.trySingleTxFirst) throw new
    CodexCronotonValidationError("trySingleTxFirst cannot be set at
    commit time — this cronoton has no steps yet; add steps first, then
    enable it via an edit");`; thread `input.trySingleTxFirst ? 1 : 0` and
    `input.singleTxMode ?? null` into the INSERT statement/column
    list/params. Add the same two fields to `EditCodexCronotonPatch`; in
    `editCodexCronoton`, add: `if (patch.singleTxMode === 'default') throw
    new CodexCronotonValidationError("singleTxMode 'default' is not yet
    supported");` and, when `patch.trySingleTxFirst === true` (or the
    row's EXISTING `try_single_tx_first` is already 1 and the patch
    doesn't explicitly turn it off), call the already-imported
    `listStepsForCronoton(id, {db})` (from `./steps.js`) and throw
    `CodexCronotonValidationError` naming "no steps" if it returns an
    empty array; otherwise thread the patched values into the existing
    `UPDATE` statement/column list/params (both `nextTrySingleTxFirst`/
    `nextSingleTxMode` locals mirroring every other `next*` local already
    in this function), adding both to `changedFields` when actually
    changed.

## Wave 2 (depends on Wave 1's T1)
- [x] T2: Add the shared single-tx-first decision helper — done when:
      `npx vitest run src/server/single-tx.test.ts` passes with new tests
      (using a real in-memory DB + a fake `ChainClient`, no mocked store
      calls) proving: (1) a row with `try_single_tx_first=0` returns
      `{ fired: false }` immediately, with the chain client's
      `dirtyRead`/`submit` never called at all; (2) a row with
      `try_single_tx_first=1` whose own `pact_code`/payload/config/
      gas-payer/signers simulate successfully under the gas ceiling
      returns `{ fired: true, result }` with `result.ok === true`, AND a
      new row exists in `codex_cronoton_fires` with `status:'success'`
      (via `listFires`), AND zero rows exist in `codex_cronoton_runs`; (3)
      the identical row, when its simulate is refused SPECIFICALLY for
      being too expensive (the test's fake chain client returns a
      `gas`/`preflight` value forcing the executor's existing "refuse
      unmineable" branch), returns `{ fired: false }` with NO
      `codex_cronoton_fires` row written — proving the caller alone
      decides what happens next, this function never writes a fire record
      on a refusal; (4) the identical row, when its simulate fails for a
      genuine NON-gas reason (the fake chain client's `dirtyRead` rejects
      with a plain error, no numeric `gasUsed` on the result), REJECTS
      (throws) rather than returning any `{fired:...}` value — the caller
      must see this as a real error, never silently treated as "doesn't
      fit"; (5) a row that fits simulation but whose actual fire call then
      fails for a genuine on-chain reason (the fake `submit`/`listen`
      rejects or returns `ok:false` with no numeric `gasUsed`) returns
      `{ fired: true, result }` with `result.ok === false`, AND a
      `codex_cronoton_fires` row exists with `status:'failure'` — i.e. the
      attempt is still reported as "fired" (so the caller does NOT fall
      back to the chain), just with a failed result, exactly like any
      ordinary one-shot cronoton's fire failure; (6) scenario (2) repeated
      with the row's `gasPayer` set to `{ type: "codex", address: "..." }`
      instead of the default `{ type: "gas-station" }` — both succeed
      through the identical code path, proving no gas-payer-specific
      branch was added inside this function.
  - files: `packages/khronoton-core/src/server/single-tx.ts` (new),
    `packages/khronoton-core/src/server/single-tx.test.ts` (new)
  - Implementation: `export interface SingleTxAttemptCtx { db: Database;
    runtime: ChainRuntime; resolver: KeyResolver; config?: Partial<Config>;
    resolveFireMode?: ResolveFireMode; onAudit?: OnAudit; }` (mirrors the
    structural subset `RunsDriverCtx`/`TickCtx` already share — reuse
    those existing seam types, imported from `./seams.js`, rather than
    redeclaring their member types). `export async function
    attemptSingleTxFirst(row: CodexCronotonRow, ctx:
    SingleTxAttemptCtx): Promise<{ fired: boolean; result?: FireResult;
    fireId?: string }>`: if `!row.try_single_tx_first` return `{ fired:
    false }` immediately (no simulate call at all — this is the ONLY
    branch allowed to skip simulating, since the flag itself is off).
    Otherwise: build `const definition = rowToDefinition(row);` (imported
    from `./store/mappers.js`, already used identically by `tick.ts`/
    `execute.ts`), call `const sim = await executeCodexTransaction(
    definition, "simulate", { runtime: ctx.runtime, resolver: ctx.resolver,
    config: ctx.config });`. If `sim.ok` returns true: proceed to fire —
    call `fireByServerResolver(definition, row, { runtime: ctx.runtime,
    resolver: ctx.resolver, config: ctx.config, db: ctx.db })`, then
    `recordFire(...)`/`computeDefinitionFingerprint(row)`/
    `applyTerminalIntent` (only when `definition.scheduleKind ===
    'one-time'`) — this exact sequence, copied from `handlers/execute.ts`'s
    existing PRIVATE `fireAndRecord` helper (which cannot be imported
    directly, since it is module-private to that file) — and an `onAudit`
    call with `action: result.ok ? "codex_cronoton.single_tx.fire" :
    "codex_cronoton.single_tx.fire_failed"` (a distinct action name from
    the plain-fire path's own `codex_cronoton.fire`/`.fire_failed`, so an
    operator reading the audit log can tell a single-tx attempt apart from
    an ordinary one-shot fire or a chained run start) — then return `{
    fired: true, result, fireId }`. If `sim.ok` is false AND
    `typeof sim.gasUsed === "number"` (the executor's existing refuse-
    unmineable signal — the EXACT same check `ouronet.aqp-evict` already
    uses to decide "fan out instead," do not reimplement a parallel check):
    return `{ fired: false }` with NO fire record written at all — the
    caller falls through to its own existing chained/plain logic
    unchanged. If `sim.ok` is false and `gasUsed` is NOT a number (a
    genuine non-gas simulate failure): `throw new Error(sim.error ??
    "single-tx simulate failed")` — propagate as a real error, never
    silently treated as "doesn't fit."

## Wave 3 (depends on Wave 2's T2; T3 and T4 touch disjoint files)
- [x] T3: Wire `attemptSingleTxFirst` into the scheduler tick's due-row
      handling — done when: `npx vitest run src/server/tick.test.ts`
      passes with new tests proving (1) a due row with
      `try_single_tx_first=0` drives through the existing chained/plain
      branches exactly as today — every pre-existing test in this file
      passes completely unmodified, proving zero behavior change; (2) a
      due, chained row (≥1 step) with `try_single_tx_first=1` whose
      single-tx variant fits simulation fires it and reports the row in
      `firedIds`, with `drivenRunIds` staying empty (no run was ever
      created) and `listStepsForCronoton`'s steps left completely
      untouched (no leg rows anywhere); (3) the identical row, when its
      single-tx variant is gas-refused, falls through to the EXISTING
      chained path — `drivenRunIds` contains the new run id, exactly as a
      `try_single_tx_first=0` row would behave; (4) a due row whose
      single-tx variant's genuine (non-gas) simulate failure propagates
      through to this function's EXISTING per-row try/catch, landing the
      row in `skippedIds` with a console error — the SAME isolation
      behavior any other orchestration error in this loop already gets,
      not a new error path.
  - files: `packages/khronoton-core/src/server/tick.ts`,
    `packages/khronoton-core/src/server/tick.test.ts`
  - Implementation: import `attemptSingleTxFirst` from `./single-tx.js`.
    In `codexCronotonTickOnce`'s per-row loop, immediately after the
    `claimDueCodexCronoton` claim succeeds and BEFORE the existing `const
    steps = listStepsForCronoton(row.id, { db: ctx.db });` line, insert:
    `const attempt = await attemptSingleTxFirst(row, ctx); if
    (attempt.fired) { if (attempt.result!.ok) firedIds.push(row.id); else
    failedIds.push(row.id); continue; }` — reusing this function's own
    `ctx` (already structurally compatible, since `TickCtx` is a superset
    of `SingleTxAttemptCtx`'s required fields) directly, no adaptation
    needed. When `attempt.fired` is `false`, fall through to the existing
    `steps.length > 0` branch completely unchanged — no new branch, no
    duplicated logic, this is a pure insertion ahead of the existing
    decision.
- [x] T4: Wire `attemptSingleTxFirst` into `executeNow`'s manual-trigger
      branch — done when: `npx vitest run src/handlers/execute.test.ts`
      passes with new tests proving the same four behaviors as T3's done-
      when, adapted to `executeNow`'s HTTP response shape: (1) zero
      behavior change when `try_single_tx_first=0` (every pre-existing
      test in this file passes unmodified); (2) a chained row with
      `try_single_tx_first=1` whose single-tx variant fits returns `200
      {ok:true, fireId, requestKey, ...}` (the SAME response shape the
      existing plain-fire branch already returns) and never creates a
      `codex_cronoton_runs` row; (3) the identical row, gas-refused, falls
      through to the EXISTING chained-run response shape (`200
      {ok:true, runId, status}`); (4) a genuine non-gas simulate failure
      propagates as a thrown error from the handler (consistent with how
      any other unexpected `executeNow` error already surfaces — this
      handler has no existing catch-and-convert-to-500 wrapper of its own
      to preserve or add).
  - files: `packages/khronoton-core/src/handlers/execute.ts`,
    `packages/khronoton-core/src/handlers/execute.test.ts`
  - Implementation: import `attemptSingleTxFirst` from
    `../server/single-tx.js`. In `executeNow`, immediately after the
    paused/terminal status guards and BEFORE the existing `const steps =
    listStepsForCronoton(row.id, { db: ctx.db });` line, insert: `const
    attempt = await attemptSingleTxFirst(row, { db: ctx.db, runtime:
    ctx.runtime, resolver: ctx.resolver, config: ctx.config, onAudit:
    ctx.onAudit ?? defaultOnAudit }); if (attempt.fired) { return
    json(200, { ok: attempt.result!.ok, fireId: attempt.fireId, requestKey:
    attempt.result!.requestKey, error: attempt.result!.error }); }` — the
    `ctx.onAudit ?? defaultOnAudit` adaptation mirrors the EXACT pattern
    this same function already uses two lines below for `driverCtx`, not
    a new idiom. When `attempt.fired` is `false`, fall through to the
    existing `steps.length > 0` branch completely unchanged.
