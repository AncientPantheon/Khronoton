## Wave 1

- [x] T1: Add the syntax-highlight + selection CSS custom properties to `packages/khronoton-core/src/ui/ui.css` —
  done when: the `:root, .khronoton-ui` block in `ui.css` contains exactly these six new declarations
  (alongside the existing ones, none removed), with these exact names and default values:
  ```css
  --khr-syntax-keyword: #c586c0;
  --khr-syntax-type: #4ec9b0;
  --khr-syntax-string: #ce9178;
  --khr-syntax-number: #b5cea8;
  --khr-syntax-atom: #d7ba7d;
  --khr-selection: #1e3a5f;
  ```
  No other file changes. This task has no tests (a CSS-only change); its correctness is verified by T2/T5
  reading these exact var names.
  - files: `packages/khronoton-core/src/ui/ui.css`

- [x] T3: Create the pure Tx-size estimator — done when: `packages/khronoton-core/src/ui/tx-size.ts` exports:
  - `STOA_TX_BYTE_CEILING = 2 * 1024 * 1024` and `PROXY_SOFT_LIMIT = 1 * 1024 * 1024` (named constants).
  - `interface TxSizeEstimate { bytes: number; ceiling: number; fraction: number; permille: number; over: boolean }`.
  - `async function estimateTxSize(state: BuilderState): Promise<TxSizeEstimate>` (import `BuilderState`,
    `builderToCommit` from `../builder-state.js`). Implementation:
    1. Call `const commit = builderToCommit(state)` to get `commit.envelope.{pactCode, config, payload, signers}`
       (already-resolved payload object, no need to touch `builder-state.ts`).
    2. Try the accurate path in a `try {}`: dynamically `await import("@stoachain/kadena-stoic-legacy/client")`
       for `Pact`, `await import("@stoachain/stoa-core/gas")` for `anuToStoa`, and
       `await import("@stoachain/stoa-core/constants")` for `KADENA_NETWORK` (all three are already-declared
       optional peers + devDependencies in `packages/khronoton-core/package.json` — do not add new ones). Build
       `Pact.builder.execution(commit.envelope.pactCode || "").setMeta({ senderAccount: state.gasPayer.type ===
       "codex" ? (state.gasPayer.address ?? "") : "c:gas-station", chainId: commit.envelope.config.chainId,
       gasLimit: commit.envelope.config.gasLimit, gasPrice: anuToStoa(commit.envelope.config.gasPrice), ttl:
       commit.envelope.config.ttl }).setNetworkId(KADENA_NETWORK)`, call `.addData(k, v)` for every
       `Object.entries(commit.envelope.payload)`, then `.createTransaction()`. Cast values as needed (`as any`
       is acceptable here — this build is for byte-sizing only, never signed or submitted). Serialize
       `JSON.stringify({ cmds: [tx] })`, measure with `new TextEncoder().encode(body).length`, and add
       `commit.envelope.signers.length * 140` (the same per-signature byte allowance OuronetUI's
       `BYTES_PER_SIGNATURE` uses) to get `bytes`.
    3. On any thrown error (peer not installed, or any other build failure) in a `catch`, fall back to
       `bytes = new TextEncoder().encode(commit.envelope.pactCode + JSON.stringify(commit.envelope.payload)).length`
       — never throw out of `estimateTxSize`.
    4. Return `{ bytes, ceiling: STOA_TX_BYTE_CEILING, fraction: bytes / STOA_TX_BYTE_CEILING, permille:
       (bytes / STOA_TX_BYTE_CEILING) * 1000, over: bytes > STOA_TX_BYTE_CEILING }`.
  - Tests in `packages/khronoton-core/src/ui/tx-size.test.ts` (plain Node env, no jsdom needed): (a) an empty
    `makeEmptyBuilderState()` produces `bytes > 0` and `over === false`; (b) a `pactCode` string whose own length
    alone exceeds `STOA_TX_BYTE_CEILING` (e.g. `"(x)".repeat(1_000_000)`) produces `over === true` and
    `permille > 1000`; (c) adding one signer to the state increases `bytes` by at least 140 vs. the same state
    with zero signers (proves the signature allowance is applied); (d) `estimateTxSize` never rejects/throws
    even when passed a state whose `pactCode` is `""` and `payload` raw JSON is invalid (drives the catch path
    deterministically by asserting the promise resolves, not by mocking the dynamic import).
  - files: `packages/khronoton-core/src/ui/tx-size.ts`, `packages/khronoton-core/src/ui/tx-size.test.ts`

- [x] T4: Promote CodeMirror packages to real (optional) peerDependencies and add the two new ones — done
  when: in `packages/khronoton-core/package.json`, `@uiw/react-codemirror`, `@codemirror/state`,
  `@codemirror/view` are REMOVED from `devDependencies` and ADDED to both `peerDependencies` (using their
  current devDependency version ranges verbatim: `@uiw/react-codemirror": "^4.23.10"`, `@codemirror/state":
  "^6.5.2"`, `@codemirror/view": "^6.36.4"`) and `peerDependenciesMeta` (each `{ "optional": true }`, matching
  the existing `react`/`react-dom` entries); two NEW packages, `@codemirror/language` (use `^6.12.4`) and
  `@lezer/highlight` (use `^1.2.3` — the same version OuronetUI itself already depends on), are added
  the same way: in `peerDependencies` + `peerDependenciesMeta` (optional) AND in `devDependencies` (so the
  package's own tests/build can resolve them — this mirrors how `@codemirror/state`/`@codemirror/view` already
  sit in `devDependencies` today even after also being peers). In `packages/khronoton-core/tsup.config.ts`, the
  `external` array gains `/^@codemirror/` already covers `@codemirror/language`, but explicitly verify `/^@lezer/`
  is present too (add it if not — `@lezer/highlight` must not be bundled). Done when: `npm install` run from
  the repo root completes without error and `require.resolve` (or a plain `import` in a throwaway
  `node -e` check) confirms `@codemirror/language` and `@lezer/highlight` resolve from
  `packages/khronoton-core/node_modules` or the workspace root `node_modules`.
  - files: `packages/khronoton-core/package.json`, `packages/khronoton-core/tsup.config.ts`, `package-lock.json`

- [x] T6: Add an optional `subBar` slot to the Pact editor panel — done when: `PactCodeEditorProps` in
  `packages/khronoton-core/src/ui/PactCodeEditor.tsx` gains `subBar?: ReactNode` (doc comment: "Optional
  content rendered as a full-width strip between the header and the editor body, e.g. a tx-size/gas meter.").
  In the component's JSX, between the existing `headerStyle` div and the `{ height }`-styled editor wrapper
  div, render `{subBar ? <div style={subBarWrapStyle}>{subBar}</div> : null}` where `subBarWrapStyle:
  CSSProperties = { padding: "0 12px 10px", borderBottom: "1px solid var(--khr-border)" }` (a new const
  alongside the file's existing `panelStyle`/`headerStyle`/etc.). No other behavior changes; `subBar` absent
  (undefined) renders nothing extra, matching every existing call site untouched.
  Tests added to `packages/khronoton-core/src/ui/PactCodeEditor.test.tsx` (extend the existing `renderEditor`
  helper's props pass-through, following the file's existing `forceFallback`-based pattern): (a) passing
  `subBar={<span>METER</span>}` renders that content; (b) omitting `subBar` renders no extra wrapper (assert
  `screen.queryByText("METER")` is null in a render without the prop).
  - files: `packages/khronoton-core/src/ui/PactCodeEditor.tsx`, `packages/khronoton-core/src/ui/PactCodeEditor.test.tsx`

- [x] T8: Hoist the Simulate call out of ExecuteTab so it can be shared with the Builder-level meter — done
  when: `packages/khronoton-core/src/ui/builder/ExecuteTab.tsx` no longer imports or calls `useSimulate` from
  `../../hooks/index.js`; instead `ExecuteTabProps` gains a required `sim: UseExecuteActionResult<[envelope:
  SimulateEnvelope], SimulateView>` field (import `UseExecuteActionResult` from `../../hooks/index.js`,
  `SimulateEnvelope`/`SimulateView` from `../../provider/index.js`), and the component destructures `sim` from
  its props instead of calling the hook. Every existing use of `sim.pending`/`sim.run`/`sim.result` inside the
  component body is otherwise UNCHANGED — this is a pure prop-in-instead-of-hook-call swap, no behavior change.
  Update `packages/khronoton-core/src/ui/builder/ExecuteTab.test.tsx`'s `mount()` helper: inside its `Harness`
  function component (already rendered under `<KhronotonProvider adapter={adapter}>`), add `const sim =
  useSimulate();` (import `useSimulate` from `../../hooks/index.js` in the test file) and pass `sim={sim}` into
  `<ExecuteTab>` alongside the existing props. No other test bodies change — every existing `it(...)` in this
  file must still pass unmodified, since `sim`'s wiring/behavior is identical, just sourced one level up.
  - files: `packages/khronoton-core/src/ui/builder/ExecuteTab.tsx`, `packages/khronoton-core/src/ui/builder/ExecuteTab.test.tsx`

## Wave 2 (depends on Wave 1)

- [x] T2: Create the Pact language + highlight extension — done when: `packages/khronoton-core/src/ui/pact-lang.ts`
  exports:
  - `pactLanguageSupport(): StreamLanguage<unknown>` (or a plain exported `pactLanguage` instance — implementer's
    call on the exact export shape, but it must be usable directly inside a CodeMirror `extensions` array) built
    via `StreamLanguage.define({...})` from `@codemirror/language` (installed by T4). The `token(stream, state)`
    function, in this exact precedence order (identifiers can never start with a digit/operator/comment/quote
    character, so this order has no ambiguity):
    1. `stream.eatSpace()` → return `null`.
    2. `stream.match(";;")` → `stream.skipToEnd(); return "lineComment"`.
    3. `stream.match(/^"(?:[^"\\]|\\.)*"?/)` → return `"string"` (handles `\"`/`\\` escapes; the trailing `"?`
       keeps an unterminated string from hanging the tokenizer at EOL).
    4. `stream.match(/^\d+(\.\d+)?/)` → return `"number"` (covers both Pact `Number` and `Decimal`).
    5. `stream.match(/^'[a-zA-Z_-][a-zA-Z0-9_-]*/)` → return `"atom"` (Pact `Symbol`, e.g. `'coin`).
    6. `stream.match(/^@[a-zA-Z_][a-zA-Z0-9_-]*/)` → return `"meta"` (Pact `MetaTag`, e.g. `@doc`, `@model`).
    7. `stream.match(/^(:=|::)/)` → return `"operator"`.
    8. `stream.match(/^[+\-*/=<>!]=?/)` → return `"operator"`.
    9. `stream.match(/^[()]/)` → return `"paren"`.
    10. `stream.match(/^[[\]]/)` → return `"squareBracket"`.
    11. `stream.match(/^[{}]/)` → return `"brace"`.
    12. `stream.match(/^[a-zA-Z_][a-zA-Z0-9_\-.%#+&$@<>=?*!|/]*/)` (the full Pact identifier char class) →
        capture the matched text as `word`, then: if `word` is one of `defun, defcap, defconst, defpact,
        defschema, deftable, module, interface, defproperty` → return `"definitionKeyword"`; else if `word` is
        one of `if, let, let*, lambda, cond, use, namespace, implements, bless, with-read, with-default-read,
        with-capability, bind, step, step-with-rollback, resume, yield, enforce, enforce-one, enforce-keyset,
        enforce-guard, require-capability, compose-capability, read, write, update, select, where, and, or,
        not, try, format, map, fold, filter, define-keyset, define-namespace` → return `"keyword"`; else if
        `word` is one of `integer, decimal, time, bool, string, list, value, keyset, guard, object, table` →
        return `"typeName"`; else if `word === "true" || word === "false"` → return `"bool"`; else return
        `"variableName"`. (This whole-token-then-classify order is deliberate — it is what correctly keeps
        `my-defun-helper` classified as `variableName`, never matching `defun` as a substring, since the match
        always consumes the FULL identifier before any keyword comparison happens.)
    13. Otherwise (e.g. a stray `:`/`,`) → `stream.next(); return null`.
    `languageData: { commentTokens: { line: ";;" }, closeBrackets: { brackets: ["(", "[", "{", '"'] } }`.
    `tokenTable` mapping every custom string above to a `@lezer/highlight` tag (import `tags as t` from
    `@lezer/highlight`, installed by T4): `{ definitionKeyword: t.definitionKeyword, keyword: t.keyword,
    typeName: t.typeName, bool: t.bool, string: t.string, number: t.number, lineComment: t.lineComment,
    variableName: t.variableName, atom: t.atom, operator: t.operator, meta: t.meta, paren: t.paren,
    squareBracket: t.squareBracket, brace: t.brace }`.
  - `pactHighlightExtension` — a `syntaxHighlighting(HighlightStyle.define([...]))` (both from
    `@codemirror/language`) mapping EXACTLY these tag → CSS var pairs (reading the T1 tokens):
    `t.keyword → "var(--khr-syntax-keyword, #c586c0)"`, `t.definitionKeyword → "var(--khr-accent, #f0a500)"`
    with `fontWeight: "bold"`, `t.typeName → "var(--khr-syntax-type, #4ec9b0)"`, `t.bool → "var(--khr-blue,
    #60a5fa)"`, `t.string → "var(--khr-syntax-string, #ce9178)"`, `t.number → "var(--khr-syntax-number,
    #b5cea8)"`, `t.lineComment → "var(--khr-text-dim2, #6b7280)"` with `fontStyle: "italic"`, `t.variableName →
    "var(--khr-mono, #d2d3d4)"`, `t.atom → "var(--khr-syntax-atom, #d7ba7d)"`, `t.operator → "var(--khr-text-dim,
    #8a8f98)"`, `t.paren → "var(--khr-text-dim, #8a8f98)"`, `t.squareBracket → "var(--khr-text-dim, #8a8f98)"`,
    `t.brace → "var(--khr-text-dim, #8a8f98)"`.
  Tests in `packages/khronoton-core/src/ui/pact-lang.test.ts` — pure, no DOM/jsdom needed: build a headless
  `EditorState.create({ doc, extensions: [pactLanguageSupport()] })` (from `@codemirror/state`, already a
  dependency) for each sample below, then walk `syntaxTree(state)` (from `@codemirror/language`) over the full
  doc range and assert the expected node name(s) appear covering the expected text range:
  - `"(defun foo () 1)"` → a `definitionKeyword`-tagged node covering `"defun"`.
  - `"(if true 1 2)"` → a `keyword`-tagged node covering `"if"`, and TWO separate `bool`-tagged nodes (`"true"`
    is one; note `1`/`2` are `number`).
  - `"(let ((my-defun-helper 1)) my-defun-helper)"` → NO `definitionKeyword`-tagged node anywhere in the tree
    (proves `defun`-as-substring is not misclassified) — both occurrences of `my-defun-helper` are
    `variableName`-tagged.
  - `";; a comment\n(x)"` → a `lineComment`-tagged node covering the full `";; a comment"` text (not including
    the newline).
  - `'"a \\"quoted\\" string"'` (a Pact string containing an escaped quote) → exactly one `string`-tagged node
    spanning the whole literal including its escapes.
  - `"@doc \"desc\""` → a `meta`-tagged node covering `"@doc"`.
  - `"(integer)"` → a `typeName`-tagged node covering `"integer"`.
  - `"'my-symbol"` → an `atom`-tagged node covering `"'my-symbol"`.
  Also assert `pactHighlightExtension` is a non-null CodeMirror `Extension` (e.g. `expect(pactHighlightExtension).
  toBeTruthy()` plus, if feasible, that combining `[pactLanguageSupport(), pactHighlightExtension]` into one
  `EditorState.create({ extensions: [...] })` does not throw).
  - files: `packages/khronoton-core/src/ui/pact-lang.ts`, `packages/khronoton-core/src/ui/pact-lang.test.ts`

- [x] T7: Create the Tx Size + Gas metering strip component — done when:
  `packages/khronoton-core/src/ui/builder/TxMeters.tsx` exports `TxMeters({ state, sim }: { state: BuilderState;
  sim: UseExecuteActionResult<[envelope: SimulateEnvelope], SimulateView> })`. Behavior:
  - Calls `estimateTxSize(state)` (from `../tx-size.js`, built in T3) inside a `useEffect` keyed on
    `[state.pactCode, state.config.chainId, state.config.gasLimit, state.config.gasPriceAnu, state.config.ttl,
    JSON.stringify(state.payload), state.signers.length, state.gasPayer]` (async — `estimateTxSize` returns a
    `Promise` — store the resolved value in `useState<TxSizeEstimate | null>(null)`, guard against a stale
    resolve after a newer effect run started with an `active` boolean flag, same pattern as `Builder.tsx`'s own
    `signers`-fetch `useEffect`). While `null` (first render, before the effect resolves), the Tx Size row shows
    a `"…"` value and an empty (0%-filled) bar rather than throwing or omitting the row.
  - Renders two rows using inline `style={{...}}` objects (this package uses no Tailwind/className styling
    anywhere — follow `ExecuteTab.tsx`'s/`Builder.tsx`'s existing `CSSProperties` const + `var(--khr-*)`
    convention, not `ConsoleMeters.tsx`'s Tailwind classes):
    - **Tx Size**: label "Tx Size"; a thin (`height: "6px"`) rounded (`borderRadius: "999px"`) bar with
      `backgroundColor: "var(--khr-inset)"` track and a fill `div` whose `width` is
      `` `${Math.min(estimate.fraction * 100, 100)}%` `` and whose `backgroundColor` is `"var(--khr-error)"`
      when `estimate.over`, else `"var(--khr-amber)"` when `estimate.bytes > PROXY_SOFT_LIMIT` (imported from
      `../tx-size.js`), else `"var(--khr-success)"`; a value string formatted as bytes (`< 1024` → `"${n} B"`,
      `< 1024*1024` → `"${(n/1024).toFixed(2)} KB"`, else `"${(n/1024/1024).toFixed(3)} MB"`) + `" · "` +
      `estimate.permille.toFixed(4)` + `" ‰"` (append `" ⚠"` when `estimate.over`), colored
      `var(--khr-error)`/`var(--khr-amber)`/`var(--khr-text-dim)` matching the bar-fill tier.
    - **Gas**: label "Gas"; `const used = sim.result?.gasUsed; const limit = state.config.gasLimit; const hasSim
      = typeof used === "number" && used > 0 && limit > 0;` — bar track `var(--khr-inset)`, and when `hasSim`,
      two stacked fill segments: `var(--khr-amber)` from 0 to `Math.min((used/limit)*100, 100)`%, and
      `var(--khr-error)` filling the remainder up to 100% (or the WHOLE bar `var(--khr-error)` when
      `used > limit`); value text `` `${used.toLocaleString()} / ${limit.toLocaleString()}` `` (or `"${used} >
      ${limit} ⚠"` when over-limit) when `hasSim`, else the literal string `"Run Simulate"` in
      `var(--khr-text-dim)` with an EMPTY (unfilled) bar.
  - Both rows render inside a single wrapping `<div>` styled to fit the `subBar` slot (e.g.
    `{ display: "flex", flexDirection: "column", gap: "4px" }`) — no `Card`/panel chrome of its own (the parent
    `PactCodeEditor`'s `subBarWrapStyle` from T6 already provides the border/padding).
  Tests in `packages/khronoton-core/src/ui/builder/TxMeters.test.tsx` (`@vitest-environment jsdom`, following
  `Builder.test.tsx`'s fake-adapter mount pattern): (a) renders "Run Simulate" for the Gas row when
  `sim.result` is undefined; (b) renders `"${used} / ${limit}"`-shaped text when `sim.result = { ok: true,
  gasUsed: 1500 }` and `state.config.gasLimit = 2000`; (c) after mount + `waitFor`, the Tx Size row's value text
  is no longer `"…"` (the async estimate resolved) and contains `" ‰"`; (d) an over-limit gas result
  (`gasUsed: 3000` vs `gasLimit: 2000`) renders the `"⚠"` marker.
  - files: `packages/khronoton-core/src/ui/builder/TxMeters.tsx`, `packages/khronoton-core/src/ui/builder/TxMeters.test.tsx`

## Wave 3 (depends on Wave 2)

- [x] T5: Wire the Pact language/highlight extension, fix selection contrast, and pin the editor's line-height
  into `packages/khronoton-core/src/ui/PactCodeMirror.tsx` — done when:
  - `khronotonEditorTheme`'s `".cm-content"` block gains `lineHeight: "1.4"` (alongside its existing
    `fontFamily`/`caretColor`).
  - The selection rule — currently `"&.cm-focused .cm-selectionBackground, .cm-selectionBackground,
    .cm-content ::selection"` mapping to `backgroundColor: "var(--khr-accent-tint, #1a1500)"` — has its
    `backgroundColor` changed to `"var(--khr-selection, #1e3a5f)"` (the token added in T1). No other rule in
    `khronotonEditorTheme` changes.
  - A new exported function `export function buildPactEditorExtensions() { return [pactLanguageSupport(),
    pactHighlightExtension]; }` (importing both from `./pact-lang.js`, built in T2) is added to this file, and
    `<CodeMirror ... extensions={buildPactEditorExtensions()} ...>` is added to the existing `<CodeMirror>`
    call in the default-exported component (it currently passes no `extensions` prop at all).
  Tests in a new `packages/khronoton-core/src/ui/PactCodeMirror.test.ts` (plain `.ts`, NOT `.tsx` — this test
  imports only the pure `buildPactEditorExtensions` export, never renders the React component, so it needs
  no DOM/jsdom environment, consistent with this file's own docblock explaining why the real CodeMirror view
  cannot be exercised under jsdom): `buildPactEditorExtensions()` returns an array with `length >= 2`, and
  constructing `EditorState.create({ doc: "(defun x () 1)", extensions: buildPactEditorExtensions() })` (from
  `@codemirror/state`) does not throw.
  - files: `packages/khronoton-core/src/ui/PactCodeMirror.tsx`, `packages/khronoton-core/src/ui/PactCodeMirror.test.ts`

- [x] T9: Rebuild the Builder layout as a full-width top/bottom stack and wire the meter + shared Simulate —
  done when, in `packages/khronoton-core/src/ui/builder/Builder.tsx`:
  - `PANE_WRAP` changes from the 2-column grid to `{ display: "flex", flexDirection: "column", gap: "1rem" }`.
  - `import { useSimulate } from "../../hooks/index.js";` is added, and `const sim = useSimulate();` is called
    once inside the `Builder` component (alongside the existing `signers`/`actions` hook calls, same level).
  - The JSX inside `{editReady ? (<div style={PANE_WRAP}> ... </div>) : ...}` is reordered so `<PactCodeEditor>`
    renders FIRST (full width, as a direct flex-column child), followed by the header+tabs+content `<div>`
    (also a direct flex-column child, no width styling needed — flex-column children default to full width).
    `<PactCodeEditor>` gains `height={126}` and `subBar={<TxMeters state={state} sim={sim} />}` (import
    `TxMeters` from `./TxMeters.js`, built in T7).
  - `<ExecuteTab ... sim={sim} />` — the existing `<ExecuteTab>` call site gains the `sim` prop (required per
    T8's updated `ExecuteTabProps`); every other prop on that call is unchanged.
  Tests added/updated in `packages/khronoton-core/src/ui/builder/Builder.test.tsx`:
  (a) a new test asserting the rendered DOM order places the "PACT Code Editor" header text before the
  `role="tablist"` element (`compareDocumentPosition` or a `container.textContent.indexOf` comparison — either
  is acceptable, pick whichever reads more clearly) — proves the top/bottom order, not left/right.
  (b) a new test asserting `PANE_WRAP`'s rendered wrapper computed/inline style has `flexDirection: "column"`
  (query the DOM node and check `style.flexDirection`, or assert the wrapper does NOT have `display: "grid"` —
  implementer's call on the exact assertion, as long as it fails against the OLD grid layout and passes
  against the new one).
  (c) a new test mounting `Builder` and asserting the Gas meter row (rendered via the new `subBar`) shows
  "Run Simulate" before any Simulate call, then — after clicking "Execute" tab, clicking "Simulate", and the
  fake adapter's `simulate` resolving with `{ ok: true, gasUsed: 900 }` — the SAME meter row (still visible,
  the Config/Payload/etc. tabs never unmount it since it now lives above the tab bar) updates to show
  `"900 / <configured gas limit>"`, proving `sim` is genuinely shared between `ExecuteTab` and the top meter
  (one `adapter.simulate` call, not two independent `useSimulate()` instances).
  Every PRE-EXISTING test in this file must still pass with only the interaction paths adjusted for the new
  DOM order if (and only if) an existing selector was position-dependent — check each existing test after the
  change; most use `getByRole`/`getByLabelText`/`getByPlaceholderText`, which are order-independent and need
  no edits.
  - files: `packages/khronoton-core/src/ui/builder/Builder.tsx`, `packages/khronoton-core/src/ui/builder/Builder.test.tsx`
