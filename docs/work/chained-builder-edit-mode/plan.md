# `ChainedBuilder` edit mode — Plan

Design: `docs/work/chained-builder-edit-mode/design.md`. Single-wave plan — T1 (adapter type) has no
dependency on T2; T2 is the bulk of the work; T3 is docs/version/publish, last.

## T1 — `KhronotonAdapter` gains `updateChain?`

**Files:** `src/provider/adapter.ts`.

- Add `updateChain?(id: string, body: ChainCommitBody, opts?: ConfirmOpts): Promise<ChainCommitView>`
  next to the existing `commitChain?`/`simulateChain?` slots, same doc-comment convention (OPTIONAL,
  not in `REQUIRED_METHODS`, degrades gracefully).
- Done when: `npx tsc --noEmit` clean; no existing fake adapter breaks (optional field, nothing to
  update elsewhere).

## T2 — `ChainedBuilder` edit mode

**Files:** `src/ui/chained/ChainedBuilder.tsx`, `src/ui/chained/ChainedBuilder.test.tsx`.

TDD: write failing tests first, covering (per design.md's acceptance criteria 3-8):
- A realistic multi-step fixture with a `singleTxFirst` variant (modeled on the hub's real
  `StoicismRewardFlow.json` shape — name/description/schedule/singleTxFirst + 2+ `single`-mode steps
  with `yieldAs`) round-trips through `initialDocument`: the step rail shows the right step count +
  labels, the variant row is present, and the Pact code / config / signers for a selected step match
  the fixture (spot-check at least the Pact code and one config field, not just presence).
- Save is DISABLED immediately after a clean load (no edits) and ENABLED after changing exactly one
  field (e.g. the Pact code of one step).
- Clicking Save (dirty, gate-passing) calls `adapter.updateChain` with `editId` + the exact current
  commit body, never `adapter.commit`/`commitChain`; `onDone` is called with `editId` (not whatever
  the mock response echoes — use a DIFFERENT id in the mock's response to prove this).
- `editId` set, `initialDocument` undefined → renders the loading placeholder, not the builder.
- `initialDocument` that fails `jsonToChainedBuilderState` (e.g. `steps: []`) → renders a distinct
  error, not the loading placeholder and not a blank editable form.
- The button label reads "Save changes" in edit mode (not "Create..."), "Saving…" while committing.
- Omitting `editId`/`initialDocument` entirely still passes every PRE-EXISTING test in this file
  unmodified (byte-identical create path) — this is the regression pin, not a new test.

Then implement: the `editId?`/`initialDocument?` props, the one-time lazy-initializer seed (state +
`loadError` + `baselineDocJson`, computed together per design.md), `safeStringifyOrNull` (factored out
of `codeText`'s existing try/catch, reused by the dirty check), `editReady`, the `primaryLabel`/
`primaryDisabled` expressions, and the `handleCommit` edit branch calling `adapter.updateChain` via
`runGated`.

- Done when: every new test fails against the pre-edit-mode code for the right reason (confirm via a
  scoped `git stash` of just the implementation file, per this session's established practice), then
  passes after the implementation; `npx tsc --noEmit` clean; full suite green (old + new); a few
  repeat runs for flake confidence given this file's own history.

## T3 — Docs, version, publish

**Files:** `packages/khronoton-core/package.json`, `CHANGELOG.md`, `README.md`.

- Bump MINOR (additive props + adapter slot).
- CHANGELOG entry + README `## Status`/`## Version history`, satisfying the real CI doc-parity gates.
- Full verification: `npx tsc --noEmit`, `npm run build`, `npx vitest run` (repeat runs).
- Commit, push, tag, push tag, watch `publish.yml`, verify registry + provenance + GitHub Release.
- Reply with the published version string so the hub can pin + flip `goToEdit`.
