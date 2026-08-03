# Khronoton — evented server resolvers (scheduleless, store-authoritative) — Design

## Problem

A server resolver can be **event-driven**: its cronoton is fired by an in-process host event, never by a
schedule (Pythia's `dual-link-activate` fires when a consumer's two Apollo halves finish verifying — a link
event with no clock). The scheduler-off machinery already exists (`externalFireable === true` → `triggerOnly`
→ `next_fire_at = NULL` → the due-query `next_fire_at IS NOT NULL` skips it) and `executeNow` already fires
such a row independent of schedule — but nothing ties any of it to the resolver. So (a) each consumer must
enforce scheduleless in its own proxy (Pythia does, but the guarantee doesn't live in the package), (b) the
bundled Builder still shows a live schedule editor for an evented-resolver cronoton, (c) the admin list
renders a blank next-fire for a scheduleless row instead of saying "Evented", and (d) two cronotons can bind
the same `server_resolver` (the finder returns the newest, so a duplicate silently shadows the first and the
wrong template fires). 0.6.0 shipped a first cut via a **client-side** `eventDriven` flag; this makes the
package the **server-authoritative** source of truth.

## Approach

Model "evented" on the resolver registry and let the **store** enforce scheduleless from it — so the guarantee
holds for every consumer regardless of what the client sends. Four coordinated changes (the 4 handoff asks):

### 1. `evented` on the resolver registry + store forces scheduleless (server-authoritative)
- Add `evented?: boolean` to **both** `SingleTxResolver` and `MultiTxResolver` (`server/resolvers.ts`), so
  `getServerResolver(name)?.evented` typechecks against the `ServerResolver` union without narrowing.
- `createCodexCronoton` derives `const evented = getServerResolver(input.serverResolver ?? "")?.evented ===
  true`. This is a **safe, acyclic** import (`store/cronoton.ts → resolvers.ts → executor/seams/types`; no
  store file is imported by resolvers, verified).
- **An evented resolver forces `external_fireable = 1`** in the persisted row (not merely `triggerOnly`):
  `const externalFireable = input.externalFireable === true || evented;` — bind `externalFireable ? 1 : 0`
  in the INSERT and fold it into `triggerOnly = externalFireable || runtimeArgKeys.length > 0 ||
  input.eventDriven === true`. See the HMAC decision below for why `external_fireable`, not just triggerOnly.
- `editCodexCronoton`: derive evented from the **patched-or-existing** `server_resolver` via
  `getServerResolver`; when evented, force `next_fire_at = NULL` **and** `external_fireable = 1` (mirroring
  create), alongside the existing `patch.eventDriven` path. `resumeCodexCronoton` is already correct — its
  `rowSchedulerOff = row.next_fire_at === null` guard keeps an evented row (created with NULL) scheduler-off.

### 2. `GET /resolvers` read handler + adapter method + Builder reacts
- `server/resolvers.ts` gains `listServerResolvers(): { name: string; kind: ServerResolver["kind"]; evented:
  boolean }[]` (over `Object.entries(SERVER_RESOLVERS)`), exported through the `/server` barrel.
- `handlers/read.ts` gains a `resolversHandler` (`GET`, `withRead`) → `json(200, { ok: true, resolvers:
  listServerResolvers() })`, aliased in `handlers/index.ts`. Pythia mounts it under
  `/admin/khronoton/resolvers` via its existing catch-all proxy.
- `provider/adapter.ts`: a new `ResolversView` + `resolvers(): Promise<ResolversView>` on the
  `KhronotonAdapter` read tier + `"resolvers"` added to `REQUIRED_METHODS` (so `assertAdapter` enforces it);
  implemented in `fetch-adapter.ts` (`GET /resolvers`) and `memory-adapter.ts` (calls the handler).
- The Builder fetches `/resolvers` **once** (a new `useServerResolvers` hook mirroring the once-fetched
  signers), builds an evented-name `Set`, and makes `eventDrivenResolver` **server-authoritative**:
  `eventedNames.has(state.serverResolver) || <the existing 0.6.0 serverResolverOptions.eventDriven
  derivation>`. When `eventDrivenResolver` is true the Builder **auto-sets `state.externalFireable = true`**
  (so the committed row matches the store's forced `external_fireable`), and the existing 0.6.0 ExecuteTab
  behavior (hide `ScheduleStep`, show the "Event-driven — fired on its trigger, not a schedule" notice)
  already renders the disabled-schedule display.

### 3. List shows "Evented" as next-fire
- No new list-item field: post-0.6.1 `listCodexCronotons` returns the full `CodexCronotonRow` (which already
  carries `external_fireable` + `runtime_arg_keys`), so `triggerOnly` is derivable in the UI.
- `CronotonList.tsx`'s `isTriggerOnly(row)` is broadened to also return true when `row.external_fireable ===
  1` (today it checks only `runtime_arg_keys`). The **next-fire cell** renders a styled **"Evented"** label
  (not a timestamp / EM-dash) when `isTriggerOnly(row)`.

### 4. One-resolver-one-cronoton at the store
- In `createCodexCronoton`, right after the existing runtime-args mutual-exclusion throw: if
  `input.serverResolver` is set and `findCodexCronotonIdByServerResolver(input.serverResolver, { db })`
  returns a non-null id, throw `CodexCronotonValidationError(\`server resolver "\${name}" is already bound to
  cronoton \${existingId} — delete it first\`)`. The read handler's error mapping already routes
  `CodexCronotonValidationError` → HTTP 400, so the UI shows the message. Create-path only.

### Alternatives considered
- **Keep the 0.6.0 client `eventDriven` flag as the source of truth** — rejected: it makes the guarantee
  depend on each consumer sending the flag; the whole point of this feature is a package-level, server-
  authoritative guarantee. (The 0.6.0 flag is kept as an additive, now-redundant `triggerOnly` reason for
  back-compat — see Decisions.)
- **Handler derives `evented` and passes it into the store input** (instead of the store calling
  `getServerResolver`) — rejected: a direct store-API caller would then bypass the guarantee. The store
  calling `getServerResolver` is safe (no cycle) and makes the store itself authoritative, per the handoff.
- **Add a computed `triggerOnly` field to `CodexCronotonListItem`** (the handoff's literal Ask 3) — rejected:
  since 0.6.1 the list item *is* the full `CodexCronotonRow` carrying the raw columns, so a computed field is
  redundant; deriving it in the one UI that needs it is cleaner.
- **A persisted `event_driven` DB column** — rejected: `external_fireable = 1` + `next_fire_at = NULL`
  already carry the state; no migration needed.

## Decisions

- **`external_fireable = 1` for evented rows — reverses 0.6.0's HMAC stance, deliberately.** The 0.6.0 handoff
  said *don't* reuse `externalFireable` for event-driven, to keep an in-process-fired cronoton off the public
  HMAC trigger endpoint. This feature reverses that: an evented resolver forces `external_fireable = 1`, which
  **does** make the row HMAC-fireable. This is a conscious choice because (a) Pythia **already** forces
  `externalFireable = true` for evented resolvers in production (v2.7.19/2.7.20) — this change *codifies*
  shipped reality rather than introducing new exposure; and (b) it makes the store-authoritative guarantee,
  the Builder's "auto-mark external-fireable", and the list's `external_fireable === 1` "Evented" detection
  all consistent from one persisted signal. Manually HMAC-firing an evented resolver (e.g. `dual-link-activate`)
  just re-runs its idempotent resolve, which no-ops when nothing is ready. **Surfaced here and in the final
  report so the operator can object if the HMAC exposure is unwanted.**
- **Naming: keep the published 0.6.0 `eventDriven` surface, add server-side `evented`.** `ServerResolverOption
  .eventDriven`, `CommitEnvelope.eventDriven`, the store input/patch `eventDriven`, and `builderToCommit`'s
  opt stay (renaming/removing would break 0.6.x consumers). The registry uses `evented` (per the handoff) and
  becomes the authoritative source via `GET /resolvers`; `input.eventDriven` remains an additional (redundant)
  `triggerOnly` reason. No second `evented` field is added to `ServerResolverOption` — the handoff's "surface
  on ServerResolverOption" is met by the existing `eventDriven` field plus the authoritative `/resolvers`
  fetch. One concept, two historical names, reconciled in one place (the Builder's `eventDrivenResolver`).
- **Target version: minor 0.7.0** (new public API — the resolver `evented` flag, `listServerResolvers`, the
  `GET /resolvers` handler, the `resolvers()` adapter method — plus new store enforcement; no breaking removal).
- Autonomous delivery confirmed 2026-08-03 — the operator gave the full 4-ask spec + "commit push publish".

## Acceptance criteria

- [ ] A cronoton committed with an `evented` server resolver is persisted `next_fire_at = NULL` **and**
      `external_fireable = 1` — even when the caller sends a real schedule — and `fetchDueCodexCronotons` never
      returns it. Enforced in the store (verified without going through any consumer proxy).
- [ ] Editing a cronoton onto an `evented` resolver forces `next_fire_at = NULL` (+ `external_fireable = 1`);
      `resumeCodexCronoton` of an evented row keeps `next_fire_at = NULL`.
- [ ] A second `createCodexCronoton` reusing an already-bound `server_resolver` throws
      `CodexCronotonValidationError` naming the existing cronoton id; a first bind, and re-using a *different*
      resolver, both succeed.
- [ ] `GET /resolvers` returns `{ ok: true, resolvers: [{ name, kind, evented }] }` listing every registered
      resolver with its `evented` flag; the `resolvers()` adapter method is **optional** (non-breaking for
      existing adapters — NOT added to `REQUIRED_METHODS`) but implemented by both reference adapters, and the
      Builder degrades gracefully (empty resolver list, falls back to the 0.6.0 `serverResolverOptions
      .eventDriven`) when an adapter doesn't provide it.
- [ ] In the Builder, selecting an `evented` resolver hides the `ScheduleStep` editor, shows the event-driven
      notice, and marks the row external-fireable (the committed body carries `externalFireable: true`);
      selecting a non-evented (or no) resolver restores the schedule controls.
- [ ] The cronoton list's next-fire column reads **"Evented"** for a row that is trigger-only
      (`external_fireable === 1` or has runtime-arg keys), instead of a blank/timestamp.
- [ ] All existing khronoton-core tests pass; new tests cover the evented→scheduleless+external_fireable store
      path, the uniqueness rejection, `GET /resolvers`/`resolvers()`, the Builder evented schedule-off +
      external-fireable auto-set, and the list "Evented" cell.

## Out of scope

- **Pythia-side follow-ups** — its evented-name set, commit-time scheduleless enforcement, the in-process event
  fire, and the 409-on-duplicate — all already shipped (v2.7.20) and become belt-and-suspenders no-ops once
  this lands. Nothing to do in the Pythia repo here except adopt the published version.
- A persisted `event_driven` DB column / schema migration (not needed).
- Renaming or removing the published 0.6.0 `eventDriven` surface.
- Edit-time uniqueness (rejecting an *edit* that repoints a cronoton onto an already-bound resolver) — the ask
  is create-path only; noted as a possible follow-up.
- Changing `executeNow`/`fireByServerResolver` — they already fire a scheduleless server-resolver row.
