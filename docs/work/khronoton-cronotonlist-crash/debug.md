# CronotonList crash (`row.pact_code` undefined) — debug + fix

**Severity:** HIGH — white-screens the whole Khronoton admin page for any consumer with ≥1 cronoton.
Handoff: `Pythia/docs/HANDOFF-khronoton-cronotonlist-crash.md`. Target: publish `0.6.1`.

## Symptom
`Uncaught TypeError: Cannot read properties of undefined (reading 'replace')` at `CronotonList.tsx`'s
`pactPreview` → `pactCode.replace(...)`, on loading the list with ≥1 cronoton.

## Reproduction (evidence — a real in-memory DB probe, not the handoff's prose)
Seeding one cronoton and calling `listCodexCronotons({}, {db})` returns rows with exactly these keys:
```
createdAt, createdBy, id, lastFireAt, modifiedAt, name, nextFireAt, scheduleMode, status
```
i.e. the camelCase 9-field `CodexCronotonListItem` projection. `pact_code` is `undefined`; so are
`schedule_mode`, `next_fire_at`, `last_fire_at` (only the camelCase `scheduleMode`/`nextFireAt`/`lastFireAt`
exist), and `schedule_config_json` / `runtime_arg_keys` / `description` / `server_resolver` are absent
entirely.

## Root cause (corrected — broader than the handoff diagnosed)
`listCodexCronotons` (`server/store/cronoton.ts`) SELECTs a hand-picked projection and maps it to a
**camelCase** `CodexCronotonListItem`. But:
- the read handler (`handlers/read.ts`) types the response as `ListCronotonsView.codexCronotons:
  CodexCronotonRow[]` — full **snake_case** rows;
- `CronotonList.tsx` reads full snake_case `CodexCronotonRow` fields: `pact_code` (l.202), `schedule_mode`
  + `schedule_config_json` (l.106-112 `scheduleLine`), `runtime_arg_keys` (l.95 `isTriggerOnly`),
  `last_fire_at`/`last_fire_status` (l.117 `lastFireCell`), `description`/`server_resolver` (l.196-197).

So only `id`/`name`/`status` (identical in both casings) actually work. Everything else the list renders is
silently `undefined` — schedule line blank, last-fire "—", trigger-only always false, no description /
resolver pill. `pact_code` additionally **crashes** because `pactPreview` is the one place that calls a
string method (`.replace`) on the undefined without a guard. The handoff's "the 9 projected columns happen
to be snake_case so they work" is factually wrong (the projection maps to camelCase); the crash is the
loudest symptom of a comprehensively-mismatched list projection, latent since 0.3.0.

The sibling `getCodexCronoton` already returns a full honest row via `SELECT *` → `CodexCronotonRow`.

## Fix
1. **Real fix:** `listCodexCronotons` returns `CodexCronotonRow[]` via `SELECT *` (both the status-filtered
   and unfiltered branches), matching the handler's declared `ListCronotonsView` type and exactly what the
   UI reads — mirroring `getCodexCronoton`. This restores the entire list (pact preview, schedule line,
   last-fire, trigger-only, description, server-resolver pill), not just the crash. The ≤200-row admin list
   over-fetching four JSON columns (`config_json`/`payload_json`/`gas_payer_json`/`signers_json`) is
   negligible and buys type-honesty. `CodexCronotonListItem` (public export, referenced only here) becomes a
   deprecated alias of `CodexCronotonRow` so no importer breaks.
2. **Cheap defense:** `pactPreview(pactCode)` guards a non-string input → treats it as `""` → returns
   `"(empty)"`. A list-render helper must never be able to white-screen the page over a missing field.

## Acceptance criteria (from handoff)
- Opening the list with ≥1 cronoton no longer throws; the page renders.
- `pactPreview` cannot throw on a missing/non-string `pact_code`.
- The list shows the real pact preview / description / server-resolver pill (and now also schedule line,
  last-fire, trigger-only) — the whole projection is honest.
- A test proves `listCodexCronotons` returns `pact_code` (+ the other rendered fields) and that CronotonList
  renders crash-safe.
- Published as `0.6.1`.

## Verification + review

- **Both regression tests proven non-vacuous:** stashed the two production fixes and ran the new tests
  against the pre-fix code — both FAILED (store: `row.pact_code` undefined + old `scheduleMode` key present;
  UI: `pactPreview(undefined).replace` throws → render throws). Restored the fixes → both pass.
- **Full suite:** `Tests 850 passed (850)`; `tsc --noEmit` clean.
- **Review (correctness + tests + conventions + performance lenses):** clean. Confirmed `SELECT *` returns
  every field `CronotonList` reads (cross-checked schema.ts); the `as CodexCronotonRow[]` cast is honest;
  no consumer depended on the old camelCase list shape (the `.nextFireAt`/`.scheduleMode` reads elsewhere
  are on commit/edit/resume return objects, which legitimately stay camelCase); over-fetching four JSON
  columns × ≤200 admin rows is negligible and buys type-honesty (a targeted projection would need a lying
  partial-`CodexCronotonRow` cast). One LOW fixed: removed a stale orphaned JSDoc line above the deprecated
  `CodexCronotonListItem` alias.
