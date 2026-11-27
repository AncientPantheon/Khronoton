# `ChainedBuilder` edit mode — Design

Handoff: `Z:\StoaChain\_hub\AncientHoldings\docs\work\chained-cronoton-edit\khronoton-agent-handoff.md`
(local path: `~/ClaudeWS/StoaChain/_hub/AncientHoldings/docs/work/chained-cronoton-edit/{khronoton-agent-handoff,plan}.md`).
Package-only change — the hub's half (update route, adapter wiring, `goToEdit` rewire) is already
built/in progress and is not this document's concern.

## Problem

`ChainedBuilder` is uncontrolled + create-only: no `editId`/`initialState`, seeds
`makeEmptyChainedBuilderState()`, and Save always calls `adapter.commitChain` (create). The single-tx
`Builder` already has this exact shape (`editId` → fetch + rehydrate → PATCH instead of POST) — this
mirrors that precedent for the chained builder.

## Scope decisions

**In scope (required by the handoff):**
1. `ChainedBuilderProps` gains `editId?: string` + `initialDocument?: ChainCommitBody`.
2. `KhronotonAdapter` gains an optional `updateChain?(id, body, opts): Promise<ChainCommitView>` slot.
3. Save, in edit mode: labelled "Save changes", calls `updateChain` (never `commitChain`/`commit`,
   regardless of `isSingleStepChain`), enabled only when the commit gate passes AND state is dirty
   vs. the loaded baseline, `onDone(editId)` on success.
4. Reuses the existing gated call path (`runGated` + `onNeedConfirm`) — no new client plumbing.
5. Byte-identical create path when both new props are absent.

**Explicitly out of scope for this pass (per the handoff's own "optional, not required"):**
- The package-side `updateChainedCronoton(id, input, dep)` store function. The hub already has a
  working `updateChainedCodexCronoton` with the run-safety guard; the handoff frames the package
  version as "cleaner long-term... not required for this feature." Revisit as a follow-on once the
  hub's own copy has proven itself in production — moving store logic into the package later is a
  compatible, non-breaking follow-up (the hub's adapter call site doesn't change either way, since it
  calls through `updateChain?` regardless of what's behind the hub's own route).
- An "unsaved changes?" confirm on back/close — a "nicety" the handoff itself doesn't require, and
  there is no existing `onBack`/`onClose` prop on `ChainedBuilderProps` to hook it into (adding one
  would be its own scope expansion beyond what's asked).

## Design

### Seeding: a ONE-TIME mount-time conversion, not a reactive effect

The handoff: *"On mount, if `initialDocument` is provided, seed state from it... reusing the existing
in-builder Raw-JSON import logic."* Read literally: a single mount-time event, not "whenever the prop
changes." `jsonToChainedBuilderState(JSON.stringify(initialDocument))` is called exactly once, inside
`useState`'s lazy initializer (the same mechanism the component already uses for
`makeEmptyChainedBuilderState()`), computing THREE things at once (state, any load error, and the
dirty-check baseline) so the raw document is parsed exactly once:

```ts
const [{ initialState, loadError, baselineDocJson }] = useState(() => {
  if (!initialDocument) {
    return { initialState: makeEmptyChainedBuilderState(), loadError: null, baselineDocJson: null };
  }
  const result = jsonToChainedBuilderState(JSON.stringify(initialDocument));
  if (!result.ok) {
    return { initialState: makeEmptyChainedBuilderState(), loadError: result.error, baselineDocJson: null };
  }
  return {
    initialState: result.state,
    loadError: null,
    // The baseline for the dirty check is derived from the ROUND-TRIPPED state,
    // never the raw `initialDocument` text — `jsonToChainedBuilderState` is
    // deliberately LENIENT (a missing `description` defaults to `""`;
    // `chainedBuilderToCommit` always emits an explicit `payload: {}` on a
    // single-mode step even when the source document omitted the key). Diffing
    // against the raw prop would flag a freshly-loaded, UNTOUCHED cronoton as
    // "dirty" purely from this round-trip normalization — comparing against
    // `chainedBuilderToCommit(result.state)` instead means "dirty" means
    // exactly what it should: the OPERATOR changed something.
    baselineDocJson: safeStringifyOrNull(chainedBuilderToCommit(result.state)),
  };
});
const [state, setState] = useState<ChainedBuilderState>(initialState);
```

**Deliberately NOT a `useEffect` keyed on `initialDocument`/`editId`.** A reactive re-seed would be
necessary if `ChainedBuilder` did its own async fetch (like `Builder.tsx`'s `adapter.get(editId)`
effect, which needs `loadedEditId` tracking to handle a stale in-flight fetch after the target
changes) — but here the document is handed in as a prop, already resolved, by a host that has
already done its own fetch (per the hub's own plan: `PackagedChainBuilder` fetches the chain-JSON
projection and only then renders `<ChainedBuilder initialDocument={doc} />`). A reactive effect keyed
on the `initialDocument` object reference would risk silently wiping in-progress edits on any
re-render where the host passes a fresh (even if logically-identical) object literal — a strictly
worse failure mode than "the host must remount to switch edit targets." Documented on the prop itself:
switching `editId`/`initialDocument` on an already-mounted instance has no effect; the host should
`key={editId}` the element to force a remount when switching between edit targets (exactly the
`key`-based remount idiom React itself recommends for "this prop defines identity, not just data").

### Gating: never show a blank create-shaped form under an "edit" label

```ts
const isEdit = Boolean(editId);
// An editId without a document yet (the host's own fetch still in flight, if
// it mounts eagerly rather than waiting) stays gated — the alternative is a
// confusingly blank CREATE-shaped form rendered under an "edit" label. A
// document that failed to parse (loadError) stays gated too, with a distinct
// message — not treated the same as "still loading."
const editReady = !isEdit || (Boolean(initialDocument) && loadError === null);
```
Rendering: `loadError` → a clear inline error (never silently falls through to an editable blank
form); `!editReady` (no error, just not ready yet) → "Loading cronoton…" (mirrors `Builder.tsx`'s own
wording); else the real builder.

### Dirty check

```ts
const commitBodyJson = useMemo(() => safeStringifyOrNull(commitBody), [commitBody]);
const isDirty = baselineDocJson === null || commitBodyJson === null || commitBodyJson !== baselineDocJson;
```
`baselineDocJson === null` covers BOTH "not in edit mode" (irrelevant there — the Save button's own
enable expression only consults `isDirty` when `isEdit`) and "edit mode but the load failed" (stays
gated by `editReady` regardless). A stringify failure on EITHER side (a pathologically deep hand-typed
payload — the same class of edge the 0.19.1 fix already covers for the read-only preview) is treated
as dirty: "can't prove it's clean" must never silently disable Save, only "can prove it's clean" may.
`safeStringifyOrNull` is a new tiny local helper, also used to replace `codeText`'s own ad-hoc
try/catch (previously it returned a human-readable fallback STRING on failure for direct display;
factored so both call sites share one try/catch, not two independent copies).

### Save routing

Edit mode ALWAYS calls `updateChain` with the chain shape — never routes through `isSingleStepChain`'s
create-time `commit`/`commitChain` branching, regardless of how many steps the edited state currently
has. The existing row was created through the chain store (it has rows in `codex_cronoton_steps`
already); routing an edit through the single-tx `adapter.commit`/`edit` methods would target the
wrong update mechanism entirely. `handleSimulate` already does this unconditionally for the SAME
reason (whole-chain dry run always uses the chain shape) — Save in edit mode now matches that
existing precedent rather than introducing a new one.

```ts
if (isEdit && editId) {
  if (!adapter.updateChain) {
    window.alert("This backend does not support updating chained cronotons (no updateChain).");
    return;
  }
  await runGated((opts) => adapter.updateChain!(editId, commitBody, opts), {
    onNeedConfirm: config.onNeedConfirm,
  });
  onDone?.(editId); // the KNOWN id, not whatever the response echoes — never ambiguous
} else if (isSingleCronoton) {
  /* unchanged create path */
} else {
  /* unchanged create path */
}
```
Reuses the already-memoized `commitBody` (not a fresh `chainedBuilderToCommit(state)` call) — the
existing file's own stated philosophy ("the per-step pipeline runs once per keystroke, not twice").

### Button label + enable expression

```ts
const primaryLabel = committing
  ? (isEdit ? "Saving…" : "Creating…")
  : isEdit
    ? "Save changes"
    : isSingleCronoton
      ? "Create cronoton"
      : "Create chained cronoton";
const primaryDisabled =
  committing || !canMutate(access) || !gate.ok || (isEdit && (!editReady || !isDirty));
```

### Small UX nicety (cheap, non-breaking, not explicitly required)

The header title (`"Cronoton builder"` / `"Chained cronoton builder"`) gains an `"Edit "` prefix when
`isEdit` — purely cosmetic, visible only in the new edit mode (never in any existing create-only test
path), consistent with giving the operator an unambiguous signal they're editing, not creating.

## Acceptance criteria

1. ✅ `ChainedBuilderProps` gains `editId?`/`initialDocument?`; omitting both reproduces today's
   create behavior exactly (seed, label, Save routing all byte-identical — verified by every
   pre-existing test in the file passing unmodified, plus a dedicated preserved-styling check).
2. ✅ `KhronotonAdapter` gains `updateChain?(id, body, opts): Promise<ChainCommitView>`.
3. ✅ Loading a real multi-step document (+ a `singleTxFirst` variant) via `initialDocument`
   reproduces the exact step rail + variant AND the per-step `config`/`gasPayer`/`signers` — the
   acceptance test's own round-trip, using a realistic multi-field fixture (modeled on the hub's
   real `StoicismRewardFlow.json`). The round-trip test originally only spot-checked step
   count/labels/one Pact code string (a tests-lens HIGH finding); strengthened to also assert the
   gas-station signing key, a step's gas limit, and a signer's public key survive.
4. ✅ A freshly-loaded, untouched edit is NOT dirty (Save disabled); editing exactly one field makes
   it dirty (Save enabled) and does not touch any OTHER field's value — now verified via `toEqual`
   against the REAL round-trip of the untouched fixture (`roundTripStoicismFixture()`), not loose
   per-field string checks (a tests-lens HIGH finding: the original test's own comment claimed
   "everything else survived untouched" while never actually asserting on `config`/`gasPayer`/
   `signers`, only on `pactCode`/`name`).
5. ✅ Save in edit mode calls `adapter.updateChain(editId, <the exact current commit body>, opts)`,
   never `adapter.commit`/`adapter.commitChain`, and calls `onDone(editId)` on success.
6. ✅ Save goes through the same `runGated`/`onNeedConfirm` path as create — a stale confirm
   surfaces the same re-prompt-and-retry behavior, with no new client-side confirm plumbing. Now
   has a dedicated test (a tests-lens MEDIUM finding: generic `runGated` coverage proves the
   helper works, not that THIS call site forwards the right arguments) mocking `updateChain` to
   reject once with `NeedsConfirmError` then succeed, confirming the retry actually fires with
   `confirmed: true` and `onDone` still lands.
7. ✅ `editId` without `initialDocument` yet renders a loading placeholder, not a blank editable
   form.
8. ✅ A document that fails to parse renders a clear, distinct error, not a blank editable form and
   not the generic loading message.
9. ✅ Full suite green, `tsc`/build clean, README documents the new props + adapter slot.

### Findings from the nectar review (correctness/conventions/tests; security lens omitted — pure
client-side React state wiring reusing existing gated call paths, no new validation/auth logic)

**Correctness (1 MEDIUM, fixed):** `codeText` (the Raw JSON preview) and the header title both
branched on the raw `isSingleCronoton` predicate unconditionally — but `handleCommit`'s edit branch
always sends the CHAIN shape via `updateChain` regardless of step count. An operator editing a chain
down to exactly one step would have been SHOWN a single-cronoton preview/title while a different
(chain-shaped) document was what actually got persisted. Fixed with a new `previewAsSingle = !isEdit
&& isSingleCronoton` used by both; regression test added. Correctness otherwise affirmatively
verified (not just "no finding reported," genuinely traced): the one-time seed never re-fires on a
later prop change (no `useEffect` exists for this — `useState`'s lazy initializer runs exactly once
by React's own contract); no code path calls any adapter mutation method outside the Save button's
`onClick`; the dirty check has no wall-clock/random/render-order-dependent false positive.

**Conventions (3 MEDIUM, fixed; 1 LOW, fixed):** the "Commit routing" header doc comment didn't
mention the new edit-mode override; the `EDIT_BANNER` precedent `Builder.tsx` uses was silently
dropped with no documented rationale (every OTHER deliberate divergence from that precedent WAS
documented) — now has an explicit scope note; the test file's own module docblock didn't mention the
new edit-mode describe block.

**Tests (3 HIGH, fixed; 3 MEDIUM, fixed):** beyond criteria 3/4/6 above — no test proved "no-save ⇒
no-update" directly (editing without ever clicking Save, asserting `updateChain` was never called);
no test proved the documented one-time-seed contract (re-rendering an already-mounted instance with a
DIFFERENT `initialDocument`/`editId` must not re-seed — added via `rerender`); no test exercised edit
mode composed with the pre-existing Raw JSON "Paste / import" affordance (importing a brand-new
document while editing must still mark the form dirty and route Save to `updateChain`, never
`commitChain`).
