# khronoton-chained-runs-phase-4b — Design

## Problem

Per the parent design (`docs/work/khronoton-chained-runs/design.md`, "Topics"
§4, owner correction 2026-11-19), Phase 4b ships **four** built-ins, not
two: `ouronet.aqp-inject`, `ouronet.aqp-evict` (both built and reviewed —
see `khronoton-chained-runs-phase-4`/`-phase-4.1`), and two the original
handoff didn't call out — `ouronet.stoa-wrap` and `ouronet.stoa-unwrap`.
These need a built-in for a different reason than inject/evict: not
leg-construction/fan-out complexity, but because **getting the Pact
capability set right by hand is the dangerous, easy-to-get-wrong part**
(parent design, line ~347) — a wrong capability scope can grant more
authority than intended, independent of whether the step fans out at all.

The parent design also flagged an open question: the source handoff only
verified `wrap`'s live route (`03_TS01-C2.pact:142`) because the driving
job never needed the inverse, and explicitly deferred `stoa-unwrap`'s
verification to "when this phase is actually shaped" — i.e., now.

**Research finding that corrects the parent design's premise:** contrary
to the parent design's implication that unwrap might need new Pact-side
work, `LQD|C_UnwrapStoa` is a real, live, already-shipped route
(`03_TS01-C2.pact:141`/`1821`, delegating to `LIQUID.C_UnwrapStoa`,
`12_LIQUID.pact:575`), wired in OuronetUI's dashboard since
`addedInVersion: "0.3.20"` (2026-05-15). Both built-ins can be built now.

## Approach

### A. `ouronet.stoa-wrap` — live-balance-read amount, one capability-bearing leg

**Real route** (verified against `03_TS01-C2.pact:1838` and
`12_LIQUID.pact:612`): `ouronet-ns.TS01-C2.LQD|C_WrapStoa (patron:string
executor:string amount:decimal)`. Capability chain: `LIQUID|C>WRAP` →
`LIQUID|C>X_WRAPPER` → `DALOS.CAP_EnforceAccountOwnership` (account-level,
enforced by the contract itself — nothing this planner constructs).

**The one capability this planner DOES construct**: OuronetUI's own spec
(`tokenOpSpecs.tsx:660-702`, `TF_WRAP_STOA`) grants a `coin.TRANSFER`
capability scoped to `[patronAccount, STOA_AUTONOMIC_LIQUIDPOT, amount]` —
the exact same amount as the call itself. `STOA_AUTONOMIC_LIQUIDPOT` is a
fixed, public, non-secret system account
(`"c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI"`, confirmed from
`ouronet-core/src/constants/ouronet.ts:44`) — a module-local constant in
this planner, not a dynamic value.

**Amount is a LIVE chain read, not an inter-step-carried value.**
The handoff's own instruction is "wrap the EXACT drained amount, not the
account's balance" — but Khronoton has no mechanism today for one step to
hand a value to the next (`context_json` on `codex_cronoton_runs` is
write-once at `createRun`, never updated by any driver code — confirmed by
grep). Rather than build that inter-step-context plumbing now (out of
scope — see below), this planner reads the patron account's CURRENT STOA
balance via `coin.get-balance` (a `dirtyRead`, not a signed tx) immediately
before building the leg. This is both simpler and more correct: the
handoff's own Stage-Two precedent for inject's "full balance, not a stored
amount" is exactly this self-correcting principle — *"the dispenser
balance IS the carried state... if a later part fails, the funds sit and
you retry."* Applied here: if the drain step landed and wrap didn't run
yet (or failed and is re-planned), the dispenser's balance at read-time
already equals exactly what's eligible to wrap — no double-count, no
staleness, no new engine feature required.

**Signer shape:** the planner adds (or requires already-present, mirroring
`effectiveSigners`'s own "already present? leave untouched" posture) one
`capabilityMode:'scoped'` signer whose `capabilities` string is
`` `(coin.TRANSFER "${patronAccount}" "${STOA_AUTONOMIC_LIQUIDPOT}"
${amountDecimalLiteral})` ``. **This is a deliberate, narrow exception to
the "never interpolate into executed code" rule** established in
`evict.ts`'s review — and it has to be, because Pact's own signer-capability
mechanism (the signed `clist`) has no `read-string`/env-data equivalent;
capabilities must be literal in the signed command, by Pact's own design.
The exception is made SAFE two ways, not by trusting the inputs:
1. `patronAccount` is shape-guarded (`^[kc]:[A-Za-z0-9_-]+$`-style check,
   same posture as `evict.ts`'s `isWellFormedEvictLeg`) before it reaches
   either the payload OR the capability line — it never carries a quote,
   paren, or space.
2. `amount` is never a trusted string from an external source — it is a
   **number** this planner reads from `coin.get-balance` and formats
   itself (e.g. `amount.toFixed(12)` or similar, stripped of trailing
   zeros down to at least one decimal digit) into a controlled decimal
   literal, exactly the shape `inject.ts`'s `/^\d+\.\d+$/` regex already
   validates elsewhere in this codebase — never a pass-through of
   arbitrary chain-read text.

The call's own `pactCode` — `(ouronet-ns.TS01-C2.LQD|C_WrapStoa
(read-string "patron") (read-string "executor") (read-decimal "amount"))`
— follows the established env-data pattern exactly like `evict.ts`/
`inject.ts`: zero interpolated values in the executed code itself. Only
the signer's capability line (which Pact's own design puts outside that
mechanism) needs the narrower, explicitly-documented treatment above.

**Shape:** always exactly ONE leg (no fan-out — the parent design is
explicit that wrap needs a built-in for the capability reason alone, not
because it ever produces more than one leg). If the live-read balance is
`0`, the planner returns `[]` (step trivially satisfied — mirrors
`unstallPlanner`'s own "zero stale users → `[]`" convention) rather than
submitting a doomed zero-amount wrap.

### B. `ouronet.stoa-unwrap` — conditional two-form composite leg, asymmetric capability

**Real route** (verified against `03_TS01-C2.pact:1821` and
`12_LIQUID.pact:575`): `ouronet-ns.TS01-C2.LQD|C_UnwrapStoa (patron:string
executor:string amount:decimal)`. Capability chain: `LIQUID|C>UNWRAP` →
composes `LIQUID|CONVERTER` + `LIQUID|NATIVE-AUTOMATIC` — **does NOT call
`CAP_EnforceAccountOwnership`**, a real, material asymmetry vs. wrap (so
this planner is NOT a mirror image of A; it is independently derived from
its own real route, not copy-pasted from wrap with names swapped).

**Amount is an explicit planner param, not a live-read "full balance."**
Unlike wrap (where the handoff gives an explicit, confirmed "exact drained
amount" semantic), no equivalent confirmed semantic exists for "unwrap the
full WSTOA balance" — the driving job this feature was built for never
calls unwrap at all (handoff §0's three-step job is drain→wrap→inject→
evict; unwrap is being built ahead of a confirmed consumer, per the
parent design's own "ship the built-in, not the job" framing for Phase 4b).
Guessing an auto-full-balance semantic here would be exactly the kind of
invented behavior the ported `split-plan.ts`'s own doc comment warns
against ("deliberately NOT ported... a failure here is a plain
`{ok:false}` return, never a thrown error and never a silently-accepted
oversized batch — the caller decides"). `amount: string` (same validated
non-negative-decimal shape as `inject.ts`'s own `amount` field) comes from
`planner_params_json`, same as `fvtId`/`patronAccount`/`rewardDptfId`
elsewhere.

**Target-account probe (real mechanism, not invented):** verified against
`ouroWrapFunctions.ts:212` / `ouroPriceFunctions.ts:46` /
`tokenOpSpecs.tsx:985-991`. Two reads, both `dirtyRead`:
1. Resolve the target StoaChain address:
   `(ouronet-ns.DALOS.UR_AccountKadena (read-string "unwrapper"))`.
2. Check existence: `(try false (coin.get-balance (read-string
   "target")))` — `data === false` means the account doesn't exist yet;
   a numeric/decimal result means it does. The target string returned by
   step 1 is chain-read-sourced, so it is shape-guarded (same
   `^[kc]:[A-Za-z0-9_-]+$`-style check as §A) before it's used anywhere
   downstream — in payload, in a capability line, or as a guard-derived
   pubkey.

**Composite leg — real mechanism, not string-concatenation.** OuronetUI's
own registry assembles `coin.C_CreateAccount` + `LQD|C_UnwrapStoa` as two
independently-rendered forms, verified to both survive inside one wrapped
body (`RegistryOpCFMModal.tsx`'s "customCode dropped a rendered leg"
guard) — i.e., ONE Pact transaction containing two top-level forms in
sequence, not two separate transactions and not raw string-splicing of
untrusted text. This planner ports that STRUCTURE (two env-data-only forms
joined by a newline inside one `pactCode`, when creation is needed) but
deliberately drops OuronetUI's own `IGNIS.C_Collect`/
`IGNIS.UDC_CustomCodeCumulator` billing preamble (`tokenOpSpecs.tsx:1018-
1021`) — that call exists to charge OuronetUI's own "custom code builder"
UI feature fee for constructing an ad-hoc composite transaction through
its generic registry; it has nothing to do with the underlying
`coin.C_CreateAccount`/`LQD|C_UnwrapStoa` contracts, and charging it from
a backend automaton calling these entrypoints directly (not through that
UI feature) would incorrectly bill the patron for a UI mechanic that was
never invoked. **This is a judgment call, flagged explicitly for the
review/final read, not a silent drop** — if real-world testing against a
testnet later shows the contracts themselves expect this collection call
as a precondition (not just a UI billing convenience), that would surface
as a genuine on-chain refusal during simulate, which this planner's
existing try/fallback-to-genuine-error posture already handles safely
(see Out of scope).

When creation is needed, the composite `pactCode` is:
```
(coin.C_CreateAccount (read-string "target") (read-keyset "ks"))
(ouronet-ns.TS01-C2.LQD|C_UnwrapStoa (read-string "patron") (read-string "executor") (read-decimal "amount"))
```
with `payload["ks"] = { keys: [strippedTargetPubkey], pred: "keys-all" }`
— `read-keyset` reads a `{keys, pred}`-shaped object directly from
transaction data, the same env-data mechanism as `read-string`/
`read-decimal`, confirmed against `coin.C_CreateAccount`'s real signature
(`talos-registry/src/tooltip.ts:224`: `[["account","string"],
["guard","guard"]]`). When the target already exists, `pactCode` is just
the second form.

**Signer shape:** OuronetUI's spec grants `coin.TRANSFER` from
`STOA_AUTONOMIC_LIQUIDPOT` to the target account, signed under what the UI
calls the "gas-station's caps key" (`nativeCapsNeedPaymentKey: false`) —
distinct from wrap's "resident's own payment key" signer. This planner
constructs the equivalent capability line
(`` `(coin.TRANSFER "${STOA_AUTONOMIC_LIQUIDPOT}" "${target}"
${amountDecimalLiteral})` ``) the same guarded way as §A (shape-guarded
account strings, a validated decimal-formatted amount — here taken
directly from the already-validated `planner_params_json` `amount`
field, not a live read). WHICH physical key ends up signing this
capability is the cronoton author's responsibility (same posture as
Phase 4.1 design.md §E's step-sequencing convention) — this planner
builds the required capability SHAPE on whichever signer the step's
`signers_json` supplies, same as every other planner in this codebase.

**Shape:** always exactly ONE leg (never fans out — same rationale as
wrap: the built-in exists for the capability/account-creation complexity,
not for leg-count).

### C. The capability-line exception, stated once for both planners

Both planners construct a `CodexSigner.capabilities` string directly
(template-literal interpolation), which is the one place in this codebase
that deliberately departs from the "every dynamic value flows through
payload + read-X" rule `evict.ts`'s review established. This is necessary
(Pact's signed `clist` has no env-data equivalent) and is made safe by:
shape-guarding every account string before it is used anywhere (payload
OR capability line), and by only ever interpolating amounts that this
planner itself formatted from a trusted source (a live numeric chain read,
or an already-regex-validated planner param) — never a raw pass-through
of untrusted text. No new "capability-line builder" abstraction is
introduced (checked: no existing builder in this codebase, per research;
a one-off template literal matches the established, already-shipped
precedent in `executor-signers.ts`'s own `DALOS.GAS_PAYER` capability
line, rather than inventing a new generic abstraction this change doesn't
need).

## Acceptance criteria

- [ ] `ouronet.stoa-wrap` reads the patron account's live STOA balance via
      `coin.get-balance` and builds exactly one leg whose `pactCode` and
      `payload` carry that balance as `amount`, with zero interpolated
      values in `pactCode` itself.
- [ ] `ouronet.stoa-wrap` returns `[]` (never a zero-amount leg) when the
      live balance read is `0`.
- [ ] `ouronet.stoa-wrap`'s leg's signer carries a `coin.TRANSFER`
      capability scoped to `[patronAccount, STOA_AUTONOMIC_LIQUIDPOT,
      amount]`, with the same `amount` as the call.
- [ ] `ouronet.stoa-unwrap` with a target account that already exists
      produces exactly one leg with a single-form `pactCode` (no
      `coin.C_CreateAccount`).
- [ ] `ouronet.stoa-unwrap` with a target account that does not exist
      produces exactly one leg with a two-form composite `pactCode`
      (`coin.C_CreateAccount` then `LQD|C_UnwrapStoa`), with a correctly
      shaped `read-keyset` payload entry.
- [ ] `ouronet.stoa-unwrap`'s leg's signer carries a `coin.TRANSFER`
      capability scoped to `[STOA_AUTONOMIC_LIQUIDPOT, targetAccount,
      amount]`.
- [ ] A chain-read-sourced account string (the unwrap target) that fails
      the shape guard is rejected with a genuine error before it reaches
      either `payload` or a capability line.
- [ ] Every Pact-code string built by either planner contains zero
      interpolated values in the EXECUTED code — only each leg's signer's
      `capabilities` string interpolates (shape-guarded accounts,
      self-formatted amounts), documented and tested as the one
      necessary exception.

## Out of scope

- Any inter-step `context_json` update mechanism — wrap's amount is
  sourced by a live balance read specifically to avoid needing this (see
  §A). If a future built-in genuinely needs step-to-step carried state,
  that is its own topic, not bundled into this one.
- `IGNIS.C_Collect`/`IGNIS.UDC_CustomCodeCumulator` billing — deliberately
  not ported (see §B). If simulate later proves this is load-bearing (not
  just a UI fee), that surfaces as a genuine on-chain refusal, handled by
  the planner's ordinary error-propagation path, not silently swallowed.
- Resolving WHICH physical signer key plays "payment key" vs "gas-station
  caps key" vs "account key" — same cronoton-author-responsibility posture
  as every other planner in this codebase (design.md §E of Phase 4.1).
- An "unwrap the full WSTOA balance" auto-amount semantic — no confirmed
  real-world consumer needs it yet (see §B); `amount` stays an explicit,
  validated planner param until one does.
- The merge optimiser (Phase 6) — explicitly owner-deferred, unrelated to
  this topic.
