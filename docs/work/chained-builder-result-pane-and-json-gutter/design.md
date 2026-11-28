# Result pane (bounded-height Simulate/Run-history) + Raw JSON line-number gutter — Design

Handoff: `Z:\StoaChain\_hub\AncientHoldings\docs\work\chained-cronoton-edit\khronoton-agent-handoff-server-resolver.md`
§5b items 3–4.

## 1. Bounded "Result" pane (PRIORITY — real usability bug)

**The bug, confirmed by reading `ChainedBuilder.tsx`:** the dry-run `SimPanel` (after Simulate)
and the 0.24.0 `RunHistory` block both render as plain `<div style={panel}>` blocks appended
BELOW the whole pane filmstrip, full width, with no height cap and no internal scroll. On a
small chain this is a few lines and unnoticeable; on a 13-step chain (`OuroMinterStageTwoV2`)
either block is taller than the viewport, so the page's overall height balloons and the rail +
panes (which are sized to fill a BOUNDED parent — `ChainedBuilder`'s own mount contract says so
explicitly) get dragged along into one giant page-level scroll instead of each scrolling
independently inside its own box.

**Fix:** a 4th toggleable pane, `{key: "result", label: "Result"}`, inserted into the existing
`panes` array BETWEEN `"pact"` and `"fields"` (so the tab order reads Pact → Result → Fields →
Raw JSON). This is a strict extension of the EXISTING pane-filmstrip machinery — confirmed by
reading it first, not assumed: `fit`/`autoFit`/`PANE_MIN`/`PANE_MAX`/the eviction logic in
`togglePane` are already parameterized on `panes.length`, not hardcoded to 3; only the manual
Fit-selector's button list (`["auto", 1, 2, 3]`) is a fixed set of discrete choices, and that's
unaffected — "Auto" already picks up to `panes.length` (now 4) when the measured width allows,
exactly like it already does for 3. Each pane (including this one) already renders inside a
`paneStyle` box with `overflow: "hidden"` on the OUTER section — the new pane's own inner content
gets a `flex: 1, minHeight: 0, overflowY: "auto"` wrapper (the same "bounded parent + internal
scroll" discipline `PactCodeEditor`'s `fill` mode and the Fields pane's tab bodies already use),
so a 13-step `RunHistory` table scrolls INSIDE its own pane and never changes the builder's own
height.

**Discoverability (not just "add a pane and hope someone clicks it"):** the old behavior showed
both blocks unconditionally, with no click required — hiding them behind an opt-in pane toggle
by default would be a silent regression (an operator who just clicks "Simulate chain" expects to
see the result immediately; an operator who opens an existing cronoton in edit mode currently
always saw its run history without doing anything extra). Two targeted preservations, not a
blanket "always show Result":
  - `handleSimulate` now calls a new `ensurePaneVisible("result")` (mirrors `togglePane`'s own
    "add, evict-oldest-if-over-capacity" branch) right after a successful `setSim(res)` — so
    clicking Simulate shows the dry run exactly as before, just now inside a bounded pane.
  - `visiblePanes`'s initial `useState` is seeded via a small function (previously a bare array
    literal) that includes `"result"` by default ONLY when `Boolean(editId) && adapter.listRuns
    && adapter.listRunLegs` — i.e. exactly the condition under which `RunHistory` used to render
    unconditionally. A fresh CREATE-mode mount (no sim yet, no run history to show) still
    defaults to `["pact", "fields"]`, unchanged — showing an empty Result pane by default there
    would just waste a slot for nothing.

Empty state: the Result pane shows a short neutral message ("Run Simulate chain to preview a dry
run...") when neither `sim` nor an edit-mode run-history mount applies, rather than an
inexplicable blank pane.

## 2. Raw JSON pane: line-number gutter via CodeMirror (nice-to-have)

The Raw JSON pane already pretty-prints (0.23.0); it's still a plain `<pre>`, no gutter. Fix:
render it through the SAME CodeMirror machinery the Pact editor pane already uses, in read-only
JSON mode. New files, mirroring the EXISTING `PactCodeEditor.tsx`/`PactCodeMirror.tsx` split
exactly (same SSR/jsdom-safety rationale: `@uiw/react-codemirror` touches `window`/DOM at view
init, so it must never be statically imported):

- `PactCodeMirror.tsx`'s module-local `khronotonEditorTheme` is now `export`ed (it was already
  fully stateless/shared-safe; only its visibility changes) — reused as-is rather than
  duplicated, so the Raw JSON viewer matches the Pact editor's exact dark-panel/gold-accent theme
  with zero drift risk.
- `RawJsonCodeMirror.tsx` (new, browser-only, reached only via `lazy(() => import(...))` from the
  wrapper below): a `<CodeMirror>` with `extensions={[json()]}` (new peer dep `@codemirror/lang-
  json`, the standard tiny CM6 JSON grammar package, same family as the already-required
  `@codemirror/language`/`@codemirror/view`/`@codemirror/state`), `editable={false}` (genuinely
  non-editable, not just "no onChange handler"), line numbers on via `basicSetup`.
- `RawJsonViewer.tsx` (new, the SSR-safe wrapper — mirrors `PactCodeEditor.tsx`'s mounted-state +
  `Suspense` + `forceFallback` contract exactly): pre-mount / SSR / `forceFallback` all render the
  SAME `<pre data-testid="chained-builder-raw-json-pre">` the pane has always rendered — so every
  existing Raw-JSON test (the 0.23.0 pretty-print regression test, the dirty-check test, every
  resolver-select/synthetic-option test that reads the Raw JSON pane's text) keeps passing
  UNCHANGED; only a real mounted browser gets the CodeMirror upgrade. `ChainedBuilder.tsx`'s own
  raw-pane branch swaps its inline `<pre>{codeText}</pre>` for `<RawJsonViewer value={codeText}
  />`; `ChainedBuilder.test.tsx` gains one more `vi.mock(...)` line (for `./RawJsonCodeMirror.js`,
  alongside the existing `./PactCodeMirror.js` mock) so jsdom never attempts the real mount here
  either — exactly the same mechanism, not a new one.

Not unit-tested for its real rendered gutter/line-numbers (jsdom has no layout engine to verify
that against, same documented limitation `PactCodeMirror.test.ts` already lives with for the Pact
editor) — `RawJsonCodeMirror.tsx` itself gets no component-mount test, matching precedent
exactly; `RawJsonViewer.test.tsx` covers the SSR/fallback contract the same way
`PactCodeEditor.test.tsx` does (via `forceFallback`, never attempting a real mount).

## Acceptance criteria

1. ✅ A "Result" pane toggle exists in the pane strip, between Pact code and Fields.
2. ✅ Clicking "Simulate chain" shows the dry-run output inside the Result pane (auto-shown via
   `ensurePaneVisible`), scrolling internally, never changing the overall builder height.
3. ✅ Edit mode with `listRuns`/`listRunLegs` adapter support shows the Run History inside the
   Result pane by default, same discoverability as before, same internal scroll.
4. ✅ Neither block renders outside the pane filmstrip anymore (verified: the old unconditional
   `{sim && ...}`/`RunHistory` blocks below the track are gone; a new test confirms the dry-run
   text's nearest `chained-builder-pane-*` ancestor is `chained-builder-pane-result`).
5. ✅ The Raw JSON pane's fallback contract (jsdom / SSR / `forceFallback`) is pixel-for-pixel
   unchanged from today — same testid, same pretty-printed text, same newlines; all 52 pre-existing
   Raw-JSON-pane tests pass with zero content changes (only a new module mock added).
6. ✅ A real browser renders the Raw JSON pane through CodeMirror with a line-number gutter and
   JSON syntax mode, read-only (`editable={false}`).
7. ✅ Full suite green (1636/1636, stable across repeat runs), `tsc`/build clean.

## Findings from the nectar review

Single focused correctness-lens pass (proportionate — layout/plumbing change reusing
already-reviewed 0.20.0 pane math and already-shipped `SimPanel`/`RunHistory` content, no new
business logic). One MEDIUM, no real logic bugs:

- **MEDIUM — two doc comments went stale the moment the implementation changed out from under
  them.** The module-level docblock still listed only "Pact code / Fields / Raw JSON" (omitting
  the new 4th pane), and `RunHistory`'s own doc comment asserted the OPPOSITE of what the new code
  does — it claimed `RunHistory` is "never a 4th toggleable pane" and that an unbounded block below
  the filmstrip is "zero-risk to [the pane-sizing] math," when the whole point of this change was
  making it a real, evictable pane subject to that exact math. A real risk: a future maintainer
  trusting that comment while touching `panes`/the fit math could reasonably conclude the Result
  pane doesn't need considering. Fixed: both comments rewritten to describe the actual
  bounded-pane behavior, cross-referencing `ensurePaneVisible` and this design doc.
- Explicitly re-verified (no findings): `visiblePanes`'s lazy initializer reads the real `editId`
  prop and the real `adapter` returned by `useKhronotonAdapter()` — both already in scope at that
  point in the component body, not a later-derived stand-in; the Result pane's empty-state
  condition is the exact logical negation of its two sibling render conditions (confirmed by
  reading all three side by side, not assumed); the old below-the-track blocks are genuinely
  removed, not duplicated; `RawJsonViewer`'s wrapper-div testid and the test mock's deliberately
  testid-less `<pre>` together avoid a duplicate-testid break of `getByTestId`'s single-match
  contract; `editable={false}` + `readOnly` on the CodeMirror instance are not contradictory.

