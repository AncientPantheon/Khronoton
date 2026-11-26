# ChainedBuilder layout tweaks — Plan

Design: `docs/work/chained-builder-layout-tweaks/design.md`. Two independent fixes, can be
built in either order; T3 is docs/version/publish, last.

## T1 — Pact editor fill-height fix

**Files:** `src/ui/chained/StepWorkspace.tsx` (+ a new `StepWorkspace.test.tsx`, none existed).

TDD: write a failing test asserting `editorPane`'s rendered wrapper (reached via the "PACT
code" textarea's ancestor, using `forceFallback` via the mocked `PactCodeMirror` or the plain
textarea seam, matching `PactCodeEditor.test.tsx`'s own convention) has `style.flex === "1 1
0%"` (or jsdom's own normalization — confirm exact string empirically) and `style.minHeight ===
"0px"`, NOT `style.height === "100%"`, when rendered with `pane="editor"` + `fillEditor`. Then
flip `editorPane`'s wrapper style from `height:"100%"` to `flex:1, minHeight:0`.

- Done when: the new test fails against the pre-fix code (confirms it's a real regression
  guard, not a tautology), passes after the one-line style change; `npx tsc --noEmit` clean;
  `npx vitest run src/ui/chained/StepWorkspace.test.tsx` green; full suite still green (the
  existing `ChainedBuilder.test.tsx` mocks `PactCodeMirror.js` with a plain textarea, so this
  change must not disturb any existing DOM-shape assertion there).

## T2 — Integrator-settable pane-sizing props

**Files:** `src/ui/chained/ChainedBuilder.tsx`, `ChainedBuilder.test.tsx`, `README.md`.

TDD: write failing tests first (`ChainedBuilder.test.tsx`, new describe block), covering:
- Omitting the three new props reproduces today's exact rail-column `width` style + the same
  `renderedPanes` pane-width behavior at a fixed mocked `clientWidth` (regression pin).
- Passing `railWidth={320}` changes the ACTUALLY-RENDERED rail `<div>`'s own `style.width` to
  `"320px"` (not just an internal constant) — the landmine-closing test.
- Passing `paneMaxWidth`/`paneMinWidth` changes the rendered pane `<section>`'s own `style.flex`
  basis (`paneW`) accordingly, and `autoFit`'s pane count (readable via the "Fit" control's
  "Auto (N)" label) responds to a larger `paneMinWidth`.
- `paneMaxWidth` passed smaller than `paneMinWidth` doesn't produce a pane wider than
  `paneMinWidth` would alone (the clamp).
- At a stubbed `clientWidth`, the rendered workspace's total width (rail + gap + panes) never
  exceeds that `clientWidth` at any of the above custom prop combinations (no-horizontal-scroll
  invariant, re-checked under custom props).

Then implement: add `paneMaxWidth?`/`paneMinWidth?`/`railWidth?` to `ChainedBuilderProps` (JSDoc
each with its default), destructure with defaults `600`/`360`/`210`, replace the `RAIL`/
`PANE_MIN`/`PANE_MAX` local consts with the resolved prop values (`PANE_MAX = Math.max(paneMinWidth,
paneMaxWidth)`), and replace the rail `<div>`'s stray `width: 210` literal with `RAIL`.

- Done when: all new tests pass (and the landmine test genuinely fails against the pre-fix
  code — confirm before committing to the fix); `npx tsc --noEmit` clean; full suite green.
  Document the three props + defaults in `README.md` (a short subsection near wherever
  `ChainedBuilder`'s own mount-contract note already lives, or alongside its other documented
  props).

## T3 — Docs, version, publish

**Files:** `packages/khronoton-core/package.json`, `CHANGELOG.md`, `README.md`.

- Bump version (MINOR — new props are an additive feature; the fill-height fix ships in the same
  release rather than as its own separate patch, since both are being delivered together per the
  handoff's single "ship both, reply with the version" ask).
- CHANGELOG entry (new section at top) + README `## Status` + `## Version history`, satisfying
  the real CI doc-parity gates (`` `<version>` on public npmjs`` line, `**v<version>**`
  version-history entry, CHANGELOG's first `##` heading matching).
- Full verification: `npx tsc --noEmit`, `npm run build`, `npx vitest run` (repeat runs per this
  package's established flake-paranoia precedent).
- Commit, push to `main`, tag, push the tag, watch `publish.yml` to completion, verify the npm
  registry (shasum match against the real publish log) + provenance/publish attestations + the
  GitHub Release, exactly as done for every prior release this session.
- Reply to the Hub with the published version string.
