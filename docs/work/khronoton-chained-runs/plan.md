## Wave 1
- [x] T1: `SubmitResult` type + widen `ExecutorResult` — done when: `npm run typecheck --workspace=@ancientpantheon/khronoton-core` passes with a new `SubmitResult` interface added to `src/server/types.ts`, directly below `FireResult`, matching the existing discriminated-union style (`readonly` fields, `mode: "submit"` literal):
  ```ts
  export interface SubmitResult {
    readonly ok: boolean;
    readonly mode: "submit";
    readonly requestKey?: string;
    readonly chainId?: string;
    readonly networkId?: string;
    readonly rawResult?: unknown;
    readonly error?: string;
  }
  ```
  and `export type ExecutorResult = SimulateResult | FireResult | SubmitResult;` (was `SimulateResult | FireResult`). No test file — this is a pure additive type change verified by typecheck alone, matching how this package treats type-only additions elsewhere (e.g. the `public_token`/`public_observable` fields on `CodexCronotonRow`).
  - files: `src/server/types.ts`

- [x] T2: `ChainClient.pollRequestKeys?` seam — done when: `npm run typecheck --workspace=@ancientpantheon/khronoton-core` passes with a new optional method added to the `ChainClient` interface in `src/server/seams.ts`, directly below `getBlockGasLimit?()`, matching that method's own doc-comment density and "optional, best-effort" framing:
  ```ts
  /**
   * Poll many request keys on ONE chain in a single call. Returns a map keyed
   * by requestKey; a key ABSENT from the map means "still pending" (Kadena's
   * /poll endpoint only returns landed transactions), a key PRESENT means a
   * definite {@link ListenResult}. Optional — a consumer without it falls back
   * to polling keys one at a time via `listen`, slower but never unsafe. What
   * matters is that a multi-leg step costs one request per chain per tick, not
   * one request per leg — see `blockchain/stoachain.ts` for the implementation.
   */
  pollRequestKeys?(keys: string[], chainId: string): Promise<Record<string, ListenResult>>;
  ```
  - files: `src/server/seams.ts`

- [x] T6: three new tables for chained runs — done when: `npm test --workspace=@ancientpantheon/khronoton-core -- schema` passes with `src/server/schema.ts`'s `SCHEMA_SQL` extended with three new `CREATE TABLE IF NOT EXISTS` blocks (appended after the existing `codex_cronoton_manual_batches` block, before the closing template-literal backtick) plus their indexes, and `src/server/schema.test.ts` extended with:
  1. A test asserting `installSchema(db)` on a fresh `:memory:` db creates all three new tables — `codex_cronoton_steps`, `codex_cronoton_runs`, `codex_cronoton_run_legs` — via `SELECT name FROM sqlite_master WHERE type='table'`.
  2. A test proving the partial unique self-block index is real: insert a `codex_cronotons` parent row, insert a `codex_cronoton_runs` row for it with `status='awaiting'`, then attempt to insert a SECOND `codex_cronoton_runs` row for the SAME `codex_cronoton_id` also with a non-terminal status (`'planning'`, `'awaiting'`, or `'advancing'`) — assert the second `INSERT` throws matching `/UNIQUE constraint/i`. Then update the first row's status to `'failed'` (a terminal status) and assert a third insert for the same `codex_cronoton_id` now succeeds.
  3. A test proving `codex_cronoton_steps`'s mode-shape `CHECK` constraint: an insert with `mode='single'` and a non-null `pact_code` succeeds; an insert with `mode='single'` and a NULL `pact_code` throws; an insert with `mode='planner'` and a non-null `planner_name` succeeds; an insert with `mode='planner'` and a NULL `planner_name` throws.
  4. An upgrade-from-pre-existing-shape test mirroring the existing `ensureColumn` test's pattern: hand-create a `codex_cronotons` row via raw SQL on a db that has NOT yet called `installSchema`'s new-table statements (i.e. a db where only the base schema exists — achievable by calling `installSchema` once, then directly `DROP TABLE codex_cronoton_runs` (and the other two) to simulate a pre-this-change db, then call `installSchema` again and assert all three tables exist again with no error). Table/column shapes, verbatim:
  ```sql
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
  ```
  These are genuinely NEW tables (no pre-existing columns to merge via `ensureColumn`), so they go straight into the `SCHEMA_SQL` template literal as plain `CREATE TABLE IF NOT EXISTS` blocks — no `ensureColumn` call needed for them (that helper is for adding a COLUMN to an existing table, not a new table; a new table's own `IF NOT EXISTS` already gives both a fresh install and an upgrade the identical path).
  - files: `src/server/schema.ts`, `src/server/schema.test.ts`

- [x] T7: `RunAlreadyInFlightError` typed error — done when: `npm run typecheck --workspace=@ancientpantheon/khronoton-core` passes with a new error class added to `src/server/store/errors.ts`, directly below `ManualBatchActiveError`, matching that class's exact shape (plain `Error` subclass, fixed message, `this.name` set):
  ```ts
  /** A non-terminal run already exists for this cronoton — self-blocking only (a DIFFERENT cronoton must never be blocked by this). */
  export class RunAlreadyInFlightError extends Error {
    constructor(codexCronotonId: string) {
      super(
        `codex cronoton ${codexCronotonId} already has a non-terminal run in flight — a new run cannot start until it settles`,
      );
      this.name = 'RunAlreadyInFlightError';
    }
  }
  ```
  No test file for this task alone — it's exercised by T9's `store/runs.test.ts`, which is the first real caller.
  - files: `src/server/store/errors.ts`

## Wave 2 (depends on Wave 1)
- [x] T3: extract `submitTransaction`, add `"submit"` executor mode — done when: `npm test --workspace=@ancientpantheon/khronoton-core -- executor` passes with:
  1. Every existing test in `src/server/executor.test.ts`'s `"fire mode"`, `"REQ-23 504/derived-request-key recovery"`, `"FIX 1 config.autoGasCeiling override"`, `"gas-station GAS_PAYER signer synthesis wiring"`, `"live gas floor at fire time"`, `"runtime WITHOUT the gasMeta capability"`, `"live block gas limit"`, `"refuse the unmineable case"`, and `"AUTO-gas fire on a runtime WITHOUT preflightRead"` describe blocks (lines 335-983 as they exist today) passing UNCHANGED — zero edits to those test bodies, proving the extraction didn't change `fire`'s observable behavior.
  2. A NEW `describe("executeCodexTransaction — submit mode", ...)` block, co-located in the same file, covering: (a) a successful submit returns `{ ok: true, mode: "submit", requestKey, chainId }` and the mock `ChainClient`'s `listen` is never invoked (assert via a `listen: vi.fn(() => { throw new Error("listen must never be called in submit mode"); })` mock); (b) a preflight-failure (mock `dirtyRead`/`preflightRead` returning `{ result: { status: "failure", error: { message: "..." } } }`) returns `{ ok: false, mode: "submit", error }` with `client.submit` never called; (c) a gas-over-ceiling preflight result returns `{ ok: false, mode: "submit" }` with the same `"Transaction needs {gasUsed} gas, over the block limit"` error message `fire` mode produces, and `client.submit` never called; (d) the REQ-23 ambiguous-submit (mock `client.submit` throws, but the signed command's `hash` is a valid string) still returns `{ ok: true, requestKey: <the derived hash> }` — i.e. submit mode gets the SAME 504-recovery `fire` mode already has.

  Implementation, in `src/server/executor.ts`:
  - Extract a new PRIVATE async function `submitTransaction(ctx: ExecutorCtx, definition: CodexTxDefinition, signers: CodexTxDefinition["signers"], client: ChainClient, ceiling: number)` covering exactly what `runFire`'s current lines ~349-441 do today: build (ceiling-limited if `autoGasLimit`), sign, the `preflightRead`-availability throw-check, the preflight/refuse-unmineable checks, the AUTO-gas rebuild+resign, request-key derivation, and the submit-with-504-recovery try/catch. Its return type (private to this module, not exported):
    ```ts
    type SubmitOutcome =
      | { ok: true; chainId: string; requestKey: string; networkId?: string }
      | { ok: false; chainId: string; error: string; rawResult?: unknown; gasUsed?: number };
    ```
    On success, `requestKey`/`networkId` come from the normal `client.submit(signed)` result on the happy path, or from the derived-hash/derived-networkId descriptor on the 504-recovery path — both cases populate the SAME shape (unlike today's code, where `networkId` is only populated in the recovery branch; widen it to always include the already-computed `derivedNetworkId` on success, which is a strictly additive change to the data flowing into the subsequent `listen` call and has no effect on `FireResult`, which has no `networkId` field to leak it through).
  - `runFire` becomes: build nothing itself before calling `submitTransaction`; call it; on `ok: false` map directly to today's `FireResult` failure shape (same error/rawResult/gasUsed handling, `terminalIntent: computeTerminalIntent(definition.scheduleKind, "fire", false)`); on `ok: true` call `listenWithTimeout(client.listen, { requestKey, chainId, networkId }, listenMs)` exactly as today and interpret the result exactly as today (byte-identical to the current post-submit logic).
  - New private `async function runSubmit(ctx: ExecutorCtx, definition: CodexTxDefinition, signers: CodexTxDefinition["signers"]): Promise<SubmitResult>`: constructs `client`/`ceiling` the same two lines `runFire` does, calls `submitTransaction`, and returns `{ ok: true, mode: "submit", requestKey, chainId, networkId }` or `{ ok: false, mode: "submit", chainId, error, rawResult }` directly from the outcome — no `listen` call, ever.
  - `executeCodexTransaction`'s overload set gains `(definition, mode: "submit", ctx): Promise<SubmitResult>`, and its implementation gains a `mode === "submit"` branch mirroring the existing `fire` branch exactly: wrapped in the same try/catch that converts any thrown build/sign error into `{ ok: false, mode: "submit", chainId: definition.config.chainId, error }` (never throws out, same F-002 guarantee `fire` has — submit is a step toward on-chain submission, not a dry-run like `simulate`, so it inherits `fire`'s never-throws contract, not `simulate`'s surface-build-errors contract).
  - files: `src/server/executor.ts`, `src/server/executor.test.ts`

- [x] T4: `pollRequestKeys` on the StoaChain `ChainClient` — done when: `npm test --workspace=@ancientpantheon/khronoton-core -- stoachain` passes with a new case (or cases) in `src/blockchain/stoachain.test.ts`'s `"createStoachainRuntime — createClient wrapper"` describe block, mirroring `preflightRead`/`getBlockGasLimit`'s existing test style (mocked HTTP/SDK calls, no real network): (a) `pollRequestKeys(["key-a", "key-b"], "0")` against a mocked response where only `key-a` has landed returns `{ "key-a": <ListenResult-shaped> }` — `key-b` absent from the returned object, not present with a null/undefined value; (b) a non-2xx or network-error response resolves to `{}` (empty map — every key reads as "still pending"), never throwing, mirroring `getBlockGasLimit`'s own never-throws-on-failure contract.

  Implementation, in `src/blockchain/stoachain.ts`: add `pollRequestKeys` to the object returned by the `createClient` wrapper (alongside the existing `preflightRead`/`getBlockGasLimit`). Before implementing a raw `fetch`, check whether the already-imported `@stoachain/kadena-stoic-legacy/client`'s `createClient(url)` result (`real`, already destructured in this function) exposes a batch-poll primitive of its own (its TS types are available via `node_modules/@stoachain/kadena-stoic-legacy`) — if it does, wrap that the way `dirtyRead`/`submit`/`listen` are already passed through unchanged. If it does not, implement via a raw `fetch` to the chain's `/poll` endpoint (`POST {origin}/chainweb/0.0/{networkId}/chain/{chainId}/pact/api/v1/poll` with body `{ requestKeys: keys }`, mirroring `getBlockGasLimit`'s existing `origin`-derivation-then-`fetch` pattern and its try/catch-degrade-to-fallback shape — here the fallback is `{}`, not a numeric constant). Map whatever shape the Kadena response actually uses (an object keyed by request key, values being Pact command results) into `Record<string, ListenResult>` — reuse `ListenResult`'s existing `{ result: { status, error? }, reqKey? }` shape rather than inventing a new one.
  - files: `src/blockchain/stoachain.ts`, `src/blockchain/stoachain.test.ts`

- [x] T5: barrel-export `SubmitResult` — done when: `npm run typecheck --workspace=@ancientpantheon/khronoton-core` passes with `SubmitResult` added to `src/server/index.ts`'s "Shared domain types" `export type { ... }` block (the same block that already lists `SimulateResult`, `FireResult`, `ExecutorResult`), alphabetically/contextually placed directly after `FireResult`.
  - files: `src/server/index.ts`

- [x] T8: `codex_cronoton_steps` CRUD — done when: a new `npm test --workspace=@ancientpantheon/khronoton-core -- store/steps` run is green, covering (against a real in-memory `better-sqlite3` DB, `installSchema`'d, with a raw-SQL-inserted `codex_cronotons` parent row — mirroring `claim.test.ts`'s own `seedCronoton` helper pattern): (a) `insertStep` for a `mode: 'single'` step persists `pact_code`/`config_json`/`payload_json`/`gas_payer_json`/`signers_json` and reads back identically via `listStepsForCronoton`; (b) `insertStep` for a `mode: 'planner'` step persists `planner_name`/`planner_params_json` and reads back identically; (c) `listStepsForCronoton` returns steps ordered by `step_index` ascending regardless of insertion order (insert step 2 before step 0, assert the returned array is `[0, 1, 2]`-ordered); (d) `insertStep` with `idempotent: true` round-trips a truthy `idempotent` field in the returned/read-back step (stored as `1`, projected as `boolean`); (e) a second `insertStep` call for the SAME `(codexCronotonId, stepIndex)` pair throws matching `/UNIQUE constraint/i` (the `idx_codex_cronoton_steps_order` index from T6).

  Implementation, in `src/server/store/steps.ts`: `export interface InsertStepInput { codexCronotonId: string; stepIndex: number; mode: 'single' | 'planner'; pactCode?: string; config?: unknown; payload?: unknown; gasPayer?: unknown; signers?: unknown; plannerName?: string; plannerParams?: unknown; idempotent?: boolean }`, `export function insertStep(input: InsertStepInput, dep: DbDep): string` (returns the new row's id, mirroring `commitCodexCronoton`'s own return-the-id convention), `export interface CodexCronotonStepRow { id: string; codex_cronoton_id: string; step_index: number; mode: 'single' | 'planner'; pact_code: string | null; config_json: string | null; payload_json: string | null; gas_payer_json: string | null; signers_json: string | null; planner_name: string | null; planner_params_json: string | null; idempotent: number; created_at: string; modified_at: string }`, `export function listStepsForCronoton(codexCronotonId: string, dep: DbDep): CodexCronotonStepRow[]` (raw snake_case rows, `SELECT * ... ORDER BY step_index ASC` — mirroring `listCodexCronotons`'s own "full `SELECT *` row, not a hand-picked camelCase projection" precedent and its documented rationale). No decision logic (no validation of step sequencing, no planner-registry lookup) — purely mechanical CRUD, per the design's explicit Phase 1/Phase 2 boundary.
  - files: `src/server/store/steps.ts`, `src/server/store/steps.test.ts`

- [x] T9: `codex_cronoton_runs` + `codex_cronoton_run_legs` CRUD — done when: a new `npm test --workspace=@ancientpantheon/khronoton-core -- store/runs` run is green, covering (against a real in-memory `better-sqlite3` DB, never a SQL-string mock — per `claim.test.ts`'s own stated rationale, which applies identically to this new self-block constraint):
  1. `createRun({ codexCronotonId, stepCount: 3 }, { db })` on a cronoton with no existing run returns a new run id, and the row reads back with `status: 'planning'`, `step_index: 0`, `step_count: 3`.
  2. A second `createRun` call for the SAME `codexCronotonId`, while the first run's status is still non-terminal (`'planning'`, `'awaiting'`, or `'advancing'`), throws `RunAlreadyInFlightError` (the typed class from T7, not a raw `SqliteError` leaking out of the store layer) — and the first run's row is completely unchanged (re-read it and assert every field matches the pre-attempt read).
  3. Once the first run's status is updated to a terminal value (`'succeeded'`, `'failed'`, or `'abandoned'` — parametrize over all three via `it.each`), a new `createRun` call for the same `codexCronotonId` succeeds.
  4. TWO-RACING-CALLERS proof, mirroring `claim.test.ts`'s own two-racing-claimers pattern: call `createRun` twice in direct succession for the same `codexCronotonId` with NO status update between them (simulating two concurrent callers racing to start a run) — assert exactly one call returns a run id and the other throws `RunAlreadyInFlightError`; assert exactly one row exists in `codex_cronoton_runs` for that `codexCronotonId` afterward (not two).
  5. `insertRunLeg({ runId, stepIndex: 0, legIndex: 0, definitionJson: '{"pactCode":"(+ 1 1)"}' }, { db })` creates a row with `status: 'pending'` and a NULL `request_key` — proving a leg can exist before any request key is known, matching the design's "write a leg row before its transaction is submitted" requirement.
  6. `markLegSubmitted(legId, { requestKey: 'abc', chainId: '0' }, { db })` flips the leg to `status: 'submitted'`, sets `request_key`/`chain_id`/`submitted_at`, and — proving §5.3's invariant is enforced here, not left to caller discretion — a SECOND call to `markLegSubmitted` on the SAME leg (simulating an accidental re-submit attempt) throws (a typed error, e.g. `LegAlreadySubmittedError` added to `store/errors.ts` in this task) rather than silently overwriting the existing `request_key`.
  7. `markLegConfirmed(legId, { db })` and `markLegFailed(legId, { errorMessage: '...' }, { db })` each flip a `'submitted'` leg to its terminal status and stamp `confirmed_at`/`error_message` respectively.
  8. `listRunLegs(runId, { db })` returns every leg for a run ordered by `(step_index, leg_index)` ascending.

  Implementation, in `src/server/store/runs.ts`, with these exact exported names (T10 barrels them verbatim):
  ```ts
  export interface CreateRunInput {
    codexCronotonId: string;
    stepCount: number;
    deadlineAt?: string;
    contextJson?: unknown;
  }
  export interface CodexCronotonRunRow {
    id: string;
    codex_cronoton_id: string;
    fire_id: string | null;
    status: 'planning' | 'awaiting' | 'advancing' | 'succeeded' | 'failed' | 'abandoned';
    step_index: number;
    step_count: number;
    started_at: string;
    modified_at: string;
    deadline_at: string | null;
    attempt: number;
    context_json: string | null;
  }
  export interface CodexCronotonRunLegRow {
    id: string;
    run_id: string;
    step_index: number;
    leg_index: number;
    status: 'pending' | 'submitted' | 'confirmed' | 'failed';
    request_key: string | null;
    chain_id: string | null;
    definition_json: string;
    error_message: string | null;
    submitted_at: string | null;
    confirmed_at: string | null;
    attempt: number;
  }
  export function createRun(input: CreateRunInput, dep: DbDep): string; // returns new run id
  export function getRun(runId: string, dep: DbDep): CodexCronotonRunRow | null;
  export function listRunLegs(runId: string, dep: DbDep): CodexCronotonRunLegRow[];
  export function insertRunLeg(
    input: { runId: string; stepIndex: number; legIndex: number; definitionJson: string },
    dep: DbDep,
  ): string; // returns new leg id, status: 'pending'
  export function markLegSubmitted(
    legId: string,
    input: { requestKey: string; chainId: string },
    dep: DbDep,
  ): void;
  export function markLegConfirmed(legId: string, dep: DbDep): void;
  export function markLegFailed(legId: string, input: { errorMessage: string }, dep: DbDep): void;
  ```
  `createRun` performs the INSERT directly (letting the partial unique index from T6 be the actual enforcement — SQLite throws a constraint-violation `SqliteError` on the racing second insert, which `createRun` catches by message/code and re-throws as `RunAlreadyInFlightError`, never a raw driver error escaping the store layer); the rest are plain parameterized CRUD, no decision logic (no barrier-met check, no "which legs are missing" — that is Phase 2's `advanceRun`, explicitly out of scope here). Add `LegAlreadySubmittedError` to `src/server/store/errors.ts` in this same task (it's this task's first and only caller).
  - files: `src/server/store/runs.ts`, `src/server/store/runs.test.ts`, `src/server/store/errors.ts`

## Wave 3 (depends on Wave 2 — needs T7/T8/T9's exact export names)
- [x] T10: barrel-wire the new store surface — done when: `npm run typecheck --workspace=@ancientpantheon/khronoton-core` passes and `npm test --workspace=@ancientpantheon/khronoton-core` (full suite) passes, with `src/server/store/index.ts` gaining two new sections mirroring its existing per-table grouping style:
  ```ts
  // ── Chained-run step definitions: insert / list ──────────────────────────────
  export { insertStep, listStepsForCronoton } from "./steps.js";
  export type { InsertStepInput, CodexCronotonStepRow } from "./steps.js";

  // ── Chained runs + legs: create / read / leg lifecycle ────────────────────────
  export {
    createRun,
    getRun,
    listRunLegs,
    insertRunLeg,
    markLegSubmitted,
    markLegConfirmed,
    markLegFailed,
  } from "./runs.js";
  export type { CreateRunInput, CodexCronotonRunRow, CodexCronotonRunLegRow } from "./runs.js";
  ```
  and `src/server/store/errors.ts`'s new `RunAlreadyInFlightError`/`LegAlreadySubmittedError` added to the existing `export { CodexCronotonValidationError, AutoGasGateError, TerminalCronotonError, ManualBatchActiveError } from "./errors.js";` list in `store/index.ts` (the exact exported type/function names must match whatever T8/T9 actually named them — if a name differs from what's sketched above, export the REAL name, not this sketch's placeholder). No new test file — this task is verified by the full suite + typecheck passing, since every new store function already has its own direct-import test coverage from T8/T9; the barrel is a pure re-export wiring check.
  - files: `src/server/store/index.ts`
