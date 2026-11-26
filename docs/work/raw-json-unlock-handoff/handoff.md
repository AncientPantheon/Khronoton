# Handoff — in-builder Raw JSON "unlock / paste / import" (0.19.0)

**From:** AncientHoldings Hub session (consumer of `@ancientpantheon/khronoton-core`)
**To:** khronoton-core package agent
**Date:** 2026-11-26
**Status:** requested feature for **0.19.0**. The Hub is on 0.18.0 and live (Talos.19).

## What's wanted

The `ChainedBuilder`'s **Raw JSON** pane is currently **read-only** — it shows the
builder's current state as canonical chained-cronoton JSON, and the pane itself
says *"pasting your own code (unlock) is a follow-on."* This is the request for
that follow-on: let an author **paste / load a raw cronoton JSON into the builder**
so it populates the fields.

The Hub owner's accepted UX (keep it simple, keep the pane safe from accidental
typing):

- The Raw JSON pane stays **read-only by default** (so a stray keystroke can't
  corrupt it).
- Add an **"Import / paste"** affordance on that pane — a button (e.g. *"Paste /
  import"* or an unlock toggle) that reveals an editable textarea (or a small
  popup), where the author pastes raw JSON **or** uploads a `.json` file.
- A **"Capture & parse"** action then parses that JSON and **loads it into the
  builder's state** — every field, step, config/payload/gas/signers, schedule,
  single-tx-first fills in — exactly the inverse of what the pane renders. On a
  parse error, show a clear message and leave the current state untouched.
- After capture, the pane returns to its read-only view reflecting the new state.

Editing the JSON **in place** char-by-char is explicitly **not** required — the
paste/upload → capture → populate flow is the whole ask.

## What the package already has (so this is an inverse, not new model work)

- `ChainedBuilderState`, `makeEmptyChainedBuilderState()`, `makeEmptyStepState()`
  (exported) — the target state shape.
- `chainedBuilderToCommit(state)` — state → the canonical `ChainCommitBody`. **This
  is the forward direction**; the Raw JSON pane presumably renders from it. The
  follow-on is its **inverse**: `commitBodyToChainedBuilderState(json)` (or
  `jsonToChainedBuilderState`) — a pure, browser-safe parser that maps a canonical
  JSON doc back into `ChainedBuilderState`, best-effort + typed errors (never
  throws into the render).

The canonical JSON is the same shape `chainedBuilderToCommit` emits:
`{ name, description?, schedule|externalFireable, singleTxFirst?, steps: [...] }`,
each step `{ mode, pactCode?, config?, payload?, gasPayer?, signers?, plannerName?,
plannerParams?, idempotent?, yieldAs? }`. The Hub has a working reference for the
round-trip (its own `chain-json.ts` `draftToJson`/`jsonToDraft` over the Hub's draft
model) if useful, but the package should map to its **own** `ChainedBuilderState`.

## Note — the Hub already ships a standalone import

To unblock authoring now, the Hub added its **own** "Import Raw Cronoton" path
(paste / `.json` upload → parse → **codex signature check** → create via `/chained`),
living in the full-page builder's top bar. That covers *creating* from a raw JSON
today. This handoff is the **nicer in-builder** version — paste → populate the
builder so the author can then review/tweak the fields and Simulate before creating.
The two can coexist; the in-builder one is the better long-term UX.

One thing worth folding in if easy: the Hub's import blocks creation when a signer
`publicKey` isn't signable (it checks against the codex). The package builder can't
see the codex, so it needn't replicate that — but when the imported state loads, the
builder's existing Signatures surfacing should make non-codex keys visible the same
way a hand-entered key would. No package-side codex check is expected.

## Also for 0.19.0 — publish a raw-cronoton-JSON field catalogue / schema

Now that an author can paste a raw JSON to populate the builder, the package should
**publish the canonical schema for that JSON** — the field catalogue describing the
syntax of every field and how to define it. The package is the right owner: it owns
the canonical format (the state model + `chainedBuilderToCommit` + the new inverse)
AND the planner param schemas (`BUILTIN_DESCRIPTORS`).

**Generate it from the package's own types/descriptors — do NOT hand-write it.**
One source of truth → the inverse parser validates against it, the catalogue renders
from it, no drift. Ship it as a **machine-readable JSON Schema** (for validation +
editor tooling) **plus** a human field reference. It should cover:

- **Top level**: `name`, `description?`, `schedule` | `externalFireable`,
  `singleTxFirst?`, `steps[]`.
- **Step**: `mode` (`single`/`planner`), `pactCode`, `config`, `payload`, `gasPayer`,
  `signers`, `plannerName`, `plannerParams`, `idempotent?`, `yieldAs?`.
- **`config`**: `chainId`, `gasPrice`, `gasPriceBufferAnu`, `gasLimit`, `autoGasLimit`,
  `ttl` — with units + ranges.
- **`gasPayer`**: the `codex` vs `gas-station` forms.
- **`signers[]`**: `publicKey`, `capabilityMode` (`pure`/`scoped`), and the
  `capabilities` string syntax.
- **`{"$yield":"name"}`** reference form + how `yieldAs` names a step's result.
- **`schedule`**: each mode + its config shape.
- **Planner names + their `plannerParams` schemas** — from `BUILTIN_DESCRIPTORS`.

The Hub will render/link the published schema on its public `/docs` — no second copy.

## The ask

Add (1) the in-builder Raw JSON unlock/paste/import + the `json → ChainedBuilderState`
inverse, and (2) the generated raw-JSON field catalogue / JSON Schema. Publish
**0.19.0**, and reply with the version. The Hub will pin, redeploy, and surface the
schema on `/docs`.
