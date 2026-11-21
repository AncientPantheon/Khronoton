# Khronoton single-tx-first orchestration + Custom mode — Design

Topic 1 of 2 under `docs/work/khronoton-single-tx-chain/design.md` — see
that doc for the full problem statement, the sibling Default-mode topic,
and the alternatives considered at the project level.

## Problem

Every chained cronoton today always drives its work as N separate
transactions, one per step, even for a chain cheap enough that the whole
thing would easily fit in a single transaction with room to spare. There
is no way to attempt a cheaper, faster single-transaction execution and
fall back to the proven step-by-step chain only when it is genuinely
needed.

## Approach

Add two new fields to `codex_cronotons`: an opt-in boolean
(`try_single_tx_first`, `NOT NULL DEFAULT 0`) and a mode flag
(`single_tx_mode TEXT CHECK (single_tx_mode IN ('custom', 'default'))`,
meaningful only when the boolean is on). This topic implements only the
`'custom'` branch; committing or editing a cronoton with
`single_tx_mode = 'default'` is rejected with a clear validation error
until the sibling Default-mode topic ships — never silently accepted and
ignored.

When `try_single_tx_first` is on and `single_tx_mode = 'custom'`, the
cronoton's own existing top-level `pact_code`/`payload_json`/
`config_json`/`gas_payer_json`/`signers_json` fields (already required,
`NOT NULL`, currently unused placeholder data for any row that also has
`codex_cronoton_steps` rows — confirmed by reading `tick.ts`'s own
chained-vs-plain branch, which never touches these fields once ≥1 step
row exists) are reinterpreted as the single-tx variant: the operator
writes their own composed Pact code there directly, exactly as they
would for a plain one-shot cronoton, except this cronoton *also* has
steps declared as the fallback chain.

At the exact point a chained row's work would normally begin —
`tick.ts`'s due-row branch and `handlers/execute.ts`'s `executeNow`
manual-trigger branch, both of which already decide "chained vs plain"
on `steps.length > 0` — insert one more decision ahead of it, only when
`try_single_tx_first` is on:

1. Simulate the row's own `pact_code`/payload/config/gas-payer/signers
   (via the existing `executeCodexTransaction(..., "simulate", ...)`
   seam — no new executor mode needed).
2. **Fits** (simulate succeeds, gas under the ceiling): fire it via the
   exact same plain one-shot path (`fireByServerResolver`/`recordFire`)
   a non-chained cronoton already uses today. The chained run/step
   machinery is never touched; the firing is recorded as an ordinary
   `codex_cronoton_fires` row, identical to any one-shot fire.
3. **Refused specifically for being too expensive** (a numeric `gasUsed`
   present on an `{ok:false}` simulate result — the executor's existing
   "refuse unmineable" signal, the same one `ouronet.aqp-evict` already
   reads to decide "fan out instead"): fall through to the existing
   chained-run path (`createRun`/`driveRunOnce`), completely unchanged.
4. **Any other simulate failure** (a genuine Pact error, unrelated to
   gas): propagate as a real error — never silently treated as "fall
   back to the chain," mirroring `evict`'s own established discipline for
   the identical decision shape one level down.
5. **The single-tx variant is actually fired (step 2) and then genuinely
   fails for real** (a true on-chain revert, not a gas issue): the fire
   is recorded as failed, exactly as a plain one-shot cronoton's fire
   failure is recorded today. No fallback to the chain at this point —
   Pact transactions are atomic, so no partial state exists to recover
   from, and the underlying failure is a business-logic one the chained
   path would very likely hit too.

Both existing Khronoton gas-payer types (`type: "codex"`, self-paid;
`type: "gas-station"`, sponsored) are already supported end to end by
the executor/signer-planning code this reuses — Custom mode needs no new
gas-payer logic. The operator's own hand-written Pact code is
responsible for satisfying whatever the gas station's `GAS_PAYER`
capability actually requires (e.g. the Ouronet gas station's documented
donation/let-block shape for a sponsored composed transaction); Khronoton
only fires whatever Pact code + signers the operator configured, exactly
as it already does for any other stored transaction.

**Alternatives considered:** see the parent topic's design.md for the
full comparison against Hub-level two-cronoton orchestration and against
building Default mode first.

## Acceptance criteria

- [x] A cronoton with `try_single_tx_first` off behaves byte-identically
      to today — no simulate-first step, no behavior change — for both
      scheduled (tick) and manually-triggered (`executeNow`) firing.
- [x] A cronoton with `try_single_tx_first` on, whose single-tx Pact code
      simulates under the gas ceiling, fires that one transaction via the
      existing plain one-shot path and never creates a
      `codex_cronoton_runs` row — proven by asserting zero rows in
      `codex_cronoton_runs`/`codex_cronoton_run_legs` and one new row in
      `codex_cronoton_fires`.
- [x] A cronoton with `try_single_tx_first` on, whose single-tx Pact code
      is refused specifically for exceeding the gas ceiling, falls
      through to driving the existing step-by-step chain exactly as a
      `try_single_tx_first`-off cronoton would — proven end to end via a
      real `driveRunOnce` run reaching `succeeded` through the normal
      step machinery.
- [x] A cronoton with `try_single_tx_first` on, whose single-tx Pact
      code's simulate fails for a genuine non-gas reason, surfaces that
      as a real error — never silently falls back to the chain.
- [x] A cronoton with `try_single_tx_first` on, whose single-tx Pact code
      passes simulation but genuinely fails at real fire time, is
      recorded as a failed fire — never retried via the chain in the same
      pass.
- [x] Both gas-payer types (`codex` and `gas-station`) work for the
      single-tx attempt, using the exact same executor/signer-planning
      path a plain one-shot cronoton already uses — no new
      gas-payer-specific code needed.
- [x] `single_tx_mode: 'default'` is rejected at commit/edit time with a
      clear validation error — never silently accepted and ignored.
- [x] Setting `try_single_tx_first = true` on a cronoton with zero steps
      is rejected at commit/edit time with a clear validation error,
      since there would be no fallback chain for the flag to ever fall
      back to.

## Out of scope

- Default mode (Khronoton auto-composing the single-tx Pact code from
  the chain's own step definitions) — the sibling topic,
  `khronoton-single-tx-default-compose`, blocked on confirming the real
  `TS01-C1.DPTF|C_Transmute` signature and the gasless-patron account
  identifier.
- Any Ouronet-gas-station-specific composition logic (the Case-3
  namespace/donation/let-block shape, the `exec-code` env-data mirror,
  the "gasless DALOS patron" exemption) — these only matter for
  auto-generating the single-tx Pact code, which Custom mode never does;
  the operator's own hand-written code is responsible for satisfying the
  gas station however they choose.
- Any change to the existing chained-run machinery itself (schema,
  driver, step-to-step yield carry) — this topic only adds a new decision
  BEFORE that machinery is reached, never inside it.
- A standalone HTTP route or UI for toggling `try_single_tx_first`/
  supplying the single-tx Pact code — reuses `commitCodexCronoton`'s/
  `editCodexCronoton`'s existing input surface, widened with the two new
  fields, the same pattern as every other optional field added to that
  type across this project's history.
