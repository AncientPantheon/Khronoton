# Khronoton — evented DETAIL schedule + confirm-gated system delete (0.8.0) — Review

Scope reviewed: the full 6-task build (19 changed files under `packages/khronoton-core/src`) — the shared
`isTriggerOnly` helper + Detail "Evented" cell (Fix 1), and the `?force=1` confirm-gated system-cronoton
delete across handler → adapter contract → both adapters → action hook → access rule → confirm copy → both
UIs (Fix 2), plus co-located tests.

## Pipeline

16+ file diff → all 5 lenses (correctness, conventions, security, tests, performance) via parallel
`nectar:lens` agents → dedup → adversarial validation via `nectar:validator` (fresh context) → fix CONFIRMED
only → clean full-scope pass.

## Findings & resolution

### correctness — no findings
Traced the force flow UI→hook→adapter→handler intact; the handler still 409s a system row without force and
deletes with force (`"1"` and `"true"` both parsed; absent → 409 stands); Detail + list share one
`isTriggerOnly`; `deleteDisabled` blocks non-admins on system rows first.

### security — no findings
Force is read only inside `withConfirm` (an unconfirmed/non-admin request never reaches the parse);
`deleteDisabled` keeps non-admins blocked; `force === "1" || "true"` fails closed on everything else; the
audit `forced` flag is preserved; the UI warning and `force:true` are coupled at one source expression; no
injection (`server_resolver`/`name` reach only `window.confirm` text + a structured audit object).

### performance — no findings
The `isTriggerOnly` extraction is byte-identical to the removed local copy (same single `JSON.parse` via
`parseRuntimeArgKeys`); the list's per-row call sites and the delete handler's pre-`storeGet` are pre-existing.

### [LOW] conventions — `deleteSystemConfirm` JSDoc is an unwrapped ~185-char line — VALIDATED **STYLISTIC**, deferred
- **Where:** `src/ui/confirm-flows.ts` (`deleteSystemConfirm`'s doc)
- Validator verdict: STYLISTIC — the file has the "one-liner for short notes, wrapped block for prose"
  tendency, but does not enforce it uniformly (`src/ui/confirm-flows.ts` already carries a ~100-char
  single-line doc), so a competent reviewer could call this authorial preference. Comment-only, zero behavior
  change. **Deferred (autonomous delivery; STYLISTIC is the user's call) — left as-is.**

### [LOW] test-coverage — system-delete UI tests didn't assert the in-gate password confirm still fires — CONFIRMED, FIXED
- **Where:** `src/ui/Detail.test.tsx`, `src/ui/CronotonList.test.tsx` (system-resolver delete tests)
- **Evidence:** the tests inspected only `confirmSpy.mock.calls[0][0]` (the warning) + the forced
  `adapter.delete` call; with `window.confirm` stubbed `true`, collapsing the two nested `withConfirm` calls
  (dropping `deletePasswordConfirm` on the system path — deleting after a single warning) would still pass
  every assertion. Validator CONFIRMED the regression is genuinely undetected.
- **Fix:** both system-delete tests now assert `confirmSpy` was called exactly twice and that the second,
  ordered prompt is `Confirm to delete codex cronoton "Daily treasury sweep".` — pinning that the in-gate
  password confirm still fires (design.md: "keep the in-gate `deletePasswordConfirm`").

## Clean pass (postdates the last applied edit)

- **Typecheck:** `> tsc --noEmit` — clean.
- **Full suite:** `Test Files  71 passed (71)` / `Tests  893 passed (893)`.
- (No lint script — the green triad is typecheck + tests.)

## Behavioral verification (design.md acceptance criteria, real store→handler→adapter path)

An in-process probe committed a system cronoton on an `evented` resolver through `createMemoryAdapter` (the
real Phase-C handlers), then exercised both fixes:

- **Fix 1:** the stored row is trigger-only — `isTriggerOnly(row) === true`, `external_fireable === 1` — the
  exact predicate the Detail Schedule cell renders "Evented" from (the render test proves the "Evented" label
  + the absent schedule summary).
- **Fix 2:** `delete(id, { confirmed: true })` → threw `System cronoton — cannot be deleted…` (409 blocked),
  and the row survived; `delete(id, { confirmed: true, force: true })` → `{ ok: true }` and the row was gone.

Observed output: `{ isTriggerOnly: true, external_fireable: 1, noForce: "409_BLOCKED", survivedNoForce: true,
forcedOk: true, goneAfterForce: true }`.

## Outcome

Rounds: 1 lens pass (5 lenses) → validation (2 findings) → fix loop (1 CONFIRMED test-coverage fix; 1 STYLISTIC
deferred) → clean full-scope pass. Zero CONFIRMED findings remain. Ready to ship as 0.8.0.
