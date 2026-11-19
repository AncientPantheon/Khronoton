## Wave 1

- [x] T1: Build `ouronet.stoa-wrap` — a one-leg planner that reads the
      patron's live STOA balance and wraps the exact amount, attaching a
      scoped `coin.TRANSFER` capability. — done when: `npx vitest run
      src/server/planners/stoa-wrap.test.ts` passes with the behaviors
      below, and `npm run typecheck` is clean.
  - files: `packages/khronoton-core/src/server/planners/stoa-wrap.ts`
    (new), `packages/khronoton-core/src/server/planners/stoa-wrap.test.ts`
    (new); reads (no changes) `planners/evict.ts` (the env-data-pactCode
    and `isWellFormedEvictLeg`-shape-guard pattern this mirrors),
    `planners/registry.ts` (`StepPlanner`/`PlannedLeg`/`PlannerCtx`,
    `registerStepPlanner`), `executor.ts` (`executeCodexTransaction`'s
    `"simulate"` mode and its `rawResult.data` shape — same call style
    `evict.ts`'s plan-read probe already uses), `executor-signers.ts`
    (`stripPrefix`, imported directly — a meaningful Kadena-specific
    transform, not duplicated like the trivial `parseJson` helper is),
    `types.ts` (`CodexSigner`/`CapabilityMode`/`CodexGasPayer`/
    `CodexTxConfig`), `store/steps.ts` (`CodexCronotonStepRow`).
  - Implementation, following `evict.ts`'s module shape exactly
    (doc comment, local `parseJson`, `registerStepPlanner` call at the
    bottom):
    1. `planner_params_json` shape: `{ patronAccount: string }`. Parse it;
       throw `"ouronet.stoa-wrap: step.planner_params_json must have a
       patronAccount string"` if missing/wrong type.
    2. Shape-guard `patronAccount` against `/^[kc]:[A-Za-z0-9_-]+$/`
       (deliberately stricter than `evict.ts`/`inject.ts`'s bare
       `typeof === "string"` param check — see design.md §C: this value
       flows into a signer `capabilities` line, which has no
       `read-string`-equivalent safety net, so it is guarded before use
       regardless of source). Throw `` `ouronet.stoa-wrap: patronAccount
       is not a well-formed k:/c: account: ${JSON.stringify(patronAccount)}`
       `` on failure.
    3. Parse `signers`/`config`/`gasPayer` from `step.signers_json`/
       `config_json`/`gas_payer_json` exactly like `evict.ts` lines
       100-109 (same empty-signers throw message pattern, substituting
       `"ouronet.stoa-wrap"`). Derive `executor = \`k:${signers[0].publicKey}\``.
    4. Read the live balance: `pactCode: '(coin.get-balance (read-string
       "patron"))'`, `payload: { patron: patronAccount }` — **no namespace
       prefix**: `coin` is Kadena's root/system module, unlike
       `AQP-EVCT`/`AQP-FVT`, which live inside `ctx.runtime.namespace` —
       confirm this distinction in a doc comment citing OuronetUI's own
       bare `coin.get-balance`/`coin.TRANSFER` calls. Call via
       `executeCodexTransaction(probeDefinition, "simulate", executorCtx)`
       exactly like `evict.ts`'s plan-read probe (`executorCtx = {
       runtime: ctx.runtime, resolver: ctx.resolver, config: ctx.config }`).
       A failed read (`!result.ok`) is a genuine error — throw
       `result.error ?? "coin.get-balance read failed"` (the dispenser
       account existing is a precondition, same posture as every other
       planner's trust in its inputs).
    5. Validate `result.rawResult.data` is `typeof === "number"` — throw
       `"ouronet.stoa-wrap: coin.get-balance returned a non-numeric
       result"` otherwise. If the balance is `0`, return `[]` (mirrors
       `unstallPlanner`'s own "zero stale users → `[]`" convention —
       the step is trivially satisfied, nothing to wrap).
    6. Format the balance as a Pact decimal literal via a local
       (unexported) helper `formatPactDecimal(n: number): string` that
       guarantees a decimal point and never scientific notation — e.g.
       `n.toFixed(12)` then strip trailing zeros down to at least one
       digit after the `.` (so `5` → `"5.0"`, `5.5` → `"5.5"`,
       `5.100000000000` → `"5.1"`). Throw if `n` is negative or
       non-finite (`!Number.isFinite(n) || n < 0`) — a negative/NaN/
       Infinity balance from `coin.get-balance` is impossible in a
       correct chain state, so treat it as a genuine error:
       `` `ouronet.stoa-wrap: coin.get-balance returned an invalid amount:
       ${n}` ``.
    7. Build the one leg:
       - `pactCode: '(${ctx.runtime.namespace}.TS01-C2.LQD|C_WrapStoa
         (read-string "patron") (read-string "executor") (read-decimal
         "amount"))'` — namespaced via `ctx.runtime.namespace`, never
         hardcoded (same discipline as `evict.ts`'s `AQP-EVCT`/`inject.ts`'s
         `AQP-FVT`).
       - `payload: { patron: patronAccount, executor, amount:
         formattedAmount }`.
       - `signers`: a NEW array — every entry from `signers` copied
         unchanged EXCEPT index 0 (the same signer `executor` was derived
         from), whose `capabilityMode` becomes `"scoped"` and whose
         `capabilities` becomes the ORIGINAL `capabilities` string (if
         non-empty) plus a new line
         `` `(coin.TRANSFER "${patronAccount}" "${STOA_AUTONOMIC_LIQUIDPOT}"
         ${formattedAmount})` `` appended (joined with `\n`, using
         `[original, newLine].filter(Boolean).join("\n")` so an empty
         original capabilities string doesn't produce a leading blank
         line) — preserves any author-configured capability lines rather
         than clobbering them.
       - `STOA_AUTONOMIC_LIQUIDPOT` is a local module constant:
         `"c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI"` (confirmed
         against `ouronet-core/src/constants/ouronet.ts:44` — cite this
         in a doc comment; duplicated in `stoa-unwrap.ts` too, per the
         same per-module-duplication convention `parseJson` already
         uses, to keep T1/T2 independent).
       - `config`, `gasPayer`: as parsed in step 3.
    8. `registerStepPlanner("ouronet.stoa-wrap", stoaWrapPlanner);` at the
       bottom of the file.
  - Tests (`stoa-wrap.test.ts`, mirroring `evict.test.ts`'s/`inject.test.ts`'s
    `makeRuntime`/`makeResolver`/`dirtyRead`/`makeStepRow` fixture style —
    `runtime.namespace: "ouronet-ns"`):
    - "reads the live balance via `coin.get-balance` (no namespace prefix)
      and builds exactly one `LQD|C_WrapStoa` leg with the EXACT namespaced
      pact code and payload, amount formatted as a decimal with a `.`" —
      `dirtyRead` returns `{result:{status:"success",data:5}}` for the
      balance read; asserts
      `legs[0].pactCode === '(ouronet-ns.TS01-C2.LQD|C_WrapStoa (read-string "patron") (read-string "executor") (read-decimal "amount"))'`
      and `legs[0].payload === {patron:"k:patron", executor:\`k:${PUB_A}\`, amount:"5.0"}`.
    - "returns `[]` without building any leg when the live balance is `0`,
      and never calls `dirtyRead` a second time" — `dirtyRead` returns
      `{result:{status:"success",data:0}}`; asserts `legs).toEqual([])`
      and `dirtyRead` called exactly once.
    - "attaches a `coin.TRANSFER` capability to signer 0, scoped to
      `[patronAccount, STOA_AUTONOMIC_LIQUIDPOT, amount]`, preserving
      signer 0's ORIGINAL capabilities string by appending rather than
      replacing" — step row's `signers_json` has signer 0 with
      `capabilityMode:"scoped"`, `capabilities:"(some.OTHER-CAP \"x\")"`;
      asserts `legs[0].signers[0].capabilities ===
      '(some.OTHER-CAP "x")\n(coin.TRANSFER "k:patron" "c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI" 5.0)'`
      and `legs[0].signers[0].capabilityMode === "scoped"`.
    - "formats an integer balance (`5`) as `\"5.0\"`, not `\"5\"`, so
      Pact's `read-decimal` accepts it" — `dirtyRead` returns `data:5`;
      asserts `legs[0].payload.amount === "5.0"`.
    - "rejects a malformed `patronAccount` (fails the k:/c: shape guard)
      before ever calling the chain" — `planner_params_json:
      {patronAccount:"not-an-account"}`; asserts the promise rejects with
      `/not a well-formed k:\/c: account/` and `dirtyRead` was never
      called.
    - "rejects when `coin.get-balance` returns a non-numeric result,
      never silently treating it as zero" — `dirtyRead` returns
      `{result:{status:"success",data:"oops"}}`; asserts rejection with
      `/non-numeric/`.
    - "rejects when `coin.get-balance` itself fails (account doesn't
      exist), never silently returning `[]`" — `dirtyRead` returns
      `{result:{status:"failure",error:{message:"row not found"}}}`;
      asserts rejection with `/row not found/`.

- [x] T2: Build `ouronet.stoa-unwrap` — a one-leg planner that resolves
      the unwrap target account, conditionally composes an account-
      creation form, and attaches a scoped `coin.TRANSFER` capability
      from the LIQUIDPOT. — done when: `npx vitest run
      src/server/planners/stoa-unwrap.test.ts` passes with the behaviors
      below, and `npm run typecheck` is clean.
  - files: `packages/khronoton-core/src/server/planners/stoa-unwrap.ts`
    (new), `packages/khronoton-core/src/server/planners/stoa-unwrap.test.ts`
    (new); reads (no changes) the same reference files as T1
    (`planners/evict.ts`, `planners/inject.ts` — for the "validate an
    `amount: string` param with `/^\d+\.\d+$/`" pattern already
    established there — `planners/registry.ts`, `executor.ts`,
    `executor-signers.ts` for `stripPrefix`, `types.ts`, `store/steps.ts`).
  - Implementation (independent of T1 — disjoint files, no shared
    helpers imported between the two planner files; `STOA_AUTONOMIC_LIQUIDPOT`
    and the `/^[kc]:[A-Za-z0-9_-]+$/` shape guard are each duplicated
    locally here too, same convention as T1):
    1. `planner_params_json` shape: `{ patronAccount: string; amount:
       string }`. Parse and validate both are strings (throw
       `"ouronet.stoa-unwrap: step.planner_params_json must have
       patronAccount and amount strings"` otherwise), THEN validate
       `patronAccount` against `/^[kc]:[A-Za-z0-9_-]+$/` (throw ``
       `ouronet.stoa-unwrap: patronAccount is not a well-formed k:/c:
       account: ${JSON.stringify(patronAccount)}` ``) AND `amount` against
       `/^\d+\.\d+$/` (throw `` `ouronet.stoa-unwrap: amount must be a
       non-negative decimal string (e.g. "5.0"), got
       ${JSON.stringify(amount)}` `` — exact same message shape as
       `inject.ts`'s own amount guard, substituting the planner name).
    2. Parse `signers`/`config`/`gasPayer`, derive `executor`, build
       `executorCtx` — identical to T1 step 3, substituting
       `"ouronet.stoa-unwrap"` in the empty-signers throw message.
    3. Resolve the target account: `pactCode:
       '(${ctx.runtime.namespace}.DALOS.UR_AccountKadena (read-string
       "patron"))'`, `payload: { patron: patronAccount }`. A failed read
       is a genuine error (throw `result.error ?? "UR_AccountKadena read
       failed"`). Validate `result.rawResult.data` is a string matching
       `/^[kc]:[A-Za-z0-9_-]+$/` (this value IS chain-read-sourced,
       unlike `patronAccount` — same `isWellFormedEvictLeg`-style
       "chain reads are not trusted" posture as `evict.ts`) — throw ``
       `ouronet.stoa-unwrap: UR_AccountKadena returned a malformed target
       account: ${JSON.stringify(data)}` `` on failure. Call this value
       `targetAccount`.
    4. Check existence: `pactCode: '(try false (coin.get-balance
       (read-string "target")))'` (bare `coin`, no namespace prefix, same
       as T1), `payload: { target: targetAccount }`. A failed simulate
       here (`!result.ok`) is a genuine error — rethrow. On success,
       inspect `result.rawResult.data`: `=== false` → target does not
       exist (`needsCreate = true`); `typeof === "number"` → exists
       (`needsCreate = false`); anything else → throw ``
       `ouronet.stoa-unwrap: coin.get-balance existence probe returned an
       unexpected shape: ${JSON.stringify(data)}` ``.
    5. If `needsCreate`, require `targetAccount` to match
       `/^k:[A-Za-z0-9_-]+$/` specifically (not the looser `k:`/`c:`
       guard from step 3 — account CREATION assumes a single-key `k:`
       account, matching OuronetUI's own unconditional `target.slice(2)`
       key-stripping; a `c:`-prefixed target here is a shape the real UI
       never handles either, so treat it as a genuine error rather than
       guessing a guard construction for it): throw ``
       `ouronet.stoa-unwrap: cannot auto-create a non-k: target account:
       ${targetAccount}` `` otherwise. Strip the prefix via
       `stripPrefix(targetAccount)` (imported from `executor-signers.ts`).
    6. Build the one leg:
       - If `needsCreate`: `pactCode` is the two-form composite (joined
         by `"\n"`):
         ```
         (coin.C_CreateAccount (read-string "target") (read-keyset "ks"))
         (${ctx.runtime.namespace}.TS01-C2.LQD|C_UnwrapStoa (read-string "patron") (read-string "executor") (read-decimal "amount"))
         ```
         with `payload: { patron: patronAccount, executor, "amount":
         amount, target: targetAccount, ks: { keys: [strippedPubkey],
         pred: "keys-all" } }`.
       - Else: `pactCode` is just the second form above, `payload: {
         patron: patronAccount, executor, amount }` (no `target`/`ks`
         keys at all — they're meaningless when no account is being
         created).
       - `signers`: same append-not-replace treatment as T1 step 7, but
         the capability is `` `(coin.TRANSFER "${STOA_AUTONOMIC_LIQUIDPOT}"
         "${targetAccount}" ${amount})' `` — LIQUIDPOT→target, the
         REVERSE account order from wrap's patron→LIQUIDPOT (confirmed
         asymmetric per design.md §B — do not copy T1's capability
         line and swap names without re-deriving the arg order from the
         real OuronetUI spec cited there).
       - `config`, `gasPayer`: as parsed in step 2.
    7. `registerStepPlanner("ouronet.stoa-unwrap", stoaUnwrapPlanner);` at
       the bottom of the file.
  - Tests (`stoa-unwrap.test.ts`, same fixture style as T1/`evict.test.ts`):
    - "target account already exists → exactly one leg with the
      SINGLE-form pact code (no `coin.C_CreateAccount`), and no `target`/
      `ks` payload keys" — `dirtyRead` sequence: `UR_AccountKadena` →
      `{data:"k:target123..."}`, then existence probe → `{data:50}`
      (a number); asserts `legs[0].pactCode` is exactly the single
      `LQD|C_UnwrapStoa` form and `legs[0].payload` has no `target`/`ks`
      keys.
    - "target account does not exist → exactly one leg with the TWO-FORM
      composite pact code, in order (create THEN unwrap), with a
      correctly shaped `read-keyset` payload entry" — existence probe
      returns `{data:false}`; asserts `legs[0].pactCode` equals the exact
      two-line composite string and `legs[0].payload.ks` equals
      `{keys:["target123..."], pred:"keys-all"}` (prefix stripped).
    - "attaches a `coin.TRANSFER` capability scoped to
      `[STOA_AUTONOMIC_LIQUIDPOT, targetAccount, amount]` — LIQUIDPOT
      first, target second, the REVERSE order from wrap's capability" —
      asserts the exact capability string on signer 0.
    - "rejects a malformed `amount` before ever calling the chain" —
      `planner_params_json: {patronAccount:"k:res", amount:"-5.0"}`;
      asserts rejection with `/amount must be a non-negative decimal/`
      and `dirtyRead` never called.
    - "rejects when `UR_AccountKadena` returns a malformed (non k:/c:)
      target account" — existence-resolution read returns
      `{data:"garbage"}`; asserts rejection with `/malformed target
      account/`.
    - "rejects rather than guessing a guard when the resolved target is
      a `c:`-prefixed account and the account doesn't exist" —
      `UR_AccountKadena` returns `{data:"c:someModuleGuardAccount"}`,
      existence probe returns `{data:false}`; asserts rejection with
      `/cannot auto-create a non-k: target account/`.
    - "rejects when the existence probe returns a shape that is neither
      `false` nor a number" — existence probe returns
      `{data:"unexpected-string"}`; asserts rejection with /unexpected
      shape/.

## Wave 2 (depends on Wave 1)

- [x] T3: Barrel-export both new planners from `server/index.ts`. —
      done when: `grep -n "stoa-wrap\|stoa-unwrap" dist/server/index.d.ts`
      (after `npm run build`) shows both re-exported, and
      `node -e 'import("./dist/server/index.js").then(m =>
      console.log(typeof m.getStepPlanner("ouronet.stoa-wrap"),
      typeof m.getStepPlanner("ouronet.stoa-unwrap")))'` prints
      `function function`.
  - files: `packages/khronoton-core/src/server/index.ts` (extends the
    existing `planners/*` export block — currently `export * from
    "./planners/evict.js"; export * from "./planners/inject.js"; export
    * from "./planners/unstall.js";` — with two more lines for
    `stoa-wrap.js`/`stoa-unwrap.js`, and extends that block's existing
    heading comment to list the two new self-registration side effects
    (`registerStepPlanner("ouronet.stoa-wrap", ...)`,
    `registerStepPlanner("ouronet.stoa-unwrap", ...)`) alongside the
    three already documented there); reads (no changes)
    `planners/stoa-wrap.ts`, `planners/stoa-unwrap.ts` (T1/T2's output —
    this task cannot start until both exist, hence Wave 2).
