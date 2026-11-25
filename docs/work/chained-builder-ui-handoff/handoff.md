# Handoff — embed the settled Chained-Builder UI + publish

**From:** AncientHoldings Hub session (consumer side)
**To:** khronoton-core package agent (owner of this repo)
**Date:** 2026-11-25
**Status:** UI shape is **settled and owner-approved**. All edits are already in your
working tree on `main`, uncommitted. Your job: review → run the gates → **embed +
publish a version** so the Hub can pin it.

---

## 1. What this is

The **chained-cronoton builder** (`src/ui/chained/ChainedBuilder.tsx`) UI was iterated
SHAPE-FIRST in the Hub's local browser-pane preview against the owner's feedback, over
two refinement rounds. The owner has now signed off on the shape ("tell the khronoton
agent to embed this in the package"). The code changes that produce that shape are
sitting in **this repo's working tree** (I edited the package source directly during the
preview loop — that's the agreed workflow: iterate here, you publish).

Do **not** rebuild the shape from scratch — it's done. Review it, verify the one thing I
could not (CodeMirror fill — see §4), and publish.

---

## 2. Working-tree state right now (on `main`, uncommitted)

```
 M packages/khronoton-core/src/ui/chained/ChainedBuilder.tsx    # the refactor (main change)
 M packages/khronoton-core/src/ui/chained/StepWorkspace.tsx     # + fillEditor prop
 M packages/khronoton-core/src/ui/PactCodeEditor.tsx            # + fill prop; height now number|string
 M packages/khronoton-core/src/ui/PactCodeMirror.tsx            # height: number | string
?? packages/khronoton-core/src/ui/chained/step-result-text.ts  # NEW formatStepResult helper — needs `git add`
```

`preview-dist/` is gitignored (confirmed) — it's preview-only and must **not** ship. Its
`PactCodeMirror.js` is a textarea stub, not CodeMirror; ignore it.

Current version: **0.17.0** (last tag `v0.17.0`).

---

## 3. What the changes do (the owner-approved shape)

All of this is verified live in the Hub preview via DOM measurement + screenshots.

1. **Centered, width-capped builder.** The whole rail+panes block is measured via a
   `rootRef` ResizeObserver and capped at `bodyMaxWidth = RAIL + GAP + workspaceMaxWidth`,
   then `alignSelf:"center"`. No more left-dumped void.
2. **No horizontal scroll, ever.** The pane strip renders **at most `fit`** panes
   (`renderedPanes = panes.filter(visible).slice(-fit)`); the Pact/Fields buttons are
   **toggle chips** (show/hide), and adding one past capacity drops the oldest. `paneW`
   sizes to the count **actually shown** (2 visible → full width each), not to capacity,
   so there's no dead space. Verified `docOverflowX: 0` at every width.
3. **Pact editor flex-fills its pane height — no vertical scroll, no clip.** The old
   fixed-pixel `editorHeight` clipped the editor by ~55px because it couldn't know the
   height of the Mode/Yield row above it. Replaced with a real flex-fill threaded
   `StepWorkspace(fillEditor) → PactCodeEditor(fill) → PactCodeMirror(height:"100%")`.
   Panes stretch to equal height; the editor grows/shrinks with the pane. Verified
   `editorBottomGap: 16` (inside the card, no clip).
4. **Fields pane = two main tabs: `Step config` | `Whole cronoton`,** defaulting to
   **Step config** (the dominant surface). Schedule moved into the Whole-cronoton tab so
   it no longer competes with step config for vertical space.
5. **Name + Description share one field** via a `Name | Description` sub-toggle (halves
   that block's height).
6. **Whole-cronoton tab flashes to warn** when nothing identifies the cronoton yet:
   amber pulse (`khr-attn` keyframe, injected `<style>` inside the component — self-
   contained) + a `•` dot, gated on `wholeIncomplete = state.name.trim().length === 0`.
   Flash + dots clear the instant a name is typed, and "Name is required" drops off the
   gate. Verified.

New optional props (all back-compat, default to prior behavior):
- `PactCodeEditor.fill?: boolean`
- `StepWorkspace.fillEditor?: boolean`
- `PactCodeMirror.height: number | string` (was `number`; render guards with
  `typeof height === "number" ? ${height}px : height`)

---

## 4. ⚠️ The one thing you MUST verify that I could not

My preview exercises the **textarea stub**, not CodeMirror (the Z: SMB box can't dlopen
CodeMirror's native deps). So **verify the flex-fill against the REAL CodeMirror editor**:

- CodeMirror with `height="100%"` needs its ancestor chain bounded. `PactCodeEditor`'s
  fill branch gives the panel `{height:"100%", minHeight:0}` and the body `{flex:1,
  minHeight:0}`; `StepWorkspace` wraps it in `{flex:1, minHeight:0}`; the pane
  (`ChainedBuilder`) is a bounded flex column. Mount it in a bounded-height harness and
  confirm: editor fills the pane, **no clip at the bottom, no runaway vertical growth**,
  internal scroll works.
- Run the existing UI test gate. In particular `PactCodeMirror.test.ts` pins the theme
  spec + the `height` derivation — confirm the `number | string` widening didn't break
  the `${height}px` numeric path (it's guarded, but run it).

If the real editor needs a small tweak to the fill CSS, make it — the prop contract is
the settled part, the exact CSS to satisfy CodeMirror is yours to finalize.

---

## 5. Consumer contract the Hub needs documented

- **The builder fills `height: 100%`.** The mount MUST give it a bounded height or it
  collapses. The preview harness used `#root { height: calc(100vh - 40px); overflow:
  hidden }`. Please note this in the component doc / README / a prop comment so the Hub
  mount gets it right.
- `commitChain` / `simulateChain` adapter methods remain **optional** (unchanged from
  0.17.0).

---

## 6. Explicitly OUT of scope for this handoff

- **Descriptor-driven planner form** — replacing `StepWorkspace`'s raw
  `plannerParamsJson` textarea (around StepWorkspace.tsx:243) with a schema-driven form
  consuming `builtins/descriptors.ts` (`preview()` + standalone/composable badge +
  `toFragment()` wiring caps into Signatures). This is the remaining UI gap but it is
  **NOT greenlit** — do not build it as part of this publish. It's `docs/work/builtin-
  descriptors/` territory, separate cycle.
- **Deeper ScheduleStep compaction** — `ScheduleStep` is **shared with the single-tx
  builder**. It was only *isolated into its own tab* here, not internally compacted.
  Leave it as-is unless the owner asks (changing it touches the single-tx builder too).

---

## 7. The ask

1. `git add` the new `step-result-text.ts`, review the 5-file diff.
2. Verify §4 (real CodeMirror fill + test gate), typecheck, lint.
3. **Bump a version + publish.** This is a feature-level UI change (new tabbed layout +
   fill mode + new optional props) → a **minor** bump (0.17.0 → 0.18.0) reads right, but
   it's your ChronVer call.
4. Tell the Hub the published version string. The Hub will then: pin it, `npm install`,
   build, wire the bounded-height mount, bump `lib/version.ts`, and update `/docs` +
   the per-codename release page (Hub's rule: every user-visible change updates `/docs`).

The exact approved shape is running in the Hub session's local preview if you want a
visual reference, but the code in your tree IS that shape.
