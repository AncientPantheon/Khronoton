# Khronoton step-to-step yield carry — Design

## Problem

A chained cronoton's steps (0.13.0) can only get the inputs they need in two
ways: a fixed value baked into the step's stored `payload_json`/
`planner_params_json` at creation time, or a live re-probe of chain state at
the step's own fire time (the pattern `ouronet.stoa-wrap` and
`ouronet.aqp-evict` already use). Neither works for a drain → wrap → inject
pipeline where each step needs the EXACT amount the previous step moved —
not whatever a target account happens to hold live, since a wrap/inject
target account can independently hold its own pre-existing balance
unrelated to this run. There is currently no way for one step to hand a
specific computed value to the next; `docs/work/khronoton-chained-runs/
design.md` explicitly scoped this out as "no mechanism for that yet."
Concretely, this blocks `ouronet.aqp-inject`'s `amount` (a required static
param today) from ever reflecting what a prior `ouronet.stoa-wrap` step
actually wrapped, and blocks a custom "drain the stoicism miner" step from
communicating its `(get-balance)`-derived amount forward at all.

## Approach

**A generic, flat, named-yield pool per run, written by any step and read
by any later step via a structured placeholder — resolved transparently
before the step executes, so no planner (built-in or custom) needs any
yield-specific code.**

- **Storage.** New table `codex_cronoton_run_yields(run_id, name,
  value_json, step_index, created_at)`, unique on `(run_id, name)` — a flat
  namespace scoped to one run, not indexed by step. A write to an existing
  name overwrites (`INSERT ... ON CONFLICT DO UPDATE`), so a replanned
  step's freshest computed value is always what's visible to anything
  downstream; no separate invalidation logic is needed because nothing
  downstream of an unconfirmed step is ever invoked yet (the existing
  barrier-before-advance invariant already guarantees step N+1 never runs
  before step N confirms).

- **Producing a yield.**
  - `mode: 'planner'` step: widen `StepPlanner`'s return type from
    `Promise<PlannedLeg[]>` to `Promise<PlannedLeg[] | { legs: PlannedLeg[];
    yield?: { name: string; value: unknown } }>`. The bare-array return
    stays valid forever — none of the 5 existing built-ins are forced to
    change. Written to the pool at `replan-step` time (the only point a
    planner's JS code actually runs); a planner that wants to yield a live
    probe result (e.g. a `coin.get-balance` read, exactly like
    `stoa-wrap`'s own pattern) just returns it alongside its legs instead
    of only using it to build the leg's payload.
  - `mode: 'single'` step: new nullable `yield_as TEXT` column on
    `codex_cronoton_steps`. When set, the moment that step's one leg
    CONFIRMS, Khronoton captures the real on-chain return value
    (`ListenResult.result.data` — already flowing through
    `runs-driver.ts`'s `pollRequestKeys` confirm loop today, currently
    discarded after flipping leg status) and stores it under that name.
    This is the only way a plain hand-written Pact call (e.g. a custom
    drain transaction whose last expression returns the amount it just
    moved) can contribute a yield, since no JS-side planner runs for it.

- **Consuming a yield.** A step references a prior yield by writing a
  structured placeholder — `{"$yield": "<name>"}` — anywhere a literal
  value would normally go inside its stored `payload_json`
  (`mode:'single'`) or `planner_params_json` (`mode:'planner'`). Right
  before that step executes, a new pure helper
  (`server/pure/yields.ts`'s `resolveYieldRefs(value, pool)`) recursively
  walks the parsed JSON and substitutes every `$yield` reference against
  the run's pool, THEN the existing code path continues unchanged:
  - single-mode: resolution runs on the parsed `payload_json` before
    `stepRowToDefinition` builds the leg.
  - planner-mode: resolution runs on the parsed `planner_params_json`,
    producing a shallow-cloned step row with that field replaced by the
    resolved JSON string, which is what actually gets passed to the
    planner. `ouronet.aqp-inject` keeps calling
    `parseJson(step.planner_params_json, {})` exactly as it does today and
    simply receives an already-resolved decimal string for `amount` — zero
    changes needed to `inject.ts`, `stoa-wrap.ts`, or any other planner,
    built-in or Hub-custom.
  - A placeholder naming a yield that doesn't exist yet (typo, wrong step
    order, referenced before it was ever produced) throws a clear, named
    error (`YieldNotFoundError`) rather than silently resolving to
    `null`/`undefined` — matching this package's existing "never silently
    guess" posture (`isSaneCeiling`, the refuse-unmineable checks, etc.).

- **Scope for this pass:** one named yield per step, not a bag of several.
  Matches the stated need exactly (each step in the drain→wrap→inject→evict
  chain only ever needs to pass along one amount) and is a trivial,
  backward-compatible widen later (`yield` → `yields: Record<string,
  unknown>`) if a real multi-value case ever shows up — not worth the
  extra surface now.

**Alternatives considered and rejected:**

- **Implicit payload capture** (auto-expose the whole previous step's
  stored payload to the next step, no declaration needed). Rejected:
  undeclared, fragile — a reader of either step has to go read the other
  step's planner source to know what fields exist; exactly the kind of
  implicit cross-file coupling this codebase's own review history has
  repeatedly flagged as a drift trap (e.g. the `isUniqueConstraintError`
  and `resolvePlannerFor` duplication findings).
- **Native Pact `defpact` yield/resume** (model the whole chain as one
  on-chain multi-step pact, let Pact itself carry the value between
  continuations). Rejected: the miner/wrap/inject contracts are already
  deployed as independent entrypoints, not steps of one shared defpact;
  adopting this would mean rewriting those on-chain contracts, a
  different and much larger project outside this package's own layer
  (Khronoton orchestrates calls into existing contracts — it doesn't own
  or rewrite them).

## Acceptance criteria

- [ ] A `mode:'planner'` step's planner can return `{ legs, yield: { name,
      value } }` and that value becomes readable by a later step via
      `{"$yield": "<name>"}` in that step's own stored params/payload —
      proven end-to-end with a real `driveRunOnce` test, not a unit test
      of the resolver alone.
- [ ] A `mode:'single'` step with `yield_as` set captures the confirmed
      leg's real on-chain return value under that name, readable the same
      way by a later step.
- [ ] None of the 5 existing built-in planners (`evict`, `inject`,
      `unstall`, `stoa-wrap`, `stoa-unwrap`) require source changes for
      yield CONSUMPTION to work — resolution happens before they are ever
      invoked.
- [ ] A step referencing a yield name that was never produced (by the time
      it runs) fails the run with a clear, named error — never silently
      proceeds with a missing/null value.
- [ ] A replanned step's second (or later) attempt overwrites the pool
      entry with its freshest computed value; nothing downstream can ever
      observe a stale value from an earlier, superseded attempt.
- [ ] Every existing chained-run test (all 0.13.0 behavior — no `$yield`
      references anywhere in a step's stored JSON) passes unchanged: a
      step with no placeholders behaves byte-identically to before this
      feature existed.
- [ ] The concrete drain → wrap → inject → evict chain can be built and
      driven end-to-end (via the existing `driveRunOnce`/`executeNow`
      paths, no new HTTP surface required) with wrap's amount and inject's
      amount both genuinely carried from the preceding step, not
      independently re-probed or statically pre-set.

## Out of scope

- A yields "bag" (multiple named values from one step) — ship with exactly
  one yield per step; revisit only if a real need appears.
- Path/field extraction from a nested on-chain return value (e.g.
  `{"$yield": "drainResult.amount"}`) — this pass captures the WHOLE
  on-chain return value verbatim under the declared name; if a contract's
  return value is itself a nested object and only a sub-field is needed,
  that's a future, backward-compatible extension to the placeholder syntax.
- Any change to `fan-out` planners (`ouronet.aqp-evict`,
  `ouronet.aqp-unstall`) to produce or consume yields — neither is part of
  the motivating chain and both are already self-correcting via their own
  live on-chain plan reads; adding yield support to a multi-leg fan-out
  step raises its own design questions (which leg's result is "the"
  yield?) deliberately deferred rather than guessed at here.
- A new built-in "generic drain" planner — the Hub will register its own
  custom planner (or a `mode:'single'` step with `yield_as`) for the
  stoicism miner's specific collect/claim entrypoint, reusing the already-
  public `registerStepPlanner`/`executeCodexTransaction` extension point;
  Khronoton doesn't know that contract's shape and shouldn't guess at it.
- Any new public HTTP route for step creation/editing — still none exists
  after this change (tracked as a pre-existing gap from the 0.13.0 handoff,
  not fixed here); the Hub still creates steps via direct `insertStep()`
  calls.
- Validating `$yield` references at step-CREATION time (e.g. refusing to
  save a step that references a yield no earlier step in the chain could
  ever produce). This pass only validates at RESOLUTION time (when the
  step actually runs) — build-time validation is a nice-to-have, not
  required to unblock the test run, and deferred as a possible follow-up.
