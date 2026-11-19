# Khronoton chained runs — Phase 0 + Phase 1 — Review

Scope: `packages/khronoton-core/src/server/types.ts`, `seams.ts`,
`store/errors.ts`, `schema.ts`+test, `executor.ts`+test,
`blockchain/stoachain.ts`+test, `server/index.ts`, `store/steps.ts`+test,
`store/runs.ts`+test, `store/index.ts`. 15 files → full 5-lens tier:
correctness, conventions, security, tests, performance.

Design: `design.md`. Plan: `plan.md` (10 tasks, 3 waves, all built via
`nectar:implementer` agents, TDD throughout).

**6 rounds, 5 lenses each (30 lens dispatches), adversarial validation on
every finding that wasn't trivially mechanical. 8 CONFIRMED findings fixed.
Several more findings were correctly declined as pre-existing, untouched
code outside this diff's actual scope — verified via `git diff` each time,
not assumed.** Zero REFUTED (every genuine finding held up), zero STYLISTIC.

## Round 1 (2 CONFIRMED)

### [CRITICAL→MEDIUM on validation] `markLegConfirmed`/`markLegFailed` had no status guard
- **Where:** `store/runs.ts`
- **Why:** `markLegSubmitted` conditionally updates `WHERE status = 'pending'` and throws a typed error on a miss; the two terminal-transition functions had no equivalent `WHERE status = 'submitted'` guard — either could be called on a never-submitted leg, or silently overwrite an already-terminal leg (e.g. flip a confirmed leg back to failed, inviting an unsafe re-submit of a leg that already landed).
- **Validated down from CRITICAL to MEDIUM**: no live caller exists yet (Phase 2's `advanceRun`, the first real caller, is explicitly out of scope for this topic) — a real, confirmed gap, but currently latent rather than an active main-path defect.
- **Fixed:** both functions gained the `WHERE status = 'submitted'` guard + a new `LegNotSubmittedError`, plus three negative-case tests (pending leg, already-confirmed leg, already-failed leg).

### [HIGH, confirmed on independent empirical check] `submit` mode's ambiguous-submit-catch
- **Where:** `executor.ts`'s shared `submitTransaction` helper
- **Why:** the REQ-23 504-recovery catch treats ANY throw from `client.submit` as "ambiguous, assume it may have landed" whenever a request key can be derived — which is unconditional, since that key is just the signed command's hash. For `fire` mode this is safe because `listen` afterward eventually sorts ambiguous from genuine; `submit` mode never listens.
- **Validated:** downgraded to MEDIUM. This is pre-existing `fire`-mode logic (REQ-23, predates this phase), not new; the design's own later-phase mechanisms (deadline + re-plan reading live chain state, §5.5/§5.7) bound the consequence to a failed run requiring operator resume, not an indefinite stall; narrowing the catch isn't achievable without inventing speculative error classification the generic `ChainClient.submit` contract doesn't support.
- **Fixed:** documentation only, as recommended — `SubmitResult`'s doc comment in `types.ts` now explicitly states `ok: true` is not proof of on-chain landing, names the mechanism that makes a false-positive safe, and warns against re-submitting as the (unsafe) workaround.

A third round-1 finding (gas-ceiling resolved live per call, not cached per chain per tick) was validated down to LOW — pre-existing in `runFire` since 0.11.0, inherited by `submit`, with an already-available mitigation (`config.autoGasCeiling` override) requiring no code change.

## Round 2 (3 CONFIRMED)

### [HIGH] `LegNotSubmittedError` defined but never barrel-exported
Round 1's own fix added the error to `errors.ts` but `store/index.ts`'s
export list predated it — my own oversight, caught by the next round.
**Fixed:** added to the barrel.

### [MEDIUM] `insertStep` leaked a raw `SqliteError` on a duplicate step index, unlike `createRun`'s typed-error pattern in the same phase
**Fixed:** added `StepAlreadyExistsError` + the same try/catch-by-code pattern `createRun` already used; test updated to assert on the typed class instead of a raw message regex.

### [MEDIUM] Unsanitized `chainId` interpolated into the Pact URL
**Validated down to LOW**: pre-existing pattern (`runSimulate`/`runFire` predate this phase), and `chainId` is admin-operator-controlled on every current and designed path (confirm-gated commit, or future trusted-planner code) — never attacker-controlled. **Fixed as hardening anyway:** `encodeURIComponent` on the one caller-supplied URL segment in the `nodeBaseUrl`-configured branch.

A fourth round-2 finding (the "two-racing-callers" test not actually
exercising concurrency, since `createRun` has no pre-fetched-state parameter
for interleaving to land in, unlike `claim.test.ts`'s real race proof) was
confirmed and fixed by relabeling/re-documenting the test honestly rather
than deleting it.

## Round 3 (1 CONFIRMED)

### [MEDIUM] `insertRunLeg` had the identical raw-error-leak gap `insertStep` had just been fixed for
Same pattern, third occurrence (`createRun` → `insertStep` → `insertRunLeg`).
**Fixed:** `RunLegAlreadyExistsError` + the same guard, barrel-wired, tested.

Two other round-3 findings (seams.ts single-quote style on
`ResolveFireMode`, sequential signer-keypair resolution in `executor.ts`)
were declined — confirmed via `git diff` to be completely untouched,
pre-existing code outside this diff's actual changes.

## Round 4 (1 CONFIRMED)

### [MEDIUM] Stale "three tables" doc comments in `schema.ts`/`schema.test.ts` after this diff brought the total to six
**Fixed:** updated both doc comments to "six tables," cross-checked against `types.ts`'s own identical-sounding comment (confirmed accurate in its own, narrower scope — not the same drift).

## Round 5 (1 CONFIRMED)

### [LOW] Error-message-formatting logic duplicated verbatim between the `submit` and `fire` catch branches
Directly contradicts the phase's own stated principle (`submitTransaction`
itself was extracted specifically to avoid this). **Fixed:** extracted a
shared `describeThrown(e, fallbackLabel)` helper.

The gas-ceiling-per-call and sequential-signer-resolution observations
recurred (independently rediscovered by fresh lens instances with no memory
of prior rounds) and were declined again on the same `git diff`-confirmed
pre-existing-code grounds — not re-validated a second time, since nothing
about them had changed.

## Round 6 — the clean pass

Full scope, all 5 lenses, zero CONFIRMED findings. The gas-ceiling/signer-
resolution items were checked once more (via `git diff`) and correctly not
re-raised a fourth time.

## Behavioral verification

Exercised end-to-end against the real **built** `dist/` artifact (not just
unit tests): installed the six-table schema, committed a base cronoton,
inserted two static step definitions (`single` + `planner` mode) and
confirmed ordering, created a run and proved the self-block (`createRun`
throws `RunAlreadyInFlightError` on a second attempt while the first is
non-terminal), inserted a leg and walked it `pending → submitted →
confirmed`, then called `executeCodexTransaction(def, "submit", ctx)`
against a mock chain runtime and confirmed the single most important
property directly: **`listen` was never called.**

## Final state

- `npm test --workspace=@ancientpantheon/khronoton-core`: **1059 passed
  (1059)**, 78 test files.
- `npm run typecheck`: clean.
- `npm run build`: clean.
- Every acceptance criterion in `design.md` is satisfied.

Clean pass achieved after round 6. Phases 2–6 remain as listed topics in
`design.md`, not started.
