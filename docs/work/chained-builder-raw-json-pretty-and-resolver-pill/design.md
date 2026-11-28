# Raw JSON pane pretty-print + a visible resolver pill — Design

Handoff: `Z:\StoaChain\_hub\AncientHoldings\docs\work\chained-cronoton-edit\khronoton-agent-handoff-server-resolver.md`
§5b. Two small, purely-cosmetic follow-ups found after 0.22.0 shipped and the hub wired it up.

## 1. Pretty-print the Raw JSON pane (bug fix — a self-introduced regression)

**Root cause, confirmed by reading:** `codeText`'s original (0.19.1-era) implementation called
`JSON.stringify(value, null, 2)` directly. During 0.21.0's edit-mode work, that call was factored
into a shared `safeStringifyOrNull(value)` helper (reused by the new dirty-check comparison values,
`baselineDocJson`/`commitBodyJson`) — and the `null, 2` pretty-print arguments were dropped in the
process, silently regressing the Raw JSON pane back to one unreadable line. This went unnoticed
through two full nectar review cycles (0.21.0 and 0.22.0) because every test asserting on the Raw
JSON pane's content used a substring/regex match (`screen.getByText(/"serverResolver":.../)`) —
and `@testing-library`'s default text matching NORMALIZES whitespace (collapses all whitespace,
including newlines, to single spaces) before comparing, so a regex check like this passes
IDENTICALLY whether the underlying text is pretty-printed or crammed onto one line. The hub's own
live usage (an operator unable to see `serverResolver` because it scrolled off the right edge of a
single long line) is what actually surfaced this — not this package's own test suite.

**Fix:** `safeStringifyOrNull` gains an optional `pretty` parameter (default `false`, so the
dirty-check comparison values stay exactly as compact as before — no behavior change there, and
critically, BOTH sides of that comparison (`baselineDocJson`/`commitBodyJson`) must keep using the
IDENTICAL format, since the dirty check is a plain string-equality test; pretty-printing only one
side would make every comparison show "dirty" even when nothing changed). `codeText`'s own call
site passes `pretty: true`, restoring the original `JSON.stringify(value, null, 2)` behavior.

**Verification approach, fixed to actually catch a regression this time:** reading `.textContent`
directly off the `<pre>` element (now `data-testid="chained-builder-raw-json-pre"`) and asserting
it literally CONTAINS a real newline character — bypassing `getByText`'s whitespace normalization,
which is exactly what let the regression through undetected the first time.

## 2. A visible resolver pill outside the Fields tab (additive, optional per the handoff, built anyway — cheap and clearly useful)

Today `state.serverResolver` is only visible on the Fields tab's "Whole cronoton" sub-tab. An
operator viewing the Pact-code pane (or Raw JSON pane) has no visible signal the cronoton is
resolver-bound at all. Added a small pill (`⟳ <resolver>`) in the ALWAYS-VISIBLE title row (not
inside any pane — the title row renders regardless of which panes are toggled on/off), so it's
visible no matter which pane is active. Purely additive, read-only (the editable select stays on
Fields, unchanged) — renders nothing when `state.serverResolver` is unset, matching every other
"purely additive" convention in this component.

## Acceptance criteria

1. ✅ The Raw JSON pane's rendered text contains real newlines (multi-line, 2-space-indented) —
   verified via raw `.textContent`, not a whitespace-normalizing text matcher.
2. ✅ The dirty-check's own comparison (`isDirty`) is unaffected — both sides still use the
   identical (compact) format, confirmed by a test that an untouched load stays non-dirty.
3. ✅ A pill showing the resolver renders in the always-visible title row when `state.serverResolver`
   is set, regardless of which pane(s) are currently shown; renders nothing when unset.
4. ✅ Full suite green, `tsc`/build clean.

Reviewed via nectar (correctness lens only — a single focused pass, proportionate to this change's
small, well-contained size rather than a full 3-lens dispatch). No findings: directly verified (not
assumed from the diff) that both dirty-check comparison values still use the identical compact
format; that `pretty` only changes whitespace, never the underlying serialized value/key order;
that the pill's JSX is structurally outside every pane's conditional rendering (a sibling of the
whole `renderedPanes`-driven block, not nested inside it); that the pill and the Fields-tab select
read the exact same `state.serverResolver` scalar (no divergent derived value); and that
`JSON.stringify(x, null, 2)`'s indent argument doesn't change its recursion depth relative to the
bare call, so the existing 0.19.1-era deep-nesting stack-overflow guard is unweakened.
