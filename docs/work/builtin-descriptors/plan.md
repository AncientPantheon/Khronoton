## Wave 1
- [x] T1: Create `packages/khronoton-core/src/builtins/descriptors.ts` with the full data-type
      surface and the 3 standalone-only built-in descriptors. Zero imports from `server/executor.js`,
      any `@stoachain/*` path, or `node:crypto` — verify by reading the finished file's own import
      list before marking this done. Export:
      ```ts
      export type BuiltinKind = 'standalone' | 'composable';
      export interface BuiltinParamField {
        name: string; label: string;
        type: 'string' | 'decimal' | 'account' | 'glyph-account' | 'enum';
        required: boolean; help?: string; placeholder?: string; options?: string[];
        allowExpr?: boolean;
      }
      export interface RequiredCap { line: string; signerIndex?: number; }
      export interface BuiltinFragment {
        pactExpr: string; payload: Record<string, unknown>; requiredCaps: RequiredCap[];
      }
      export interface BuiltinDescriptor {
        name: string; label: string; kind: BuiltinKind; description: string;
        params: BuiltinParamField[];
        toFragment?(params: Record<string, unknown>): BuiltinFragment;
        preview?(params: Record<string, unknown>): { summary: string; entrypoints: string[] };
      }
      export const BUILTIN_DESCRIPTORS: Record<string, BuiltinDescriptor> = { /* keyed by name, e.g. BUILTIN_DESCRIPTORS["ouronet.aqp-inject"] */ };
      ```
      (A `Record` keyed by `name`, not an array, so a UI picker can look one up directly by
      registry name without a linear scan.) Populate 3 entries:
      - `"ouronet.aqp-inject"`: `kind: 'standalone'`, `params` = `fvtId` (string, required),
        `patronAccount` (string, required), `executor` (`glyph-account`, required, `help` text
        stating a glyph Ouronet account is required and a `k:` account will be rejected — read
        `packages/khronoton-core/src/server/planners/inject.ts`'s `InjectPlannerParams.executor`
        doc comment and condense it, do not invent new wording), `rewardDptfId` (string, required),
        `amount` (`decimal`, required). `preview(params)` returns `{ summary:
        \`Inject ${params.amount} to fvt ${params.fvtId}\`, entrypoints: ["CC_InjectFinalize", "CC_Inject"] }`.
      - `"ouronet.aqp-evict"`: `kind: 'standalone'`, `params` = `fvtId`/`patronAccount` (string,
        required — read `packages/khronoton-core/src/server/planners/evict.ts`'s
        `EvictPlannerParams`, exactly these 2 fields, no more). `preview` →
        `entrypoints: ["CC_FullEvictRewards", "CC_EvictSingleReward (fan-out)"]`.
      - `"ouronet.aqp-unstall"`: `kind: 'standalone'`, `params` = `fvtId`/`patronAccount`/
        `rewardDptfId` (string, required — read `packages/khronoton-core/src/server/planners/unstall.ts`'s
        `UnstallPlannerParams`, exactly these 3 fields, no `amount`). `preview` →
        `entrypoints: ["CCp_FvtFixSlice (fan-out)"]`.
      Done when: `npx vitest run src/builtins/descriptors.test.ts` passes, covering: (a) a test
      enumerating each of the 3 descriptors' `params` names against the real planner file's own
      `*PlannerParams` interface field names (read the 3 planner files directly in the test or in
      a shared fixture, not hardcoded expectations that could silently drift from the real
      interfaces) — exact set equality, no missing/extra field; (b) each `preview()` call returns
      the exact `entrypoints` array specified above; (c) `BUILTIN_DESCRIPTORS["ouronet.aqp-inject"].kind === 'standalone'`
      (and same for the other two) with no `toFragment` present on any of the 3 (standalone built-ins
      never emit a fragment).
  - files: `packages/khronoton-core/src/builtins/descriptors.ts`, `packages/khronoton-core/src/builtins/descriptors.test.ts`

## Wave 2 (depends on Wave 1)
- [x] T2: Add composable `toFragment` support to the SAME `descriptors.ts` for all 4 composable
      built-ins, each carrying its own capability-safety treatment per design.md's Design decisions
      1 and 3. Add 4 entries to `BUILTIN_DESCRIPTORS`:
      - `"ouronet.stoa-wrap"`: `kind: 'composable'`, `params` = `patronAccount` (`account`, required,
        `help` noting `k:`/`c:` shape — read `packages/khronoton-core/src/server/planners/stoa-wrap.ts`'s
        `ACCOUNT_SHAPE` regex and `StoaWrapPlannerParams` doc), `amount` (`decimal`, required,
        `allowExpr: true`), `amountCeiling` (`decimal`, required, `help` text stating this is a
        SAFE UPPER BOUND for the managed `coin.TRANSFER` capability — the actual transfer may use
        less, never more, so a generous ceiling is harmless), `namespace` (string, required,
        default-suggested value `"ouronet-ns"` in its `placeholder` — every real planner derives
        this from `ctx.runtime.namespace` at run time; this pure module has no runtime context, so
        it is an explicit param here). `toFragment(params)`: let `ns = params.namespace`,
        `patron = params.patronAccount`; if `/^\d+\.\d+$/.test(String(params.amount))` (a literal),
        `amountExpr = '(read-decimal "amount")'` and `payload.amount = params.amount`; otherwise
        (an operator-authored Pact expression, per `allowExpr`), `amountExpr = String(params.amount)`
        verbatim and `payload` gets NO `amount` key (nothing to env-data — the expression is spliced
        directly into the Pact source). `pactExpr = \`(${ns}.TS01-C2.LQD|C_WrapStoa (read-string "patron") (read-string "executor") ${amountExpr})\`;
        payload.patron = patron;` (no `executor` key here — unlike the standalone planner, composable
        mode has no signer to derive an executor from; the surrounding hand-written block supplies
        `executor` via its OWN env-data, outside this descriptor's concern). `requiredCaps = [{ line:
        \`(coin.TRANSFER "${patron}" "c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI" ${params.amountCeiling})\` }]`
        (duplicate the `STOA_AUTONOMIC_LIQUIDPOT` literal locally in this file — do not import it
        from `stoa-wrap.ts`, matching this codebase's own established per-module-constant-duplication
        convention already used between `stoa-wrap.ts` and `stoa-unwrap.ts` themselves).
      - `"ouronet.stoa-unwrap"`: `kind: 'composable'`, `params` = `patronAccount` (`account`,
        required), `amount` (`decimal`, required, `allowExpr: true`), `amountCeiling` (`decimal`,
        required, same help framing as wrap's), `targetAccount` (`account`, required, `help` noting
        this REPLACES the real planner's live `DALOS.UR_AccountKadena` resolve — composable mode
        has no chain read, so the operator supplies the already-known target directly),
        `needsCreate` (`enum`, `options: ["yes", "no"]`, required, `help` noting this REPLACES the
        real planner's live `coin.get-balance` existence probe for the identical reason),
        `namespace` (string, required, same as wrap's). `toFragment(params)`: same literal-vs-expr
        `amountExpr` detection as wrap. `unwrapForm = \`(${ns}.TS01-C2.LQD|C_UnwrapStoa (read-string "patron") (read-string "executor") ${amountExpr})\`;`.
        If `params.needsCreate === "yes"`: require `/^k:[A-Za-z0-9_-]+$/.test(params.targetAccount)`
        (throw a clear `Error` if not — account creation assumes a single-key `k:` account, matching
        `stoa-unwrap.ts`'s own `stripPrefix`/key-stripping precedent exactly), `strippedPubkey =
        String(params.targetAccount).slice(2)` (inlining the trivial string-slice `stripPrefix`
        performs — read `packages/khronoton-core/src/server/executor-signers.ts`'s `stripPrefix` to
        confirm it is exactly this, then inline rather than import, keeping this module's import
        list clean), `pactExpr = \`(coin.C_CreateAccount (read-string "target") (read-keyset "ks"))\n\${unwrapForm}\`;`,
        `payload` gets `target: params.targetAccount, ks: { keys: [strippedPubkey], pred: "keys-all" }`
        in addition to `patron`/`amount` (literal case). Otherwise `pactExpr = unwrapForm` with no
        `target`/`ks` payload keys. `requiredCaps = [{ line: \`(coin.TRANSFER
        "c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI" "${params.targetAccount}" ${params.amountCeiling}")\` }]`
        — LIQUIDPOT→target order (confirmed reversed from wrap's patron→LIQUIDPOT order by reading
        `stoa-unwrap.ts` directly; do not copy wrap's order here).
      - `"ouronet.stoa-transmit"`: `kind: 'composable'`, `params` = `sender` (`account`, required),
        `receiver` (`account`, required), `variant` (`enum`, `options: ["transmit", "transmit-anew"]`,
        required), `amount` (`decimal`, required, `allowExpr: true`), `capAmount` (`decimal`,
        required, `help` text stating EXPLICITLY that `coin.TRANSMIT` is an UNMANAGED capability (no
        ceiling slack) and `capAmount` must be the operator's EXACT promised value — a mismatch
        between `capAmount` and what the spliced expression actually evaluates to at execution time
        causes a hard on-chain revert, not a soft over-reservation; this wording must be materially
        different from `amountCeiling`'s own help text above, never copy-pasted), `receiverPublicKey`
        (string, required ONLY when `variant === "transmit-anew"` — state this conditionality in its
        own `help` text). No `namespace` param — `coin` is bare/un-namespaced (confirmed via
        `coin-live.pact`'s own `(module coin GOVERNANCE)` declaration). `toFragment(params)`: same
        literal-vs-expr `amountExpr` detection. If `params.variant === "transmit"`: `pactExpr =
        \`(coin.C_Transmit (read-string "sender") (read-string "receiver") ${amountExpr})\`;` with
        `payload = { sender: params.sender, receiver: params.receiver, ...(literal-case amount) }`.
        If `"transmit-anew"`: `pactExpr = \`(coin.C_TransmitAnew (read-string "sender") (read-string "receiver") (read-keyset "receiver-guard") ${amountExpr})\`;`
        with `payload` additionally getting `"receiver-guard": { keys: [params.receiverPublicKey], pred: "keys-all" }`.
        `requiredCaps = [{ line: \`(coin.TRANSMIT "${params.sender}" "${params.receiver}" ${params.capAmount})\` }]`.
      - `"ouronet.urstoa-transmit"`: identical field list and logic to `"ouronet.stoa-transmit"`,
        substituting `coin.C_Transmit`→`coin.C_UR|Transmit`, `coin.C_TransmitAnew`→`coin.C_UR|TransmitAnew`,
        and the required cap's `coin.TRANSMIT`→`coin.UR|TRANSMIT`.
      Done when: `npx vitest run src/builtins/descriptors.test.ts` passes, with these ADDED cases
      (the Wave 1 cases from T1 keep passing unmodified): (a) one snapshot test per composable
      descriptor (4 total) with a literal `amount`, asserting the exact `pactExpr`/`payload`/
      `requiredCaps` returned; (b) one snapshot test per composable descriptor (4 total) with
      `amount` set to a raw Pact expression string (e.g. `"(at \"drained\" ctx)"`), asserting
      `pactExpr` splices it verbatim in place of `(read-decimal "amount")` and `payload` carries NO
      `amount` key; (c) for `stoa-wrap`/`stoa-unwrap`: a test where `amount` and `amountCeiling`
      differ, asserting the emitted `requiredCaps[0].line` uses `amountCeiling`'s value, never
      `amount`'s; (d) for `stoa-transmit`/`urstoa-transmit`: the same shape of test asserting
      `requiredCaps[0].line` uses `capAmount`, never `amount`; (e) a test asserting
      `BUILTIN_DESCRIPTORS["ouronet.stoa-wrap"].params.find(f => f.name === "amountCeiling").help`
      and `BUILTIN_DESCRIPTORS["ouronet.stoa-transmit"].params.find(f => f.name === "capAmount").help`
      are not equal strings, and that the latter contains language about an exact match / revert
      (e.g. matches `/revert|exact/i`); (f) `transmit-anew` variant tests for both transmit
      descriptors asserting the `(read-keyset "receiver-guard")` form and payload key appear only
      for that variant, never for plain `"transmit"`; (g) `stoa-unwrap`'s `needsCreate: "yes"` case
      asserts the two-form `pactExpr` (create-account newline-joined with the unwrap form) and the
      `ks`/`target` payload keys; `needsCreate: "no"` asserts the single-form `pactExpr` with
      neither key present.
  - files: `packages/khronoton-core/src/builtins/descriptors.ts`, `packages/khronoton-core/src/builtins/descriptors.test.ts`

## Wave 3 (depends on Wave 2)
- [x] T3: Re-export the new module from the package's existing `/ui` barrel. Read
      `packages/khronoton-core/src/ui/index.ts` in full first (it already has substantial content
      from a separate, concurrent, uncommitted change in this same repo — do not reorder, remove,
      or otherwise touch any existing line in this file). Append exactly one new line at the end
      of the file's existing export list: `export * from "../builtins/descriptors.js";`. Do not
      touch `package.json`, `CHANGELOG.md`, or any other file outside this one line in this one file.
      Done when: `npx tsc --noEmit` is clean for the whole package (confirming the new export
      doesn't collide with any existing `/ui` export name — `BuiltinKind`/`BuiltinParamField`/
      `RequiredCap`/`BuiltinFragment`/`BuiltinDescriptor`/`BUILTIN_DESCRIPTORS` must not already be
      exported by anything else `src/ui/index.ts` re-exports); `git diff packages/khronoton-core/src/ui/index.ts`
      shows exactly one added line and zero removed/changed lines; `npx vitest run` (full suite)
      passes with no regressions outside `src/builtins/descriptors.test.ts`.
  - files: `packages/khronoton-core/src/ui/index.ts`, (reads) `packages/khronoton-core/src/builtins/descriptors.ts`
