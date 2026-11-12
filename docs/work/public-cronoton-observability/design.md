# Public per-cronoton observability API — Design

## Problem

Today a codex-cronoton's state (schedule, status, next/last fire, fire history,
success/fail counts) is only visible through the authenticated admin surface
(`listHandler`/`getHandler`/`firesHandler` behind `withRead` + a host's own
`AuthSeam`). Nothing lets a host expose ONE cronoton's state to an
unauthenticated, cross-origin caller — the concrete driver is the Ouronet UI
emission page wanting to embed the Stoicism minter's next-mint time + recent
executions, but the handoff frames this as a general capability: **every**
codex-cronoton should be able to opt into a public view, not just this one.

This must live in `@ancientpantheon/khronoton-core`, not be re-implemented
inline in a consuming host (the AncientHoldings hub's `lib/codex-cronoton/*`
is exactly the kind of duplication this package exists to replace — see
WORKSPACE.md: "AncientHoldings (hub) — will pin all three Constructor
packages"). The hub's own `GET /api/public/cronoton/[token]` Next.js route is
a thin wrapper over this package's new exports, built in a later/separate
step once a khronoton-core version carrying this ships.

## Approach

**Schema.** Add two real top-level columns to `codex_cronotons`:
`public_token TEXT` (unique, nullable) and `public_observable INTEGER NOT
NULL DEFAULT 0`. These can't be folded into an existing JSON blob column (the
package's usual self-healing trick — see `gasPriceBufferAnu`, 0.9.0) because
`public_token` needs an indexed, unique lookup for the public handler's
by-token read.

This is the **first time** `installSchema` needs to add a column to an
already-provisioned database, not just a fresh `CREATE TABLE`. Confirmed
empirically: SQLite (3.53.2, bundled via better-sqlite3) does not support
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (syntax error) — the idempotent
pattern is `PRAGMA table_info` → conditional `ALTER TABLE ADD COLUMN`.
`installSchema` gains a small reusable `ensureColumn(db, table, columnDef)`
helper that does this check-then-add, called once for each of the two new
columns, plus a `CREATE UNIQUE INDEX IF NOT EXISTS` for `public_token`
(SQLite's unique index already permits multiple NULLs, so non-observable rows
with no token never collide). Alternative considered: a one-off inline ALTER
block scoped to just these two columns — rejected because this is already the
second ask for a genuinely new top-level column (after the original hub
handoff's own proposal), and the generic helper is ~10 lines, fully testable
the same way `schema.test.ts` already verifies shape.

**Token.** Generated lazily, once, the first time a row is made observable;
stable across an observable → non-observable → observable toggle (so an
embed URL never has to be re-minted). `crypto.randomBytes(20).toString(
"base64url")` — 160 bits, URL-safe, ~27 chars. A new
`setPublicObservable(id, { observable, regenerate? }, dep)` store function
owns this: generates a token only if the row has none yet (or `regenerate` is
explicitly requested), flips `public_observable`, never touches schedule/
status/any other field.

**Public view.** A new pure projector, `toPublicCronotonView(row, fires)`,
assembles the sanitized DTO from a `CodexCronotonRow` + its recent
`CodexCronotonFireRow[]` — never the raw rows themselves. Comprehensive
observability shape (the handoff's own field list, plus derived fields that
make an embed genuinely useful without a second round-trip):

```
{
  name, description,
  status,                                  // active | paused | completed | error
  schedule: { mode, humanText, cron? },     // cron present only for cron-expression mode
  triggerOnly: boolean,                     // externally-fireable / runtime-arg / event-driven — no timer
  nextFireAt, lastFireAt,
  isOverdue: boolean,                       // active, scheduled, nextFireAt < now (scheduler looks stuck)
  since,                                    // created_at — "observable since" / job age
  counts: {
    fired, succeeded, failed,
    lastSuccessAt, lastFailureAt,
    currentFailStreak,                      // consecutive failures since the last success
    successRatePercent,                     // round(succeeded / fired * 100), null when fired = 0
  },
  health: "healthy" | "degraded" | "down",   // derived: see below
  fires: {
    page: [ { firedAt, status, chainId, requestKey, txKeys, recoveredAt, mode } ],
    total, limit, offset                     // same clamping convention as the admin firesHandler
  }
}
```

`fires` is a full pagination window over the cronoton's *entire* history, not
a fixed "last 20" — the public handler accepts `limit`/`offset` query params
and clamps them exactly like the existing admin `firesHandler` (1..100,
default 20), echoing back the window actually queried. A caller wanting the
complete firing history pages through it the same way the admin list already
does; there is no artificial ceiling on how far back a viewer can look.

`health` derivation (pure function, unit-tested on its own): `"down"` when
`currentFailStreak >= 3`; `"degraded"` when `currentFailStreak` is 1–2 OR
`isOverdue`; `"healthy"` otherwise. A simple, documented traffic light — good
enough for an embed to color a dot without the embedder re-deriving logic
from raw counts.

Never included (privacy — carried over from the handoff verbatim): `id`
(the internal UUID — the token IS the public identifier), `pact_code`,
`payload_json`, `signers_json`, `gas_payer_json`, `server_resolver`,
`created_by`, `config_json`, raw `chain_response_json`. `errorMessage` is
reduced to nothing — a fire's public shape carries only `status` (which
already says `failure`); no raw error text ships, full stop (the handoff's
"unless you deliberately decide a short reason is safe" default resolves to
*not* deciding that here — a generic fail is always safe, a leaked error
string's safety has to be re-litigated per error site, which this package
cannot do on the host's behalf).

**Store additions**, all in a new `server/store/public.ts`:
- `getCodexCronotonByPublicToken(token, dep)` — `null` for an unknown token
  OR a known token whose row has `public_observable = 0` (the handler can't
  tell those two apart, matching "404 if token unknown or
  public_observable=0 ... never 403"). One query:
  `SELECT * FROM codex_cronotons WHERE public_token = ? AND public_observable = 1`.
- `setPublicObservable(id, opts, dep)` — as described above.
- `getCronotonFireCounts(cronotonId, dep)` — **refinement over the original
  sketch**: `counts` is a whole-history aggregate (total fired/succeeded/
  failed, last success/failure timestamps, consecutive-failure streak), but
  `fires` is deliberately a paginated window — so counts cannot be derived
  from the page alone (a page of 20 out of 150 fires would under-report
  every aggregate). This function runs the aggregate SQL independently:
  one query for `fired`/`succeeded`/`failed`/`lastSuccessAt`/`lastFailureAt`,
  plus a `SELECT status FROM codex_cronoton_fires WHERE codex_cronoton_id = ?
  ORDER BY fired_at DESC LIMIT 1000` scanned in JS, counting leading
  `'failure'` rows until the first non-failure (or the 1000-row cap) for
  `currentFailStreak` — a streak past 1000 reports `1000`, which is an
  acceptable approximation since `deriveCronotonHealth` already treats
  anything `>= 3` identically as `"down"`.
- `deriveCronotonHealth({ currentFailStreak, isOverdue })` — the pure health
  rule, exported standalone so a consumer (or a test) can reason about it
  without a DB row.
- `toPublicCronotonView(row, counts, firesPage, now)` — the pure projector
  (no DB access of its own): `counts` is `getCronotonFireCounts`'s result,
  `firesPage` is `listFires`'s `{ fires, total, limit, offset }`, `now`
  defaults to `new Date()` (explicit param so the `isOverdue` derivation
  stays pure/testable, same discipline as `computeNextFire`'s own `now`
  parameter). The handler calls `getCodexCronotonByPublicToken`,
  `getCronotonFireCounts`, and `listFires`, then passes all three into this
  one projector.

**Handler.** A new `publicCronotonHandler(ctx, request)` in
`handlers/public.ts`, added to the barrel. Deliberately bypasses
`ctx.auth`/`withRead` entirely — this is a *different* trust tier than the
admin `AuthSeam` governs; gating is purely "does this token resolve to an
observable row," independent of whatever the host's admin auth would
otherwise require. Still returns `{status, body}` via the existing
`json`/`err` helpers and needs only `{ db }` from the context (a consumer can
construct a minimal context for this one route if it doesn't want to thread
a full `HandlerContext`). Fetches the row by token, 404s on `null` (reusing
`mapStoreError`'s "not found" convention isn't a fit here since there's no
thrown error to map — the handler emits the 404 directly), otherwise parses
`limit`/`offset` from `request.query` with the same defensive clamping
`read.ts`'s `clampInt` already provides (1..100, default 20 — reused, not
reimplemented), calls `listFires(row.id, { limit, offset })`, and returns
`toPublicCronotonView`.

Cache-Control and CORS stay entirely host-side (unchanged package
convention — `HandlerResponse` is `{status, body}` only, no headers field;
every existing handler already leaves transport concerns to the consumer).
The handler's doc comment states the host should set
`Cache-Control: public, max-age=30` and whatever CORS policy fits its
deployment, mirroring the hub's own `pythia-odometer.ts` precedent.

**Out of scope for this package version** — the hub's actual Next.js route
(`GET /api/public/cronoton/[token]`), its admin "Make observable" toggle UI,
and the `public_observable`/`public_token` wiring into the Hub's *own*
pre-package inline `lib/codex-cronoton/store.ts` are a separate, later
handoff once the hub adopts this khronoton-core version as a dependency (it
doesn't yet — WORKSPACE.md still says "will pin").

## Acceptance criteria

- [ ] `installSchema` run twice on a DB that predates `public_token`/
      `public_observable` (i.e. simulating an existing host's DB) ends with
      both columns present, `public_observable` defaulting to `0`, and no
      data loss — proven by a schema test that creates the table via an OLD
      shape, then calls the current `installSchema`.
- [ ] `public_token` has a unique index; two rows can both have `NULL`
      tokens without a constraint violation.
- [ ] `setPublicObservable(id, { observable: true })` generates a token only
      once; calling it again with `{ observable: false }` then `{
      observable: true }` returns the SAME token (no silent rotation).
      `{ observable: true, regenerate: true }` mints a new one.
- [ ] `getCodexCronotonByPublicToken` returns `null` for an unknown token
      AND for a known token on a non-observable row — indistinguishable from
      the handler's perspective.
- [ ] `toPublicCronotonView`'s output contains none of: `id`, `pact_code`,
      `payload_json`, `signers_json`, `gas_payer_json`, `server_resolver`,
      `created_by`, `config_json`, `chain_response_json`, or any
      `errorMessage`/raw error text — checked by a test that asserts the
      serialized JSON string contains none of these substrings even when the
      underlying row/fires are stuffed with recognizable sentinel values for
      every one of them.
- [ ] `deriveCronotonHealth` returns `"down"` at `currentFailStreak >= 3`,
      `"degraded"` for 1–2 or `isOverdue`, `"healthy"` otherwise — table-driven
      unit tests covering each boundary.
- [ ] `getCronotonFireCounts` reports accurate `fired`/`succeeded`/`failed`/
      `lastSuccessAt`/`lastFailureAt` against a fixture with a known mix of
      outcomes, and `currentFailStreak` correctly counts only the
      CONSECUTIVE failures immediately preceding the most recent fire (a
      success anywhere in the middle of an otherwise-all-failure history
      resets the streak count for everything before it to not matter).
- [ ] `publicCronotonHandler` returns 404 for an unknown token, 404 for a
      known-but-non-observable token, and 200 with the sanitized view for a
      known observable token — without touching `ctx.auth` at all (a context
      whose `auth` seam always denies still returns 200 for an observable
      token, proving the bypass is real, not coincidental).
- [ ] `publicCronotonHandler` accepts `limit`/`offset` and clamps them
      exactly like the admin `firesHandler` (1..100, default 20); a cronoton
      with 150 historical fires is reachable in full across repeated calls
      with increasing `offset`, and `fires.total` reports 150 regardless of
      the requested window.
- [ ] CHANGELOG + README version-history entries land at a new MINOR version
      (additive, non-breaking surface).

## Out of scope

- The AncientHoldings hub's `GET /api/public/cronoton/[token]` Next.js route.
- The hub's admin "Make observable" toggle UI.
- CORS header values (host-decided; this package emits `{status, body}` only).
- Rate-limiting the public endpoint (host/infra concern, e.g. a CDN or
  reverse-proxy in front of it — this package has no concept of a request's
  origin IP).
- Rotating/expiring a `public_token` automatically (manual `regenerate` only).
