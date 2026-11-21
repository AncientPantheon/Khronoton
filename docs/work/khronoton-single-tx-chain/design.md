# Khronoton optional single-tx chain variant — Design

## Problem

A chained cronoton (0.13.0+, step-to-step yield carry in 0.14.0) always
drives its work as N separate transactions across N steps. For some
chains — especially cheap or small ones — this is unnecessarily slow and
multiplies on-chain overhead (N transactions' worth of base cost) when
the whole chain's work could fit into one transaction. There is currently
no way for a cronoton to attempt a cheaper single-transaction execution
of its own chain, falling back to the proven step-by-step path only when
the single-tx attempt genuinely does not fit under the chain's gas
ceiling.

## Approach

Add an opt-in, per-cronoton "try single-tx first" mode: before driving a
chained run through the existing step machinery, Khronoton simulates a
single-transaction variant of the whole chain's work; if it fits under
the gas ceiling, it fires that one transaction and the run is done; if
specifically refused for being too expensive (mirroring
`ouronet.aqp-evict`'s own established try-then-fan-out precedent — the
same "refuse unmineable" signal, never any other kind of failure), it
falls through to the existing, already-proven step-by-step chain
unchanged. A genuine (non-gas) on-chain failure of the chosen single-tx,
once simulation has already said it fits, fails the run outright — Pact
transactions are atomic, so there is no partial-state risk, and a
business-logic revert is unlikely to be fixed by retrying the same work
split across the chain.

Two ways the single-tx variant's actual Pact code gets produced, split
into two separately-shaped topics given their very different
risk/complexity profile:

- **Custom mode** (Topic 1, shaped now): the operator supplies the
  composed single-tx Pact code (and its own payload/config/gas-payer/
  signers) directly — reusing the cronoton's own top-level `pact_code`/
  `payload_json`/`config_json`/`gas_payer_json`/`signers_json` fields,
  which already exist (`NOT NULL` in the schema) but sit unused,
  placeholder data for a chained row today. No new table, no code-
  generation logic — Khronoton only adds the simulate-then-decide
  orchestration on top of machinery that already exists.
- **Default mode** (Topic 2, deferred): Khronoton auto-composes the
  single-tx Pact code from the cronoton's existing step definitions,
  including the Ouronet-gas-station-specific "Case 3" shape (a namespace
  declaration + a mandatory IGNIS donation via `TS01-C1.DPTF|C_Transmute`
  + an uninspected `(let ...)` block) when the composed transaction is
  gas-station-sponsored, plus a matching `exec-code` env-data mirror the
  gas station's own `GAS_PAYER` capability re-derives and checks against
  the real transaction body. Deferred: needs the real `C_Transmute` call
  signature confirmed directly against the deployed contract, plus a
  capability-merging design for combining multiple steps' signer
  capabilities onto one composed transaction's signer list.

**Alternatives considered:**

- Orchestrate this entirely outside Khronoton — the embedding Hub
  schedules two independent cronotons, one single-tx, one chained, and
  decides which one "ran." Rejected: two independently-scheduled
  cronotons for one logical job is a real double-fire risk (nothing stops
  both becoming due around the same time unless the Hub's own
  coordination is airtight), whereas one cronoton with one run reuses
  Khronoton's already-proven self-blocking/claim machinery for free.
- Build Default-mode auto-composition first, since it is the more
  "complete" feature. Rejected for now: it depends on unverified,
  real-chain-specific Pact details (the Transmute signature, the IGNIS
  donation accounting, the gasless-patron exemption) that need direct
  confirmation against the real deployed contracts before any
  code-generation logic can be trusted. Custom mode has no such blocker
  and delivers real value immediately — including a self-paid (no
  gas-station, no donation) composed single-tx chain, which is likely
  the simpler and more common case.

## Topics

1. `khronoton-single-tx-custom` — the opt-in single-tx-first
   orchestration (simulate → fire-or-fallback-to-chain) plus Custom mode,
   where the operator supplies the composed single-tx Pact code directly;
   supports both self-paid and gas-station-sponsored gas payers for that
   one transaction, since Khronoton never needs to understand which one
   the operator's own code satisfies.
2. `khronoton-single-tx-default-compose` — Khronoton auto-composes the
   single-tx Pact code from a chain's existing step definitions,
   including the Ouronet-gas-station Case-3 donation/let-block/exec-code
   shape for the gas-station-sponsored case, and recognizing the
   "gasless DALOS patron" exemption. Blocked on confirming the real
   `TS01-C1.DPTF|C_Transmute` call signature and the gasless-patron
   account identifier directly with the project owner; shaped once both
   are available.
