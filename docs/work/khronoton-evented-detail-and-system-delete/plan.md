# Khronoton — evented DETAIL schedule + confirm-gated system delete (0.8.0) — Plan

Read design.md first (Approach + Decisions + acceptance criteria). Test-first for every task.

## Wave 1 (independent leaves — disjoint files, no cross-dependency)

- [x] T1: Shared `isTriggerOnly` helper + Detail "Evented" schedule cell (Fix 1).
  - Create `src/ui/row-derive.ts` exporting `isTriggerOnly(row: CodexCronotonRow): boolean` =
    `row.external_fireable === 1 || parseRuntimeArgKeys(row.runtime_arg_keys).length > 0` (import
    `parseRuntimeArgKeys` from `../server/pure/runtime-args.js`; import `CodexCronotonRow` type). Replace the
    local `isTriggerOnly` in `src/ui/CronotonList.tsx` with an import of the shared helper (behavior
    identical). In `src/ui/Detail.tsx`, compute `const triggerOnly = isTriggerOnly(row)` (was
    `runtimeArgKeys.length > 0`) and render the **Schedule** MetaCell as `triggerOnly ? "Evented" :
    scheduleLine(row)` (was `"Trigger-only — no schedule"`).
  - done when: `src/ui/row-derive.ts` exists and is imported by both `CronotonList.tsx` and `Detail.tsx`; a
    new `src/ui/row-derive.test.ts` asserts `isTriggerOnly` true for `external_fireable:1`, true for a
    non-empty `runtime_arg_keys`, false for a plain scheduled row; `Detail.test.tsx` asserts an
    external-fireable row's Schedule cell reads "Evented" (not a time) and a normal scheduled row still shows
    its summary; `CronotonList` tests still pass (next-fire "Evented" unchanged); `npx vitest run
    src/ui/row-derive.test.ts src/ui/Detail.test.tsx src/ui/CronotonList.test.tsx` green.
  - files: `src/ui/row-derive.ts`, `src/ui/row-derive.test.ts`, `src/ui/CronotonList.tsx`, `src/ui/Detail.tsx`,
    `src/ui/Detail.test.tsx`

- [x] T2: Handler force-delete branch + audit (Fix 2, server edge).
  - In `src/handlers/cronoton.ts` `deleteCodexCronoton`, read `const force = req.query?.force === "1" ||
    req.query?.force === "true";` inside the `withConfirm` body. Change the guard to `if (row.server_resolver
    && !force) return json(409, { error: "System cronoton — cannot be deleted. Pause it to disable instead.",
    protected: true });`. On delete, set the audit `detail` to `{ serverResolver: row.server_resolver ?? null,
    forced: row.server_resolver ? force : false }`. Everything else unchanged (404 on missing, `{ ok: true }`
    on success).
  - done when: `src/handlers/cronoton.test.ts` (or the delete handler's existing test file) proves: a
    `server_resolver` row deleted WITHOUT force → 409 `protected:true` (unchanged); the SAME row with
    `query:{force:"1"}` → `{ ok: true }` and the row is gone; a non-system row deletes with or without force;
    the forced delete records an audit with `forced:true`. `npx vitest run` for that file green.
  - files: `src/handlers/cronoton.ts`, `src/handlers/cronoton.test.ts`

- [x] T3: `ConfirmOpts.force` + both adapters thread `?force=1` (Fix 2, adapter contract + impls — one task
      because the contract change and both impls are tightly coupled and small).
  - `src/provider/adapter.ts`: add `force?: boolean` to `ConfirmOpts` (doc it: "permits deleting a
    server-resolver/system row; ignored by non-delete methods").
  - `src/provider/fetch-adapter.ts`: `delete(id, opts)` → `request<DeleteView>("DELETE", \`/${id}${opts?.force
    ? "?force=1" : ""}\`, { confirmed: opts?.confirmed })`.
  - `src/provider/memory-adapter.ts`: `delete(id, opts)` → `call<DeleteView>(deleteCodexCronoton, { params: {
    id }, query: opts?.force ? { force: "1" } : undefined, confirmed: opts?.confirmed })`.
  - done when: `fetch-adapter.test.ts` asserts `delete(id,{force:true})` issues `DELETE /<id>?force=1` and
    `delete(id)` issues `DELETE /<id>` (no query); `memory-adapter.test.ts` asserts `delete(id,{force:true})`
    on a real system row (server_resolver) resolves `{ ok:true }` and removes it, while `delete(id)` on the
    same kind of row throws the 409 protected error; `npx vitest run src/provider/fetch-adapter.test.ts
    src/provider/memory-adapter.test.ts src/provider/adapter.test.ts` green.
  - files: `src/provider/adapter.ts`, `src/provider/fetch-adapter.ts`, `src/provider/memory-adapter.ts`,
    `src/provider/fetch-adapter.test.ts`, `src/provider/memory-adapter.test.ts`

- [x] T4: `deleteDisabled` enables system rows for admins + `deleteSystemConfirm` copy (Fix 2, UI leaves —
      disjoint from T1's files).
  - `src/ui/access.ts`: rewrite `deleteDisabled` so a `server_resolver` row is no longer hard-disabled — order:
    `if (!canMutate(access)) return { disabled: true, title: ADMIN_ONLY_TITLE };` then `if (opts.working)
    return WORKING;` then for a system row `return { disabled: false, title: SYSTEM_CRONOTON_DELETE_TITLE };`
    else `return ENABLED;`. Reword `SYSTEM_CRONOTON_DELETE_TITLE` to "System cronoton — deleting removes the
    automaton's template; you'll be warned first."
  - `src/ui/confirm-flows.ts`: add `export function deleteSystemConfirm(name: string, serverResolver: string):
    string` → `` This is the automaton's "${serverResolver}" template. Deleting it stops that capability until
    it's recreated. Delete "${name}" anyway? ``.
  - done when: `src/ui/access.test.ts` asserts `deleteDisabled(ADMIN, systemRow)` is `{ disabled:false, title:
    SYSTEM_CRONOTON_DELETE_TITLE }` and `deleteDisabled(NON_ADMIN, systemRow)` is disabled with
    `ADMIN_ONLY_TITLE`; `src/ui/confirm-flows.test.ts` asserts the exact `deleteSystemConfirm` string; `npx
    vitest run src/ui/access.test.ts src/ui/confirm-flows.test.ts` green.
  - files: `src/ui/access.ts`, `src/ui/access.test.ts`, `src/ui/confirm-flows.ts`, `src/ui/confirm-flows.test.ts`

## Wave 2 (depends on Wave 1 — T3's `ConfirmOpts.force`)

- [x] T5: Widen the delete action to thread `force` (depends on T3's `ConfirmOpts.force`).
  - `src/hooks/useCronotonActions.ts`: add `export interface DeleteRunOpts { force?: boolean }`; change
    `DeleteAction = GatedAction<[], DeleteView>` → `GatedAction<[DeleteRunOpts?], DeleteView>`; the `remove`
    factory becomes `useGatedAction<[DeleteRunOpts?], DeleteView>((runOpts) => { const target =
    requireId(id, "delete"); return (opts) => adapter.delete(target, { ...opts, force: runOpts?.force }); },
    ...)`.
  - done when: `src/hooks/useCronotonActions.test.tsx` asserts `remove.run({ force: true })` calls
    `adapter.delete` with `{ confirmed: <bool>, force: true }` and `remove.run()` calls it with `force`
    undefined (existing non-force behavior intact); `npx vitest run src/hooks/useCronotonActions.test.tsx`
    green.
  - files: `src/hooks/useCronotonActions.ts`, `src/hooks/useCronotonActions.test.tsx`

## Wave 3 (depends on Wave 1 T1/T4 + Wave 2 T5)

- [x] T6: Wire the UI warning→force-delete flow in Detail + List (depends on T4 `deleteSystemConfirm` +
      `deleteDisabled`, T5's widened `remove.run({force})`, and T1's Detail/List edits on the same files).
  - `src/ui/Detail.tsx` `handleDelete` and `src/ui/CronotonList.tsx` `handleDelete`: when `row.server_resolver`
    is set, use `deleteSystemConfirm(name, row.server_resolver)` as the first prompt (replacing
    `deleteConfirm`), keep the in-gate `deletePasswordConfirm`, and call `actions.remove.run({ force: true })`;
    otherwise keep the exact current non-system flow (`deleteConfirm` → password → `remove.run()`). Import
    `deleteSystemConfirm`.
  - done when: `Detail.test.tsx` and `CronotonList.test.tsx` prove: for a system row the warning prompt text
    (naming the resolver) is shown and, on accept, `adapter.delete` is called with `{ force: true }`; for a
    non-system row the flow is unchanged (`force` absent); `npx vitest run src/ui/Detail.test.tsx
    src/ui/CronotonList.test.tsx` green.
  - files: `src/ui/Detail.tsx`, `src/ui/Detail.test.tsx`, `src/ui/CronotonList.tsx`, `src/ui/CronotonList.test.tsx`

## Notes

- Wave 1 tasks touch disjoint files (T1: row-derive + Detail + List; T2: handler; T3: adapters; T4: access +
  confirm-flows). T6 (Wave 3) re-edits `Detail.tsx`/`CronotonList.tsx` `handleDelete` — different regions than
  T1's Schedule-cell/import change, and sequenced two waves later, so no collision. T6 depends on T5's widened
  `DeleteAction` type (calls `remove.run({ force: true })`), which is why T6 is Wave 3, not Wave 2.
- Version bump + CHANGELOG + README + publish happen in the review/close phase, not as plan tasks.
