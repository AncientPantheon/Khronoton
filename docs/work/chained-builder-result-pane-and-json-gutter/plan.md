# Plan

1. `@codemirror/lang-json` added as peer + dev dependency (done, matches the existing
   `@codemirror/*` peer-dep convention — optional in `peerDependenciesMeta`).
2. `PactCodeMirror.tsx`: export `khronotonEditorTheme` (was module-local). No behavior change —
   verify `PactCodeMirror.test.ts` still passes unmodified.
3. New `RawJsonCodeMirror.tsx` (real CodeMirror, read-only JSON mode, reached only via dynamic
   `import()`), new `RawJsonViewer.tsx` (SSR-safe wrapper, mirrors `PactCodeEditor.tsx`). New
   `RawJsonViewer.test.tsx` mirroring `PactCodeEditor.test.tsx`'s `forceFallback` contract:
   - renders the given value inside a `data-testid="chained-builder-raw-json-pre"` `<pre>` via
     `forceFallback`.
   - SSR (`renderToStaticMarkup`) renders the same fallback, never crashes.
   - preserves real newlines (pretty-printed value in, same text out — no reformatting).
4. `ChainedBuilder.tsx`'s raw-pane branch: swap the inline `<pre>{codeText}</pre>` for
   `<RawJsonViewer value={codeText} />`. `ChainedBuilder.test.tsx`: add
   `vi.mock("../RawJsonCodeMirror.js", ...)` (mirrors the existing Pact-code mock) returning a
   `<pre data-testid="chained-builder-raw-json-pre">{value}</pre>` stand-in. Run the FULL existing
   suite — every pre-existing Raw-JSON-pane test must pass with ZERO test-content changes (only
   the new mock line added); confirms the swap is truly behavior-preserving under test.
5. `ChainedBuilder.tsx`: add the `"result"` pane entry between `"pact"` and `"fields"`; change
   `visiblePanes`'s `useState` to a lazy initializer that includes `"result"` by default iff
   `Boolean(editId) && adapter.listRuns && adapter.listRunLegs`; add `ensurePaneVisible(key)`
   (the "add" branch of `togglePane`, factored out and shared); call it from `handleSimulate`
   right after a successful `setSim`; move the `{sim && <SimPanel/>}` and `RunHistory` blocks
   into the new `p.key === "result"` pane branch, wrapped in a `flex:1, minHeight:0,
   overflowY:"auto"` scroll box, with an empty-state message when neither applies.
6. New tests in `ChainedBuilder.test.tsx`:
   a. "Result" chip renders in the pane strip.
   b. Create mode, before Simulate: Result pane not shown by default (pact+fields only).
   c. Clicking Simulate auto-shows the Result pane with the dry-run output; the existing
      "Dry run: chain OK" test continues to pass UNCHANGED (proves the auto-show doesn't need
      its own extra click).
   d. Edit mode + adapter run-history support: Result pane shown by default, contains "Run
      history" without any click.
   e. The scroll wrapper inside the Result pane carries `overflowY: "auto"` (structural proof,
      not a real-layout proof — jsdom has no layout engine).
   f. Neither block renders as a sibling of the pane track anymore (query the DOM structure: no
      `panel`-styled block between the track and the closing wrapper outside any
      `data-testid="chained-builder-pane-*"`).
7. Full suite run twice (stability), `tsc --noEmit`, `npm run build`.
8. Nectar review: single correctness-lens pass (proportionate — layout/plumbing change reusing
   already-reviewed 0.20.0 pane math + already-shipped SimPanel/RunHistory content, no new
   business logic) — explicitly check the `ensurePaneVisible`/`togglePane` duplication didn't
   diverge in behavior, and that the lazy `visiblePanes` initializer reads `editId`/`adapter`
   correctly (both available at that point in the component body).
9. Version bump, CHANGELOG/README, publish, report the version back.
