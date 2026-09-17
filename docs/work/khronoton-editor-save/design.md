# Khronoton editor — discoverable edit-mode Save — Design

## Problem

Editing an existing cronoton in the package `Builder` has no discoverable Save. The only
save action is the "Commit Codex Cronoton" button on the last (Execute) tab, which reads
like *create*, not *save my edits*, and silently disables under AUTO gas until a Simulate
has run. An operator who opens a cronoton, switches gas to AUTO on the Config tab, and
looks for a way to persist it finds nothing — the save action is on another tab, disabled,
with no explanation on the tab they're actually on. Verified: `Builder.tsx` renders no
save affordance outside `ExecuteTab`, and `ExecuteTab`'s commit button has no `isEdit`
awareness at all (always reads "Commit Codex Cronoton"). The Hub already hit this and
fixed it in its own hand-rolled editor (`Talos.3`, commit `a546fd60`); this port brings
the same fix to the canonical package UI so every consumer — and a future Hub migration
onto the package UI — gets it.

## Approach

Add an always-visible edit-mode Save bar, rendered once in `Builder.tsx` above the
Pact-editor/tabs (visible regardless of which tab is active), containing a Simulate
button, a "Save changes" button, and a one-line status. A new shared hook,
`useCommitGate(state, sim)` (in `ui/builder/use-commit-gate.ts`), wraps the existing
`builderToCommit`/`canCommit` + `useMemo` pair that already lives inside `ExecuteTab` —
`ExecuteTab` is refactored to call the hook instead of computing them inline (byte-
identical behavior, single source of truth), and the new `SaveBar` component calls the
same hook independently. `sim` (the `useSimulate()` result) is *already* hoisted to
`Builder.tsx` and shared by `TxMeters` + `ExecuteTab`; `SaveBar` receives the same object,
so its status line reacts to a Simulate run triggered from *either* button with no new
state.

**Alternatives considered:**
- Duplicate the gate/commit computation inline in `SaveBar` — rejected: two independent
  `canCommit`/`builderToCommit` call sites risk drifting apart, exactly what this
  package's own `assertAutoGasGate`/`assertGasPriceBufferAnu` precedent argues against.
- Hoist `gate`/`commit` fully into `Builder.tsx` and thread as required props into both
  `ExecuteTab` and `SaveBar` — rejected: reshapes `ExecuteTab`'s existing, well-tested
  prop contract for no behavioral gain over the hook approach; more risk for the same
  outcome.

**Status line** (priority order, mirrors `ExecuteTab`'s own `onSimulate` precedence —
`postponed` checked before `ok`/`error` — plus the two new default states the Hub's fix
adds):
1. `sim.pending` → `"Running dry-run…"`
2. `sim.result.postponed` → `"Simulation postponed{ — N planned transactions}."`
3. `sim.result.ok === false` → `"Simulate failed: {error}"`
4. `sim.result.ok && typeof calibratedGasLimit === "number"` →
   `"Calibrated gas {N} — ready to save."`
5. `!gate.ok` (no result yet, or an `ok` result with nothing left to report) → the first
   `gate.reasons[0]` (e.g. the AUTO-gas-needs-Simulate message)
6. else → `"Changes apply at the next fire."`

**`SaveBar`'s Save button reuses `Builder.tsx`'s existing `handleCommit`** (passed down as
`onSave`, same callback `ExecuteTab` already receives as `onCommit`) — no new endpoint, no
new validation, matches the handoff's explicit constraint.

**Access.** `Builder.tsx` currently receives `access: Access` but discards it
(`access: _access`) — the whole component assumes "the host gates the route to admins."
`SaveBar` is the new, more prominent affordance the handoff explicitly asks to gate
(`canMutate(access)`, reusing `ui/access.ts`'s existing pure predicate): a non-admin or
logged-out viewer who somehow reaches an edit route must never see an enabled Save there,
even though today's `ExecuteTab` Commit button has never carried this check. `Builder.tsx`
stops discarding `access` and threads it to `SaveBar` only.

**`ExecuteTab`'s commit button becomes edit-aware**, per the handoff's ask #2: a new
`isEdit?: boolean` prop, button text `"Save changes"` / `"Saving…"` in edit mode,
unchanged `"Commit Codex Cronoton"` in create mode. No other behavior change — same gate,
same disabled state, same access (none, as today).

**Placement.** The Hub's reference bar renders "above the two-pane" (their left/right
split). This package's `Builder` is top/bottom (Pact editor full-width on top, header +
tabs below), so "above everything" means above both — placed at the very top of the
`isEdit` branch, before the existing `EDIT_BANNER` informational text, since the save
affordance is the thing an operator is looking for and should be the first thing they see.

## Scope (files)

- `ui/builder/use-commit-gate.ts` (new) — `useCommitGate(state, sim)` hook.
- `ui/builder/ExecuteTab.tsx` — refactor to call the hook; add `isEdit` prop + edit-aware
  button text.
- `ui/builder/SaveBar.tsx` (new) — the always-visible edit-mode Save bar.
- `ui/builder/Builder.tsx` — stop discarding `access`; render `<SaveBar>` when `isEdit`;
  pass `isEdit` to `<ExecuteTab>`.
- Test files for every module above.

## Acceptance criteria

- [ ] In edit mode, a Save bar (Simulate + Save changes + status line) is visible on
      every tab, not just Execute.
- [ ] Switching gas to AUTO on the Config tab and looking at the Save bar shows the exact
      reason Save is disabled (the AUTO-gas-needs-Simulate message), without switching
      tabs.
- [ ] Running Simulate from the Save bar calibrates gas and opens the gate — verified by
      the status line changing to "Calibrated gas N — ready to save." and the Save button
      becoming enabled, with no tab switch required.
- [ ] Clicking "Save changes" issues the same PATCH `edit.run` already used by the
      Execute-tab Commit button — no new endpoint, no duplicated validation.
- [ ] The Execute tab's own commit button now reads "Save changes" / "Saving…" in edit
      mode; a NEW cronoton (create mode) is unaffected — the button still reads "Commit
      Codex Cronoton" and no Save bar renders.
- [ ] A non-admin or logged-out `Access` tier viewing an edit route never sees an enabled
      Save bar button.

## Out of scope

- Gating `ExecuteTab`'s own Commit button with `canMutate(access)` — it has never carried
  this check (the whole `Builder` assumes host-gated route access); only the new, more
  prominent `SaveBar` gets it, per the handoff's specific ask. Not a regression, but a
  latent inconsistency the handoff didn't ask to close — flagged here as a deliberate
  boundary, not an oversight.
- Any change to firing, scheduling, pricing, or the server engine — this is purely an
  editor UX affordance (per the handoff's own "Notes").
- The Hub's own editor (`components/admin/codex-cronotons/`) — already fixed independently
  as Talos.3; this topic is package-side only.
- The unrelated pool-payout gas-display aside in the handoff (confirmed not a bug by the
  handoff itself — no package action needed).
