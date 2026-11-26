# In-builder Raw JSON "unlock / paste / import" — Design

## Problem

`ChainedBuilder`'s Raw JSON pane is read-only — it renders `chainedBuilderToCommit(state)` live
but has no inverse: an author who already has a raw chained-cronoton JSON document (hand-written,
exported from elsewhere, or produced by the Hub's own standalone "Import Raw Cronoton" path) has
no way to load it INTO the builder to review/tweak the fields and Simulate before creating. The
pane's own footer text admits this: *"Pasting your own raw code (unlock) is a follow-on."* This is
that follow-on (handoff: `docs/work/raw-json-unlock-handoff/handoff.md`).

## Approach

Add the inverse of `chainedBuilderToCommit`: a pure, browser-safe `jsonToChainedBuilderState(text)`
in `chained-builder-state.ts`, plus an unlock/paste/import UI affordance on the Raw JSON pane in
`ChainedBuilder.tsx`. No server/package-side validation beyond what already exists — the imported
state flows through the SAME `canCommitChain`/`chainedBuilderToCommit` path a hand-filled form
does, so every existing gate (name required, yield-graph ordering, decimal-amount tripwire, …)
re-applies automatically once imported. The importer's only job is **populate state faithfully**,
not **re-validate commit-readiness** — the author may be pasting a deliberately incomplete draft
specifically to keep editing it in the builder.

### `jsonToChainedBuilderState(text: string): ChainedBuilderImportResult`

```ts
export type ChainedBuilderImportResult =
  | { ok: true; state: ChainedBuilderState }
  | { ok: false; error: string };
```

Takes the RAW TEXT (what the textarea holds, or a `.json` file's read content) so the UI never
needs its own try/catch around `JSON.parse` — one call, branch on `.ok`. Never throws.

**Strict (hard error) on the load-bearing shape**, because silently discarding what was pasted is
a worse failure than refusing clearly:
- Invalid JSON syntax → `{ok:false, error:"Invalid JSON: <native message>"}`.
- Parsed value isn't a plain object (array/null/primitive) → a clear "expected a JSON object" error.
- `steps` missing, not an array, or empty → an error, reusing `chained-validation.ts`'s OWN wording
  ("a chained cronoton needs at least one step") so the author sees one voice across import and
  commit-gate messages, not two different phrasings for the same rule.
- Any step whose `mode` isn't `"single"`/`"planner"` → `step ${i}: mode must be 'single' or
  'planner'` — again literally `chained-validation.ts`'s own message.

**Lenient (coerce-with-default) on everything else**, matching `detailToBuilderState`'s own
established tolerance for a parsed-but-imperfect document (missing `gasPriceBufferAnu` on an old
stored row already defaults to 0 there; same idea here, just from pasted JSON instead of a DB
row):
- `name`/`description` default to `""` if absent or the wrong type (the existing "Name is
  required." gate will catch a missing name post-import — a parse-time hard-fail here would be
  redundant AND would block loading a legitimately incomplete draft).
- Per-step `config`/`payload`/`gasPayer`/`signers` that are absent or malformed fall back to
  `makeEmptyBuilderState()`'s own per-field defaults (object-shape check once, then per-field
  `??`-coalesce within it, mirroring `detailToBuilderState`'s `gasPriceBufferAnu ?? 0` idiom) —
  one bad sub-field degrades that ONE field, not the whole step or the whole import.
- An individual malformed `signers[]` entry (not an object, or no string `publicKey`) is dropped
  from that step's signer list rather than failing the step.
- `schedule`/`externalFireable`: mutually exclusive on the wire exactly as `chainedBuilderToCommit`
  emits them. `externalFireable: true` wins if both are somehow present; otherwise a structurally
  plausible `schedule` (`{mode: string, config: object}`) is trusted as-is — same level of trust
  `detailToBuilderState` already gives a stored row's `schedule_config_json` (re-validating the
  full `ScheduleMode`/`ScheduleConfig` union here would duplicate `schedule.ts`'s own validation
  for no real benefit, since a bad schedule just renders oddly in the shared `ScheduleStep`, the
  same as it would for a hand-corrupted edit today).
- A planner step's `plannerParams` (wire: `unknown`, parsed JSON) becomes `plannerParamsJson`
  (form: pretty-printed JSON text) via `JSON.stringify(value, null, 2)` — the existing textarea
  already round-trips arbitrary JSON text, including `{"$yield":"name"}` placeholders, verbatim.

**Reused, not reimplemented** (zero duplicate logic): `makeEmptyBuilderState()`/
`makeEmptyStepState()` for every default; `toGasPayerState` (currently private in
`builder-state.ts`, exported for this) for the `CodexGasPayer → GasPayerState` mapping;
`freshSignerId` (same file, same export) for fresh ephemeral signer-row ids, so imported signers
get IDs from the exact same counter/scheme `detailToBuilderState`'s edit-rehydration already uses
— not a second ID generator. A small internal `stepEnvelopeFromWire(raw)` helper (new, private to
`chained-builder-state.ts`) builds the shared `{pactCode, config, payload, gasPayer, signers}`
tuple once, used by BOTH a `"single"`-mode step and the `singleTxFirst` variant (which has the
identical sub-shape minus `yieldAs`/`idempotent`/`plannerName`/`plannerParams`, none of which exist
on `ChainSingleTxFirst`'s type at all).

### UI: unlock / paste / import on the Raw JSON pane

The pane stays **read-only by default** (per the owner's explicit ask — no accidental typing).
Adds:
- A **"Paste / import"** toggle button in the pane's header, next to the existing title. Clicking
  it swaps the read-only `<pre>` for an import panel (textarea + file-upload + Capture/Cancel);
  clicking it again (or Cancel) swaps back to the read-only view with no change applied.
- A `<textarea aria-label="Import JSON">` for pasting, plus a `<input type="file" accept=".json,
  application/json">` that reads the selected file's text into the SAME textarea via `FileReader`
  (so Capture always acts on one piece of text, whichever way it got there).
- **"Capture & parse"**: calls `jsonToChainedBuilderState(draftText)`. `ok:true` → `setState(result.
  state)` (full replacement — this is a LOAD, not a merge), reset `selected`/`fieldsTab`/
  `wholeField` to their fresh-mount defaults (the new state's shape may not match the old
  selection at all) and clear any stale `sim` (it described the OLD state), then close the import
  panel back to read-only. `ok:false` → show `result.error` inline, in place, state untouched (the
  explicit ask: "state untouched" on a parse error) — the author can fix the pasted text and retry
  without losing it.
- **"Cancel"**: discards the draft text/error and closes the panel, no state change.

No package-side codex/signature check (the Hub's own standalone "Import Raw Cronoton" path already
does that at CREATE time, per the handoff's own note) — once imported, the builder's existing
Signatures tab surfaces every signer exactly as it would for a hand-entered one.

## Deliverable 2 — generated raw-cronoton-JSON schema + field reference

Added mid-build when the handoff was updated (`docs/work/raw-json-unlock-handoff/handoff.md`'s
"Also for 0.19.0" section): publish the canonical schema for the raw JSON `jsonToChainedBuilderState`
accepts / `chainedBuilderToCommit` emits, **generated from the package's own types/descriptors —
never hand-written**, as both a machine-readable JSON Schema and a human field reference, so the
Hub can render it on `/docs` with zero second copy to keep in sync.

### What "generated" means here

A hand-maintained schema literal (even one covered by a drift-detecting test) is explicitly what
the handoff rejects ("do NOT hand-write it"). The generator (`scripts/generate-raw-cronoton-schema.mjs`,
run as a build step — `dist/schema/*` exists only as a build artifact, never a git-committed copy,
so there is no second copy that can EVER go stale) uses the **TypeScript Compiler API** (`typescript`,
already a build-time dependency of this monorepo) to walk the REAL exported types this package
already ships — `ChainCommitBody`/`ChainStepInput`/`ChainSingleTxFirst`/`ChainSchedule`
(`handlers/chain.ts`), `CodexTxConfig`/`CodexGasPayer`/`CodexSigner`/`CapabilityMode`
(`server/types.ts`), `ScheduleMode`/`ScheduleConfig` (`schedule.ts`) — pulling each property's name,
optionality, JSDoc description, and (where present) a `@minimum`/`@maximum` JSDoc tag straight off
the real declaration. A custom hand-rolled walker (not a third-party AST tool) was chosen
deliberately: the type surface is small and fully known in advance (~10 types), and writing the ~10
cases explicitly, grounded directly in Compiler-API introspection of the real declarations, is lower
risk than debugging an unfamiliar general-purpose generator's exact output quirks for a one-off need.

Two things the TYPES alone can't carry, generated from elsewhere instead:
- **Numeric ranges** (`ttl` 60–86400s, `gasLimit` > 0, `hour` 0–23, `dayOfWeek` 0–6, …) are enforced
  today only in validation CODE (`builder-state.ts`'s `validateConfig`, `schedule.ts`'s
  `isValidHour`/etc.), not in the type declarations themselves. Rather than have the generator
  reverse-engineer bounds out of validator function bodies (fragile, and divorced from the type it
  describes), this adds a `@minimum`/`@maximum` JSDoc tag directly to the handful of affected field
  declarations in `server/types.ts`/`schedule.ts` — a genuine, permanent documentation improvement
  to the source types (previously these bounds existed ONLY as magic numbers inside a validator),
  which the generator then reads via the same Compiler API pass. The numbers themselves are not
  duplicated into a second file; they're declared once, right on the field they constrain.
- **Planner names + `plannerParams` schemas** are generated from `BUILTIN_DESCRIPTORS`' own RUNTIME
  data (`KNOWN_PLANNERS` for the enum; each descriptor's `params: BuiltinParamField[]` — name/type/
  required/help — for its `plannerParams` object schema), since `plannerParams` is typed `unknown`
  in the wire shape — there is no static type to walk for this part, only the descriptors' own
  structured metadata, which is itself the legitimate generation source.

### Cross-check, not a runtime rewrite

The handoff's "the inverse parser validates against it" is read as a NO-DRIFT property to guarantee,
not a mandate to re-architect `jsonToChainedBuilderState` to delegate to a generic JSON-Schema
validator at runtime — that function's hand-written validation was just reviewed, tested, and fixed
this same cycle; rewriting it around a runtime schema-validation library is a large, separately-risky
change for uncertain benefit, and would add a new RUNTIME dependency (e.g. `ajv`) to the published
package's own bundle. Instead: `ajv` is added as a **dev-only** dependency, used in a dedicated test
that feeds the EXACT SAME fixtures `jsonToChainedBuilderState`'s own test suite already uses (every
hard-error case, every lenient-default case) through the generated schema's real validation, and
asserts the two surfaces AGREE on accept/reject. A future edit that lets the parser and the
generated schema drift apart fails this test — the no-drift guarantee the handoff asks for, without
touching the parser's own runtime code path or the published package's dependency footprint.

### Shipping it

`dist/schema/raw-cronoton.schema.json` (machine-readable) + `dist/schema/raw-cronoton.md` (human
reference, rendered from the SAME in-memory generation pass, so the two can never disagree with each
other either) — new `package.json` `exports` entries for both (`./schema/raw-cronoton.schema.json`,
`./schema/raw-cronoton.md`), mirroring the existing `"./ui.css"` static-asset export precedent. The
Hub fetches/imports either directly from the published package; no second copy lives anywhere else.

## Acceptance criteria

### Deliverable 1 — in-builder Raw JSON unlock/paste/import

1. ✅ `jsonToChainedBuilderState` is exported from `chained-builder-state.ts`, pure, browser-safe
   (zero new imports beyond what that module already has), never throws (verified: the step/variant
   mapping is wrapped in try/catch so even a pathological input — e.g. a ~50,000-level-deep nested
   array that reproduces a real `RangeError` in the unfixed code — returns `{ok:false, error}`
   instead of throwing).
2. ✅ Round-trips: for a state produced by the builder itself, `jsonToChainedBuilderState(JSON.
   stringify(chainedBuilderToCommit(state)))` reproduces an equivalent `ChainedBuilderState` for
   every field `chainedBuilderToCommit` actually emits (lossy only where the forward direction is
   already lossy, e.g. ephemeral signer `label`/`source`/`id`, exactly like `detailToBuilderState`
   today).
3. ✅ Invalid JSON syntax, a non-object top level, a missing/non-array/empty `steps`, and an invalid
   per-step `mode` are all hard parse errors with a clear, specific message; the chain-shape ones
   match `chained-validation.ts`'s own wording verbatim.
4. ✅ Every other missing/malformed field degrades to the matching `makeEmptyBuilderState()`/
   `makeEmptyStepState()` default rather than hard-failing the import.
5. ✅ The Raw JSON pane is read-only by default; the import affordance reveals a textarea + file
   upload + Capture/Cancel; Capture on valid JSON replaces builder state and returns to read-only;
   Capture on invalid JSON shows an error and changes nothing; Cancel changes nothing.
6. ✅ `toGasPayerState`/`freshSignerId` are exported from `builder-state.ts` and reused (not
   reimplemented) by the new importer.

### Deliverable 2 — generated raw-cronoton-JSON schema + field reference

8. ✅ The schema (`dist/schema/raw-cronoton.schema.json`) and field reference
   (`dist/schema/raw-cronoton.md`) are GENERATED (TypeScript Compiler API walk of the real
   `ChainCommitBody`/`CodexTxConfig`/`ScheduleConfig` types + `BUILTIN_DESCRIPTORS`' own runtime
   data) — never hand-written — and exist only as `npm run build` artifacts, never git-committed.
9. ✅ Numeric ranges declared via `@minimum`/`@maximum` JSDoc tags on the real source types render
   correctly scoped: on a scalar field's own schema, and inside `items` (not the array container)
   for an array-typed field like `hours`/`daysOfWeek`/`daysOfMonth` — verified directly against the
   real built artifact (`dist/schema/raw-cronoton.schema.json`'s `hours` field: `{type:"array",
   items:{type:"number", minimum:0, maximum:23}}`).
10. ✅ Planner-params schemas are generated from `BUILTIN_DESCRIPTORS`' own `params[]`, one `anyOf`
    branch per real registered planner, with each field's author-written `help` text (safety-
    critical guidance, e.g. the DPTF-revert warning on `ouronet.aqp-inject`'s `executor`) surfacing
    in the generated description alongside the generic type-shape description, never silently
    discarded.
11. ✅ The human field reference's nested-section walker reaches every nested object/array-of-object
    field, including ones inside a `oneOf`/`anyOf` branch (e.g. `schedule.config`'s
    `several-times-per-day` branch's `times: {hour,minute}[]` field gets a real
    `schedule.config.several-times-per-day.times` subsection, not a dead "(see below)" promise).
12. ✅ A dev-only `ajv` cross-check test proves the generated schema and the hand-written
    `jsonToChainedBuilderState` parser agree on every hard-error case the latter's own test suite
    covers (including non-object top level) — `ajv` never ships in the runtime bundle.

### Both deliverables

7. ✅ Full suite green (104 files / 1570 tests), `tsc --noEmit` clean, `npm run build` clean
   (including the new schema-generation build step), both CHANGELOG/README doc-parity CI gates
   satisfied for the published version.

Reviewed via nectar: deliverable 1 across 4 lenses + 3 validators + 2 parallel fix rounds (1
STYLISTIC and 1 REFUTED left alone, all CONFIRMED findings fixed). Deliverable 2 across 3 lenses
(correctness/conventions/tests — security deliberately omitted as build-time-only tooling with no
external/untrusted input) + 4 parallel validators + 4 parallel fix rounds: 2 HIGH + 7 MEDIUM + 3 LOW
findings, all CONFIRMED by validators (0 REFUTED), all fixed and re-verified against the real built
artifact — including one meta-bug caught during final verification (a structural markdown-table test
added by one fix round had its own pipe-count arithmetic wrong, caught by running the suite directly
rather than trusting the fix round's own "green" claim, given the known risk of several fix rounds
concurrently editing the same `generate.test.ts` file).
