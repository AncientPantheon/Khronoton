# Khronoton Builder — Pact-code syntax highlighting + top/bottom layout — Design

## Problem

Pythia's admin UI mounts khronoton-core's pre-built `<Builder>` component as-is and has zero ability
to change it from her own repo (per `HANDOFF-khronoton-builder-pact-editor.md`, 2026-08-02, plus two
follow-up asks from the operator once they used the screen live). Four problems in this surface affect
every consumer, not just Pythia:

1. **`PactCodeMirror.tsx`** renders a real CodeMirror instance (themed to the package's `--khr-*`
   tokens) but with zero syntax coloring — `basicSetup` only, no language/highlight extension. Every
   token (keywords, strings, parens, comments) renders in one flat color, making Pact source hard to
   read at a glance. The operator's reference point for "what this should look like" is OuronetUI's
   own Pact-code editor on its execute-code page, which has real per-token coloring.
2. **`Builder.tsx`** lays the Pact editor and the tabbed settings pane out as a hardcoded 2-column CSS
   grid (`PANE_WRAP`, inline styles, no overridable selector), with the editor defaulting to 460px
   tall. The operator wants the editor moved to a full-width top strip clamped to ~7 visible lines
   (internal scroll beyond that), with the header/tabs/tab-content full-width below it — as the one
   standard layout, not a per-consumer option.
3. **No transaction-size / gas metering.** OuronetUI's own Pact-code editor shows a metering strip
   between its header and its editor body — a "Tx Size" bar (serialized `/send` body vs the 2 MB
   StoaChain node ceiling, as bytes and per-mille) and a "Gas" bar (last-simulated gas used vs the
   configured gas limit). Khronoton's Builder has no equivalent today — an operator typing/pasting Pact
   code has no visibility into either budget until they hit Simulate (for gas) or a submission fails
   (for size).
4. **Selection is barely visible in the Pact editor.** `PactCodeMirror.tsx`'s `khronotonEditorTheme`
   colors the CodeMirror text-selection background with `var(--khr-accent-tint, #1a1500)` — the same
   token used elsewhere in this package as a subtle *panel* background under bright accent-colored text
   (active tab, selected schedule card). Against the editor's own near-black background
   (`var(--khr-panel, #0a0a0a)`), `#1a1500` is barely distinguishable — it changes luminance by only a
   few percent, so a text selection reads as almost invisible. This is a real contrast bug, not user
   unfamiliarity: Ouronet's own selection color (`#264f78`, a saturated blue) is a full one-and-a-half
   orders of magnitude lighter than its own background, and Khronoton already has an unrelated token
   (`--khr-blue-bg: #1e3a5f`) in the same family that would read clearly for the same reason.

All four are scoped to `PactCodeMirror.tsx` and `Builder.tsx` (Change 3's meter also touches
`ExecuteTab.tsx`, to hoist the shared simulate result — see below); `Detail.tsx`/`CronotonList.tsx`
must render unaffected.

## Approach

### Change 1 — syntax highlighting

**Reference investigated directly:** `OuroborosNetwork/daimons/OuronetUI/src/lang-pact/` — a hand-rolled
Lezer grammar (`pact.grammar`) compiled via `@lezer/generator`, wrapped in `LRLanguage.define()` with
`styleTags()` mapping grammar nodes to `@lezer/highlight` tags, plus a `HighlightStyle` with hardcoded
hex colors, consumed by `execute-code/CodeEditor.tsx` as `extensions={[pact(), ...]}`. Ouronet's build
compiles `.grammar` → parser at bundle time via `@lezer/generator/rollup`, a Vite/Rollup plugin.

**Constraint this creates for Khronoton:** the `/ui` subpath here builds with **tsup (esbuild)**, not
Rollup/Vite — there is no `@lezer/generator` esbuild plugin, only the Rollup one (confirmed: the
package's `exports` map offers `.` and `./rollup` only). Porting Ouronet's grammar file verbatim would
require adding `@lezer/generator` as a new devDependency and a new codegen step (e.g. the
`lezer-generator` CLI run before `tsup`) that this package's build has never had.

**Approaches considered:**

- **Port the real Lezer grammar** (Ouronet's exact mechanism) — most structurally correct (real LR
  parser, fold/indent support for nested `()`/`[]`/`{}`), but adds a new devDependency and a new
  build-pipeline stage (grammar codegen) to a small UI package, for a capability (folding) the Builder
  doesn't use today (`foldGutter: false` in the current `basicSetup`, and this handoff's Change 2
  doesn't touch it either).
- **Hand-rolled `StreamLanguage` tokenizer (chosen)** — reimplement Ouronet's exact token taxonomy and
  keyword lists (`defun`/`defcap`/`defconst`/`defpact`/`defschema`/`deftable`/`module`/`interface`/
  `defproperty` as definition keywords; `if`/`let`/`let*`/`lambda`/`cond`/`use`/`enforce`/... as regular
  keywords; `integer`/`decimal`/`time`/`bool`/`string`/`list`/`value`/`keyset`/`guard`/`object`/`table`
  as type keywords; `true`/`false` as booleans; `"..."` strings; `;;` line comments; `@doc`/`@model`-style
  `@word` meta tags; `'atom` symbols; parens/brackets/braces) as a plain JS tokenizer function passed to
  `@codemirror/language`'s `StreamLanguage.define()`. No `.grammar` file, no codegen step, no
  `@lezer/generator`/`@lezer/lr` dependency — `StreamLanguage` is a runtime module tsup bundles like any
  other `.ts` file. Still wired through the *same* downstream mechanism the handoff and Ouronet both use
  (`@lezer/highlight` tags → `HighlightStyle.define()` → `syntaxHighlighting()` → `extensions={[...]}`),
  so the visual result — the only thing the operator actually observes and asked to match — is
  equivalent. Trade-off: no fold/indent tracking of nested expressions (unused today) and slightly
  cruder error tolerance on malformed/mid-edit code than a real LR parser (acceptable for a coloring-only
  editor with `foldGutter: false`).
- **Ouronet's own suggested fallback (Scheme legacy mode via `StreamLanguage`)** — the handoff's
  "cheapest" option, offered only because its author didn't have access to the OuronetUI repo to see the
  real Pact grammar. Since this agent does have that access, shipping a generic Scheme approximation
  when the real keyword/token list is already known is strictly worse than the hand-rolled option above
  for the same implementation cost. Rejected.

Chosen: the hand-rolled `StreamLanguage` tokenizer, ported keyword-for-keyword and tag-for-tag from
Ouronet's grammar (so token *categories* match exactly — keyword, definitionKeyword, typeName, bool,
string, number, lineComment, variableName, atom, operator, meta, propertyName, paren, squareBracket,
brace) with zero new build tooling. If a future need for fold/indent arises, this can be swapped for the
Lezer grammar later without touching the `HighlightStyle`/theme layer.

**Color values:** unlike Ouronet's hardcoded hex `HighlightStyle`, khronoton-core's `HighlightStyle` maps
each tag to one of the package's existing `--khr-*` CSS custom properties, extended with a small set of
new syntax-specific tokens in the same `--khr-*` family (the current token set — `--khr-accent`,
`--khr-blue`, `--khr-amber`, `--khr-success`, `--khr-error`, `--khr-nothing`, `--khr-mono`,
`--khr-text-dim`, etc. — covers UI chrome, not the ~13 distinct token roles a Pact highlighter needs).
New tokens get documented in the package's CHANGELOG/release notes per the handoff's ask, so Pythia's
`khronoton-island.css` can pick them up (that follow-up itself is explicitly out of scope here — Pythia's
job, not Khronoton's).

`PactCodeMirror.tsx` gains an `extensions={[pact(), syntaxHighlighting(pactHighlightStyle)]}`-equivalent
(new local `lang-pact` module inside `packages/khronoton-core/src/ui/`, not a new package) alongside the
existing `basicSetup`/theme.

**Dependency fragility (handoff's secondary ask):** `@uiw/react-codemirror`, `@codemirror/state`,
`@codemirror/view` move from `devDependencies` to `peerDependencies` (optional), matching the existing
pattern already used for `react`/`react-dom` in this same package.json — consistent with `tsup.config.ts`'s
own stated intent ("the CodeMirror libs are UI-only heavy deps" left `external`) which was never backed
by a real peer declaration. The two new packages this change adds (`@codemirror/language`,
`@lezer/highlight`) join the same optional-peer group, and `tsup.config.ts`'s `external` array gets the
two new patterns so they aren't bundled either.

### Change 2 — top/bottom layout

`PANE_WRAP` becomes a single-column flex stack (`flexDirection: "column"`) instead of the 2-column grid;
`<PactCodeEditor>` moves before the header/tabs `<div>` in the JSX and both become full-width block
children instead of grid columns.

**7-line height:** CodeMirror's own base theme sets `.cm-content { padding: "4px 0" }` (8px total
vertical) and leaves `line-height` at the browser default for the font stack — which is not deterministic
across browsers for a monospace font. Rather than "measure the browser default and hope it doesn't
drift," `khronotonEditorTheme` in `PactCodeMirror.tsx` gets an explicit `line-height: 1.4` on `.cm-content`
(a standard, readable ratio for 12px monospace code), making the math fixed: `8px padding + 7 × (12px ×
1.4) = 125.6px`, rounded up to **126px** so no partial 7th line is clipped. `Builder.tsx` passes
`height={126}` to `<PactCodeEditor>` instead of relying on its 460px default. The build step should
include a jsdom/DOM-measurement test asserting the rendered editor's `.cm-content` computed line-height
matches this assumption, so a future CodeMirror theme change that silently alters line-height is caught
rather than silently drifting the "7 lines" claim.

### Change 3 — Tx-size + gas metering strip

**Reference investigated directly:** `OuroborosNetUI/src/components/execute-code/ConsoleMeters.tsx` +
`src/lib/tx-size.ts` (plus its own handoff doc, `HANDOFF-tx-size-meter.md`). Two labeled bars, rendered
in a `subBar` slot between the editor's header and its CodeMirror body:
- **Tx Size** — estimates the serialized `/send` POST body (`{cmds:[cmd]}`, `+140` bytes per expected
  signature) by actually constructing a real Pact command via `Pact.builder` (from
  `@stoachain/kadena-stoic-legacy/client`) against the current code/config, then measuring its
  UTF-8 byte length against a hardcoded `STOA_TX_BYTE_CEILING = 2 * 1024 * 1024` (Chainweb's
  `serviceRequestSizeLimit`/`p2pRequestSizeLimit`, both fixed network-wide constants, not
  per-node-configurable) — shown as bytes, a fill bar, and ‰-of-ceiling to 4 decimals, plus a fixed tick
  at a 1 MB "likely proxy limit" mark.
- **Gas** — the last Simulate's `gasUsed` vs the configured gas limit, as an amber (used) + red
  (headroom) two-segment bar; shows "Run Simulate" until a simulate result exists.

**Settled: this replicates Ouronet's mechanism exactly, unchanged.** The estimate is 100% local/client-side
— no network call, no live connection to any StoaChain node or to Khronoton's own backend. `Pact.builder`
just assembles a JS object and `JSON.stringify`s it; that's the whole computation, live on every
keystroke/config change, precisely mirroring how Ouronet's `useTxSizeEstimate` recomputes on every
`pactCode`/config change via `useMemo`. The one documented (non-blocking) caveat: because Khronoton's
actual submission is built independently, server-side, by Khronoton's own executor (`adapter.simulate`/
`commit`/`executeNow`), the browser's local preview command isn't guaranteed byte-identical to what the
executor ultimately serializes (e.g. the executor synthesizes a `DALOS.GAS_PAYER`/`coin.GAS` signer the
browser's preview doesn't know about) — the same honest limitation Ouronet's own meter already carries
for the exact same reason (it never signs or submits either; see its `FUNCTION_INVENTORY_EXCLUSION`
comment). This is a documentation note, not a design fork: no backend change, no alternate code path —
just the one client-side estimate, exactly as Ouronet does it.

**Dependency note:** `@stoachain/kadena-stoic-legacy` and `@stoachain/stoa-core` are *already* declared
as optional `peerDependencies` in `khronoton-core/package.json` (today only exercised by the
`/blockchain/stoachain` subpath) — Change 3 is the first thing in the `/ui` subpath to import from them.
Since they're optional, the meter follows the same defensive pattern `PactCodeEditor.tsx` already uses
for CodeMirror itself: if the peer isn't resolvable, degrade to a coarser estimate
(`JSON.stringify({pactCode, payload}).length`-based) rather than throwing — a less precise bar is
preferable to breaking the Builder for a consumer who hasn't installed the StoaChain peers.

**State hoisting required:** the Gas bar needs the last Simulate result, but `useSimulate()` is currently
called *inside* `ExecuteTab.tsx` (component-local state, lost on tab switch) — and Change 2 puts the new
meter strip above the tab bar, visible regardless of which tab is active. `Builder.tsx` hoists the
`useSimulate()` call up to itself (mirroring how it already fetches `signers` once and hands them down),
passing `sim` down to both the new meter and `ExecuteTab` (which drops its own internal call and takes
`sim` as a prop instead — its `onSimulate`/gate logic is otherwise unchanged).

New component: `packages/khronoton-core/src/ui/builder/TxMeters.tsx`, new util:
`packages/khronoton-core/src/ui/tx-size.ts` (pure — mirrors Ouronet's `estimateTxSize` shape but reads
`BuilderState`/`BuilderConfig` instead of Ouronet's `TransactionConfig`). Wired into `PactCodeEditor.tsx`
via a new optional `subBar` prop (same name/slot Ouronet's `CodeEditor` uses), rendered by `Builder.tsx`.

### Change 4 — visible text selection in the Pact editor

`khronotonEditorTheme` in `PactCodeMirror.tsx` gets a new dedicated token, `--khr-selection` (default
`#1e3a5f` — the same value already sitting in this package as `--khr-blue-bg`, chosen as a new token
rather than reusing `--khr-blue-bg` directly so a consumer can theme "badge blue" and "editor selection"
independently), replacing `var(--khr-accent-tint, #1a1500)` on the
`.cm-focused .cm-selectionBackground` / `.cm-selectionBackground` / `::selection` rule. This is a
one-token substitution, no structural change.

## Acceptance criteria

- [ ] `PactCodeMirror.tsx` colors Pact keywords, definition-keywords, type-keywords, strings, numbers,
      booleans, `;;` comments, and parens/brackets/braces distinctly, using `--khr-*` custom properties
      (existing or newly added) — not hardcoded hex.
- [ ] The new Pact tokenizer correctly distinguishes `defun`/`defcap`/etc. as keywords only when they
      are the full identifier token (not a substring of e.g. `my-defun-helper`), matching Ouronet's
      `@specialize`-based disambiguation.
- [ ] `@uiw/react-codemirror`, `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, and
      `@lezer/highlight` are declared as `peerDependencies` (optional, matching the `react` pattern) in
      `packages/khronoton-core/package.json`, and `tsup.config.ts`'s `external` list covers all of them.
- [ ] `Builder.tsx` renders the Pact-code editor full-width at the top (126px tall, internal scroll for
      longer content) and every other Builder control (header, tab bar, active tab content) full-width
      below it, for both create and edit mode, unconditionally (no new prop).
- [ ] `Detail.tsx` and `CronotonList.tsx` render unchanged — their snapshot/behavioral tests are untouched
      by this work.
- [ ] All existing khronoton-core tests still pass (`pnpm -F @ancientpantheon/khronoton-core test` or
      the repo's equivalent).
- [ ] New/updated tests cover: (a) the single-column top/bottom layout structure in `Builder.test.tsx`,
      (b) that `PactCodeMirror`'s CodeMirror instance is constructed with the Pact language/highlight
      extension attached (a jsdom-safe assertion on the extensions array or a rendered
      `HighlightStyle`/class-name check — full pixel-color assertions are out of reach under jsdom, per
      the existing `forceFallback` test seam in `PactCodeEditor.test.tsx`).
- [ ] The package's CHANGELOG/release notes name every new `--khr-*` CSS variable introduced, so Pythia's
      follow-up (updating `khronoton-island.css`) has an exact list to work from.
- [ ] The Pact editor shows a Tx Size bar (bytes + ‰-of-2MB-ceiling) and a Gas bar (used vs. configured
      gas limit, "Run Simulate" before any simulate result exists) between its header and its code body,
      for both create and edit mode.
- [ ] The Gas bar reflects the same Simulate result `ExecuteTab`'s own summary already shows (single
      shared `useSimulate()` call at the `Builder.tsx` level, not two independent simulate states) —
      i.e. running Simulate from the Execute tab updates the top meter without a second simulate call.
- [ ] If `@stoachain/kadena-stoic-legacy`/`@stoachain/stoa-core` are not resolvable at runtime, the Tx
      Size bar still renders (using the coarser JSON-length fallback) rather than crashing the Builder.
- [ ] Selecting text in the Pact editor shows a clearly visible highlight (`--khr-selection`, default
      `#1e3a5f`) against the editor's `--khr-panel` background, both focused and unfocused.

## Out of scope

- Updating Pythia's `khronoton-island.css` with the new `--khr-*` token values — that is explicitly
  Pythia's own follow-up once this ships and publishes, per the handoff.
- Any change to `Detail.tsx` or `CronotonList.tsx`.
- Code folding / bracket-fold UI for the Pact editor (`foldGutter` stays `false`) — the hand-rolled
  `StreamLanguage` approach does not provide this, and it was not requested.
- A per-consumer or per-cronoton opt-out of the new top/bottom layout — the handoff is explicit this is
  the new standard, unconditionally.
- Autocompletion, linting, or Pact-specific language-server-style features — this is coloring only.
- Migrating to a real Lezer grammar (fold/indent-capable) — noted as a possible future upgrade path in
  the Approach section, not part of this change.
- Byte-identical parity between the Tx Size meter's client-side estimate and whatever Khronoton's
  backend executor ultimately serializes and submits — this is a best-effort preview (see Change 3),
  same honest limitation Ouronet's own meter has.
- A configurable/overridable proxy-limit tick or byte-ceiling value — the 1 MB proxy marker and 2 MB
  Chainweb ceiling are fixed constants, matching Ouronet's own choice, not a new prop.
- Any other Ouronet execute-code page feature not explicitly named above (multi-chain progress, capability
  templates, key selection cards, etc.) — only the metering strip and the selection-contrast fix are in
  scope from that reference.

## Decisions

Autonomous run confirmed 2026-08-02.

- Highlighting mechanism: hand-rolled `StreamLanguage` tokenizer (not a compiled Lezer grammar) —
  avoids adding `@lezer/generator` + a new codegen step to a tsup/esbuild build with no bundler plugin
  for it; folding/indent (the LR-grammar-only advantage) is unused (`foldGutter: false`). User confirmed
  this trade-off is fine ("we can get the light variant for highlighting if you think it brings the same
  visual result for code").
- Tx-size/gas meter: local/client-side estimate via `Pact.builder`, exactly mirroring Ouronet's
  mechanism — no backend change, no live estimate accuracy guarantee against the executor's own
  server-side build (documented caveat only). User confirmed: "i want it to work exactly how it works in
  OuronetUI in the execute code tab, thats all."
- Selection-visibility fix folded in as Change 4 (new `--khr-selection` token) after the user reported
  selection is barely visible in the current editor — confirmed as a real contrast bug (`#1a1500` tint
  against `#0a0a0a` background), not a request for new behavior.
- Ship path: build + review run fully autonomously; version bump/changelog/commit message/publish are
  prepared but the actual `git commit`/`git push`/`npm publish` wait for one final user go-ahead once
  build+review are clean (honey's own "never ship autonomously" rule), even though the user pre-approved
  commit/push/publish — irreversible/public actions get one last look at the real diff.
- Pre-existing environment quirk found during T1: the ENTIRE `packages/khronoton-core` working tree
  already shows as modified against `HEAD` before this build touched anything — a repo-wide LF→CRLF line
  ending flip unrelated to this work (confirmed on files no task in this plan touches, e.g.
  `src/handlers/cronoton.ts`), not caused by `core.autocrlf` (unset) — likely the Windows-drive-mapped
  filesystem this environment runs on. Left as-is during build (out of this task's scope to fix
  repo-wide); handled at commit-prep time by normalizing only the files this work actually changed back
  to LF before `git add`, so the eventual diff/commit shows real content changes only, not a spurious
  157-file rewrite.
