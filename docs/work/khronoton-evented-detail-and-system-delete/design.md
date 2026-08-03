# Khronoton — evented DETAIL schedule + confirm-gated system delete (0.8.0) — Design

## Problem

Two evented-server-resolver UI gaps remain after 0.7.0 (the store side is complete; verified live against
Pythia v2.7.22–2.7.25). They are the last things blocking the Pythia automatic-link feature end-to-end.

1. **The cronoton DETAIL card's "Schedule" field is inconsistent for a trigger-only/evented row.** On the
   read-only Detail card, **Next Fire** already shows "—" (its `InstantCell` renders `next_fire_at = NULL`
   as an em-dash) and the **edit form** already disables the schedule controls (`eventedNames.has(...)`), but
   the **Schedule** field on that same card still renders the stored `schedule_config` (e.g. "Daily at 12:00
   UTC"). Root cause: `Detail.tsx` computes `triggerOnly = runtimeArgKeys.length > 0` — it does **not** check
   `external_fireable`, so an evented row (external-fireable, no runtime args) falls through to `scheduleLine(row)`.
   The list's `isTriggerOnly` was broadened in 0.7.0 to include `external_fireable === 1`; Detail was not.
2. **A system (server-resolver) cronoton is hard-blocked from deletion.** The `deleteCodexCronoton` handler
   refuses any `server_resolver` row with `409 { protected: true }`, and `deleteDisabled` greys the Delete
   button for such rows. An operator cannot clean up a wrong/duplicate system cronoton from the Builder
   (Pythia has an API-only `force-delete` stopgap, but nothing in the bundled UI reaches it).

## Approach

Two coordinated fixes; the store's delete primitive (`server/store/cronoton.ts` — an unconditional DELETE) is
already correct and unchanged. All gating lives in the handler + UI.

### Fix 1 — DETAIL "Schedule" reads "Evented" for a trigger-only row (one predicate, shared)

- Extract the list's local `isTriggerOnly(row)` into a shared UI helper `src/ui/row-derive.ts`
  (`row.external_fireable === 1 || parseRuntimeArgKeys(row.runtime_arg_keys).length > 0`), and use it in
  **both** `CronotonList.tsx` (replacing the local copy) and `Detail.tsx`. This is "the exact same check the
  edit form + list already use" the handoff asks for, from one source of truth — not a second inline copy.
- In `Detail.tsx`, compute `triggerOnly` via the shared helper and render the **Schedule** MetaCell as the
  styled label **"Evented"** when trigger-only (Next Fire already renders "—" via `InstantCell`; no change
  there). This replaces the current `triggerOnly ? "Trigger-only — no schedule" : scheduleLine(row)` with
  `triggerOnly ? "Evented" : scheduleLine(row)`, matching the list's next-fire label and arch §6.2.

### Fix 2 — confirm-gated force-delete for a system cronoton, reachable from the Builder

Thread an explicit **force** signal from the UI through the adapter to the handler; enable the button for
admins; warn before deleting.

- **Handler** (`handlers/cronoton.ts` `deleteCodexCronoton`): read `force` from `req.query` (`"1"`/`"true"`
  → true). Keep the `409 { protected: true }` refusal for a `server_resolver` row **only when force is
  absent**; when force is present, proceed to `storeDelete` regardless. Keep the audit, and add
  `forced: true` to the audit `detail` for a forced system delete so the trail distinguishes it. A force
  delete on a non-system row is harmless (it just deletes) — no new behavior there.
- **Adapter contract** (`provider/adapter.ts`): add `force?: boolean` to `ConfirmOpts` (the object already
  threaded to `delete`) — a minimal, additive, non-breaking field. No new `REQUIRED_METHODS` change (delete
  is already required).
- **fetch-adapter**: `delete(id, opts)` appends `?force=1` to the path when `opts?.force`.
- **memory-adapter**: `delete(id, opts)` passes `query: { force: "1" }` when `opts?.force` (via the existing
  `scalarQuery` helper, so an absent flag hits the handler default).
- **Action hook** (`hooks/useCronotonActions.ts`): widen `DeleteAction` to `GatedAction<[DeleteRunOpts?],
  DeleteView>` where `DeleteRunOpts = { force?: boolean }`; the `remove` factory merges the run-time `force`
  into the gated adapter call: `(opts) => adapter.delete(target, { ...opts, force })`. `run()` (no arg) stays
  byte-compatible for the existing non-system callers.
- **Access rule** (`ui/access.ts` `deleteDisabled`): stop hard-disabling a `server_resolver` row. New order:
  non-admin → disabled (`ADMIN_ONLY_TITLE`); admin + system → **enabled**, carrying the (reworded)
  `SYSTEM_CRONOTON_DELETE_TITLE` as an informative hover ("System cronoton — deleting removes the automaton's
  template; you'll be warned first."); admin + working → `WORKING`; else `ENABLED`.
- **Warning copy** (`ui/confirm-flows.ts`): add `deleteSystemConfirm(name, serverResolver)` →
  `` This is the automaton's "<serverResolver>" template. Deleting it stops that capability until it's
  recreated. Delete "<name>" anyway? `` (arch §6.2 / handoff wording).
- **Both screens** (`Detail.tsx` + `CronotonList.tsx` `handleDelete`): when `row.server_resolver` is set, show
  `deleteSystemConfirm(...)` as the first prompt (instead of the fire-history `deleteConfirm`), keep the
  in-gate `deletePasswordConfirm`, and call `remove.run({ force: true })`. Non-system rows are unchanged
  (`deleteConfirm` → password → `remove.run()`).

### Alternatives considered

- **`?force=1` vs a body flag vs reusing the confirm bit** — chose a query param (the handoff's suggested
  shape). The confirm bit already means "a fresh admin-confirm accompanied this" and is orthogonal to "the
  operator accepted the system-delete warning"; overloading it would let any confirmed delete bypass the
  system guard silently. A dedicated `force` is explicit and auditable.
- **A separate `forceDelete()` adapter method / handler route** (mirroring Pythia's stopgap) — rejected:
  doubles the delete surface and `REQUIRED_METHODS`; a `force?` on the existing `delete` is smaller and keeps
  one delete path.
- **Detail: inline-duplicate the `external_fireable` check** — rejected in favor of the shared `isTriggerOnly`
  helper, so List and Detail can never drift again (the exact bug this fixes).
- **Show "Evented" only for `external_fireable`, keep "Trigger-only — no schedule" for runtime-arg rows** —
  rejected: the list already labels every trigger-only row "Evented"; Detail must match the list, and arch
  §6.2 says a trigger-only row's Schedule reads "Evented".

## Decisions

- **Target version: MINOR 0.8.0.** New public surface (`ConfirmOpts.force`, widened `DeleteAction` args, the
  `deleteSystemConfirm` export, the shared `isTriggerOnly`/`row-derive` export) + changed delete behavior
  (system rows now deletable with force); no breaking removal — `delete(id)`/`remove.run()` without force stay
  identical, and a system delete without force still 409s.
- **The `force` audit trail is preserved and enriched** (`forced: true`), per the handoff's "keep the audit
  trail on the delete".
- Autonomous delivery: the operator gave the full 2-fix spec + "publish 0.8.0 and tell Pythia". No pause for
  design approval.

## Acceptance criteria

- [ ] An evented (external-fireable) cronoton's **Detail** card shows **Schedule = "Evented"** (never the
      stored mode/config like "Daily at 12:00 UTC"); Next Fire still shows "—". A normal scheduled cronoton's
      Detail still shows its schedule summary.
- [ ] The list and detail derive trigger-only from the **same** `isTriggerOnly(row)` helper
      (`external_fireable === 1 || runtime-arg keys present`).
- [ ] `deleteDisabled` returns **enabled** for an admin on a `server_resolver` row (disabled for a non-admin);
      the bundled Detail + List Delete buttons are clickable for a system cronoton.
- [ ] Deleting a system cronoton from the UI shows the `deleteSystemConfirm` warning naming its
      `server_resolver`, then (on confirm) issues `delete(id, { force: true })` → the handler deletes it and
      writes an audit with `forced: true`.
- [ ] `DELETE /[id]` **without** force still returns `409 { protected: true }` for a `server_resolver` row;
      **with** `?force=1` it deletes and returns `{ ok: true }`. A non-system delete is unaffected either way.
- [ ] All existing khronoton-core tests pass; new tests cover the Detail "Evented" schedule cell, the shared
      `isTriggerOnly`, the handler force/no-force branch (+ audit `forced`), both adapters' force plumbing, the
      widened delete action, `deleteDisabled` for system rows, and the UI warning→force-delete flow.

## Out of scope

- Ask 5's edit-time `externalFireable` patch, Ask 6.2's resolver ROSTER view, and Ask 7's URL routing — the
  operator scoped 0.8.0 to exactly these two fixes.
- Changing the store's `deleteCodexCronoton` primitive (already an unconditional DELETE — correct).
- Pythia-side changes beyond bumping its pin `^0.7.0 → ^0.8.0` and retiring its `force-delete` stopgap.
