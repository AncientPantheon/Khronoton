# Surface the server resolver in `ChainedBuilder` — Plan

Design: `docs/work/chained-builder-server-resolver/design.md`. Single-wave — T1 (wire + state
layer) underpins T2 (UI); T3 is docs/version/publish.

## T1 — Wire type + state serialization + gas-waiver threading

**Files:** `src/handlers/chain.ts`, `src/ui/chained-builder-state.ts`,
`src/ui/chained-builder-state.test.ts`.

- `ChainCommitBody.serverResolver?: string | null`.
- `ChainedBuilderState.serverResolver: string | undefined`; `makeEmptyChainedBuilderState` default.
- `chainedBuilderToCommit` writes it (omit when falsy); `jsonToChainedBuilderState` reads it
  (lenient — null/absent/non-string/empty → `undefined`).
- `stepBuilderState`/`validateStep`/`canCommitChain` thread `state.serverResolver` into the
  per-step/variant synthetic `BuilderState` so `validateConfig`'s existing `autoGasWaived` waiver
  applies — exported `stepBuilderState` so this is independently testable despite being masked by
  `validateStep`'s own hardcoded `simulateCalibrated: true` today.

TDD: round-trip tests (fixture now carries `serverResolver`), lenient-degrade tests (null/absent/
non-string/empty string), the `stepBuilderState` threading test (direct, not through the masked
gate), a no-regression check (`canCommitChain` still `ok` with a resolver set).

- Done when: `npx tsc --noEmit` clean; `chained-builder-state.test.ts` green (old + new).

## T2 — `ChainedBuilder` UI: the resolver select + hint + singleCronotonBody fix

**Files:** `src/ui/chained/ChainedBuilder.tsx`, `src/ui/chained/ChainedBuilder.test.tsx`.

TDD: failing tests first — default "None" + no duplicate base option from a stray `value:""` in
the registry; selection writes into the Raw JSON preview; hint shown only once selected; pre-select
+ synthetic "(system cronoton)" option from `initialDocument.serverResolver` when absent from
`serverResolverOptions`; the literal acceptance scenario (Daily-Pool-Payout-shaped fixture,
schedule-only edit, Save not blocked by AUTO gas, resolver unchanged in the sent body).

Then implement: the `serverResolverOptions?` prop, the options/hint derivation (mirroring
`BuilderHeader`'s `useResolverOptions`, package-owned base option, registry-or-provider-config
fallback), the `<select aria-label="Server resolver">` in the Whole-cronoton tab alongside Name/
Description, the hint paragraph.

A real pre-existing gap was found while writing the FIRST test (not anticipated in the design):
`singleCronotonBody()` never threaded `state.serverResolver` into its synthetic `BuilderState` —
silently dropping a selected resolver from both the CREATE-mode commit body and its own Raw JSON
preview for any single-step cronoton. Fixed by adding the field to that synthetic state.

- Done when: every new test fails against the pre-fix code for the right reason; `npx tsc --noEmit`
  clean; full suite green (old + new, including the schema-generator's `generate.test.ts`, whose
  hardcoded top-level-keys assertion needed a one-line update now that `ChainCommitBody` genuinely
  has a new top-level field — confirms the generator discovers it automatically, not hand-maintained
  drift).

## T3 — Docs, version, publish

**Files:** `packages/khronoton-core/package.json`, `CHANGELOG.md`, `README.md`.

- Bump MINOR (additive field/prop).
- CHANGELOG entry + README `## Status`/`## Version history`, satisfying the doc-parity CI gates.
- Full verification: `tsc --noEmit`, `npm run build` (confirm the regenerated schema/markdown
  artifacts include `serverResolver` with its real JSDoc description), `npx vitest run` (repeat).
- Commit, push, tag, push tag, watch `publish.yml`, verify registry + provenance + GitHub Release.
- Reply with the published version string so the hub can pin, pass the options, and route
  server-resolver cronotons into the packaged builder.
