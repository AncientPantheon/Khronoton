# Locked live-floor gas + priority buffer — Design

## Problem

0.9.0 made the *executor* floor a stale stored ANU value against the live Yin Engine
floor, so a fire can no longer underprice. But the Builder UI still frames gas price as
something an operator *sets* — an absolute "Gas Price (ANU)" number input, validated
only against a static/optional floor snapshot. That framing is wrong for a recurring
scheduled transaction: any absolute number typed today is guaranteed to go stale as the
live floor keeps rising, and the UI gives the operator no way to tell whether their
stored number still means anything. The right mental model is "always pay the live
floor, plus an optional explicit premium" — never an absolute price.

## Approach

Replace the absolute price with two things: a read-only, live-refreshing "network floor
right now" display, and an editable "priority buffer" (ANU above the floor, default 0,
never negative). `CodexTxConfig` gains `gasPriceBufferAnu`; the executor prices every
fire as `liveFloor(creationTime) + buffer`, derived fresh at build time, never cached.
Existing stored rows (no buffer field) default to buffer 0 — "pay exactly the floor" —
so every pre-migration cronoton self-heals with zero manual re-editing, same property as
the 0.9.0 fix.

**One deviation from the literal handoff snippet, with evidence:** the handoff's
executor code calls `gasMeta(0)` for the raw floor, then separately converts the buffer
via a bare `anuToStoaNumber(buffer)` and adds the two STOA floats. Verified empirically
that this reintroduces the exact precision bug 0.9.0 fixed — summing two independently-
converted decimal floats produces a different serialized value than converting the
summed ANU once, in ~21% of floor/buaffer pairs tested, and the result can round the
shipped price fractionally *below* the intended floor+buffer:

```
anuToStoaNumber(11569) + anuToStoaNumber(500)   → JSON: 1.2068999999999999e-8
anuToStoaNumber(11569 + 500)                     → JSON: 1.2069e-8   (different string)
```

Fix: extend the existing `ChainRuntime.gasMeta(floorAnu, bufferAnu?)` with an optional
second parameter. The adapter sums `floorAnu` (still 0 here — no legacy stored value to
respect) and `bufferAnu` **in ANU**, then converts **once**. This is non-breaking
(TypeScript accepts a shorter existing implementation — `(floorAnu: number) => X` — as
satisfying a supertype with an added optional parameter), preserves the "one clock read,
both fields from one call" invariant seams.ts already documents as load-bearing, and
keeps all ANU/STOA math inside the adapter (the 0.9.0 architecture goal — the executor
stays chain-unit-ignorant). Every one of the handoff's 4 verification steps is satisfied
identically either way; this changes only internal arithmetic ordering, not behavior,
UX, or the call shape at either `buildTransaction` call site.

**Rejected alternative:** the literal two-call/float-sum version, as originally
specified — rejected for the precision reason above, not a stylistic preference.

**Live floor display**, per the handoff: poll every 30s, plus a `visibilitychange` +
`focus` backstop (setInterval throttles in backgrounded tabs; this screen is left open
for hours). Centralized in one `useLiveGasFloor()` hook (`ui/builder/live-gas-floor.ts`)
called once in `Builder.tsx` and threaded as a `liveFloorAnu` prop to `ConfigTab` and
`ExecuteTab` (both *display* the floor to the operator), rather than three independent
polling components drifting against each other. `TxMeters`' byte-size estimate and
`tx-size.ts`'s serialize-and-measure path need no live prop — they already do on-demand
dynamic `@stoachain/*` imports (existing pattern), so they compute the floor fresh at
estimate time instead of subscribing to the polled value.

**Dead fields removed, not deprecated-in-place**, at the UI layer: `BuilderConfig
.gasPriceAnu` and `CommitGateOptions.minGasPriceAnu` have no meaning once there is no
absolute price to floor-check, so they are removed (not kept as inert leftovers). The
*server*-side `CodexTxConfig.gasPrice` is kept, deprecated, read-only — needed to parse
`config_json` on historical rows during rehydration.

## Scope (files)

- `server/types.ts` — `CodexTxConfig`: add `gasPriceBufferAnu`, deprecate `gasPrice`.
- `server/seams.ts` — `ChainRuntime.gasMeta`: optional `bufferAnu` 2nd param + doc update.
- `blockchain/stoachain.ts` — sum `floorAnu + bufferAnu` in ANU before the one
  `anuToStoaNumber` conversion.
- `server/executor.ts` — `buildTransaction()`: `runtime.gasMeta(0, definition.config
  .gasPriceBufferAnu ?? 0)`, both call sites (pre-flight + AUTO-gas rebuild), each fresh.
- `ui/builder-state.ts` — `BuilderConfig.gasPriceAnu` → `gasPriceBufferAnu`; drop
  `GENESIS_MIN_GAS_ANU`/`CommitGateOptions.minGasPriceAnu`; `maxTxFee` takes a
  `liveFloorAnu: number | null` param, returns `null` while unresolved;
  `builderToCommit` emits `gasPrice: 0` (deprecated, honest placeholder) +
  `gasPriceBufferAnu`; `validateConfig` drops the absolute-floor check, adds
  `gasPriceBufferAnu < 0` → reject; `detailToBuilderState` migration default
  `gasPriceBufferAnu: storedConfig.gasPriceBufferAnu ?? 0`.
- `ui/builder/live-gas-floor.ts` (new) — `useLiveGasFloor()` hook: 30s interval +
  visibilitychange + focus, dynamic `@stoachain/stoa-core/gas` import, `null` until
  first resolution.
- `ui/builder/ConfigTab.tsx` — remove the editable price input; add read-only "Live
  network floor" display, editable "Priority buffer" input (clamped-reject negative via
  the existing blocking-reasons path, not silent clamping — matches how `ttl`/`gasLimit`
  already validate), and a computed "estimated price" line; accepts `liveFloorAnu` prop.
- `ui/builder/ExecuteTab.tsx` — `gasLine` reads floor(+buffer) instead of the absolute
  field; accepts `liveFloorAnu` prop.
- `ui/builder/TxMeters.tsx` — dependency-array swap: `gasPriceAnu` → `gasPriceBufferAnu`.
- `ui/builder/Builder.tsx` — call `useLiveGasFloor()` once, thread to the two tabs.
- `ui/tx-size.ts` — compute `minGasPriceAnu(now) + config.gasPriceBufferAnu` in ANU,
  convert once (same precision fix as the executor, applied here too).
- Test files for every module above; `CHANGELOG.md`/`README.md`; `package.json` bump.

## Acceptance criteria

- [ ] A cronoton created before this change loads with buffer `0` and fires at exactly
      the live floor (no manual re-edit).
- [ ] A new cronoton with a 500 ANU buffer fires with `cmd.meta.gasPrice` equal to
      `anuToStoaNumber(liveFloorAnu + 500)` — a single exact conversion, not two summed.
- [ ] The Builder UI's "Live network floor" display updates on its own after being left
      open (interval), and immediately on refocusing a backgrounded tab.
- [ ] Typing a negative priority buffer blocks commit with a clear reason; it is never
      silently accepted.
- [ ] The AUTO-gas rebuild (second `buildTransaction` call) re-derives `gasMeta` fresh —
      not reused from the pre-flight build — exactly as in 0.9.0.
- [ ] `BuilderConfig`/`CommitGateOptions` no longer expose `gasPriceAnu`/
      `minGasPriceAnu` — confirmed removed, not left as dead/misleading surface.

## Out of scope

- The AncientHoldings Hub's independent codex-cronoton Builder UI/executor — separate
  handoff, structurally disconnected from this package.
- Dropping `CodexTxConfig.gasPrice` entirely (the deprecated server-side field stays for
  reading historical rows; a future MAJOR can remove it once nothing reads it).
- Any change to how `gasMeta`'s existing `floorAnu` (raise-a-stored-value) semantics
  work for a hypothetical future caller still using it that way — `buildTransaction`
  simply always passes `0` there now since there is no more stored absolute value to
  respect.

## Versioning note

This is **not** purely additive at the UI-type layer: `BuilderConfig.gasPriceAnu` and
`CommitGateOptions.minGasPriceAnu` are removed (not deprecated-in-place), which breaks
any direct consumer of those two exported TS types. `CodexTxConfig` itself stays
additive (`gasPrice` kept, `gasPriceBufferAnu` new). Per this package's established
practice (0.7.0–0.9.0 all shipped MINOR for real behavior/safety changes with narrow,
flagged breaks), propose **MINOR** with the removed-surface called out explicitly in the
CHANGELOG, rather than MAJOR — the known consumer (Pythia) mounts the bundled Builder UI
wholesale and does not construct `BuilderConfig`/`CommitGateOptions` directly, so the
practical break is contained to the CHANGELOG's job of warning any other direct
consumer.
