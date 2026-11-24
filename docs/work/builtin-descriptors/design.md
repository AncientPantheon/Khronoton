# Built-in descriptor + composable-fragment layer — Design

## Problem

The Hub-side ChainedBuilder UI (currently being built in parallel, in this same repo — confirmed
by reading its in-progress, uncommitted work this session: `ui/chained/ChainedBuilder.tsx` et al.)
needs two things the current `StepPlanner` registry (`server/planners/registry.ts`) can't give it:
a real per-field param FORM (not a raw JSON blob) for a chosen built-in, with a read-only preview of
what it will execute; and a way to COMPOSE certain built-ins (`stoa-wrap`/`stoa-unwrap`) into a
larger hand-written Pact block for a single-tx step, since today every planner OWNS its whole
transaction and can't be spliced into anything else. `inject`/`evict`/`unstall` genuinely can't be
composed this way either — they probe the chain, fan out, or read an on-chain plan; they're a
decision procedure, not a static expression.

## Approach

A new, browser-safe, pure data module — `packages/khronoton-core/src/builtins/descriptors.ts` —
describing all 5 registered built-ins plus 2 new composable-only ones (`stoa-transmit`/
`urstoa-transmit`, added mid-design — see below), re-exported from the existing `/ui` subpath barrel
(`src/ui/index.ts`, one added `export * from "../builtins/descriptors.js";` line) rather than a new
package.json subpath/exports-map entry or tsup config change — `/ui` is already the browser-safe,
React-external bundle this layer needs to live behind, and avoids touching `package.json`'s
exports map while a second, unrelated change (the ChainedBuilder UI work) is already mid-flight
against that same file. Zero imports from `server/executor.js`, `@stoachain/*`, or `node:crypto` —
verified for each descriptor below, since every one is derived from already-read planner source,
never calls into it.

Per-built-in treatment, derived directly from each real planner's own `*PlannerParams` interface
(read in full this session):

- **`ouronet.aqp-inject` (standalone).** Fields: `fvtId`/`patronAccount` (string, required),
  `executor` (`glyph-account`, required, help text lifted from `InjectPlannerParams.executor`'s own
  doc comment on why it must never be `k:`-prefixed), `rewardDptfId` (string), `amount` (`decimal`).
  `preview()` reports `entrypoints: ["CC_InjectFinalize", "CC_Inject"]` (the try-finalize-then-fallback
  order the real planner follows) with a summary naming the fvtId/amount.
- **`ouronet.aqp-evict` (standalone).** Fields: `fvtId`/`patronAccount` (string, required — the
  only two `EvictPlannerParams` fields). `preview()` reports
  `entrypoints: ["CC_FullEvictRewards", "CC_EvictSingleReward (fan-out)"]`.
- **`ouronet.aqp-unstall` (standalone).** Fields: `fvtId`/`patronAccount`/`rewardDptfId` (string,
  required — `UnstallPlannerParams`'s three fields; no `amount`, this built-in repairs staleness,
  never moves funds). `preview()` reports `entrypoints: ["CCp_FvtFixSlice (fan-out)"]`.
- **`ouronet.stoa-wrap` (composable, plus the existing standalone live-probe entry point stays —
  owner confirmed both forms).** Fields: `patronAccount` (`account`, required, `k:`/`c:` shape),
  `amount` (`decimal`, required, `allowExpr: true` — in composable mode this may be a Pact
  expression, e.g. a `let`-bound variable, not just a literal; standalone mode still live-probes
  `coin.get-balance` when no override is given, unchanged), `amountCeiling` (`decimal`, required in
  composable mode only — see the managed-capability subtlety below). `toFragment(params)` emits:
  `pactExpr: "(<ns>.TS01-C2.LQD|C_WrapStoa (read-string \"patron\") (read-string \"executor\")
  <amountExpr>)"` where `<amountExpr>` is `(read-decimal "amount")` when `amount` is a literal or
  `params.amount` verbatim when `allowExpr` is exercised (a raw Pact expression string the operator
  typed — composable mode is explicitly operator-authored Pact, unlike every standalone planner's
  "zero interpolated values" guarantee, which only applies to env-data-driven standalone legs);
  `payload: { patron: params.patronAccount, amount: <literal case only> }`; `requiredCaps: [{ line:
  '(coin.TRANSFER "<patron>" "<LIQUIDPOT>" <amountCeiling>)' }]` (using `amountCeiling`, never the
  possibly-dynamic `amount`, as the cap's literal argument — see below).
- **`ouronet.stoa-unwrap` (composable, plus the existing standalone entry point).** Fields:
  `patronAccount` (`account`, required), `amount` (`decimal`, required, `allowExpr: true`),
  `amountCeiling` (`decimal`, required), **plus `targetAccount` (`account`, required in composable
  mode) and `needsCreate` (`enum` of `"yes"|"no"`, required in composable mode)** — see below for
  why these two are new, composable-only fields with no standalone-param equivalent. `toFragment`
  emits the same two-form composition the real planner can produce (`coin.C_CreateAccount` ahead of
  `LQD|C_UnwrapStoa`) when `needsCreate === "yes"`, or just the unwrap form otherwise; the
  `coin.TRANSFER` cap uses the LIQUIDPOT→target order (confirmed reversed from wrap's own
  patron→LIQUIDPOT order by reading `stoa-unwrap.ts` directly this session) with `amountCeiling`.
- **`ouronet.stoa-transmit` / `ouronet.urstoa-transmit` (composable only — no standalone planner
  exists or is being added; confirmed no `transmit.ts` file exists under `server/planners/` today).**
  New built-ins, requested after the rest of this design was written — verified directly against
  the live STOA coin contract (`0_Stoa/coin-contract/coin-live.pact`, `module coin GOVERNANCE`, bare
  `coin.*`, matching wrap/unwrap's own no-namespace-prefix convention): `C_Transmit(sender,
  receiver, amount)` / `C_TransmitAnew(sender, receiver, receiver-guard, amount)` for STOA, and the
  `UR|`-prefixed pair `C_UR|Transmit`/`C_UR|TransmitAnew` for UrStoa (the "UR" prefix matches
  `stoa-unwrap.ts`'s own `DALOS.UR_AccountKadena` convention for the wrapped/liquid-staked token).
  Fields: `sender`/`receiver` (`account`, required — named to match the real Pact parameter names,
  per the handoff's own rule that a field's `name` is also the payload key the Pact code reads),
  `variant` (`enum` of `"transmit"|"transmit-anew"`, required — selects which of the two
  entrypoints `toFragment` emits, mirroring `stoa-unwrap`'s own `needsCreate` pattern for the same
  kind of "which on-chain form" choice), `amount` (`decimal`, required, `allowExpr: true`),
  `capAmount` (`decimal`, required — see Design decision 3 below, NOT the same thing as
  `amountCeiling`), `receiverPublicKey` (`string`, required only when `variant === "transmit-anew"`
  — builds the `receiver-guard` keyset argument as `{ keys: [receiverPublicKey], pred: "keys-all" }`,
  mirroring `stoa-unwrap.ts`'s own `strippedPubkey`/`keys-all` convention for account creation).
  `toFragment` emits `(coin.C_Transmit (read-string "sender") (read-string "receiver")
  <amountExpr>)` or, for the Anew variant, `(coin.C_TransmitAnew (read-string "sender")
  (read-string "receiver") (read-keyset "receiver-guard") <amountExpr>)` (`coin.UR|Transmit`/
  `coin.UR|TransmitAnew` for the UrStoa descriptor); `requiredCaps: [{ line: '(coin.TRANSMIT
  "<sender>" "<receiver>" <capAmount>)' }]` (`coin.UR|TRANSMIT` for UrStoa).

**Design decision 3 — `TRANSMIT`'s capability is UNMANAGED, so the ceiling pattern from decision 1
does not apply and reusing it would be actively wrong.** Read `coin-live.pact`'s actual `defcap`
block directly this session: `(defcap TRANSMIT (sender receiver amount) @doc "Similar to TRANSFER,
but unmanaged" @event (compose-capability (X_TRANSFER sender receiver amount)))` — no `@managed`
annotation, no manager function, unlike `TRANSFER`'s `@managed amount TRANSFER-mgr`. An unmanaged
capability requires the signed clist's literal arguments to EXACTLY match what the code's
`(with-capability (TRANSMIT sender receiver amount) ...)` call requests at runtime — not "within a
ceiling." If `amount` is a composed-in Pact expression whose runtime value genuinely isn't known
until execution (the handoff's own motivating case — "drain via transmit, THEN wrap," where the
drained amount is read mid-transaction), there is no safe looser value to grant in advance the way
a ceiling allows for the managed `TRANSFER` case; a mismatch is not "slightly over-permissioned," it
is a hard capability-acquisition failure (the whole transaction reverts). So `capAmount` here is
NOT a ceiling — it is **the operator's own exact promise of what the expression will evaluate to**,
and the field's `help` text says so explicitly, including the hard-revert consequence of a wrong
guess, rather than implying the same forgiving margin `amountCeiling` has for wrap/unwrap. This is
also why `capAmount` is a distinctly-named field from `amountCeiling` (never reused across the two
capability kinds) — collapsing them under one name would misrepresent what each actually guarantees.

**Design decision 1 — the managed-capability amount, resolved (per the handoff's own ask to "pick
the correct, safe design").** `coin.TRANSFER` is a managed capability with no env-data equivalent —
the handoff is correct that a composable `amount` may be an unknown-at-compose-time runtime
expression. Chosen: **always require a separate, literal `amountCeiling`** for both composable
built-ins (not conditionally, based on whether `amount` happens to be a literal) — simpler (one code
path, no Pact-expression-literalness detection, which would need real Pact parsing, explicitly out
of scope for a pure data/string module) and strictly safe (Pact's capability manager only enforces
that cumulative consumption never exceeds the installed ceiling; a ceiling that is `>=` the real
transfer amount is correct regardless of how much looser than "exact" it is, since nothing else in
the same signed transaction competes for the same cap). Documented in both composable descriptors'
`help` text for the `amountCeiling` field.

**Design decision 2 — `stoa-unwrap`'s two chain-read decisions, resolved.** The real
`stoaUnwrapPlanner` needs two live reads (`DALOS.UR_AccountKadena` to resolve the target account,
then a `coin.get-balance` existence probe) to decide whether to compose the create-account form —
directly conflicting with "composable `toFragment` must be pure, no on-chain probe." Resolved the
same way `stoa-wrap.ts`'s own `amountOverride` already resolves the identical tension for ITS live
probe: **composable mode takes the would-be-probed values as explicit operator-supplied params
instead** (`targetAccount` instead of resolving via `DALOS.UR_AccountKadena`; `needsCreate`
instead of the `coin.get-balance` existence probe) — zero chain reads, fully deterministic, and
consistent with the one precedent already established in this exact codebase for this exact
tension, rather than inventing a new one.

**Data types**, matching the handoff's own shape exactly (`BuiltinKind`, `BuiltinParamField`,
`RequiredCap`, `BuiltinFragment`, `BuiltinDescriptor`) — `BuiltinParamField.type` includes the
handoff's five kinds (`string`/`decimal`/`account`/`glyph-account`/`enum`); `help` text is lifted
and condensed from each real planner's own doc comments, not freshly invented, so the UI's help
copy stays traceable to the same source of truth the engine itself documents.

## Acceptance criteria

- [x] `src/builtins/descriptors.ts` has zero imports from `server/executor.js`, any `@stoachain/*`
      path, or `node:crypto` — mechanically checkable via the module's own import list.
- [x] All 7 built-ins (`ouronet.aqp-inject`, `ouronet.aqp-evict`, `ouronet.aqp-unstall`,
      `ouronet.stoa-wrap`, `ouronet.stoa-unwrap`, `ouronet.stoa-transmit`,
      `ouronet.urstoa-transmit`) have a registered `BuiltinDescriptor`. For the 5 with a real
      run-time planner, `name` matches the `registerStepPlanner(...)` name used in its
      corresponding planner file exactly. `stoa-transmit`/`urstoa-transmit` are composable-only —
      no `registerStepPlanner` call exists or is added for them; their `name` follows the same
      `ouronet.<slug>` convention without a backing planner registration.
- [x] Each descriptor's `params` field list matches its planner's required `planner_params_json`
      fields one-for-one for the standalone case (no missing field, no invented field the real
      planner doesn't read) — provable by a test enumerating each planner's own params interface
      fields against the descriptor's `params` names.
- [x] `stoa-wrap`/`stoa-unwrap`'s composable `toFragment` is pure and deterministic — two calls with
      identical params produce byte-identical output; no network/DB/randomness. Snapshot-tested:
      the exact `pactExpr`/`payload`/`requiredCaps` for at least one literal-amount case and one
      `allowExpr` case each.
- [x] `stoa-wrap`/`stoa-unwrap`'s `toFragment` always sources the `coin.TRANSFER` cap's literal
      amount argument from `amountCeiling`, never from `amount` — provable by a test where `amount`
      and `amountCeiling` differ and asserting the emitted cap line uses the ceiling value.
- [x] `stoa-transmit`/`urstoa-transmit`'s `toFragment` emits `coin.C_Transmit`/`coin.C_UR|Transmit`
      for `variant: "transmit"` and `coin.C_TransmitAnew`/`coin.C_UR|TransmitAnew` (with a
      `(read-keyset "receiver-guard")` third argument) for `variant: "transmit-anew"` — provable by
      one snapshot test per variant per descriptor (4 total).
- [x] `stoa-transmit`/`urstoa-transmit`'s required capability always sources its literal amount
      argument from `capAmount`, never from `amount` — same shape of test as the ceiling check
      above, asserting the DISTINCT field name (not `amountCeiling`) is what's used.
- [x] `stoa-transmit`/`urstoa-transmit`'s `capAmount` field's `help` text explicitly states the
      hard-revert consequence of a mismatch (unmanaged capability, no ceiling slack) — distinct
      wording from `amountCeiling`'s own help text, provable by a test asserting the two help
      strings are not equal and that `capAmount`'s mentions an exact-match/revert concept.
- [x] `inject`/`evict`/`unstall`'s `preview()` lists the real entrypoint name(s) their planner
      actually calls, in the real try-this-then-that order where one exists (inject:
      Finalize-then-Inject; evict: Full-then-fan-out; unstall: fan-out only).
- [x] The existing 5 run-time planners and their test files are byte-unchanged — this is a new,
      additive, read-only-of-their-shape layer, never a modification of planner behavior.
- [x] `/ui`'s existing barrel (`src/ui/index.ts`) gains exactly one new re-export line for this
      module; no existing export in that file is touched, removed, or reordered.

## Out of scope

- Any change to `server/planners/registry.ts`, `runs-driver.ts`, `run-advance.ts`, or
  `executor.ts` — this is a new pure layer beside the engine, never a semantics change to it (per
  the handoff's own explicit constraint).
- Per-step `serverResolver` support and raw-code paste-to-form parsing — both explicitly flagged by
  the ChainedBuilder work itself as deferred, unrelated to this layer.
- Actually wiring this descriptor module INTO `ChainedBuilder.tsx`'s param forms — that UI work is
  already in progress in a separate, concurrent stream (confirmed this session); this topic ships
  the layer the UI will import, not the UI-side consumption of it.
- Any new `package.json` subpath/exports-map entry — folding into the existing `/ui` barrel avoids
  this entirely, including avoiding a collision with the other in-flight change already touching
  `package.json`'s version field.
- A standalone run-time `StepPlanner`/`registerStepPlanner` for `stoa-transmit`/`urstoa-transmit` —
  these two are composable-only by the user's own explicit request; nothing calls
  `coin.C_Transmit`/`C_TransmitAnew`/`C_UR|Transmit`/`C_UR|TransmitAnew` through the engine's
  planner registry, only through a hand-composed single-tx step's spliced fragment.
- Any Pact-expression parsing/validation of an `allowExpr` field's actual string content — this
  module treats it as an opaque, trusted-because-operator-authored string, exactly like every
  other `allowExpr` field in this design; it is spliced verbatim into `pactExpr`, never inspected.
