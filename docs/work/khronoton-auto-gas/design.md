# Khronoton auto self-calibrating gas — Design

## Problem

Khronoton transactions default to a fixed, manually-set gas limit, so fires over-reserve
gas wildly — a real pool-payout fire measured 594 gas used against a 600,000 limit.
Verified against the current engine: `executor.ts`'s calibration source is a plain
`dirtyRead`, which reports execution gas only and omits the transaction-size charge (the
Kadena SDK's own doc confirms `dirtyRead` is the alias for `local` with both `preflight`
and `signatureVerification` false — "minimum restrictions," not the accurate measurement);
the simulate/fire ceiling is a hardcoded `AUTO_GAS_CEILING = 2_000_000` (StoaChain's own
limit, wrong for chainweb's 1.6M default or Kadena mainnet's 150k); nothing refuses a
transaction whose real gas need exceeds the block limit; and the Builder's own default is
`autoGasLimit: false` (manual). OuronetUI already solved all four problems client-side;
this brings the same behavior into the package so every consumer gets it by default,
including the engine's own unattended (no-browser) fire path.

## Approach

Scope tightly to the handoff's four mechanical asks — accurate calibration, live block
ceiling, default-on, refuse-unmineable — reusing the package's own existing structures
(`SimulateResult`/`FireResult`'s `error: string`, the existing `gate`/`canCommit` model)
rather than inventing new ones. Two new optional `ChainClient` capabilities, following the
0.9.0 `gasMeta` precedent exactly (optional or the package stops being chain-polyglot;
hard-throw only where a stale value would be unsafe, best-effort fallback everywhere it's
merely less accurate):

- **`preflightRead(tx): Promise<DirtyReadResult>`** — implemented in `stoachain.ts` via
  `client.local(tx, { preflight: true, signatureVerification: false })` (the SDK's raw
  `local` call with the OuronetUI reference's exact flags — not the SDK's own `.preflight`
  convenience alias, which sets `signatureVerification: true` and would add an extra check
  beyond what's asked). The typed return shape (`ILocalCommandResult`) is flat and
  structurally identical to the existing `DirtyReadResult` (`{ result, gas }`), so this
  slots into the executor's existing control flow with no new type. **Optional, and the
  executor hard-throws when `autoGasLimit` is true and it's absent** — exactly mirroring
  `gasMeta`'s "silent fallback ships the bug forever" reasoning: an un-upgraded custom
  `ChainRuntime` would otherwise keep calibrating against inaccurate execution-only gas
  forever without anyone noticing. **When `autoGasLimit` is false (a deliberate manual
  override), the executor keeps using plain `dirtyRead` as today** — a manual fire doesn't
  need the size-charge-accurate measurement, so an un-upgraded runtime's manual-gas fires
  stay byte-identical to today, unaffected by this change entirely.
- **`getBlockGasLimit(): Promise<number>`** — implemented via a `fetch` to the node's
  `/config` endpoint (deriving the origin from `getPactUrl`, mirroring OuronetUI's
  `fetchBlockGasLimit`'s origin-derivation and JSON-walk). **Optional, best-effort, NEVER
  throws** — on any failure (network, parse, an absent method on an older runtime) the
  executor falls back to `ctx.config.autoGasCeiling ?? AUTO_GAS_CEILING` exactly as today.
  This is deliberately the opposite risk stance from `preflightRead`: a stale ceiling
  estimate only affects the SIMULATE-at-ceiling sizing and the refuse-unmineable
  threshold — the real chainweb node is still the authoritative validator of what actually
  fits, so a wrong local guess degrades UX (a late rejection instead of an early, clear
  one) rather than safety. Matches OuronetUI's own documented choice here ("silently keeps
  the current value on any failure") — the reference itself did not treat this as
  hard-fail-worthy, and there's no principled reason to be stricter than the model we're
  copying.

**No module-level mutable cache** (unlike OuronetUI's `let currentBlockGasLimit`
singleton) — that pattern fits a single browser tab, not a Node process handling
concurrent fires across cronotons/chains. `getBlockGasLimit()` is called fresh per fire;
a fire happens at most every few seconds per cronoton, and it's one more HTTP round trip
alongside the several the fire path already makes (preflight, submit, listen) — not worth
the shared-state risk to avoid.

**Refuse-unmineable applies to BOTH auto and manual fires**, not just the auto-calibrate
path — broader than the handoff's literal framing (which discusses it in the context of
the auto-calibrate loop) but clearly in its spirit: a manually-set limit whose measured
gas exceeds the live block ceiling is exactly as unmineable as an auto-calibrated one, and
refusing loudly before submit costs nothing extra since the measurement is already being
taken. Reuses the existing `{ ok: false, error }` shape (`SimulateResult`/`FireResult`) —
no new result field.

**Default-on is a `ui/builder-state.ts` change only** — `makeEmptyBuilderState()`'s
`config.autoGasLimit: false → true`. `CodexTxConfig.autoGasLimit` has always been a
required `boolean` (not a new/optional field like `gasPriceBufferAnu` was), so there is no
genuinely-absent-on-old-rows case to default at read time the way that field needed;
"the engine's default when a stored cronoton doesn't pin a manual limit" in the handoff's
wording is satisfied by this being the only place a default is ever assigned in the first
place — an explicit `false` on an existing row stays `false` (an operator's deliberate
choice, never silently reinterpreted, matching this package's established self-healing
philosophy of enhancing forward without reinterpreting the past).

**Rejected alternatives:**
- Porting OuronetUI's full `gas-limits.ts` (sizeAdvisory, deployBindingBytes,
  line-headroom messaging, the pre-simulate `estimateSizeChargeGas` fallback) — real scope
  unrelated to the core defect; a separate, later ask if wanted, not blocking this fix.
- Hard-throwing on a missing/failed `getBlockGasLimit` (matching `preflightRead`'s
  stance) — rejected per the risk-profile argument above; would also make this package
  stricter than the reference it's explicitly modeled on.

## Scope (files)

- `server/seams.ts` — `ChainClient` gains optional `preflightRead`/`getBlockGasLimit`.
- `blockchain/stoachain.ts` — implement both.
- `server/executor.ts` — `runSimulate`/`runFire`: `preflightRead` (when auto) replaces
  `dirtyRead` as the calibration source, hard-throwing when absent-and-auto; ceiling
  resolved via `getBlockGasLimit()` with the existing constant as fallback; a new
  refuse-unmineable check (gasUsed > ceiling) applied to both auto and manual fires.
- `ui/builder-state.ts` — `makeEmptyBuilderState()` default flip.
- Test files for every module above.

No UI-surface changes planned in `ExecuteTab.tsx`/the new `SaveBar` (topic
`khronoton-editor-save`) — an unmineable refusal is a normal `sim.result.ok === false` +
`error` string, which both already render generically via their existing "Simulate
failed: …" branches. Verified no special-casing is needed; will re-confirm during build
that no test asserts a narrower error-shape assumption that would need updating.

## Acceptance criteria

- [ ] A newly-created cronoton defaults to AUTO gas (`makeEmptyBuilderState().config
      .autoGasLimit === true`); manual stays available as a deliberate toggle.
- [ ] An AUTO-gas simulate/fire calibrates from `preflightRead`'s measured gas (which
      includes the transaction-size charge), not the old execution-only `dirtyRead` value.
- [ ] The simulate/fire ceiling comes from a live `getBlockGasLimit()` fetch when
      available, falling back to the existing `AUTO_GAS_CEILING` constant on any failure —
      verified by a test where the fetch fails and the existing constant is still used
      correctly (no crash, no silent wrong ceiling).
- [ ] A transaction whose measured gas exceeds the resolved block ceiling is refused with
      a clear structured error (never silently capped, never submitted) — for both an
      AUTO-gas fire and a manually-set-limit fire.
- [ ] A `ChainRuntime` missing `preflightRead` fails loudly (hard throw / structured
      failure per F-002) on an AUTO-gas fire, but a MANUAL-gas fire on that same
      un-upgraded runtime is completely unaffected — same behavior as before this change.
- [ ] The AUTO-gas rebuild-and-resign path (the existing two-build fire flow) still
      re-derives its calibration fresh on the second build, now via `preflightRead` instead
      of `dirtyRead` — the existing 0.9.0-era "re-derives fresh, never reused" invariant
      carries over unchanged in spirit, now on the corrected measurement source.

## Out of scope

- OuronetUI's full gas-advisory UX module (`sizeAdvisory`, line-based headroom messaging,
  `deployBindingBytes`, the pre-simulate `estimateSizeChargeGas` client-side fallback for
  when preflight itself can't run) — a separate, later ask if wanted.
- Any change to the Hub's own fixed `payout-bulk-tx.ts` `DEFAULT_BULK_GAS_LIMIT` — the
  Hub's own orchestrator choice, explicitly called out in the handoff's Notes as not
  forced by this package default.
- Retrofitting `autoGasLimit` defaulting onto historical stored rows at read time — no
  genuinely-absent case exists for this always-required field (see Approach).
