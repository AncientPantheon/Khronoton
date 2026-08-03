# Khronoton — evented server resolvers (scheduleless, store-authoritative) — Review

Scope reviewed: the full 6-task build across `packages/khronoton-core/src` (resolvers registry, store
create/edit, `/resolvers` handler + adapter contract, both reference adapters, `useServerResolvers` hook,
Builder wiring, CronotonList "Evented" cell) plus their co-located tests. Lens set: correctness, conventions/
integration-consistency, tests, security (the change touches the commit/persistence path + a new read endpoint).

## Pipeline

Lenses → dedup → adversarial validation (fresh-context validators) → fix CONFIRMED only → re-review to a clean
full-scope pass. Six findings surfaced and were validated; all CONFIRMED were fixed. STYLISTIC/LOW deferred
items were also fixed as part of the same loop since they were cheap and localized.

## Findings & resolution

### [MEDIUM] C1 — evented→non-evented scheduled edit left the row permanently scheduleless — CONFIRMED, FIXED
- **Where:** `src/server/store/cronoton.ts` (edit path)
- **Evidence:** the old `rowTriggerOnly` derivation treated any `external_fireable = 1` row as trigger-only, so
  once an evented resolver had forced `external_fireable = 1`, editing the cronoton *off* the evented resolver
  onto a scheduled one never recomputed `next_fire_at` — the row stayed dead (never due, never host-fired).
- **Fix:** distinguish a *genuine* external-fireable (`genuineExternalFireable = rowExternalFireable(row) &&
  !prevEvented`) from an evented-forced one; add `eventedDeparted = prevEvented && !evented` to the recompute
  condition so an evented→scheduled repoint re-arms `next_fire_at` (both with and without a `schedule` patch)
  and clears `external_fireable` back to 0. Validator initially flagged a "hole" (no-schedule-patch case →
  dead row); closed via `eventedDeparted` in the recompute branch.

### [MEDIUM] T1 — edit "never clobber external_fireable" was untested — CONFIRMED, FIXED
- **Where:** `src/server/store/cronoton.test.ts`
- **Fix:** added test (f) — a genuine (non-evented) `external_fireable = 1` edit preserves the flag; tests (g)
  evented→non-evented scheduled repoint recomputes `next_fire_at` and clears `external_fireable` to 0; (h) the
  same without a schedule patch re-arms from the stored schedule. Store suite: 36 passed.

### [LOW] C2 — Builder sticky `externalFireable` never reset — CONFIRMED, FIXED
- **Where:** `src/ui/builder/Builder.tsx`
- **Evidence:** a `useEffect` keyed on `[eventDrivenResolver]` mutated `state.externalFireable = true` and never
  reset it, so previewing an evented resolver then switching to a non-evented one left the committed body
  carrying `externalFireable: true` — silently persisting a scheduleless *non-evented* row.
- **Fix:** removed the sticky `useEffect`; derive `if (eventDrivenResolver) body.envelope.externalFireable =
  true;` at commit time in `handleCommit` (which already lists `eventDrivenResolver` in its `useCallback`
  deps). ExecuteTab's schedule-off notice keys on `eventDrivenResolver` directly, so removing the state
  mutation doesn't hide the notice. Regression test added to `Builder.test.tsx` proving that previewing an
  evented resolver then switching to a non-evented one commits with `externalFireable` NOT stuck true (and the
  ScheduleStep is restored).

### [LOW] V1 — handler barrel doc undercount — CONFIRMED, FIXED
- **Where:** `src/handlers/index.ts:6`
- **Fix:** "the sixteen handlers below" → "the seventeen handlers below" (the new `resolversHandler`/
  `listResolvers` alias).

### [LOW] V2 — `ResolversView.kind` widened to `string` — CONFIRMED, FIXED
- **Where:** `src/provider/adapter.ts`
- **Fix:** imported `ServerResolver` and typed `kind: ServerResolver["kind"]` (`"single-tx" | "multi-tx"`)
  instead of `string`, matching `listServerResolvers`'s return type across the adapter seam.

### [LOW] T2 — `useServerResolvers` degradation untested — CONFIRMED, FIXED
- **Where:** new `src/hooks/useServerResolvers.test.tsx`
- **Fix:** added a focused suite: (1) registry load surfaces each resolver's `evented` flag; (2) an adapter
  omitting the OPTIONAL `resolvers()` method degrades to `[]` with no throw (the Builder's 0.6.0 fallback
  path); (3) a thrown fetch surfaces in `error` and leaves the list empty (doesn't block the Builder).

## Integration seams (explicitly checked, no findings)

- **Store INSERT bind** uses the computed `externalFireable` (not `input.externalFireable`) — behaviorally
  verified below.
- **Edit UPDATE** SET column order matches the positional `.run(...)` args exactly (validator verified the
  `external_fireable = ?` addition is aligned; no off-by-one).
- **`resolvers?()` is OPTIONAL** and NOT in `REQUIRED_METHODS` — `assertAdapter` still passes for pre-0.7.0
  adapters; `useServerResolvers` guards `typeof adapter.resolvers !== "function"` (test T2 case 2).
- **`external_fireable`/HMAC reversal** — implementation matches the documented design Decision (not a finding).

## Clean pass (postdates the last applied edit)

- **Typecheck:** `> tsc --noEmit` — clean, no errors.
- **Full suite:** `Test Files  70 passed (70)` / `Tests  871 passed (871)`.
- (No lint script in this package — the green triad is typecheck + tests.)

## Behavioral verification (design.md acceptance criteria, real store→handler→adapter path)

An in-process probe registered an `evented` resolver, committed a cronoton on it **with a real one-time
schedule** through `createMemoryAdapter` (the real Phase-C handlers), then inspected the DB row, the due-query,
`/resolvers`, and a duplicate commit:

- Persisted row: `{ "next_fire_at": null, "external_fireable": 1 }` — scheduleless + external-fireable forced
  despite the schedule.
- `fetchDueCodexCronotons(...)` → row excluded (`dueHasIt: false`).
- `adapter.resolvers()` → `{ "name": "behavior-evented", "kind": "single-tx", "evented": true }`.
- Second commit reusing the bound resolver → threw `server resolver "behavior-evented" is already bound to
  cronoton 84ea7eff-… — delete it first`.

All four asks verified end-to-end.

## Outcome

Rounds: 1 lens pass → validation → fix loop (store C1/T1 + Builder C2 + V1/V2/T2) → clean full-scope pass.
Zero CONFIRMED findings remain. Ready to ship as 0.7.0.
