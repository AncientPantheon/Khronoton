# Handoff — Khronoton package `Builder`: add a discoverable edit-mode **Save** affordance

**For:** the `@ancientpantheon/khronoton-core` package agent.
**From:** AncientHoldings Hub (fix shipped Hub-side as **Talos.3**, commit `a546fd60`).
**Date:** 2026-09-17.

## TL;DR

Editing an existing cronoton in the Khronoton builder has **no discoverable Save**.
The only save action is a **"Commit"** button on the last (Execute) tab, which
**silently disables under AUTO gas** until a Simulate has run. An operator who
opens a cronoton, flips gas to AUTO on the Config tab, and looks for a way to
persist it finds nothing obvious — the save button is on another tab *and*
disabled, with no explanation on the tab they're on.

The Hub just fixed this in its **own** (hand-rolled) editor. The canonical
package UI `Builder` almost certainly has the same gap. **Please verify, and if
so add the same always-visible edit-mode Save affordance at the package level**
so every consumer — and a future Hub migration onto the package UI — gets it.

## Background — two parallel editors

- The package ships the canonical Khronoton UI at **`@ancientpantheon/khronoton-core/ui`**
  (v0.4.2), exporting `Builder({ editId, access, onDone, robots })`, plus
  `Detail`, `CronotonList`, `Public`, the badge/pill atoms, `KhronotonUiRoot`,
  the `Access` model, and `PactCodeMirror`. Token-styled (`.khronoton-ui` scope,
  `--khr-*` vars, no Tailwind).
- The AncientHoldings Hub does **not** use the package UI — it imports only
  `@ancientpantheon/khronoton-core/server` (the engine) and has a hand-rolled
  editor at `components/admin/codex-cronotons/` (`CodexCronotonBuilder` + tabs).
  The Talos migration adopted the package's server engine but kept the Hub's own
  editor UI.
- The Hub editor is a structural fork of the package `Builder` — same
  `{ editId, onDone }` shape, same Config / Payload / Gas Payer / Signatures /
  Execute tabs, same Simulate → calibrate → Commit flow — so the gap the Hub just
  fixed is very likely present in the package `Builder` too. Package source:
  **`AncientPantheon/constructors/Khronoton/packages/khronoton-core`** (the `ui/`
  builder + tabs; published surface `dist/ui/`).

## The bug (edit mode = `editId` set)

- The only save action is the **Commit** button on the **Execute** tab (the last
  tab). Its label ("Commit …") reads like *create*, not *save my edits*.
- It is gated by the commit gate: with **AUTO gas** selected and **no successful
  Simulate yet**, the gate is CLOSED — reason *"AUTO gas requires a successful
  Simulate to calibrate, or switch to manual"* — so the button is **disabled**.
- Net effect: from the Config tab (where you'd switch to AUTO), there is no
  visible, working way to save, and no visible reason why.

## The Hub fix (reference implementation — mirror this)

Commit `a546fd60`, two files:

1. **`CodexCronotonBuilder.tsx`** — added an always-visible **edit-mode Save bar**
   (rendered only when `editId` is set, on **every** tab, above the two-pane):
   - a **Simulate** button (runs the same dry-run / AUTO-gas calibration);
   - a **Save changes** button (runs the same commit → PATCH), disabled per the
     shared commit gate (`canCommit`);
   - a live one-line **status**: `Running dry-run…` while simulating →
     `Calibrated gas N — ready to save.` after a successful Simulate →
     `Simulate failed: …` on error → else the first commit-gate blocking reason
     (e.g. the AUTO-gas-needs-Simulate message) → else `Changes apply at the next
     fire.`
2. **`ExecuteTab.tsx`** — the Execute-tab commit button now reads **"Save
   changes" / "Saving…"** in edit mode (was always "Commit Codex Cronoton").

Design rationale:
- Edit-mode ONLY. Create mode keeps the Execute-tab flow (a new cronoton still
  needs its schedule set on the Execute tab before commit).
- Reuses the existing simulate + commit handlers and the shared commit gate — no
  new endpoint, no new validation.
- Surfacing the gate reason inline is what resolves the "why can't I save?"
  confusion when AUTO gas needs a Simulate.

## The ask (package level)

1. **Verify** whether `@ancientpantheon/khronoton-core/ui` `Builder`, in edit mode,
   has a discoverable always-visible Save, or only the single-tab Commit that
   disables under AUTO gas.
2. If the gap exists, **add the same always-visible edit-mode Save affordance**
   (Simulate + Save changes + live gate-reason status) and make the commit button
   **edit-aware** ("Save changes" in edit mode). Translate the Hub's Tailwind
   classes to the package's inline `var(--khr-*)` token styling — no Tailwind
   ships from the package.
3. **Honor the `Access` model** — a non-admin/logged-out viewer must never see an
   enabled Save (reuse the package's existing disable/tooltip predicates).
4. **Don't regress create mode.**

## Notes

- Purely an editor UX affordance — no change to firing, scheduling, pricing, or
  the server engine.
- Version per the package's own conventions; the Hub fix (Talos.3) is independent
  and does not depend on the package change.
- Unrelated aside an operator raised in the same report: a pool-payout fire
  showing `594 / 600,000` gas is **not** a bug — that's the Hub's
  `payout-bulk-tx` `DEFAULT_BULK_GAS_LIMIT` headroom for a full batch, and the fee
  is charged on gas *used*, not the limit. No package action needed.
