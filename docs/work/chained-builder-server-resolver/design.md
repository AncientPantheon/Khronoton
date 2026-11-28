# Surface the server resolver in `ChainedBuilder` — Design

Handoff: `Z:\StoaChain\_hub\AncientHoldings\docs\work\chained-cronoton-edit\khronoton-agent-handoff-server-resolver.md`
(local: `~/ClaudeWS/StoaChain/_hub/AncientHoldings/docs/work/chained-cronoton-edit/khronoton-agent-handoff-server-resolver.md`).
Builds on the 0.21.0 `ChainedBuilder` edit mode. Package-only change.

## Problem

System cronotons (bound to a fire-time server resolver, e.g. `pool-payout`/`stoicism-mint`) can't
be edited in the packaged `ChainedBuilder` — `ChainCommitBody` has no `serverResolver` field and the
builder has no field for it, so the hub shunts them to its legacy editor. The single-tx `Builder`
already has this exact capability (`BuilderState.serverResolver`, `BuilderHeader`'s resolver
`<select>`, `validateConfig`'s `autoGasWaived` gate) — this mirrors that mature, already-built
precedent for the chained builder rather than inventing a new pattern.

## Design

### Wire + state: `ChainCommitBody.serverResolver?: string | null`

Matches `description?: string | null`'s own convention in this same interface (not the sibling
single-tx `CommitBody.envelope.serverResolver?: string`'s convention — the handoff explicitly asks
for `string | null`, and it's consistent with THIS file's own local pattern). `ChainedBuilderState.
serverResolver: string | undefined` mirrors `BuilderState`'s own state-level convention instead —
the `null`-vs-`undefined` conversion happens at the wire boundary in `chainedBuilderToCommit`
(`if (state.serverResolver) body.serverResolver = …` — omit when falsy, never emit `""`) and
`jsonToChainedBuilderState` (`null`/absent/non-string/empty-string all degrade to `undefined` —
lenient, matching every other field's tolerance in that function, never a hard-error case).

### Gas-gate waiver: threaded for correctness, not reachable today

The handoff describes "the single-tx variant's gate... blocks on AUTO gas without calibration" and
asks to skip it when a resolver is set, mirroring `builder-state.ts`'s own `validateConfig`
(`autoGasWaived = Boolean(state.serverResolver) || isTriggerOnly(state)`, already shipped for the
single-tx `Builder`). Investigation found this is **currently unreachable** in `canCommitChain`:
`validateStep` (used for every chain step AND the single-tx variant) already calls `validateConfig`
with a HARDCODED `simulateCalibrated: true` — "the chained simulator calibrates each step's gas when
it runs; this gate is structural only" (pre-existing comment). So AUTO gas is already never blocked
by `canCommitChain`, resolver or not.

Rather than leave this undone on the theory "it's already a no-op," `state.serverResolver` is
threaded through `stepBuilderState`/`validateStep` into the SAME `autoGasWaived` mechanism anyway —
currently redundant with the hardcoded bypass, but it means a FUTURE change that makes per-step
calibration conditional (a plausible improvement — real authoring-time Simulate-based calibration,
not just a structural pass) won't silently start blocking server-resolver cronotons the moment that
hardcode is loosened. `stepBuilderState` was exported (an otherwise-private helper, matching the
`toRawPayloadState`/`isPlainObject` precedent) specifically so this threading is independently
testable — the masking hardcode means a test going through the full `canCommitChain` gate can't
observe whether the wiring itself is correct, only that the (already-guaranteed) verdict doesn't
regress.

### UI: mirrors `BuilderHeader`'s resolver select, not a new pattern

`ChainedBuilder` gains `serverResolverOptions?: ServerResolverOption[]` (the SAME type the single-tx
`Builder` already uses from `provider/context.ts` — not a narrower one-off type), falling back to
`useKhronotonConfig().serverResolverOptions` when omitted — identical precedent to `BuilderHeader`'s
own `useResolverOptions`. Differences from the handoff's literal wording, both intentional
improvements matching the MORE mature existing pattern rather than the handoff's own slightly
simpler phrasing:
- The base `{value:"", label:"None (ordinary cronoton)"}` option is owned by `ChainedBuilder`
  itself (any `value:""` entry in a supplied list is filtered out, not duplicated) — the handoff
  describes the HUB remembering to always include it, but `BuilderHeader` already demonstrates the
  package owning this is more robust (a host can never get this detail wrong).
- The resolver option's existing `note?: string` field (already part of `ServerResolverOption`,
  already used by `BuilderHeader` for per-resolver hint copy) is reused for the hint shown when a
  resolver is selected, falling back to the handoff's suggested generic "⟳ Server-resolved: payload
  filled at fire time." only when the selected option has no `note` of its own. Full parity with the
  single-tx builder's existing resolver UX, not a lesser subset — and the handoff's own §2.4 only
  asked for a generic fallback ("per-resolver copy is the hub's concern, not yours"), which still
  works exactly as asked when no `note` is supplied.
- The synthetic "`<value> (system cronoton)`" option (§2.2's CRITICAL requirement) is implemented
  exactly as specified — appended only when the persisted `state.serverResolver` isn't already in
  the (filtered) registry, so a real registry entry is never shadowed.

**A real bug found and fixed while implementing this:** `singleCronotonBody()` (used both for the
CREATE-mode single-tx `adapter.commit` body AND, via `previewAsSingle`, for the Raw JSON preview of
a single-step cronoton) built its synthetic `BuilderState` without ever setting `serverResolver` —
so selecting a resolver on a brand-new, exactly-one-step cronoton would have been SILENTLY DROPPED
on Create (and invisible in its own preview). Fixed by adding `serverResolver: state.serverResolver`
to that synthetic state, caught by the first resolver-selection test actually asserting on the
rendered Raw JSON output rather than just checking the `<select>`'s own DOM value.

### §6 — two kinds of resolver (acknowledged, not solved here)

The handoff is explicit that this task's envelope-field design is the FINAL shape for a genuinely
single-tx resolver (`stoicism-mint`) but only an INTERIM shape for `pool-payout`, which is really a
dynamic multi-tx cross-chain flow (burns + SPV continuations + a bulk transfer) that belongs as a
multichained planner cronoton, not a placeholder. This task deliberately does nothing that would
block that future migration:
- `serverResolver` and real `steps` are NOT mutually exclusive anywhere in this implementation — no
  validation, UI, or serialization path treats them as alternatives. A resolver cronoton with a real
  multi-step chain round-trips exactly like any other (proven by this task's own round-trip test,
  which carries both simultaneously).
- Nothing assumes one `chainId` across a chain — untouched; steps already carry `config.chainId`
  independently.
- Cross-chain SPV continuation legs are NOT modeled anywhere in this package today (no step mode,
  planner, or validation rule for "continue a defpact on chain 0 against a burn on another chain").
  This is the real blocker to ever expressing `pool-payout` as a genuine chain, and is explicitly
  out of scope here — flagged per the handoff's own ask, for the hub's separate future migration.

## Acceptance criteria

1. ✅ `ChainCommitBody.serverResolver?: string | null`; `chainedBuilderToCommit` writes it;
   `jsonToChainedBuilderState` reads it (lenient: null/absent/non-string/empty — including a
   nested object/array, not just scalars — all → unset).
2. ✅ `ChainedBuilder` shows a "Server resolver" select at the envelope level (Whole-cronoton tab),
   options from `serverResolverOptions` (prop) falling back to the provider config, always
   including a package-owned "None" base option.
3. ✅ Pre-selects from `initialDocument.serverResolver`; a persisted value absent from the options
   list gets a synthetic `"<value> (system cronoton)"` option, never silently falling back to
   "None" — AND, the negative case, a persisted value that IS in the options list does NOT get a
   spurious synthetic option or a duplicate (closed a tests-lens gap: only the positive case had
   coverage originally).
4. ✅ The resolver survives a Save that only touches an unrelated field (e.g. the schedule) — the
   literal acceptance test (a "Daily Pool Payout"-shaped fixture, schedule-only edit, resolver
   unchanged in the body sent to `updateChain`).
5. ✅ AUTO gas with no authoring-time Simulate does not block Save once a resolver is set (currently
   true unconditionally for the chained gate; the resolver-aware waiver is wired through anyway —
   see above).
6. ✅ A hint is shown once a resolver is selected (falls back to a generic line; prefers the
   option's own `note` when present) — both the generic-fallback AND the per-option-`note` paths
   are now independently tested (the `note` path was untested originally).
7. ✅ Create path AND ordinary edit (no resolver, no `serverResolverOptions`) unchanged.
8. ✅ A resolver and real chain steps coexist with no mutual-exclusivity logic anywhere.
9. ✅ Full suite green, `tsc`/build clean, README documents the new field/prop.

### Findings from the nectar review (correctness/conventions/tests; no security lens — same
reasoning as the prior two `ChainedBuilder` releases this session, pure client-side React state
wiring plus a store-layer field, no new auth/validation logic)

**Correctness — 1 CRITICAL, fixed; everything else affirmatively verified clean.** The CRITICAL:
`commitChainedCronoton` (the CREATE-path store function for the CHAIN shape) silently dropped
`ChainCommitBody.serverResolver` entirely — `handlers/chain.ts`'s `toCommitChainInput` never read
`body.serverResolver`, `store/chain.ts`'s `CommitChainedCronotonInput` had no such field, and the
`parentInput` it builds for `commitCodexCronoton` never set it, even though the single-tx
`commitCodexCronoton` path has supported `serverResolver` (including the one-resolver-per-cronoton
uniqueness guard and `evented` auto-detection) for a long time. Any cronoton created as a genuine
multi-step chain OR with a single-tx-first variant — i.e. exactly the shape the handoff's own §6
describes as `pool-payout`'s REAL future shape — would have had its resolver binding silently
discarded on create, persisting as an ordinary cronoton despite what the builder showed. Fixed by
threading `serverResolver` through all three layers; a new store-level regression test
(`chain.test.ts`, against a real in-memory DB) confirmed red against the pre-fix code before
landing. The UI-layer `singleCronotonBody()` gap from earlier in this same task (see above) was the
first instance of this exact CLASS of bug; this was the second, deeper instance of it, in a
completely different layer the same review pass caught.

Everything else was affirmatively traced and found correct: the other two synthetic-`BuilderState`
sites (`scheduleHostState`, `StepWorkspace.tsx`'s `synthetic`) don't need `serverResolver` (nothing
downstream of them reads it); the resolver-options construction's duplicate/shadowing risk was
traced through every array and found correct; `jsonToChainedBuilderState`'s leniency correctly
degrades every non-string JSON type; the `<select>`'s clear-to-`undefined` behavior is correct;
`selectedResolverNote`'s lookup uses the right (filtered, real) registry.

**Conventions — 2 MEDIUM + 1 LOW, fixed.** Two doc comments made false precedent claims: the new
`serverResolverOptions` prop's comment claimed parity with something `Builder` doesn't actually
expose (only its internal, unexported `BuilderHeader` subcomponent has the field — `Builder` itself
never threads it through); `stepBuilderState`'s export-rationale comment claimed the SAME precedent
`toRawPayloadState`/`isPlainObject` set, which is actually a different rationale (those are
exported for genuine cross-module production reuse; `stepBuilderState` is exported solely for test
reachability). A third, LOW, inline JSX comment overstated byte-for-byte parity with
`BuilderHeader`'s hint behavior when the actual implementation is a deliberate superset. All three
reworded to state the real relationship precisely.

**Tests — 1 HIGH + 4 MEDIUM + 1 LOW, all closed.** The HIGH: the `singleCronotonBody()` fix itself
was only proven via the Raw JSON preview text, never against the actual `adapter.commit` call args
— closed with a dedicated create-flow test. The MEDIUMs: the per-option `note` override had zero
coverage (every hint test exercised only the generic fallback) — closed by adding a resolver option
with a real `note` and testing both paths explicitly; the synthetic-option logic's negative case
(persisted value ALREADY in the registry) was untested — closed; clearing the resolver back to
"None" after it was set was untested — closed; the `stepBuilderState`-threading test only proved
the helper's own output, not that `canCommitChain`/`validateStep` actually forward
`state.serverResolver` into it. The last one could NOT be closed with a meaningful test — see the
dedicated comment left in `chained-builder-state.test.ts` explaining why (native ESM binds an
internal same-module function call to its live local reference, not through an exported namespace
object, so `vi.spyOn` cannot observe it; confirmed empirically, not asserted on faith) — disclosed
rather than faked with a weaker/tautological substitute. The LOW: the lenient-degrade tests for a
non-string `serverResolver` only covered primitives (`null`/number/boolean), not a nested
object/array — closed.
