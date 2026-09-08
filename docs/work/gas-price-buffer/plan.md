## Wave 1

- [x] T1: Add `CodexTxConfig.gasPriceBufferAnu` (optional, additive), deprecate `gasPrice` — done
      when: `src/server/types.ts`'s `CodexTxConfig` interface (~line 56-65) reads:
      ```ts
      export interface CodexTxConfig {
        readonly chainId: string;
        /**
         * @deprecated Superseded by `gasPriceBufferAnu`. Kept only so historical rows'
         * `config_json` still parses; no longer used to price new fires — see
         * `server/executor.ts`'s `buildTransaction`, which always prices from the live
         * network floor plus `gasPriceBufferAnu`.
         */
        readonly gasPrice: number;
        /**
         * ANU to pay ABOVE the live network floor at fire time. 0 (default, and the
         * value used when absent — e.g. every pre-migration row) = exactly the floor.
         * The only gas-price knob an operator sets — never an absolute price, since
         * the floor rises roughly every 3h and any absolute number set today is
         * guaranteed to go stale. Absence self-heals a historical row with no DB
         * migration.
         */
        readonly gasPriceBufferAnu?: number;
        readonly gasLimit: number;
        readonly autoGasLimit: boolean;
        readonly ttl: number;
      }
      ```
      `gasPriceBufferAnu` is OPTIONAL (not `readonly gasPriceBufferAnu: number`) so every
      existing `CodexTxConfig`-typed object literal elsewhere in the repo that doesn't set it
      (e.g. `src/server/pure/runtime-args.test.ts`'s `defWith`, `src/server/store/cronoton.test.ts`'s
      `validInput`) keeps compiling unchanged. `npx tsc --noEmit` run from
      `packages/khronoton-core` is clean (no new errors).
  - files: `packages/khronoton-core/src/server/types.ts`

- [x] T2: Extend `ChainRuntime.gasMeta` with an optional `bufferAnu` 2nd param; sum floor+buffer
      IN ANU inside the adapter before the one `anuToStoaNumber` conversion (not two converted
      STOA floats added) — done when:
      - `src/server/seams.ts`'s `ChainRuntime.gasMeta` signature becomes
        `gasMeta?(floorAnu: number, bufferAnu?: number): StoaGasMeta;` and its doc comment
        (~line 122-144) adds a paragraph: `bufferAnu` (default 0) is added to `floorAnu` **in
        ANU**, before the implementation's one `anuToStoaNumber` conversion — summing two
        independently-converted STOA numbers instead produces a different serialized value in
        roughly 1 in 5 floor/buffer pairs (verified: `anuToStoaNumber(11569) + anuToStoaNumber(500)`
        !== `anuToStoaNumber(12069)` as JSON strings), which is exactly the class of bug
        `anuToStoaNumber` exists to prevent.
      - `src/blockchain/stoachain.ts`'s `gasMeta` implementation (~line 91-104) becomes:
        ```ts
        gasMeta: (floorAnu: number, bufferAnu = 0) => {
          const { creationTime } = gas.stoaGasMeta();
          const anu = Math.max(floorAnu, gas.minGasPriceAnu(creationTime)) + bufferAnu;
          return { creationTime, gasPrice: gas.anuToStoaNumber(anu) };
        },
        ```
        (still exactly ONE `gas.stoaGasMeta()` call — the "one clock read, both fields" invariant
        is unchanged.)
      - `src/blockchain/stoachain.test.ts` (its `"createStoachainRuntime — gasMeta (the live gas
        floor seam)"` describe block, ~line 151-190) gets two new tests:
        1. `"omitting bufferAnu behaves exactly as before (0.9.0 regression pin)"` —
           `rt.gasMeta!(10000)` (1-arg call) still equals `{ creationTime: mockNowS, gasPrice:
           Number("0.000000010500") }` (byte-identical to the existing "raises a STALE stored
           price up to the live floor" test).
        2. `"sums floor+buffer in ANU before the ONE conversion — proves the precision fix"` —
           `rt.gasMeta!(10000, 500).gasPrice` equals `mockAnuToStoaNumber(10500 + 500)` (computed
           by calling the file's own `mockAnuToStoaNumber` ONCE on the pre-summed ANU total), and
           is asserted to NOT equal `mockAnuToStoaNumber(10500) + mockAnuToStoaNumber(500)` (the
           two-conversions-summed value) — this second assertion is what actually catches a
           regression back to the buggy two-call form.
        Both new tests reuse the existing `mockStoaGasMeta`/`mockMinGasPriceAnu`/
        `mockAnuToStoaNumber` fixtures already in the file (do not redeclare them).
      - `npx vitest run src/blockchain/stoachain.test.ts` from `packages/khronoton-core` passes,
        all tests in the file green (existing + 2 new).
  - files: `packages/khronoton-core/src/server/seams.ts`, `packages/khronoton-core/src/blockchain/stoachain.ts`, `packages/khronoton-core/src/blockchain/stoachain.test.ts`

- [x] T3: New `useLiveGasFloor()` hook — polls the live gas floor every 30s plus a
      visibilitychange/focus backstop — done when:
      - New file `src/ui/builder/live-gas-floor.ts` exports `useLiveGasFloor(): number | null`:
        a React hook that dynamically imports `{ minGasPriceAnu }` from `@stoachain/stoa-core/gas`
        (optional peer — matches `tx-size.ts`'s existing dynamic-import precedent) and calls
        `minGasPriceAnu(Math.floor(Date.now() / 1000))`. Returns `null` until the first
        resolution. Refreshes on: (a) a `setInterval` every 30 000 ms, (b) a `visibilitychange`
        listener on `document` that re-fetches when `document.visibilityState === "visible"`,
        (c) a `focus` listener on `window`. All three listeners/interval are cleaned up on
        unmount. If the dynamic import rejects (peer not installed), the hook catches it and
        stays `null` — it never throws into render.
      - New file `src/ui/builder/live-gas-floor.test.ts` (`// @vitest-environment jsdom` at top,
        matching `TxMeters.test.tsx`'s idiom) using `renderHook`/`waitFor` from
        `@testing-library/react`, with `vi.mock("@stoachain/stoa-core/gas", ...)` mirroring
        `stoachain.test.ts`'s mocking style. Tests:
        1. `"starts null, then resolves to the live floor after mount"` — mock
           `minGasPriceAnu` returns a fixed number; `renderHook(() => useLiveGasFloor())`;
           `result.current` is initially `null`; after `waitFor`, equals the mocked number.
        2. `"refreshes again on the 30s interval"` — `vi.useFakeTimers()`, mock
           `minGasPriceAnu` to return a different value on its 2nd call; after mount + resolve,
           `vi.advanceTimersByTime(30_000)`; `result.current` updates to the 2nd value.
        3. `"refreshes on document visibilitychange -> visible"` — after initial resolve, change
           the mock's return value, stub `document.visibilityState` to `"visible"` (e.g. via
           `Object.defineProperty`), dispatch a `visibilitychange` Event on `document`; `result
           .current` updates to the new value.
        4. `"refreshes on window focus"` — same pattern, dispatching a `focus` Event on `window`.
        5. `"stays null and never throws when the optional peer import rejects"` — mock the
           module factory to `throw`/reject; render; assert no error is thrown by `renderHook`
           and `result.current` stays `null` after `waitFor`'s timeout window.
      - `npx vitest run src/ui/builder/live-gas-floor.test.ts` from `packages/khronoton-core`
        passes.
  - files: `packages/khronoton-core/src/ui/builder/live-gas-floor.ts` (new), `packages/khronoton-core/src/ui/builder/live-gas-floor.test.ts` (new)

## Wave 2 (depends on Wave 1)

- [x] T4: `buildTransaction()` prices as live-floor + buffer via `gasMeta(0, bufferAnu)`, not
      floor-vs-stored-value — done when (depends on T1 for `gasPriceBufferAnu`, T2 for the
      widened `gasMeta` signature):
      - `src/server/executor.ts`'s `buildTransaction` (~line 82-154): the line
        `const { creationTime, gasPrice } = runtime.gasMeta(definition.config.gasPrice);`
        becomes
        `const { creationTime, gasPrice } = runtime.gasMeta(0, definition.config.gasPriceBufferAnu ?? 0);`
        — `floorAnu` is always `0` now (there is no more stored absolute value to raise to the
        floor); the buffer is the only thing added on top. Update the JSDoc above `buildTransaction`
        (~line 71-81, currently describing "`config.gasPrice` is a FLOOR") to instead describe:
        every fire prices at the live network floor plus `config.gasPriceBufferAnu` (default 0);
        `config.gasPrice` is no longer read for pricing at all.
      - `src/server/executor.test.ts`: update the local `gasMeta` mock (~line 96-102 and its
        `mockImplementation` re-set at ~line 163-169) to accept a 2nd `bufferAnu = 0` param and
        compute `anuToStoaNumber(Math.max(floorAnu, liveFloorAnu(creationTime)) + bufferAnu)`
        (mirrors T2's real adapter formula exactly).
      - Rewrite `"setMeta prices via the gasMeta seam..."` (~line 216-227): assert
        `expect(gasMeta).toHaveBeenCalledWith(0, 0)` (was `toHaveBeenCalledWith(10000)`) —
        `baseDef()`'s config has no `gasPriceBufferAnu`, so it defaults to 0.
      - Replace `"floors a STALE stored gasPrice up to the live floor..."` (~line 636-642) with
        `"prices at exactly the live floor when no buffer is set — config.gasPrice is never read"`:
        use a `baseDef({ config: { chainId: "0", gasPrice: 99999999, gasLimit: 1500, autoGasLimit:
        false, ttl: 28800 } })` (a huge, deliberately-wrong `gasPrice` to prove it's ignored),
        assert `gasMeta` called with `(0, 0)` and `meta.gasPrice === anuToStoaNumber(10500)`.
      - Replace `"keeps an operator-raised gasPrice ABOVE the floor..."` (~line 644-651) with
        `"adds the priority buffer ON TOP of the live floor"`: `config: { chainId: "0", gasPrice:
        10000, gasPriceBufferAnu: 500, gasLimit: 1500, autoGasLimit: false, ttl: 28800 }`, assert
        `gasMeta` called with `(0, 500)` and `meta.gasPrice === anuToStoaNumber(10500 + 500)`
        (i.e. `anuToStoaNumber(11000)`, a SINGLE conversion of the summed ANU, not
        `anuToStoaNumber(10500) + anuToStoaNumber(500)`).
      - Keep `"stamps creationTime from the SAME seam call..."` (~line 653-660) and `"uses
        precision-safe ANU->STOA, not float division"` (~line 662-668) as-is — both still valid
        with buffer defaulting to 0.
      - Update `"AUTO-gas rebuild re-derives gas meta FRESH for the second build"` (~line
        670-697): add `gasPriceBufferAnu: 200` to the test's `config`; update the local
        `gasMeta.mockImplementation` override inside this test to accept `(floorAnu, bufferAnu =
        0)` and include `+ bufferAnu`; assert `gasMeta` called with `(0, 200)` on both calls
        (`toHaveBeenNthCalledWith(1, 0, 200)` / `toHaveBeenNthCalledWith(2, 0, 200)`); update the
        two expected `gasPrice` values to `anuToStoaNumber(10500 + 200)` and
        `anuToStoaNumber(10501 + 200)`.
      - Leave the `"runtime WITHOUT the gasMeta capability"` describe block (~line 700-722)
        unchanged — unaffected by this task.
      - `npx vitest run src/server/executor.test.ts` from `packages/khronoton-core` passes, all
        tests green.
  - files: `packages/khronoton-core/src/server/executor.ts`, `packages/khronoton-core/src/server/executor.test.ts`

- [x] T5: `ui/builder-state.ts` — buffer-only `BuilderConfig`, migration default, validation,
      `maxTxFee` takes the live floor — done when (depends on T1):
      - `BuilderConfig` (~line 64-70): `gasPriceAnu: number;` renamed to
        `gasPriceBufferAnu: number;` with a doc comment matching `CodexTxConfig
        .gasPriceBufferAnu`'s wording (ANU above the live floor, 0 default, never an absolute
        price).
      - `MSG` (~line 114-125): remove the `gasPrice: (floorAnu: number) => ...` entry; add
        `gasPriceBuffer: "Priority buffer cannot be negative."`.
      - `makeEmptyBuilderState()` (~line 130-161): `config.gasPriceAnu: GENESIS_MIN_GAS_ANU`
        becomes `config.gasPriceBufferAnu: 0`, with a comment explaining 0 = "pay exactly the
        live floor."
      - `maxTxFee` (~line 166-168) signature becomes
        `export function maxTxFee(config: BuilderConfig, liveFloorAnu: number | null): number | null`
        — returns `null` when `liveFloorAnu` is `null`; else
        `(liveFloorAnu + config.gasPriceBufferAnu) * config.gasLimit`.
      - Remove `GENESIS_MIN_GAS_ANU` (~line 312) and `CommitGateOptions.minGasPriceAnu` (~line
        314-331) entirely — both are dead once there is no absolute price to floor-check. Keep
        `CommitGateOptions.simulateCalibrated` untouched.
      - `builderToCommit` (~line 270-303): the `config` object literal becomes
        ```ts
        const config: CodexTxConfig = {
          chainId: state.config.chainId,
          gasPrice: 0, // deprecated — kept as an honest 0 placeholder; never read for pricing
          gasPriceBufferAnu: state.config.gasPriceBufferAnu,
          gasLimit: state.config.gasLimit,
          autoGasLimit: state.config.autoGasLimit,
          ttl: state.config.ttl,
        };
        ```
      - `validateConfig` (~line 337-349): remove the `minGasAnu`/floor-check lines entirely; add
        `if (c.gasPriceBufferAnu < 0) errors.push(MSG.gasPriceBuffer);`. The function's `opts:
        CommitGateOptions` parameter keeps only `simulateCalibrated`.
      - `detailToBuilderState` (~line 464-490): the rehydrated `config` becomes
        ```ts
        config: {
          chainId: storedConfig.chainId,
          gasPriceBufferAnu: storedConfig.gasPriceBufferAnu ?? 0,
          gasLimit: storedConfig.gasLimit,
          autoGasLimit: storedConfig.autoGasLimit,
          ttl: storedConfig.ttl,
        },
        ```
        Update its enclosing JSDoc (~line 454-463), which currently says "stored `gasPrice` maps
        back to `gasPriceAnu`", to instead say a missing `gasPriceBufferAnu` (every
        pre-migration row) defaults to 0.
      - Test file `src/ui/builder-state.test.ts` updates:
        - `"seeds the exact builder-spec defaults..."` (~line 74-101): `gasPriceAnu: 10000` →
          `gasPriceBufferAnu: 0`.
        - `"maxTxFee"` describe block (~line 120-127): rewrite to 3 cases —
          `maxTxFee(makeEmptyBuilderState().config, 10000)` → `15_000_000` (buffer 0, floor
          10000, limit 1500); `maxTxFee({ ...makeEmptyBuilderState().config, gasLimit: 2000,
          gasPriceBufferAnu: 500 }, 10000)` → `(10000 + 500) * 2000 = 21_000_000`;
          `maxTxFee(makeEmptyBuilderState().config, null)` → `null`.
        - `"maps gasPriceAnu back to the store's gasPrice field losslessly"` (~line 130-141):
          rewrite to `"maps gasPriceBufferAnu into the envelope config, with gasPrice as a
          deprecated 0 placeholder"` — `s.config = { chainId: "5", gasPriceBufferAnu: 12345,
          gasLimit: 2000, autoGasLimit: true, ttl: 900 }`; expect `config` to equal `{ chainId:
          "5", gasPrice: 0, gasPriceBufferAnu: 12345, gasLimit: 2000, autoGasLimit: true, ttl:
          900 }`.
        - The three `validateConfig` floor tests (~line 302-326: `"rejects a gas price below the
          10000 ANU protocol floor"`, `"rejects a gas price below an injected LIVE floor..."`,
          `"accepts a gas price at or above the injected live floor"`) are replaced with two new
          tests: `"rejects a negative priority buffer"` (`s.config.gasPriceBufferAnu = -1;
          expect(validateConfig(s)).toContain("Priority buffer cannot be negative.")`) and
          `"accepts a zero buffer"` (`expect(validateConfig(makeEmptyBuilderState())).toEqual([])`).
        - `"maps stored gasPrice back to gasPriceAnu and preserves the rest of config"` (~line
          521-530): rewrite to `"defaults gasPriceBufferAnu to 0 for a pre-migration row (no
          stored buffer)"` — `expect(s.config).toEqual({ chainId: "2", gasPriceBufferAnu: 0,
          gasLimit: 2500, autoGasLimit: true, ttl: 1200 })` (using the existing `sampleRow()`,
          whose `config_json` has no `gasPriceBufferAnu`).
        - Add a new test `"rehydrates a stored gasPriceBufferAnu when present"`: call
          `detailToBuilderState(sampleRow({ config_json: JSON.stringify({ chainId: "2",
          gasPrice: 20000, gasPriceBufferAnu: 750, gasLimit: 2500, autoGasLimit: true, ttl: 1200
          }) }))`; expect `s.config.gasPriceBufferAnu` to be `750`.
        - `"round-trips definition fields back through builderToCommit..."` (~line 594-604):
          change `expect(env.config.gasPrice).toBe(20000)` to `expect(env.config.gasPrice).toBe(0)`
          and add `expect(env.config.gasPriceBufferAnu).toBe(0)` (sampleRow's `config_json` has
          no stored buffer).
      - `npx vitest run src/ui/builder-state.test.ts` from `packages/khronoton-core` passes.
  - files: `packages/khronoton-core/src/ui/builder-state.ts`, `packages/khronoton-core/src/ui/builder-state.test.ts`

## Wave 3 (depends on Wave 2, and T3)

- [x] T6: Thread the live floor into the Builder UI — `ConfigTab` (floor display + buffer input,
      replacing the absolute price input), `ExecuteTab` (gas summary line), `Builder.tsx` (calls
      `useLiveGasFloor()` once, passes it to both tabs) — done when (depends on T3, T5; bundled
      into one task because `Builder.tsx` must be edited once for both tabs' new prop, which a
      split into separate ConfigTab/ExecuteTab tasks would conflict on):
      - `src/ui/builder/ConfigTab.tsx`: `ConfigTabProps` gains `liveFloorAnu?: number | null;`.
        The `"Gas Price (ANU)"` `Field` block (~line 139-148) is removed entirely and replaced
        with two new `Field`s directly after the Chain ID field:
        ```jsx
        <Field label="Live Network Floor (ANU)">
          <div style={DISPLAY_STYLE}>
            {liveFloorAnu != null ? `${formatThousands(liveFloorAnu)} ANU` : "Loading…"}
          </div>
          <Hint>The chain's live minimum gas price right now. Refreshes automatically.</Hint>
        </Field>

        <Field label="Priority Buffer (ANU above floor)">
          <input
            aria-label="Priority Buffer (ANU above floor)"
            type="number"
            style={INPUT_STYLE}
            value={config.gasPriceBufferAnu}
            onChange={(e) => patch({ gasPriceBufferAnu: Number(e.target.value) })}
          />
          <Hint>
            The transaction always pays the live floor at fire time, plus this. Leave at 0
            unless you need priority over other pending transactions.
          </Hint>
        </Field>
        ```
        The `"Max Tx Fee (ANU)"` `Field` (~line 183-187) becomes (computing `maxTxFee` once
        into a local, not twice inline):
        ```jsx
        const fee = maxTxFee(config, liveFloorAnu ?? null);
        // ...
        <Field label="Max Tx Fee (ANU)">
          <div style={DISPLAY_STYLE}>
            {fee != null ? `${formatThousands(fee)} ANU` : "…"}{" "}
            <span style={MUTED_STYLE}>((floor + buffer) x gas limit)</span>
          </div>
        </Field>
        ```
        (`const fee = ...` goes in the component body, alongside the existing `const auto =
        config.autoGasLimit;` / `const calibrated = ...` locals, not inside the JSX.)
        Update the file's top JSDoc (~line 6-9) to describe the fee as `(live floor + buffer) x
        gas limit` instead of `gas price × gas limit`.
      - `src/ui/builder/ConfigTab.test.tsx`: in `"renders the section title and every field's
        helper verbatim"` (~line 27-33), remove the `"Minimum 10,000 ANU (protocol floor)."`
        assertion and add assertions for `"The chain's live minimum gas price right now.
        Refreshes automatically."` and `"The transaction always pays the live floor at fire
        time, plus this. Leave at 0 unless you need priority over other pending transactions."`.
        Rewrite `"patches config.gasPriceAnu as a NUMBER when Gas Price changes"` (~line 55-64)
        to `"patches config.gasPriceBufferAnu as a NUMBER when Priority Buffer changes"`, firing
        a change event on `screen.getByLabelText("Priority Buffer (ANU above floor)")` with
        value `"500"` and expecting the patch `{ gasPriceBufferAnu: 500 }`. Add a new test
        `"shows the live floor when provided, and a loading placeholder when not"`: render once
        with `liveFloorAnu={10069}` and assert the floor display's text contains `"10,069 ANU"`;
        render again with no `liveFloorAnu` prop and assert it contains `"Loading…"`. Rewrite
        the `"ConfigTab — Max Tx Fee derivation"` describe block (~line 129-140): render with
        `liveFloorAnu={10000}` and default config (buffer 0, limit 1500) → expect
        `/15,000,000 ANU/`; render with `liveFloorAnu={10000}` and `withConfig({
        gasPriceBufferAnu: 500, gasLimit: 2000 })` → expect `/21,000,000 ANU/`; render with no
        `liveFloorAnu` prop → expect the fee display to show `"…"`.
      - `src/ui/builder/ExecuteTab.tsx`: `ExecuteTabProps` gains `liveFloorAnu?: number | null;`.
        `gasLine` (~line 148-153) becomes:
        ```ts
        function gasLine(state: BuilderState, liveFloorAnu?: number | null): string {
          const c = state.config;
          const suffix = c.autoGasLimit ? " (AUTO)" : "";
          const buffer = c.gasPriceBufferAnu;
          if (liveFloorAnu == null) return `${formatThousands(c.gasLimit)} @ … ANU${suffix}`;
          const total = liveFloorAnu + buffer;
          const priceLabel =
            buffer > 0
              ? `${formatThousands(total)} ANU (floor + ${formatThousands(buffer)})`
              : `${formatThousands(total)} ANU (floor)`;
          return `${formatThousands(c.gasLimit)} @ ${priceLabel}${suffix}`;
        }
        ```
        The `SummaryRow label="Gas"` call site (~line 278) becomes `value={gasLine(state,
        liveFloorAnu)}`, reading `liveFloorAnu` from the component's destructured props.
      - `src/ui/builder/ExecuteTab.test.tsx`: everywhere a test builds
        `config: { chainId: "0", gasPriceAnu: 10000, ... }` (~lines 119, 128, 242), change to
        `config: { chainId: "0", gasPriceBufferAnu: 0, ... }` and pass `liveFloorAnu={10000}` to
        the rendered `<ExecuteTab .../>`. Update the corresponding expected `summary-gas` text:
        `"1,500 @ 10,000 ANU (floor) (AUTO)"` (~line 122), `"1,500 @ 10,000 ANU (floor)"` (~line
        132), `"42,000 @ 10,000 ANU (floor) (AUTO)"` (~line 256). Add two new tests: `"shows the
        priority buffer added onto the floor in the gas line"` (config `gasPriceBufferAnu: 500`,
        `liveFloorAnu={10000}` → `summary-gas` contains `"10,500 ANU (floor + 500)"`) and `"shows
        a loading placeholder in the gas line when the floor hasn't resolved"` (no `liveFloorAnu`
        prop → `summary-gas` contains `"@ … ANU"`).
      - `src/ui/builder/Builder.tsx`: import `useLiveGasFloor` from `./live-gas-floor.js`; call
        `const liveFloorAnu = useLiveGasFloor();` next to the existing `calibratedGasLimit`
        computation (~line 233-235); pass `liveFloorAnu={liveFloorAnu}` to both the `<ConfigTab
        .../>` call site (~line 295) and the `<ExecuteTab .../>` call site (~line 307-314).
      - `src/ui/builder/Builder.test.tsx`: add `vi.mock("@stoachain/stoa-core/gas", () => ({
        minGasPriceAnu: vi.fn(() => 12345) }))` at the top of the file (mirroring
        `stoachain.test.ts`'s module-mock idiom), and one new test that renders `<Builder
        access="admin" />` (or this file's existing helper for a fresh create-mode render),
        switches to the Config tab, and — using `waitFor`/`findByText` — asserts the live-floor
        display eventually shows `"12,345 ANU"`; then switches to the Execute tab and asserts
        the `summary-gas` row's text eventually contains `"12,345"`.
      - `npx vitest run src/ui/builder/ConfigTab.test.tsx src/ui/builder/ExecuteTab.test.tsx
        src/ui/builder/Builder.test.tsx` from `packages/khronoton-core` passes.
  - files: `packages/khronoton-core/src/ui/builder/ConfigTab.tsx`, `packages/khronoton-core/src/ui/builder/ConfigTab.test.tsx`, `packages/khronoton-core/src/ui/builder/ExecuteTab.tsx`, `packages/khronoton-core/src/ui/builder/ExecuteTab.test.tsx`, `packages/khronoton-core/src/ui/builder/Builder.tsx`, `packages/khronoton-core/src/ui/builder/Builder.test.tsx`

- [x] T7: `TxMeters.tsx` — swap the size-estimate effect's dependency from the removed
      `gasPriceAnu` to `gasPriceBufferAnu` — done when (depends on T5):
      - `src/ui/builder/TxMeters.tsx`'s `useEffect` dependency array (~line 97-106):
        `state.config.gasPriceAnu,` becomes `state.config.gasPriceBufferAnu,`. No other line in
        this file changes (it never reads the field directly, only depends on it to trigger a
        recompute).
      - `src/ui/builder/TxMeters.test.tsx`: confirm no reference to `gasPriceAnu` remains (none
        currently exists in this file). Add a new test to the `"TxMeters — Tx Size row"` describe
        block: `"the byte estimate grows when gasPriceBufferAnu adds digits to the serialized
        price"` — render `<TxMeters state={{ ...makeEmptyBuilderState(), pactCode:
        "(module-body)" }} sim={makeSim(undefined)} />`, `await waitFor` until resolved (mirror
        the existing `"resolves the async byte estimate..."` test's wait pattern), capture the
        rendered size text; separately render with `state.config.gasPriceBufferAnu` set to a
        large value (e.g. `999999999999`, enough extra digits to guarantee a byte-size increase),
        wait for resolution, and assert its estimate is larger than the buffer-0 render's.
      - `npx vitest run src/ui/builder/TxMeters.test.tsx` from `packages/khronoton-core` passes.
  - files: `packages/khronoton-core/src/ui/builder/TxMeters.tsx`, `packages/khronoton-core/src/ui/builder/TxMeters.test.tsx`

- [x] T8: `tx-size.ts` — estimate the price as live-floor + buffer, summed in ANU before the one
      conversion (same precision fix as T2, applied to the size meter) — done when (depends on
      T1, T5):
      - `src/ui/tx-size.ts`'s `estimateTxSize` (~line 63-115): the dynamic import
        `const { anuToStoaNumber } = await import("@stoachain/stoa-core/gas");` becomes
        `const { anuToStoaNumber, minGasPriceAnu } = await import("@stoachain/stoa-core/gas");`,
        and the `setMeta` call's `gasPrice: anuToStoaNumber(config.gasPrice),` line becomes
        `gasPrice: anuToStoaNumber(minGasPriceAnu(Math.floor(Date.now() / 1000)) + (config
        .gasPriceBufferAnu ?? 0)),`. Update the inline comment above it (~line 88-91) to explain
        this predicts the size using the same floor+buffer-summed-in-ANU-then-converted-once
        formula the executor uses (`config.gasPrice`, the deprecated field, is never read here).
      - `src/ui/tx-size.test.ts`: add a new test to the `"estimateTxSize"` describe block —
        `"grows the estimate when a large gasPriceBufferAnu adds digits to the serialized
        price"`: build one state via `makeEmptyBuilderState()` (buffer 0) and a second with
        `state.config.gasPriceBufferAnu = 999999999999`; `estimateTxSize` both; assert the
        buffered one's `bytes` is strictly greater (mirrors the existing `"adds at least 140
        bytes... per signer"` and `"grows with payload size..."` differential-test style already
        in this file).
      - `npx vitest run src/ui/tx-size.test.ts` from `packages/khronoton-core` passes.
  - files: `packages/khronoton-core/src/ui/tx-size.ts`, `packages/khronoton-core/src/ui/tx-size.test.ts`
