# Public per-cronoton observability API — Review

Scope: `packages/khronoton-core/src/server/schema.ts`, `schema.test.ts`,
`types.ts`, `store/public.ts`, `store/public.test.ts`, `store/index.ts`,
`store/fires.ts` (round 5+), `store/fires.test.ts` (round 5+),
`handlers/public.ts`, `handlers/public.test.ts`, `handlers/index.ts`,
`package.json`, `CHANGELOG.md`, `README.md`. 4-15 files → 4 lenses:
correctness, conventions, security, tests.

Design: `docs/work/public-cronoton-observability/design.md`. Plan:
`docs/work/public-cronoton-observability/plan.md` (5 tasks, 3 waves, all
built via `nectar:implementer` agents, TDD throughout).

**6 rounds, 4 lenses each (24 lens dispatches), adversarial validation on
every finding. 16 CONFIRMED findings fixed across rounds 1-5. Round 6 (full
scope, expanded to include `fires.ts`/`fires.test.ts`) yielded zero
in-scope CONFIRMED findings — the clean pass.** Zero REFUTED, zero
STYLISTIC across all rounds.

## Round 1 (7 CONFIRMED)

### [MEDIUM] Public handler's clamp default (20) contradicted its own doc comment and the admin `firesHandler` it claimed parity with (actual default: 50)
- **Where:** `handlers/public.ts` (clamp call + doc comment), `CHANGELOG.md`, `README.md`
- **Root cause:** a planning error — the plan document itself mis-stated `firesHandler`'s default as 20 (correctly identified as 50 during research, then mis-transcribed into the plan the build agent faithfully implemented).
- **Fixed:** default changed to 50; doc comment, CHANGELOG, README corrected; two test names/assertions updated.

### [MEDIUM] `triggerOnly` missed a plain-`eventDriven` cronoton entirely
- **Where:** `store/public.ts`'s `toPublicCronotonView`
- **Why:** a row committed with only `eventDriven: true` (no `externalFireable`, no evented resolver) persists `external_fireable = 0`/`runtime_arg_keys = null` — the original `rowExternalFireable(row) || rowRuntimeArgKeys(row).length > 0` predicate reported `triggerOnly: false` for it, so the public view would render a fabricated `schedule.humanText` for a cronoton that only ever fires via `executeNow`.
- **Fixed:** predicate widened to `... || (row.next_fire_at === null && row.status !== "completed" && row.status !== "error")`, keying off the scheduler-off marker `editCodexCronoton` itself documents, while excluding the terminal-one-time false positive (`applyTerminalIntent` also nulls `next_fire_at`).

### [MEDIUM] `currentFailStreak`'s `ORDER BY fired_at DESC` had no tiebreak
- **Fixed in round 1** with `, id DESC` — **later found wrong in round 3** (see below); final fix is `, rowid DESC`.

### [LOW] `setPublicObservable` never bumped `modified_at`
- **Fixed:** `modified_at = ?` added to the toggle's UPDATE.

### [MEDIUM]/[LOW] Two test-coverage gaps (id-leak check was name-based not value-based; `triggerOnly`'s runtime-arg-keys branch untested)
- **Fixed:** value-based substring assertion added; dedicated runtime-arg-keys test case added.

### [LOW] Handler barrel doc comment undercounted exported handlers ("seventeen" → eighteen after `publicCronotonHandler`)
- **Fixed.**

## Round 2 (3 CONFIRMED)

### [MEDIUM] `triggerOnly`'s own justifying comment asserted a false invariant
- **Where:** `store/public.ts`
- **Why:** the round-1 fix's comment claimed `applyTerminalIntent` was "the only other writer of a null `next_fire_at` for a non-trigger-only row" — but `claimDueCodexCronoton` (`claim.ts`) also nulls it, transiently for every one-time row's claim window and permanently for a recurring row with corrupt `schedule_config_json`.
- **Resolution:** documented the known limitation honestly instead of asserting it away (adding a more "robust" predicate would need a dedicated persisted column — judged disproportionate for a read-only view's display label, and `schedule_mode` can't disambiguate since a trigger-only row can itself carry any `schedule_mode`).

### Two test-coverage gaps (ORDER BY tiebreak had no test for an actual tie; terminal-row test only covered `"completed"`, not `"error"`)
- **Fixed:** both added.

## Round 3 (3 CONFIRMED)

### [MEDIUM] The round-1 `id DESC` tiebreak used a random UUID, not a chronological key
- **Where:** `store/public.ts`'s `getCronotonFireCounts`
- **Why:** production fire `id`s are `crypto.randomUUID()` (`fires.ts`) — no correlation to insertion order. On a genuine `fired_at` tie, `id DESC` picks "most recent" essentially at random, directly skewing the public `health` field. The round-1 regression test happened to pass only because its hand-chosen ids (`"a"`, `"b"`) coincided with insertion order.
- **Fixed:** tiebreak changed to SQLite's implicit `rowid DESC` (confirmed present — no `WITHOUT ROWID`/`INTEGER PRIMARY KEY` override; rows are never deleted standalone). Test rewritten so lexical id order and insertion order **deliberately diverge** (`"z"` inserted first, `"a"` second), so the test actually proves the mechanism instead of coinciding with it.

### [MEDIUM→LOW] `successRatePercent` had zero test coverage
- **Fixed:** null-on-zero-fired case + a 2/3→67 rounding case added.

### [LOW] Offset-specific clamp behavior untested (negative/non-numeric), asymmetric with limit's coverage
- **Fixed:** both cases added.

## Round 4 (3 CONFIRMED)

### [MEDIUM] `publicCronotonHandler` was the only handler with no `mapStoreError` safety net
- **Where:** `handlers/public.ts`
- **Why:** every sibling handler gets "any thrown error → structured 500" for free from `withRead`/`withConfirm`'s shared `runGated` wrapper; this route can't use that wrapper (it would reintroduce the `ctx.auth` call it exists to bypass) but still owed the same guarantee.
- **Fixed:** body wrapped in `try { ... } catch (error) { return mapStoreError(error); }`. Validated this doesn't interfere with the explicit 404 `return` (exits before the `catch` can see it).

### [MEDIUM] `view.health`'s wiring inside the projector was never asserted (only the pure `deriveCronotonHealth` function, in isolation)
- **Fixed:** a `toPublicCronotonView` test added asserting `view.health` for known `currentFailStreak`/`isOverdue` inputs.

### [LOW] `currentFailStreak`'s documented 1000-row cap was never exercised
- **Fixed:** a 1001-row fixture added, asserting the streak plateaus at 1000.

## Round 5 (1 CONFIRMED — found by security, in a file outside the original scope list)

### [HIGH→MEDIUM] Round 4's own `mapStoreError` catch-all could leak a snippet of secret fire-payload content through the public 500 body
- **Where:** `store/fires.ts`'s `listFires` (`chainResponse: r.chain_response_json ? JSON.parse(...) : null` — unguarded, unlike its sibling `parseTxKeys`), surfaced through `handlers/http.ts`'s `mapStoreError` (forwards `error.message` verbatim), reachable via round 4's new catch-all in `handlers/public.ts`.
- **Independently verified** (both by me directly via `node -e` and by the validator): Node 20+'s V8 embeds a quoted snippet of the actual malformed input in a `JSON.parse` `SyntaxError` when the content doesn't start with valid-looking JSON (e.g. `Unexpected token 'S', "SECRET_LEA"... is not valid JSON`) — confirmed empirically, not just by documentation.
- **Severity note:** downgraded HIGH→MEDIUM on validation — `chain_response_json` is only ever written via `JSON.stringify` (which can never itself produce invalid JSON), so this requires pre-existing corrupted/legacy data, not a normal write path.
- **Fixed at the root, not just the symptom:** `fires.ts` gains `parseChainResponse`, matching `parseTxKeys`'s existing try/catch-degrade-to-null shape — benefiting every current and future caller of `listFires`, not only the public route. The handler's catch-all stays (still valuable generic defense-in-depth) but is no longer the only thing standing between a malformed row and a content leak.
- **Test fallout handled:** the round-4 test that asserted this exact scenario produced a 500 was now wrong (the scenario no longer throws) — replaced with (a) a `fires.test.ts` case proving the guard degrades to `null` without throwing, (b) a `handlers/public.test.ts` case proving the now-graceful 200 response never contains the leaked substring, and (c) a new generic 500-translation test (closing the db handle) proving the handler's own catch-all still works for *some* unexpected throw, independent of this one now-fixed bug.

## Round 6 (0 in-scope CONFIRMED — the clean pass)

Full scope expanded to include `store/fires.ts`/`fires.test.ts` (newly part
of the diff after round 5's fix). Correctness: clean. Security: clean —
explicitly traced the entire call graph reachable from
`publicCronotonHandler` and confirmed no remaining unguarded `JSON.parse` or
raw-message passthrough. Conventions: clean.

Tests lens raised one item, declined as out of scope:

### [MEDIUM, declined — pre-existing, untouched by this diff] `finalizeFire` has no test coverage anywhere in the repo
- **Where:** `store/fires.ts`'s `finalizeFire` (the multi-tx fire terminal-write function)
- **Why declined:** confirmed via `git diff --stat`/`git diff` that this diff's only change to `fires.ts` is the new `parseChainResponse` helper plus the one-line swap that calls it — `finalizeFire` itself was never touched, added to, or made reachable in a new way by this feature. Its test-coverage gap predates this topic entirely and is unrelated to public observability. Noted here for visibility, not fixed, per the review skill's scope discipline ("review the change at hand — never the whole codebase").

## Behavioral verification

Exercised end-to-end against the real **built** `dist/` artifact (not just
the test suite) before the fix loop, and spot-checked again after:
commit a `daily-at-utc` cronoton → record a success + a failure → confirm
unknown-token 404 → `setPublicObservable` → confirm the real minted token
now returns 200 with `health: "degraded"`, correct `schedule.humanText`,
correct `counts` (fired/succeeded/failed/currentFailStreak/
successRatePercent) → confirm zero leakage of pact code, error text,
creator email, or internal id in the raw JSON response → confirm the
`ctx.auth`-always-deny context still returns 200 (bypass is real) → toggle
observability off → confirm the same token 404s again.

## Final state

- `npm test --workspace=@ancientpantheon/khronoton-core`: **1027 passed
  (1027)**, 76 test files.
- `npm run typecheck --workspace=@ancientpantheon/khronoton-core`: clean.
- `npm run build`: clean — `dist/server/store/public.js`,
  `dist/handlers/public.js` both compiled and barrel-wired.
- `publish.yml`'s three doc gates (README `` `0.12.0` on public npmjs ``,
  README `**v0.12.0**` version-history line, CHANGELOG's first `## `
  heading) all verified passing via the exact grep commands CI runs.
- `package.json` version: `0.12.0` (MINOR, additive).

Every acceptance criterion in `design.md` is satisfied. Clean pass achieved
after round 6.
