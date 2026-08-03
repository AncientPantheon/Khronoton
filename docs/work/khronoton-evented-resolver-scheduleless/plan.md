6 tasks, 3 waves. Vertical slice: registry → store/handler/adapter-contract → adapter-impls/UI.
Same-file work is grouped into one task (store/cronoton.ts create+edit+uniqueness = T3).

## Wave 1

- [x] T1: Add `evented` to the resolver registry + a `listServerResolvers` enumerator —
  done when, in `packages/khronoton-core/src/server/resolvers.ts`:
  - `SingleTxResolver` (~L55-59) and `MultiTxResolver` (~L67-70) each gain an optional `evented?: boolean;`
    field with a doc comment: "When true, this resolver is fired by an in-process EVENT, never by a schedule —
    a cronoton bound to it is scheduleless (the store forces `external_fireable = 1` / `next_fire_at = NULL`)
    and the Builder hides its schedule controls." (Both interfaces so `getServerResolver(name)?.evented`
    typechecks against the `ServerResolver` union without narrowing.)
  - A new `export function listServerResolvers(): { name: string; kind: ServerResolver["kind"]; evented:
    boolean }[]` that maps `Object.entries(SERVER_RESOLVERS)` → `{ name, kind: r.kind, evented: r.evented ===
    true }` (SERVER_RESOLVERS is the module-private map at ~L76, so this fn must live in this file). Sort by
    `name` for determinism.
  Tests in `packages/khronoton-core/src/server/resolvers.test.ts` (create it if absent; register resolvers via
  `registerServerResolver` — read any existing resolvers test for the register/reset pattern, and if the
  registry persists across tests, register uniquely-named resolvers per test to avoid cross-test bleed):
  register one `{ kind: "single-tx", evented: true, resolve, settle }` and one non-evented single-tx resolver,
  then assert `listServerResolvers()` includes both with `evented` true only for the flagged one, and each
  carries its `kind`.
  - files: `packages/khronoton-core/src/server/resolvers.ts`, `packages/khronoton-core/src/server/resolvers.test.ts`

- [x] T2: List UI shows "Evented" as the next-fire for a trigger-only row —
  done when, in `packages/khronoton-core/src/ui/CronotonList.tsx`:
  - `isTriggerOnly(row)` (~L100-109) returns true ALSO when `row.external_fireable === 1` — add
    `if (row.external_fireable === 1) return true;` as the first check, keeping the existing
    `runtime_arg_keys`-non-empty check after it. (No type change — `CodexCronotonRow` already carries
    `external_fireable?: number` and `runtime_arg_keys?: string | null`, and `listCodexCronotons` returns full
    rows since 0.6.1.)
  - The next-fire cell (~L214, currently `{row.next_fire_at ? <RelativeTime iso={row.next_fire_at}/> : EM_DASH}`)
    renders a styled **"Evented"** label when `isTriggerOnly(row)` is true (regardless of `next_fire_at`), else
    the existing `RelativeTime`/`EM_DASH`. Use a style already defined in the file (e.g. the `DIM` const) so it
    reads as a muted label, not a timestamp. Leave the Operation cell's existing `isTriggerOnly`-driven
    "External trigger" text unchanged.
  Tests in `packages/khronoton-core/src/ui/CronotonList.test.tsx` (extend the existing `makeRow`/`makeAdapter`/
  `mountList` harness): (a) a row with `external_fireable: 1` renders "Evented" in the next-fire column and does
  NOT render a next-fire timestamp; (b) a normal scheduled row (`external_fireable: 0`, non-null `next_fire_at`,
  no runtime args) still renders its `RelativeTime` next-fire (proving the label is conditional). Follow the
  file's existing column-assertion style.
  - files: `packages/khronoton-core/src/ui/CronotonList.tsx`, `packages/khronoton-core/src/ui/CronotonList.test.tsx`

## Wave 2 (depends on Wave 1)

- [x] T3: Store enforces evented→scheduleless+external_fireable, and one-resolver-one-cronoton —
  done when, in `packages/khronoton-core/src/server/store/cronoton.ts`:
  - Add `import { getServerResolver } from "../resolvers.js";` (verified acyclic).
  - **Uniqueness (create):** in `createCodexCronoton`, immediately after the existing runtime-args
    mutual-exclusion throw (~L122-126, `if (input.serverResolver && runtimeArgKeys.length > 0) throw …`), add:
    `if (input.serverResolver) { const existing = findCodexCronotonIdByServerResolver(input.serverResolver, {
    db: opts.db }); if (existing) throw new CodexCronotonValidationError(\`server resolver
    "\${input.serverResolver}" is already bound to cronoton \${existing} — delete it first\`); }`
    (`findCodexCronotonIdByServerResolver` is already in this file ~L190-201.)
  - **evented→scheduleless+external_fireable (create):** before the `triggerOnly` block (~L134) add
    `const evented = getServerResolver(input.serverResolver ?? "")?.evented === true; const externalFireable =
    input.externalFireable === true || evented;`. Change `triggerOnly` (currently
    `input.externalFireable === true || runtimeArgKeys.length > 0 || input.eventDriven === true`) to
    `externalFireable || runtimeArgKeys.length > 0 || input.eventDriven === true`. Change the INSERT's
    `external_fireable` bind from `input.externalFireable ? 1 : 0` to `externalFireable ? 1 : 0`.
  - **evented→scheduleless+external_fireable (edit):** in `editCodexCronoton` (apply-at-next-fire, ~L260-375),
    derive `const resolverName = patch.serverResolver !== undefined ? patch.serverResolver : row.server_resolver;
    const evented = getServerResolver(resolverName ?? "")?.evented === true;`. (a) Make the force-NULL condition
    `patch.eventDriven === true || evented` (the existing block ~L340-360 does `if (patch.eventDriven === true)
    { …nextFireAt = null } else if (scheduleChanged && !rowTriggerOnly) {…}` — broaden the first `if` to
    `patch.eventDriven === true || evented`, keeping the changedFields "schedule" marker push so the UPDATE
    runs). (b) The edit UPDATE (~L366) does NOT currently write `external_fireable` — add `external_fireable = ?`
    to its SET list and bind `const nextExternalFireable = evented ? 1 : (row.external_fireable ?? 0);` so an
    evented edit sets it to 1 while a non-evented edit preserves the row's current value (never clobbers it).
  - `resumeCodexCronoton` (~L435-442): NO code change — its `rowSchedulerOff = row.next_fire_at === null` guard
    already keeps an evented row (created with NULL) scheduler-off. Covered by a test below.
  Tests in `packages/khronoton-core/src/server/store/cronoton.test.ts` (better-sqlite3 in-memory + installSchema
  + `registerServerResolver` an evented `{ kind:"single-tx", evented:true, resolve, settle }` under a test name;
  use `validInput`/`commitCodexCronoton`/`editCodexCronoton`/`resumeCodexCronoton`/`fetchDueCodexCronotons`
  helpers already in the file):
  (a) commit a cronoton on the evented resolver WITH a real (`every-n-minutes`) schedule → `getRow(id)
  .next_fire_at` is NULL, `getRow(id).external_fireable === 1`, and `fetchDueCodexCronotons` (at a `now` past the
  schedule) excludes the id; (b) commit on a NON-evented resolver (or none) with the same schedule → non-null
  `next_fire_at` and `external_fireable === 0` (proving evented is the differentiator); (c) uniqueness: a second
  `commitCodexCronoton` reusing the same `serverResolver` throws `CodexCronotonValidationError` whose message
  contains the first cronoton's id; committing a DIFFERENT `serverResolver` succeeds; (d) edit a
  normally-scheduled cronoton onto the evented resolver (patch `{ serverResolver: <evented>, scheduleMode,
  scheduleConfig }`, no `eventDriven`) → `getRow(id).next_fire_at` becomes NULL and `external_fireable === 1`;
  (e) `resumeCodexCronoton` of an evented row keeps `next_fire_at` NULL.
  - files: `packages/khronoton-core/src/server/store/cronoton.ts`,
    `packages/khronoton-core/src/server/store/cronoton.test.ts`

- [x] T4: `GET /resolvers` read handler + the adapter CONTRACT (interface only) —
  done when:
  - `packages/khronoton-core/src/handlers/read.ts`: add `export async function resolversHandler(ctx:
    HandlerContext, request: HandlerRequest): Promise<HandlerResponse>` mirroring `listHandler`'s shape (~L74-90)
    — wrap in `withRead(ctx, request, async () => json(200, { ok: true, resolvers: listServerResolvers() }))`.
    Import `listServerResolvers` from `../server/index.js` (it flows through the `/server` barrel). It takes no
    params/query.
  - `packages/khronoton-core/src/handlers/index.ts`: export `resolversHandler` under a contract alias next to
    the other read handlers (~L18-23), e.g. `resolversHandler as listResolvers` — match the aliasing style used
    for `listHandler as listCodexCronotons` etc.
  - `packages/khronoton-core/src/provider/adapter.ts`: (1) add `export interface ResolversView { ok: true;
    resolvers: { name: string; kind: string; evented: boolean }[] }` near the other `*View` types (~L105);
    (2) add `resolvers?(): Promise<ResolversView>;` — an **OPTIONAL** method — to the read tier of the
    `KhronotonAdapter` interface (~L204, beside `signers()`). **Do NOT add `"resolvers"` to `REQUIRED_METHODS`.**
    Rationale: adding a REQUIRED adapter method is a breaking change for every existing consumer adapter (and
    every fake-adapter test fixture in this suite) on upgrade — inappropriate for a MINOR bump. Optional +
    graceful degradation (T6) keeps this non-breaking; both reference adapters still implement it (T5), and
    Pythia provides it.
  Tests: (a) handler — in the existing read-handler test file (find it near
  `packages/khronoton-core/src/handlers/read.test.ts`; it uses `tests/handlers/harness.ts`): register an evented
  + a non-evented resolver, call `resolversHandler` through the harness, assert `status === 200` and the body is
  `{ ok: true, resolvers: [...] }` containing both with the right `evented` flags. (b) `assertAdapter` — in the
  existing adapter test (`packages/khronoton-core/src/provider/adapter.test.ts`): assert `assertAdapter` STILL
  PASSES for an adapter WITHOUT a `resolvers` method (proving the addition is non-breaking / `resolvers` is not
  required) — a one-line assertion using whatever minimal adapter fixture that test already builds.
  Depends on T1 (`listServerResolvers`). Do NOT touch the adapter IMPLEMENTATIONS here (T5). Because `resolvers`
  is OPTIONAL and NOT required, this task does NOT need to touch any other test file's fake adapter — existing
  provider-mounting tests are unaffected.
  - files: `packages/khronoton-core/src/handlers/read.ts`, `packages/khronoton-core/src/handlers/index.ts`,
    `packages/khronoton-core/src/provider/adapter.ts`, the existing read-handler test file
    (`packages/khronoton-core/src/handlers/read.test.ts`), `packages/khronoton-core/src/provider/adapter.test.ts`

## Wave 3 (depends on Wave 2)

- [x] T5: Implement `resolvers()` in both reference adapters —
  done when:
  - `packages/khronoton-core/src/provider/fetch-adapter.ts`: add `resolvers()` to the read tier (beside
    `signers()` ~L161): `resolvers() { return request<ResolversView>("GET", "/resolvers"); }`. Import
    `ResolversView` from the adapter types.
  - `packages/khronoton-core/src/provider/memory-adapter.ts`: add `resolvers()` beside `signers()` (~L205):
    `resolvers() { return call<ResolversView>(resolversHandler, {}); }` — import the resolvers handler (via the
    same handler-import path the memory adapter already uses for `fetchSigners`/`listCodexCronotons`; use the
    contract alias from `handlers/index.ts`) and `ResolversView`.
  Tests (extend the existing fetch-adapter and memory-adapter test files): (a) fetch-adapter `resolvers()` issues
  a `GET` to the `/resolvers` path (assert via the mocked fetch/request spy the existing tests use); (b)
  memory-adapter `resolvers()` returns the handler body `{ ok: true, resolvers: [...] }` for a registered evented
  resolver (register one in the test's ctx setup). Follow each file's existing test harness exactly.
  Depends on T4 (`ResolversView`, the `resolvers()` interface method, and the `resolversHandler` alias).
  - files: `packages/khronoton-core/src/provider/fetch-adapter.ts`,
    `packages/khronoton-core/src/provider/memory-adapter.ts`, their existing test files
    (`packages/khronoton-core/src/provider/fetch-adapter.test.ts`,
    `packages/khronoton-core/src/provider/memory-adapter.test.ts`)

- [x] T6: Builder fetches /resolvers → server-authoritative evented + external-fireable auto-set —
  done when:
  - New hook `packages/khronoton-core/src/hooks/useServerResolvers.ts`: mirrors the once-fetch pattern of
    `useCronotons.ts` (read it) — reads the adapter from context and, since `resolvers` is OPTIONAL, calls it
    undefined-safely: `if (typeof adapter.resolvers !== "function") { setResolvers([]); return; }` then
    `adapter.resolvers()` once on mount. Returns `{ resolvers, loading, error }` (resolvers = the
    `ResolversView["resolvers"]` array, `[]` before load / on error / when the adapter lacks the method — a
    missing method or failed fetch must NOT throw or block the Builder). Export it from `hooks/index.ts`.
  - `packages/khronoton-core/src/ui/builder/Builder.tsx`: call `useServerResolvers()`; build
    `const eventedNames = new Set(resolvers.filter((r) => r.evented).map((r) => r.name));`. Change the
    `eventDrivenResolver` derivation (~L147-150) to `Boolean(state.serverResolver && (eventedNames.has(
    state.serverResolver) || config.serverResolverOptions.find((o) => o.value === state.serverResolver)
    ?.eventDriven))`. Add a `useEffect` keyed on `[eventDrivenResolver]` that, when `eventDrivenResolver` is
    true and `state.externalFireable` is not already true, flips it on ONCE:
    `setState((s) => (s.externalFireable ? s : { ...s, externalFireable: true }))` (only false→true; never force
    it back off — a non-evented resolver simply doesn't trigger the effect, and the user can still uncheck it
    for non-evented rows). The existing `builderToCommit(state, { eventDriven: eventDrivenResolver })` (~L197)
    and `<ExecuteTab eventDrivenResolver={...} />` (~L291) are unchanged — the ScheduleStep-hidden +
    EVENT_DRIVEN_NOTICE display is already handled by ExecuteTab (0.6.0). No ExecuteTab change.
  Tests in `packages/khronoton-core/src/ui/builder/Builder.test.tsx` (extend the existing fake-adapter mount;
  the fake adapter now needs a `resolvers` method — add it to the adapter factory returning
  `{ ok: true, resolvers: [{ name: "evt-resolver", kind: "single-tx", evented: true }] }`): mount, select
  "evt-resolver" in the "Server resolver" dropdown, then on the Execute tab assert (a) the event-driven notice
  renders and `queryByLabelText("Mode")` (ScheduleStep) is null, and (b) after clicking Commit (through the
  existing gate-clearing steps — name + gas-station key), the `commit` spy's body has
  `envelope.externalFireable === true` AND `envelope.eventDriven === true` AND `envelope.serverResolver ===
  "evt-resolver"`. Existing Builder tests are unaffected: `resolvers` is OPTIONAL (T4), so a fake adapter
  without it passes `assertAdapter`, and `useServerResolvers` returns `[]` → `eventDrivenResolver` falls back to
  the 0.6.0 `serverResolverOptions.eventDriven` (false in those tests). Only THIS test's adapter adds the
  `resolvers` mock; no change to other fake adapters.
  Depends on T4 (the `resolvers()` adapter method + `ResolversView`). Uses a fake adapter, so it does not depend
  on T5's real impls.
  - files: `packages/khronoton-core/src/hooks/useServerResolvers.ts`, `packages/khronoton-core/src/hooks/index.ts`,
    `packages/khronoton-core/src/ui/builder/Builder.tsx`, `packages/khronoton-core/src/ui/builder/Builder.test.tsx`
