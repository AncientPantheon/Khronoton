## Combined plan — two topics, one pass

Covers both approved designs, executed together per the user's request for a single
pass: `docs/work/khronoton-editor-save/design.md` (discoverable edit-mode Save — tasks
prefixed T1) and `docs/work/khronoton-auto-gas/design.md` (auto self-calibrating gas as
default — tasks prefixed T2). The two topics touch disjoint production files, but T1's
`ExecuteTab.tsx`/`Builder.tsx` tasks and T2's `builder-state.ts` default flip share a
dependency (T1's tests must account for T2's new AUTO-gas default), noted per-task below.

## Wave 1

- [x] T1a: `useCommitGate(state, sim)` hook — done when: new file
      `src/ui/builder/use-commit-gate.ts` exports
      `useCommitGate(state: BuilderState, sim: UseExecuteActionResult<[envelope: SimulateEnvelope], SimulateView>): { commit: CommitBody; gate: { ok: boolean; reasons: string[] }; simulateCalibrated: boolean }`,
      containing EXACTLY the logic currently inline in `ExecuteTab.tsx` (lines ~240-251):
      ```ts
      const commit = useMemo(() => builderToCommit(state), [state]);
      const simulateCalibrated = Boolean(
        sim.result?.ok && typeof sim.result.calibratedGasLimit === "number",
      );
      const gate = useMemo(
        () => canCommit(state, { simulateCalibrated }),
        [state, simulateCalibrated],
      );
      return { commit, gate, simulateCalibrated };
      ```
      moved verbatim (byte-identical formula, just relocated + wrapped in a hook
      function), importing `builderToCommit`/`canCommit`/`type BuilderState` from
      `../builder-state.js` and `useMemo` from `react`. New test file
      `src/ui/builder/use-commit-gate.test.ts` (no jsdom needed — a plain hook test via
      `@testing-library/react`'s `renderHook`, `// @vitest-environment jsdom` at top since
      `renderHook` needs a DOM): tests (a) `commit` equals `builderToCommit(state)` for a
      representative state, (b) `gate.ok === false` with the AUTO-gas reason for a fresh
      `autoGasLimit:true` state with no sim result, (c) `gate.ok` becomes `true` once
      `sim.result = { ok: true, calibratedGasLimit: 42 }` is passed (construct the `sim`
      arg as a plain object literal matching `UseExecuteActionResult`'s shape — `{ run:
      vi.fn(), pending: false, error: null, result }` — mirroring `ExecuteTab.test.tsx`'s
      own `makeSim` helper, do not mount a real provider), (d) `commit`/`gate` are the
      SAME object reference across a re-render when only an unrelated prop changes and
      `state`/`simulateCalibrated` don't (proves the `useMemo` wiring survived the move —
      use `renderHook`'s `rerender` with an unchanged `state` reference).
      `npx vitest run src/ui/builder/use-commit-gate.test.ts` passes.
  - files: `packages/khronoton-core/src/ui/builder/use-commit-gate.ts` (new), `packages/khronoton-core/src/ui/builder/use-commit-gate.test.ts` (new)

- [x] T2-seam-adapter: `ChainClient.preflightRead` + `ChainClient.getBlockGasLimit` — done
      when:
      - `src/server/seams.ts`'s `ChainClient` interface (~line 96-100) gains two new
        OPTIONAL methods:
        ```ts
        export interface ChainClient {
          dirtyRead(tx: unknown): Promise<DirtyReadResult>;
          /**
           * `local` with `{ preflight: true, signatureVerification: false }` — measures
           * the TRUE gas a transaction will consume, including the transaction-size
           * charge that a plain `dirtyRead` (execution gas only) omits. Optional so the
           * package stays non-breaking for any custom `ChainClient`; the executor HARD
           * THROWS when it's absent on an AUTO-gas fire — a silent fallback to the
           * inaccurate `dirtyRead` measurement would ship the exact over-reservation bug
           * this capability exists to fix (mirrors `ChainRuntime.gasMeta`'s precedent).
           * A MANUAL-gas fire never needs this and is unaffected by its absence.
           */
          preflightRead?(tx: unknown): Promise<DirtyReadResult>;
          /**
           * The live block gas limit, read from the node. Optional and BEST-EFFORT —
           * unlike `preflightRead`, a stale/failed read here only degrades the
           * simulate-at-ceiling sizing and the refuse-unmineable threshold, since the
           * real chainweb node is still the authoritative validator of what actually
           * fits; the executor falls back to `Config.autoGasCeiling`/`AUTO_GAS_CEILING`
           * on any failure or absence, matching OuronetUI's own documented choice here.
           */
          getBlockGasLimit?(): Promise<number>;
          submit(tx: unknown): Promise<{ requestKey: string }>;
          listen(desc: unknown): Promise<ListenResult>;
        }
        ```
      - `src/blockchain/stoachain.ts`'s `createStoachainRuntime` factory: the object its
        `createClient` currently returns is the SDK's client BY IDENTITY
        (`createClient: client.createClient as ChainRuntime["createClient"]`) — replace
        this with a THIN WRAPPER that returns the real SDK client's methods plus the two
        new ones, so the real `dirtyRead`/`submit`/`listen` stay byte-identical pass-
        throughs:
        ```ts
        createClient: ((url: string) => {
          const real = client.createClient(url);
          return {
            ...real,
            preflightRead: (tx: unknown) =>
              real.local(tx as never, { preflight: true, signatureVerification: false }),
            getBlockGasLimit: async () => {
              try {
                const origin = url.replace(/\/chainweb\/.*$/, "");
                const res = await fetch(`${origin}/config`, {
                  headers: { accept: "application/json" },
                });
                if (!res.ok) return AUTO_GAS_CEILING_FALLBACK;
                const found = findBlockGasLimit(await res.json());
                return found ?? AUTO_GAS_CEILING_FALLBACK;
              } catch {
                return AUTO_GAS_CEILING_FALLBACK;
              }
            },
          };
        }) as ChainRuntime["createClient"],
        ```
        with a local `findBlockGasLimit` helper (walk a JSON object, depth-capped at 8,
        for the first numeric value whose key matches `/block.?gas.?limit|gas.?limit.?of.?block/i`
        and whose value is in `[50_000, 50_000_000]` — mirrors OuronetUI's
        `gas-limits.ts:findBlockGasLimit` exactly, ported as a private function, NOT
        imported from OuronetUI) and a local constant
        `const AUTO_GAS_CEILING_FALLBACK = 2_000_000;` (matches `seams.ts`'s
        `AUTO_GAS_CEILING` value — do not import across the `server`/`blockchain`
        boundary for this constant; a duplicated literal with a comment cross-referencing
        `AUTO_GAS_CEILING` is correct here, matching how `blockchain/stoachain.ts` already
        stays free of importing `server/*` internals it doesn't need).
      - `src/blockchain/stoachain.test.ts`: extend the existing `mockCreateClient` fixture
        (currently `vi.fn((url: string) => ({ dirtyRead: async () => ..., submit: async
        () => ..., listen: async () => ..., url }))`) — since the real implementation now
        WRAPS the SDK client rather than returning it by identity, add a new describe
        block `"createStoachainRuntime — createClient wrapper (preflightRead +
        getBlockGasLimit)"` with tests: (a) `rt.createClient(url).preflightRead(tx)` calls
        the mocked client's `local` with `(tx, { preflight: true, signatureVerification:
        false })` — extend `mockCreateClient`'s returned object with a `local: vi.fn(async
        () => ({ result: { status: "success" }, gas: 900 }))` and assert the wrapper's
        `preflightRead` result equals `local`'s resolved value AND that `local` was called
        with those exact two args; (b) `getBlockGasLimit()` against a mocked
        `global.fetch` (`vi.stubGlobal("fetch", vi.fn(...))`) returning
        `{ ok: true, json: async () => ({ nested: { blockGasLimit: 1_600_000 } }) }`
        resolves to `1_600_000` (proves the nested-object-walk); (c) `getBlockGasLimit()`
        when `fetch` rejects (network error) resolves to `2_000_000` (the fallback),
        never rejects/throws; (d) `getBlockGasLimit()` when `fetch` resolves `{ok:false}`
        (a non-2xx) also falls back to `2_000_000`; (e) the wrapper's `dirtyRead`/`submit`/
        `listen` still delegate to the real mocked client's own methods BY IDENTITY
        (unchanged pass-through, regression-pinning that the wrap didn't break the
        existing behavior) — reuse the file's existing `mockCreateClient`-returned
        `dirtyRead`/`submit`/`listen` spies and assert the wrapper's client's own
        `dirtyRead`/`submit`/`listen` === those exact same spy functions (`toBe`, not
        `toEqual`).
        Restore `vi.unstubAllGlobals()` in an `afterEach` if `vi.stubGlobal` is used (check
        whether the file already has an `afterEach`; add one scoped to this new describe
        block if not, matching the file's existing `beforeEach`-per-describe-block idiom).
      - `npx vitest run src/blockchain/stoachain.test.ts` from `packages/khronoton-core`
        passes, all tests green (existing + new).
  - files: `packages/khronoton-core/src/server/seams.ts`, `packages/khronoton-core/src/blockchain/stoachain.ts`, `packages/khronoton-core/src/blockchain/stoachain.test.ts`

- [x] T2-builder-state: default `autoGasLimit` to `true` — done when (self-contained to
      this file pair; do NOT touch `ExecuteTab.test.tsx`/`Builder.test.tsx` in this task —
      their fallout from this default flip is handled by T1b/T1d in Wave 2, which already
      touch those files):
      - `src/ui/builder-state.ts`'s `makeEmptyBuilderState()` (~line 130-161): change
        `config.autoGasLimit: false` to `config.autoGasLimit: true`, with a comment
        explaining AUTO is now the default per the auto-gas handoff (over-reservation was
        the prior default's failure mode) and manual stays available as a deliberate
        toggle.
      - `src/ui/builder-state.test.ts` updates (all in this one file):
        1. The `"seeds the exact builder-spec defaults..."` test (~line 74-101):
           `autoGasLimit: false` → `autoGasLimit: true` in the expected `config` object.
        2. `committableState()` (~line 21-26, the shared "fully configured, ready to
           commit" test helper used ~18 times in this file): add
           `s.config = { ...s.config, autoGasLimit: false };` before `return s;` — this
           helper's CONTRACT is "committable out of the box," which now requires an
           explicit manual override since AUTO needs a Simulate first; every one of its
           18 call sites keeps working unchanged since the helper itself absorbs the
           fix.
        3. `"accepts a zero buffer"` (~line 322-324, `expect(validateConfig
           (makeEmptyBuilderState())).toEqual([])`): this now fails because the fresh
           default is AUTO-gas-gated. Change to construct an explicitly-manual state:
           `const s = makeEmptyBuilderState(); s.config.autoGasLimit = false; expect
           (validateConfig(s)).toEqual([]);` — keeps the test's actual intent (buffer=0 is
           valid) isolated from the unrelated AUTO-gas gate.
        4. `"passes the default manual config"` (~line 373-375) — this test's name and
           premise are now WRONG (the default is no longer manual). Replace with TWO
           tests: `"the default AUTO-gas config requires a Simulate before it validates
           clean"` (`expect(validateConfig(makeEmptyBuilderState())).toContain("AUTO gas
           requires a successful Simulate to calibrate, or switch to manual.")`) and
           `"a manual override still validates clean with no Simulate needed"` (`const s =
           makeEmptyBuilderState(); s.config.autoGasLimit = false; expect(validateConfig
           (s)).toEqual([]);`).
        5. `canCommit`'s `"blocks the fresh default with name → gas-payer → signer reasons
           in order"` test (~line 468-476): the expected `res.reasons` array now has FOUR
           entries, not three — the AUTO-gas reason is inserted between the name reason
           and the gas-payer reason (config-validation order, per the file's own "folds
           reasons in the fixed order name → config → gasPayer → payload → signers"
           documented precedence, pinned by the very next test in this file). New expected
           array:
           ```ts
           expect(res.reasons).toEqual([
             "Name is required.",
             "AUTO gas requires a successful Simulate to calibrate, or switch to manual.",
             "Select a key to sign the DALOS.GAS_PAYER capability.",
             "At least one signer is required.",
           ]);
           ```
        6. Search the rest of this file for any OTHER assertion depending on
           `makeEmptyBuilderState()`'s config being immediately committable WITHOUT going
           through `committableState()` (i.e. not already covered by fix #2) — fix each
           the same way (explicit `s.config.autoGasLimit = false` when the test's intent
           is unrelated to auto-gas, or an explicit `simulateCalibrated: true` opt / a
           calibrated `sim.result` when the test IS about the auto-gas path).
      - `npx vitest run src/ui/builder-state.test.ts` from `packages/khronoton-core`
        passes, all tests green.
  - files: `packages/khronoton-core/src/ui/builder-state.ts`, `packages/khronoton-core/src/ui/builder-state.test.ts`

## Wave 2 (depends on Wave 1)

- [x] T1b: `ExecuteTab` uses the shared hook + becomes edit-aware — done when (depends on
      T1a for the hook, T2-builder-state for the new AUTO-gas default this file's tests
      must now account for):
      - `src/ui/builder/ExecuteTab.tsx`: replace the inline `useMemo` block (~line
        240-251) with `const { commit, gate, simulateCalibrated } = useCommitGate(state,
        sim);` (import from `./use-commit-gate.js`) — `payloadKeyCount`/`triggerOnly`/
        `schedulerOff`/`onSimulate`/`onCommitClick`/`commitEnabled` all stay exactly as
        they are today, now reading `commit`/`gate` from the hook instead of local
        `useMemo`s. `ExecuteTabProps` gains `isEdit?: boolean`. The commit button's label
        (~line 349, currently the literal `"Commit Codex Cronoton"`) becomes:
        `{isEdit ? (committing ? "Saving…" : "Save changes") : "Commit Codex Cronoton"}`
        — create mode (`isEdit` falsy) is byte-identical to today.
      - `src/ui/builder/ExecuteTab.test.tsx`:
        1. `validState()` (~line 53-60, the shared test-state helper): add `config: {
           ...makeEmptyBuilderState().config, autoGasLimit: false },` as a base field
           (before the `...patch` spread, so a caller's own `patch.config` — several
           existing call sites already pass one — still fully overrides it, unchanged
           behavior for those; only callers that DON'T touch `config` at all are
           affected, and they now get an explicit manual default instead of silently
           inheriting whatever `makeEmptyBuilderState()` defaults to).
        2. Add two new tests: `"reads 'Save changes' / 'Saving…' in edit mode"` (mount
           with `isEdit` true via whatever the file's existing `mount`/render helper
           supports — add an `isEdit` param if the helper doesn't already thread arbitrary
           props — assert the button's accessible name toggles with a `committing` prop)
           and `"stays 'Commit Codex Cronoton' in create mode regardless of isEdit being
           omitted"` (existing default behavior, pinned so a future regression is caught).
        3. Confirm (no code change expected, just verify) that every existing test in
           this file still passes unchanged now that `commit`/`gate` are sourced from the
           hook rather than inline — if any test mocked/spied on the REMOVED inline
           `useMemo` internals directly (unlikely, since `ExecuteTab`'s public behavior
           was always observed through the rendered DOM, not internal hooks), fix it to
           observe the same DOM output instead.
      - `npx vitest run src/ui/builder/ExecuteTab.test.tsx` from `packages/khronoton-core`
        passes.
  - files: `packages/khronoton-core/src/ui/builder/ExecuteTab.tsx`, `packages/khronoton-core/src/ui/builder/ExecuteTab.test.tsx`

- [x] T1c: `SaveBar` — the always-visible edit-mode Save bar — done when (depends on T1a
      for the shared hook):
      - New file `src/ui/builder/SaveBar.tsx` exports
        `SaveBar({ state, sim, onSave, committing, access }: SaveBarProps): ReactNode`
        where `SaveBarProps` is `{ state: BuilderState; sim: UseExecuteActionResult<
        [envelope: SimulateEnvelope], SimulateView>; onSave: () => void; committing?:
        boolean; access: Access }`. Uses `useCommitGate(state, sim)` for `{ gate }`.
        Renders: a "Simulate" / "Simulating…" button (`disabled={sim.pending}`, calling
        `sim.run(useCommitGate's commit.envelope as unknown as Record<string, unknown>)`
        — reuse the SAME `commit` from the hook, do not call `builderToCommit` again); a
        "Save changes" / "Saving…" button, `disabled={!gate.ok || committing ||
        !canMutate(access)}` (import `canMutate` from `../access.js`), `onClick={() =>
        { if (gate.ok && !committing && canMutate(access)) onSave(); }}`; and a one-line
        status `<p>` computed by a local pure function `saveBarStatus(sim, gate):
        string`:
        ```ts
        function saveBarStatus(
          sim: UseExecuteActionResult<[envelope: SimulateEnvelope], SimulateView>,
          gate: { ok: boolean; reasons: string[] },
        ): string {
          if (sim.pending) return "Running dry-run…";
          const result = sim.result;
          if (result?.postponed) {
            const detail =
              typeof result.plannedCount === "number"
                ? ` — ${result.plannedCount} planned transaction${result.plannedCount === 1 ? "" : "s"}`
                : "";
            return `Simulation postponed${detail}.`;
          }
          if (result && !result.ok) {
            return `Simulate failed: ${result.error ?? "unknown error"}`;
          }
          if (result?.ok && typeof result.calibratedGasLimit === "number") {
            return `Calibrated gas ${formatThousands(result.calibratedGasLimit)} — ready to save.`;
          }
          if (!gate.ok && gate.reasons.length > 0) return gate.reasons[0];
          return "Changes apply at the next fire.";
        }
        ```
        (import `formatThousands` from `./format.js`). When `!canMutate(access)`, the
        rendered status additionally reads exactly `"Ancient admins only"` (reuse the
        `ADMIN_ONLY_TITLE` constant from `../access.js`) INSTEAD of the computed status
        above (an access denial takes precedence over any sim/gate state) — both buttons
        stay disabled regardless. Style with the same inline `var(--khr-*)` token pattern
        already used throughout `ui/builder/` (reuse `SIMULATE_BUTTON_STYLE`/
        `COMMIT_ENABLED_STYLE`/`COMMIT_DISABLED_STYLE`-equivalent literals — do not import
        `ExecuteTab.tsx`'s private consts, which aren't exported; define this component's
        own small style consts matching the same values/pattern).
      - New test file `src/ui/builder/SaveBar.test.tsx` (`// @vitest-environment jsdom`),
        mirroring `ExecuteTab.test.tsx`'s harness style (a `validState`-equivalent local
        helper, a plain-object `makeSim(result?)` helper). Tests:
        1. Renders "Simulate" and "Save changes" buttons.
        2. `"Save changes"` disabled when `gate.ok` is false (fresh AUTO-gas default, no
           sim result) — status line shows the AUTO-gas gate reason verbatim.
        3. Clicking Simulate calls `sim.run` with the hook's `commit.envelope`.
        4. Status line shows `"Running dry-run…"` when `sim.pending` is true.
        5. Status line shows `"Calibrated gas 1,400 — ready to save."` and Save becomes
           enabled when `sim.result = { ok: true, calibratedGasLimit: 1400 }` is passed
           in (formatted via `formatThousands`, comma-grouped).
        6. Status line shows `"Simulate failed: boom"` when `sim.result = { ok: false,
           error: "boom" }`.
        7. Status line shows `"Simulation postponed — 3 planned transactions."` when
           `sim.result = { ok: false, postponed: true, plannedCount: 3 }` — mirrors
           `ExecuteTab.tsx`'s own postponed-detail pluralization exactly (verify the
           `=== 1 ? "" : "s"` wording matches).
        8. Status line shows `"Changes apply at the next fire."` when `gate.ok` is true
           and `sim.result` is undefined (e.g. an already-manual, already-valid state with
           no Simulate run yet).
        9. `access.tier !== "admin"` (both `"non-admin"` and `"logged-out"`) → both
           buttons `disabled`, status line reads exactly `"Ancient admins only"` — even
           when `gate.ok` would otherwise be true.
        10. Clicking Save calls `onSave` exactly once when the gate is open and access is
            admin; does NOT call `onSave` when disabled by either the gate or access
            (fire the click event anyway and assert `onSave` was never called, proving the
            `onClick` guard, not just the `disabled` attribute, blocks it).
      - `npx vitest run src/ui/builder/SaveBar.test.tsx` from `packages/khronoton-core`
        passes.
  - files: `packages/khronoton-core/src/ui/builder/SaveBar.tsx` (new), `packages/khronoton-core/src/ui/builder/SaveBar.test.tsx` (new)

- [x] T2-executor: preflight-based calibration, live block ceiling, refuse-unmineable —
      done when (depends on T2-seam-adapter for `ChainClient.preflightRead`/
      `getBlockGasLimit`):
      - `src/server/executor.ts`: add a small helper near the top (below the imports):
        ```ts
        /** Resolves the effective simulate/fire ceiling: an explicit config override
         * wins outright (no network call); else a best-effort live fetch off the
         * ALREADY-CONSTRUCTED client for this fire's own chain; else the static
         * fallback. Never throws — `getBlockGasLimit` failures are absorbed by the
         * adapter itself (see `blockchain/stoachain.ts`). */
        async function resolveCeiling(ctx: ExecutorCtx, client: ChainClient): Promise<number> {
          if (typeof ctx.config?.autoGasCeiling === "number") return ctx.config.autoGasCeiling;
          const live = await client.getBlockGasLimit?.();
          return typeof live === "number" ? live : AUTO_GAS_CEILING;
        }
        ```
        (import `ChainClient` as a type alongside the existing `ChainRuntime`/
        `KeyResolver`/etc. imports from `./seams.js`.) Takes the client as a parameter
        rather than constructing its own — both call sites below already build (or, for
        `runSimulate`, will now build) a `client` bound to the definition's real
        `chainId` before this is called, so `resolveCeiling` never does a second,
        redundant `createClient`/wrong-chain lookup.
      - `runSimulate` (~line 229-275) — REORDER so the client exists before both the
        ceiling resolution and the build (today the client is constructed only after
        build+sign, via a destructured `const { dirtyRead } = runtime.createClient(...)`
        — that destructure must become the WHOLE client object, and move up):
        ```ts
        async function runSimulate(
          ctx: ExecutorCtx,
          definition: CodexTxDefinition,
          signers: CodexTxDefinition["signers"],
        ): Promise<SimulateResult> {
          const { runtime, resolver } = ctx;
          const { autoGasLimit } = definition.config;
          const client = runtime.createClient(runtime.getPactUrl(definition.config.chainId));
          const ceiling = await resolveCeiling(ctx, client);

          const tx = buildTransaction(
            runtime,
            definition,
            signers,
            autoGasLimit ? ceiling : undefined,
          );
          const signed = await signTransaction(runtime, resolver, signers, tx);

          if (autoGasLimit && !client.preflightRead) {
            throw new Error(
              "ChainRuntime.preflightRead is required to auto-size gas for an AUTO-gas " +
                "transaction: without it the calibration would use dirtyRead's execution-" +
                "only gas figure, which omits the transaction-size charge and reproduces " +
                "the exact over-reservation bug this capability exists to fix. Upgrade the " +
                "injected runtime adapter (see blockchain/stoachain.ts), or switch this " +
                "cronoton to manual gas.",
            );
          }
          const simulation = autoGasLimit
            ? await client.preflightRead!(signed)
            : await client.dirtyRead(signed);

          if (simulation.result.status === "failure") {
            return {
              ok: false,
              mode: "simulate",
              error: dirtyReadError(simulation.result),
              rawResult: simulation.result,
              terminalIntent: null,
            };
          }

          const gasUsed = simulation.gas || 0;
          if (gasUsed > ceiling) {
            return {
              ok: false,
              mode: "simulate",
              gasUsed,
              error: `Transaction needs ${gasUsed} gas, over the block limit of ${ceiling} — no gas setting can mine it. Reduce the transaction's size or complexity.`,
              rawResult: simulation.result,
              terminalIntent: null,
            };
          }
          const calibratedGasLimit =
            autoGasLimit && gasUsed > 0 ? runtime.calculateAutoGasLimit(gasUsed) : undefined;

          return {
            ok: true,
            mode: "simulate",
            gasUsed,
            calibratedGasLimit,
            rawResult: simulation.result,
            terminalIntent: null,
          };
        }
        ```
        (the refuse-unmineable check applies regardless of `autoGasLimit` — a manual
        limit whose measured gas exceeds the ceiling is equally unmineable.)
      - `runFire` (~line 277-393) — SMALLER reorder needed: it already builds the whole
        `client` object (not destructured) before build+sign, so only the ceiling line
        moves (from a synchronous constant to an awaited call AFTER `client` exists) and
        the pre-flight call site changes:
        ```ts
        const { runtime, resolver } = ctx;
        const listenMs = ctx.config?.listenTimeoutMs ?? LISTEN_TIMEOUT_MS;
        const { chainId, autoGasLimit } = definition.config;
        const client = runtime.createClient(runtime.getPactUrl(chainId));
        const ceiling = await resolveCeiling(ctx, client);

        // Build + sign for the pre-flight read.
        let tx = buildTransaction(runtime, definition, signers, autoGasLimit ? ceiling : undefined);
        let signed = await signTransaction(runtime, resolver, signers, tx);

        if (autoGasLimit && !client.preflightRead) {
          throw new Error(/* same message as runSimulate's, verbatim */);
        }
        const preflight = autoGasLimit
          ? await client.preflightRead!(signed)
          : await client.dirtyRead(signed);
        if (preflight.result.status === "failure") {
          return { ok: false, mode: "fire", chainId, error: dirtyReadError(preflight.result),
            rawResult: preflight.result,
            terminalIntent: computeTerminalIntent(definition.scheduleKind, "fire", false) };
        }

        const gasUsed = preflight.gas || 0;
        if (gasUsed > ceiling) {
          return {
            ok: false,
            mode: "fire",
            chainId,
            error: `Transaction needs ${gasUsed} gas, over the block limit of ${ceiling} — no gas setting can mine it. Reduce the transaction's size or complexity.`,
            rawResult: preflight.result,
            terminalIntent: computeTerminalIntent(definition.scheduleKind, "fire", false),
          };
        }

        // Auto-gas: rebuild + re-sign with the calibrated limit from the pre-flight read.
        if (autoGasLimit && gasUsed > 0) {
          const calibrated = runtime.calculateAutoGasLimit(gasUsed);
          tx = buildTransaction(runtime, definition, signers, calibrated);
          signed = await signTransaction(runtime, resolver, signers, tx);
        }
        ```
        (the refuse-unmineable return sits BEFORE the rebuild block — an unmineable tx
        must never reach the rebuild-and-resubmit step.)
      - Update the module JSDoc / the `runSimulate`/`runFire` function doc comments to
        describe the new preflight-based calibration, the live ceiling, and the refuse-
        unmineable behavior (matching this file's existing practice of documenting the
        four load-bearing invariants at the top).
      - `src/server/executor.test.ts` updates:
        1. Extend the shared `createClient` mock fixture (~line 76-79): add
           `const preflightRead = vi.fn();` alongside `dirtyRead`/`submit`/`listen`, and
           include it in the object `createClient` returns: `vi.fn((..._a) => ({
           dirtyRead, submit, listen, preflightRead }))`.
        2. In the shared `beforeEach` (~line 187), add
           `preflightRead.mockResolvedValue({ result: { status: "success", data: "OK" },
           gas: 700 });` alongside the existing `dirtyRead.mockResolvedValue(...)` line —
           gives every `autoGasLimit:true` test in the file the same default calibration
           source as before, with ZERO changes needed to tests that don't override it
           (e.g. the "AUTO-gas rebuild re-derives gas meta FRESH" test at ~line 725-763
           needs no edits at all).
        3. `"autoGasLimit → calibrated gas is calculateAutoGasLimit(700) === 1400"`
           (~line 290-301, simulate mode): change `dirtyRead.mockResolvedValue({...})` to
           `preflightRead.mockResolvedValue({...})`. Add two assertions:
           `expect(preflightRead).toHaveBeenCalled();` and
           `expect(dirtyRead).not.toHaveBeenCalled();` (proves AUTO fires route to the
           accurate measurement, not the old one).
        4. `"autoGasLimit fire → rebuilds so the last setMeta.gasLimit === 1400"` (~line
           404-417): same two changes (mock source + the two new routing assertions).
        5. `"injected autoGasCeiling is the gasLimit of the FIRST (pre-flight) build"`
           (~line 489-505, the `FIX 1 config.autoGasCeiling override` describe block):
           change its own `dirtyRead.mockResolvedValue(...)` to
           `preflightRead.mockResolvedValue(...)` (this test uses `autoGasLimit: true`).
           No other change needed — `ctx.config.autoGasCeiling` being explicitly set means
           `resolveCeiling` never calls `getBlockGasLimit` at all, so this test's existing
           assertions (`firstMeta.gasLimit === 5_000_000`, `lastMeta.gasLimit === 1400`)
           hold unchanged. Add one assertion confirming the short-circuit:
           `expect(mockRuntime.createClient(...))`... actually simpler: since
           `mockRuntime`'s `createClient` doesn't define `getBlockGasLimit` at all in this
           file's fixture (it's optional and this fixture predates it), the short-circuit
           is implicitly proven by the test still passing at all — no extra assertion
           needed, just confirm behavior is unchanged.
        6. New describe block `"executeCodexTransaction — live block gas limit"`:
           (a) `"resolves the ceiling via getBlockGasLimit when no config override is
           set"` — add a `getBlockGasLimit: vi.fn(async () => 1_600_000)` to a ONE-OFF
           runtime built via `{ ...mockRuntime, createClient: vi.fn(() => ({ dirtyRead,
           submit, listen, preflightRead, getBlockGasLimit: vi.fn(async () => 1_600_000)
           })) }`, run an `autoGasLimit:true` simulate with NO `ctx.config.autoGasCeiling`,
           and assert the FIRST build's `setMeta.gasLimit === 1_600_000` (the ceiling used
           for the pre-flight build, mirroring the existing `FIX 1` test's own assertion
           style); (b) `"falls back to AUTO_GAS_CEILING when getBlockGasLimit is absent"`
           — using the FILE'S EXISTING `mockRuntime` (no `getBlockGasLimit` defined),
           assert the first build's `gasLimit` equals the imported `AUTO_GAS_CEILING`
           constant (import it from `./seams.js` in the test file) — this is really a
           regression pin that the pre-existing default behavior (before this task)
           didn't change for a runtime that hasn't upgraded.
        7. New describe block `"executeCodexTransaction — refuse the unmineable case"`:
           (a) `"AUTO-gas simulate refuses when gasUsed exceeds the ceiling — never
           returns a calibratedGasLimit"` — `preflightRead.mockResolvedValue({ result: {
           status: "success" }, gas: 3_000_000 })` (over the default 2,000,000 fallback
           ceiling), assert `res.ok === false`, `res.error` matches `/over the block
           limit/`, `res.calibratedGasLimit` is `undefined`; (b) `"MANUAL-gas fire also
           refuses when measured gas exceeds the ceiling"` — same over-ceiling
           `dirtyRead.mockResolvedValue({...gas: 3_000_000})` with `autoGasLimit: false`
           (the default `baseDef()`), fire mode, assert `res.ok === false`, `submit` was
           NEVER called, `res.error` matches `/over the block limit/`, and
           `res.terminalIntent` is the expected error-terminal-intent shape (matching the
           file's existing F-001-failure test's assertion style at ~line 333-346).
        8. New describe block `"executeCodexTransaction — AUTO-gas fire on a runtime
           WITHOUT preflightRead"` (mirrors the existing "runtime WITHOUT the gasMeta
           capability" describe block at ~line 766-788 exactly):
           ```ts
           function legacyCtx(): ExecutorCtx {
             const legacyRuntime = { ...mockRuntime } as ChainRuntime;
             const legacyCreateClient = () => {
               const c = legacyRuntime.createClient("x") as unknown as Record<string, unknown>;
               delete c.preflightRead;
               return c;
             };
             // (adjust to whatever shape correctly strips preflightRead from the CLIENT
             // this fixture's createClient returns — re-derive precisely once T2-seam-
             // adapter's exact mock shape is visible; the goal is a runtime whose
             // client lacks preflightRead specifically, not the whole runtime.)
             return { runtime: legacyRuntime, resolver: mockResolver };
           }
           ```
           with three tests: an AUTO-gas (`autoGasLimit:true`) fire on this legacy client
           returns `{ ok: false, error: /preflightRead/ }` and `submit` is never called;
           an AUTO-gas simulate on it `rejects.toThrow(/preflightRead/)`; a MANUAL-gas
           (`baseDef()`, the default) fire on the SAME legacy client succeeds exactly as
           today (`res.ok === true`, `dirtyRead` was called) — proving the hard-throw is
           scoped to AUTO fires only, per the design's explicit "manual fires on an
           un-upgraded runtime are completely unaffected" acceptance criterion.
      - `npx vitest run src/server/executor.test.ts` from `packages/khronoton-core`
        passes, all tests green (existing + new).
  - files: `packages/khronoton-core/src/server/executor.ts`, `packages/khronoton-core/src/server/executor.test.ts`

## Wave 3 (depends on Wave 2)

- [x] T1d: `Builder.tsx` wiring — stop discarding `access`, render `SaveBar`, pass
      `isEdit` to `ExecuteTab` — done when (depends on T1b for `ExecuteTab`'s `isEdit`
      prop, T1c for `SaveBar`, and T2-builder-state's default flip for this file's own
      CREATE-mode test fallout):
      - `src/ui/builder/Builder.tsx`: the destructured prop `access: _access` (~line 118)
        becomes `access` (no longer discarded). Import `SaveBar` from `./SaveBar.js`.
        Render `<SaveBar state={state} sim={sim} onSave={handleCommit} committing=
        {committing} access={access} />` inside the `isEdit` branch, ABOVE the existing
        `EDIT_BANNER` block (~line 256-268) — i.e. as the very first thing rendered once
        `editReady` is true in edit mode, before the "Edits apply at the NEXT fire..."
        text, so it's the first thing an operator sees. Pass `isEdit={isEdit}` to the
        existing `<ExecuteTab ... />` call site (~line 317-327).
      - `src/ui/builder/Builder.test.tsx`:
        1. Every CREATE-mode test that clicks `screen.getByRole("button", { name:
           "Commit Codex Cronoton" })` without first configuring gas — search for this
           exact pattern in a `describe` block that does NOT pass `editId` (currently 4:
           "commits builderToCommit(state) built from the edited name...", "selecting an
           event-driven resolver commits...", "marks a resolver the SERVER reports
           evented...", "does NOT leave externalFireable stuck true..."). Each needs ONE
           added step before the Commit click: navigate to the Config tab and click
           `screen.getByRole("button", { name: "Switch to manual" })`, e.g.:
           ```ts
           fireEvent.click(screen.getByRole("tab", { name: "Config" }));
           fireEvent.click(screen.getByRole("button", { name: "Switch to manual" }));
           fireEvent.click(screen.getByRole("tab", { name: "Execute" }));
           ```
           inserted before the existing `fireEvent.click(screen.getByRole("tab", { name:
           "Execute" }))` + Commit-click sequence each test already has (some already
           navigate to Execute for an earlier assertion — insert the Config-tab detour
           before that, then return to Execute).
        2. The FIRST of those four tests ("commits builderToCommit(state) built from the
           edited name...") additionally reconstructs an `expected` body via
           `builderToCommit({ ...makeEmptyBuilderState(), name: "Nightly", gasPayer: {...}
           })` (~line 143-147) — this reconstruction must ALSO reflect the manual
           override to match the actual committed body:
           `builderToCommit({ ...makeEmptyBuilderState(), name: "Nightly", gasPayer:
           {...}, config: { ...makeEmptyBuilderState().config, autoGasLimit: false } })`.
        3. Every EDIT-mode test (passes `editId`) — verify unaffected (their fixture rows
           already set `autoGasLimit` explicitly, e.g. `autoGasLimit: false` at ~line 94 —
           `detailToBuilderState` reads the STORED value, never `makeEmptyBuilderState()`'s
           default) — no changes expected, but re-run to confirm.
        4. New tests for the `SaveBar` wiring: `"renders SaveBar in edit mode, not in
           create mode"` (mount once with an `editId`, assert `screen.getByRole("button",
           { name: "Save changes" })` exists on EVERY tab — switch tabs via the tablist
           and re-assert presence each time; mount again with no `editId`, assert
           `screen.queryByRole("button", { name: "Save changes" })` is null); `"a
           non-admin access tier never sees an enabled Save in edit mode"` (mount with
           `access={{tier: "non-admin"}}` and an `editId`, assert the Save button is
           disabled regardless of gate state).
      - `npx vitest run src/ui/builder/Builder.test.tsx` from `packages/khronoton-core`
        passes.
  - files: `packages/khronoton-core/src/ui/builder/Builder.tsx`, `packages/khronoton-core/src/ui/builder/Builder.test.tsx`
