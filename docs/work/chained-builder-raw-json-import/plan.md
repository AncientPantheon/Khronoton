# In-builder Raw JSON "unlock / paste / import" — Plan

Design: `docs/work/chained-builder-raw-json-import/design.md`. Single-wave plan (no cross-task
dependencies beyond straightforward file-scope separation) — tasks T1/T2 touch `builder-state.ts`
(additive exports only) and `chained-builder-state.ts` respectively and can run together; T3 (the
UI) depends on T1+T2's exports existing; T4 is docs/version/publish, last.

## T1 — Export `toGasPayerState` + `freshSignerId` from `builder-state.ts`

**Files:** `src/ui/builder-state.ts` (+ its existing test file if one needs a touch to assert the
new exports, otherwise none).

- Add `export` to `toGasPayerState` and `freshSignerId`. No behavior change — purely widening
  visibility for `chained-builder-state.ts` to reuse (avoids a second signer-id counter / a second
  `CodexGasPayer → GasPayerState` mapping).
- Done when: `npx tsc --noEmit` clean; the existing `builder-state.test.ts` (and anything else that
  imports this module) still passes unmodified — a pure visibility widening shouldn't need new
  tests of its own, but confirm no name collision at either import site.

## T2 — `jsonToChainedBuilderState` in `chained-builder-state.ts` + its test file

**Files:** `src/ui/chained-builder-state.ts`, `src/ui/chained-builder-state.test.ts`.

TDD: write the failing tests first, covering (per design.md's acceptance criteria 2-4):
- Round-trip: build a non-trivial `ChainedBuilderState` by hand (2 steps — one `single` with a
  payload/signers/gasPayer, one `planner` with `plannerParamsJson` containing a `{"$yield":...}`
  placeholder — plus a `singleTxVariant`), run it through `chainedBuilderToCommit` →
  `JSON.stringify` → `jsonToChainedBuilderState`, and assert the resulting state's FIELDS (not
  ephemeral `key`/signer `id`/`label`/`source`) match the original.
- Hard-error cases, each asserting the EXACT message where design.md pins one verbatim against
  `chained-validation.ts`: invalid JSON syntax; a JSON array/string/number/null at the top level;
  missing `steps`; `steps: []`; `steps` not an array; a step with `mode: "bogus"`.
- Lenient-default cases: a minimal `{name, steps:[{mode:"single"}]}` doc (no config/payload/
  gasPayer/signers/pactCode at all) parses successfully into a state using
  `makeEmptyBuilderState()`'s own defaults for every omitted sub-field; a step with one malformed
  signer entry (`signers: [{}, {publicKey:"..."}]`) drops the first, keeps the second; a doc with
  BOTH `externalFireable:true` and a `schedule` key present uses `externalFireable` and ignores
  the stray `schedule`.
- `singleTxFirst` present → populates `state.singleTxVariant` with the right pactCode/config/
  payload/gasPayer/signers (reusing the same per-field mapping as a `single` step, confirmed by a
  dedicated test rather than assumed from the step-mode test alone).
- A planner step's `plannerParams` (an object, not a string) round-trips into `plannerParamsJson`
  as pretty-printed JSON text that `JSON.parse`s back to the same value.

Then implement `jsonToChainedBuilderState(text: string): ChainedBuilderImportResult` (+ the
exported `ChainedBuilderImportResult` type) and the small private `stepEnvelopeFromWire(raw)`
helper design.md describes, importing `toGasPayerState`/`freshSignerId` from `builder-state.js`
(now exported per T1).

- Done when: `npx tsc --noEmit` clean; `npx vitest run src/ui/chained-builder-state.test.ts`
  passes with every case above; the round-trip test specifically proves T2 and the EXISTING
  `chainedBuilderToCommit` agree on the wire shape (not a second, independently-invented shape).

## T3 — Raw JSON pane: unlock / paste / import affordance

**Files:** `src/ui/chained/ChainedBuilder.tsx`, `src/ui/chained/ChainedBuilder.test.tsx`.

TDD: extend the existing commit-routing test file (same mount/adapter harness, same
`ResizeObserver` polyfill already added there) with new cases:
- The Raw JSON pane renders read-only by default (no textarea present) with a "Paste / import"
  toggle visible.
- Clicking the toggle reveals a `textarea` (aria-label "Import JSON") + Capture/Cancel controls;
  clicking it again (or Cancel) hides them again with no state change.
- Pasting valid JSON (e.g. a single-step doc with a Pact code + name) and clicking "Capture &
  parse" updates the builder's own visible fields (e.g. the step rail's step count, or the Fields
  pane's name field once its tab is opened) to match — proving the captured state actually lands
  in the component, not just that the pure function returns something.
- Pasting invalid JSON and clicking "Capture & parse" shows the error text and leaves the
  previously-entered fields untouched (set a Pact code by hand first, then attempt a bad import,
  then assert the hand-entered Pact code is still there).
- `.json` file upload: a minimal test using a mocked/stubbed `FileReader` (or a real one if jsdom's
  supports `readAsText` on a `File` sufficiently — check before assuming either way) confirming the
  selected file's text lands in the same textarea Capture reads from.

Then implement: a toggle button in the Raw JSON pane's header, local component state for
`importOpen`/`importDraft`/`importError`, the textarea + file input + Capture/Cancel buttons, and
the `handleCaptureImport` callback calling `jsonToChainedBuilderState` and either `setState(...)`
(plus resetting `selected`/`fieldsTab`/`wholeField`/`sim` per design.md) or setting `importError`.

- Done when: `npx tsc --noEmit` clean; `npx vitest run src/ui/chained/ChainedBuilder.test.tsx`
  passes, old + new cases; a few full-suite stress runs (per the 0.18.0 precedent) confirm no new
  flake from the added async/file-read paths.

## T4 — Docs, version, publish

**Files:** `packages/khronoton-core/package.json`, `CHANGELOG.md`, `README.md`.

- Bump to `0.19.0` (additive feature on a 0.y.z line — matches this package's own established
  MINOR convention for every prior feature release).
- CHANGELOG entry (new section at top) + README `## Status` + `## Version history` entries,
  satisfying the real CI doc-parity gates in `.github/workflows/publish.yml`: README must contain
  a line matching `` `0.19.0` on public npmjs`` and a line starting `**v0.19.0**`; CHANGELOG's
  FIRST `##` heading must be `## 0.19.0 …`.
- Full verification: `npx tsc --noEmit`, `npm run build`, `npx vitest run` (plus a few repeat runs
  given the 0.18.0 flake history, to build confidence before trusting the automated CI gate).
- Commit, push to `main`, tag `v0.19.0`, push the tag, watch the real `publish.yml` run to
  completion, verify the npm registry + GitHub Release the same way 0.17.0/0.18.0 were verified
  (per-version registry endpoint shasum match, both attestations present).
- Reply to the Hub with the published version string.
