# ChainedBuilder layout tweaks: Pact-editor fill-height fix + pane-sizing props — Design

Handoff: `docs/work/chained-builder-layout-tweaks/handoff.md`. Two independent deliverables,
both internal to `ChainedBuilder.tsx` (+ `StepWorkspace.tsx` for #1); no server/wire changes.

## 1. Pact editor fill-height bug — root cause + fix

### Root cause (confirmed by reading, not guessed)

The handoff floats two hypotheses: (a) CodeMirror's own `.cm-editor`/`.cm-scroller` not
filling, or (b) a parent in the flex chain losing the bound. Reading `@uiw/react-codemirror`'s
own installed source (`cjs/useCodeMirror.js` + `cjs/theme/dimensionTheme.js`) rules out (a):
the library unconditionally applies a `scrollerTheme` (`.cm-scroller { height: '100% !important'
}`, always included in `getExtensions`) and, whenever a truthy `height` prop is passed, a
per-call `getDimensionTheme` setting `&{height: ...}` (`&` = `.cm-editor`'s own root in a
CodeMirror `EditorView.theme`). `PactCodeMirror.tsx` already passes `height="100%"` through
to `<CodeMirror height={...}>` in fill mode — so CodeMirror-internal height is already
correctly wired, out of the box, with no theme change needed here.

(b) is the real bug. `StepWorkspace.tsx`'s `editorPane` wrapper:
```ts
<div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>
```
is a **flex item** of its parent (`ChainedBuilder.tsx`'s Pact-pane `panel` card: `flex: 1,
display: "flex", flexDirection: "column", minHeight: 0`). Setting `height: "100%"` directly on
a flex item — instead of `flex: 1` (+ `minHeight: 0`) — is the textbook flexbox gotcha: a
percentage height on a flex item does not reliably resolve the way it does on a plain block
child, because the item's own flex-basis/height resolution and the parent's definite-height
resolution are both mid-flight in the same layout pass. Every OTHER layer in this exact chain
(the `panel` card itself, `PactCodeEditor.tsx`'s inner `<div style={{flex:1,minHeight:0}}>`
wrapping the actual CodeMirror mount) already uses the correct `flex:1 + minHeight:0` idiom —
`editorPane` is the one link that didn't. Content-sized `editorPane` (mode/yield row + Pact
editor's own intrinsic size) exactly matches the reported symptom: a short program renders at
content height with dead space below down to the (correctly flex-filled) pane's bottom edge.

`PactCodeEditor.tsx`'s own outer `panelStyle` div (`height:"100%"` in fill mode, line ~140) is
NOT a flex item of a multi-child flex container — its parent (`StepWorkspace.tsx`'s `<div
style={{flex:1,minHeight:0}}>` wrapper) has no `display:flex` of its own and has exactly one
child, so a plain block `height:100%` there is standard, reliable CSS (resolves fine once its
ancestor chain has a definite height) and needs no change.

### Fix

`StepWorkspace.tsx`: `editorPane`'s wrapper becomes `flex: 1, minHeight: 0` (dropping
`height: "100%"`), matching the established idiom used by every sibling layer in this chain.
`pane="both"` (unused by any current call site, confirmed via a repo-wide grep — only
`"editor"`/`"fields"` are ever passed) still works correctly with this change: `flex:1` on a
child of an unconstrained (auto-height) flex column is a no-op (nothing to grow into), so it's
strictly safe-or-equivalent there, never a regression.

No change needed to `PactCodeEditor.tsx` or `PactCodeMirror.tsx`.

### Verification approach

jsdom has no real layout engine (this package's own established precedent — see
`PactCodeMirror.test.ts`'s docblock and `KHRONOTON_EDITOR_THEME_SPEC` test's own comment: "a
DOM-computed-style assertion isn't reachable here... pinning the source spec is the closest
reachable guard"). A real-browser pixel-fill assertion is not reachable here either. The
reachable, meaningful guard: render `StepWorkspace` with `pane="editor"`/`fillEditor` and
assert the **actual rendered DOM node's inline style** carries `flex:"1 1 0%"`/`minHeight:"0px"`
(jsdom's own normalization of the shorthand) rather than `height:"100%"` — i.e. test the real
JSX output, not just read the source. Combined with the CodeMirror-source-reading evidence
above (cited in this doc, not re-derived in a test — there is nothing further jsdom can verify
about CodeMirror's own internal height handling), this is the strongest guarantee available in
this environment, matching the package's own established testing philosophy for this exact
CSS-fill problem class (see the 0.18.0 CHANGELOG entry's own "DOM chain" verification language).

## 2. Integrator-settable pane-sizing props

### Current state

`RAIL`/`PANE_MIN`/`PANE_MAX` (210/360/600) are local `const`s inside `ChainedBuilder`, feeding
`autoFit`/`paneW`/`workspaceMaxWidth`/`bodyMaxWidth`. A **second, independent** hardcoded
`210` literal exists at the actually-rendered left-rail `<div style={{width:210,...}}>` — found
by grepping every literal occurrence of these numbers, not just the named consts. This is a
real landmine: wiring `railWidth` through the WIDTH MATH alone, without also fixing this JSX
literal, would silently desync the math's assumed rail width from the actually-rendered rail
width the moment anyone overrides `railWidth` away from 210 — breaking the no-horizontal-scroll
invariant the handoff explicitly asks to preserve "at ANY values."

### Fix

Add three optional numeric props to `ChainedBuilderProps`, each defaulting to today's exact
value (byte-for-byte backward compatible when omitted):
- `paneMaxWidth?: number` (default `600`)
- `paneMinWidth?: number` (default `360`)
- `railWidth?: number` (default `210`)

Destructured with those defaults; `RAIL`/`PANE_MIN` become straight reads of the resolved
props.

**Post-review update (see below):** the first-draft design added a separate `PANE_MAX =
Math.max(paneMinWidth, paneMaxWidth)` clamp to prevent `paneMaxWidth < paneMinWidth` from
inverting the cap. A nectar correctness review found this clamp was dead weight (`paneW`'s own
outer floor already fully absorbs that case — confirmed by hand-tracing the one and only
consumer of `PANE_MAX`) AND, far more seriously, that the SAME outer floor had a real bug: it
unconditionally rescued `paneW` UP to `paneMinWidth` regardless of what the measured width could
actually hold, so a `paneMinWidth`/`railWidth` configured larger than the available space forced
a genuine, measured horizontal overflow — directly contradicting this deliverable's own "no
horizontal scroll at ANY prop values" promise. The separate `PANE_MAX` clamp was removed; `paneW`
now computes `Math.min(preferredPaneW, Math.max(0, rawShare))`, where `rawShare` is the actual
per-pane share of the measured width — the preference (`PANE_MIN`/`PANE_MAX`) can never win over
it, down to and including an unusably narrow but never-overflowing 0px pane. The one case this
still cannot rescue is a `railWidth` that ALONE exceeds the whole mount's own width (no pane-width
clamp can fix that) — a deliberately out-of-scope misconfiguration, not a "pane sizing" bug this
prop's own contract covers. No other validation is added — consistent with this package's
existing posture toward optional numeric UI props elsewhere (e.g. `PactCodeEditor.height`/
`editorHeight` are also used directly, with no extra guarding).

The JSX's stray `width: 210` literal is replaced with the resolved `RAIL` so the math and the
actually-rendered column width can never desync, regardless of the configured value.

`autoFit` already derives from `PANE_MIN` (now prop-driven) — no separate change needed there;
this was already correct once `PANE_MIN` itself becomes the resolved prop value, confirming the
handoff's "derive autoFit from the configured paneMinWidth" ask falls out for free from fixing
the constants' source.

### Verification approach

Pure arithmetic/JSX-prop-threading, fully testable under jsdom without any layout engine:
- Omitting the new props reproduces today's exact `bodyMaxWidth`/rail width/pane width at a
  fixed mocked `clientWidth` (regression-proofing "fully backward compatible").
- Passing `paneMaxWidth`/`paneMinWidth`/`railWidth` changes the resolved values used by BOTH the
  width math AND the actually-rendered rail `<div>`'s own width — proving the landmine above is
  closed, not just the math-side constant.
- A misconfigured `paneMaxWidth < paneMinWidth` doesn't invert the cap (PANE_MAX clamp).
- No pane ever renders wider than the current `clientWidth` stub would allow — i.e., the
  no-horizontal-scroll invariant (checked via the same `renderedPanes`/`fit` arithmetic this
  file already uses) continues to hold at custom prop values, not just the default ones.

## Acceptance criteria

1. ✅ A short Pact program's editor fills its pane's full height (no CodeMirror-internal theme
   change needed, confirmed non-issue); verified via the rendered `editorPane` wrapper's real
   inline style (`flex`/`minHeight`, not `height:"100%"`).
2. ✅ `pane="both"` (unused today, kept for back-compat) is unaffected/still safe — a smoke test
   added during the review round (both surfaces render, nothing dropped).
3. ✅ `ChainedBuilderProps` gains `paneMaxWidth?`/`paneMinWidth?`/`railWidth?`, each defaulting to
   600/360/210 — omitting all three reproduces the current layout exactly (including rendering
   the SAME `paneW` on every simultaneously-visible pane, not just one of them — a tests-lens gap
   closed during the review round).
4. ✅ The rail column's actually-rendered width and the width math agree at every prop value (the
   stray JSX literal is gone).
5. ✅ `paneMaxWidth < paneMinWidth` doesn't invert the pane-width cap — now via `paneW`'s own
   floor alone (the separately-clamped `PANE_MAX` was removed as redundant; the review's own test
   for this was also fixed to no longer pass identically with the clamp deleted).
6. ✅ `autoFit` responds to a custom `paneMinWidth` — the regression test now uses a
   GAP-discriminating breakpoint (488, not 700) so a GAP-naive mutant formula would genuinely fail
   it, per the tests lens's finding.
7. ✅ No horizontal scroll at any combination of configured prop values + measured width — this
   was the HIGH correctness finding (see above): `paneMinWidth`/`railWidth` larger than the
   measured width used to force real overflow; fixed, and the invariant sweep test now covers
   three distinct edge-case combinations including the `availPanes → 0` boundary.

Reviewed via nectar: correctness/conventions/tests lenses (security omitted — pure client-side
layout/props, no external input, no auth/data-exposure surface). Conventions came back fully
clean. Tests: 4 MEDIUM + 1 LOW, all closed (see criteria 2/3/5/6/7 above). Correctness: 1 HIGH
(criterion 7, above) — independently re-derived by hand before fixing, not taken on faith.
8. README documents the three new props + their defaults.
9. Full suite green, `tsc`/build clean, CHANGELOG/README doc-parity gates satisfied.
