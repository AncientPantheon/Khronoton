# Handoff — ChainedBuilder layout tweaks: Pact-editor fill-height + a wider "extended fit"

**From:** AncientHoldings Hub session (consumer of `@ancientpantheon/khronoton-core`)
**To:** khronoton-core package agent
**Date:** 2026-11-26
**Status:** two requested `ChainedBuilder` UI refinements for the next release. The
Hub is live on **0.19.0** (Hub release Talos.20). Owner-reviewed against the real
live builder (full-page mount in the Hub, StoicismRewardFlow imported).

Both are internal to `src/ui/chained/ChainedBuilder.tsx` (+ `StepWorkspace.tsx` /
`PactCodeEditor.tsx`) — the Hub mounts `<ChainedBuilder>` as a black box (props are
only `access` / `onDone` / `robots`), so it cannot reach either. This is a package
change.

## 1. The Pact code editor does not fill its pane's height

**Symptom (live, full-page mount):** the Pact editor stops at its content height —
e.g. a 25-line program renders ~25 lines tall and then there is empty dark space
below it, down to the bottom of the pane. The *pane* fills the column height
correctly; the **editor inside it does not grow** to fill that pane.

**What's already there (so this is a bug, not missing wiring):**
- `ChainedBuilder.tsx` Pact pane: `<div style={{ ...panel, flex: 1, display: "flex",
  flexDirection: "column", minHeight: 0 }}>` → `<StepWorkspace … pane="editor"
  fillEditor />`.
- `StepWorkspace.tsx`: the editor branch wraps it in `<div style={{ flex: 1,
  minHeight: 0 }}>` → `<PactCodeEditor height={editorHeight} fill={fillEditor} />`.
- `PactCodeEditor.tsx`: `fill` → `bodyHeight = fill ? "100%" : height` (default 460).

So the flex chain *looks* correct, yet the editor still sizes to content in the live
builder. Likely one of: (a) CodeMirror's own `.cm-editor` / `.cm-scroller` height is
not set to fill (CodeMirror needs an explicit `&{height:100%}` + a scrolling
`.cm-scroller` in fill mode, otherwise it collapses to content height even inside a
`height:100%` wrapper); or (b) a parent between the bounded flex child and the
CodeMirror host loses the bound so `100%` resolves against an auto-height ancestor.

**Ask:** make the Pact editor **truly flex-fill its pane** in `fill` mode — the editor
body grows to the full pane height and scrolls internally past that, with no empty gap
below short programs and no clipping of long ones. Please reproduce in the preview
harness (`#root { height: calc(100vh - 40px); overflow: hidden }`) with a short program
(see the gap) and a long one (see it scroll, not clip), then fix. The non-fill fixed
`height` path (used elsewhere) should be unaffected.

## 2. Expose pane sizing as integrator-settable props (default unchanged)

**Today:** `PANE_MIN = 360` and `PANE_MAX = 600` (ChainedBuilder.tsx ~lines 289–290) are
hard-coded constants. The "Fit" control (`Auto | 1 | 2 | 3`) only changes how *many* panes
render (`fit`), never their width — so on a wide monitor with only Pact + Raw JSON shown,
each still caps at 600px and a large void is centred around them. The consuming integrator
(the Hub) cannot influence this at all.

**The owner's position (and we agree):** rather than bake in one *new* fixed size, the
package should ship a sensible **default** and let the **integrator decide** the sizing.
The Hub mounts `<ChainedBuilder>` full-page and knows how much room it has; it should be
able to widen the panes (e.g. to ~1100–1200 for Pact + Raw JSON) without a package change
each time the preference shifts.

**Ask:** add optional sizing **props** to `ChainedBuilder` (all defaulting to today's
exact values, so this is fully backward-compatible — omitting them reproduces current
behaviour byte-for-byte):
- `paneMaxWidth?: number` — default `600`. The per-pane width cap.
- `paneMinWidth?: number` — default `360`. Feeds `autoFit` / the "too cramped → fewer
  panes" threshold, so a larger min naturally lowers the auto pane count.
- (optional, your call if cheap) `railWidth?: number` (default `210`) and/or a way to
  cap/choose the `Fit` options — only if it falls out naturally; the two above are the core.

Prefer real props over a grab-bag `style`/CSS-var object, so the sizing stays typed and the
internal invariants can be enforced against the configured numbers. Constraints to preserve
at ANY prop values: never introduce horizontal scroll (the current hard invariant); keep
the centred-surplus behaviour; derive `autoFit` from the *configured* `paneMinWidth`; work
at the full-page Hub mount and the preview harness alike. Document the new props in the
README with their defaults.

Then the Hub sizes the panes from its own mount (e.g. `paneMaxWidth={1200}`) — no package
change needed next time the owner wants them wider or narrower.

## The ask

Ship (1) the Pact-editor fill-height fix and (2) the integrator-settable pane-sizing props
in the next release, and reply with the version. The Hub will pin + redeploy and pass the
sizing props from its full-page `PackagedChainBuilder` mount — no other Hub wiring expected.
