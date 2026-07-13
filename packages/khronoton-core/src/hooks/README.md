# Khronoton hook API (the Phase-E data-layer contract)

The consumer-facing data layer of `@ancientpantheon/khronoton-core`. Phase-E UI
consumes exactly this surface — no other entry reaches the backend. Two published
subpaths back it:

- `@ancientpantheon/khronoton-core/provider` — the mount root + the adapter seam.
- `@ancientpantheon/khronoton-core/hooks` — the data + action hooks below.

`react`/`react-dom` are **peer** deps (`^18 || ^19`); both subpaths ship ESM with
React external.

## Mount recipe

Mount `<KhronotonProvider>` once at the tree root with a **required `adapter`**
prop. Everything under it reads the adapter + resolved config from context. The
provider is SSR-safe (no adapter call / poller fires during a server render), but
the Phase-E consumer still mounts it `ssr:false` (dynamic import) per REQ-PB03.

```tsx
import {
  KhronotonProvider,
  createFetchAdapter, // HTTP reference adapter (browser/server)
  // createMemoryAdapter — in-process handler driver for SSR-seed / tests / demos
} from "@ancientpantheon/khronoton-core/provider";

const adapter = createFetchAdapter("/api/admin/codex-cronotons");

<KhronotonProvider
  adapter={adapter}                       // REQUIRED — assertAdapter() validates it at mount
  explorerBase="https://explorer.stoachain.com/transactions" // default
  onNeedConfirm={async () => askUserToReconfirm()}           // Promise<boolean> — drives runGated retry
  showMode={true}                         // TEST/LIVE mode-column policy (default true)
  renderMultiTx={(fire) => <PoolPayout fire={fire} />}       // optional multi-tx breakdown renderer
  serverResolverOptions={[{ value, label }]}                 // server-resolver dropdown registry
  pageSize={50}                           // fire-history page size (default 50)
  pollCadenceMs={5000}                    // poller cadence (default 5000)
>
  {children}
</KhronotonProvider>;
```

`useKhronoton()` (also re-exported from `/hooks`) → `{ ready, error, adapter,
config }`; `ready` flips true after the browser-only init.

## Data hooks

| Hook | Signature | Returns |
| --- | --- | --- |
| `useCronotons` | `(query?: ListCronotonsQuery) => UseCronotonsView` | `{ cronotons: CodexCronotonRow[]; loading; error: Error \| null; refetch(): Promise<void> }` — loads `adapter.list` on mount; load errors surface (not swallowed). |
| `useCronoton` | `(id: string) => UseCronotonView` | `{ cronoton: CodexCronotonRow \| null; loading; error; refetch }` — re-loads on `id` change; a 404 surfaces as `error`, `cronoton` stays null. |
| `useCronotonFires` | `(id: string, opts?: { pageSize?: number }) => UseCronotonFiresResult` | `{ fires: CodexCronotonFireRow[]; total; page; pageCount; loading; error; setPage(n); refetch() }` — 0-based offset paging (`offset = page*pageSize`, default 50). **Poller #1**: silently re-fetches every `pollCadenceMs` while any fire on the page is `running`; poll errors swallowed. |
| `useManualBatch` | `(id: string) => UseManualBatchResult` | `{ batch: ManualBatchView \| null; active; loading; error; refetch }` — `active = batch.status==='active'`. **Poller #2**: polls `getBatch` every `pollCadenceMs` while active; poll errors swallowed. |

## Lifecycle action hook (confirm-gated)

`useCronotonActions(id?, { onSuccess? }) => CronotonActions`:

```ts
const { create, edit, pause, resume, remove } = useCronotonActions(id, { onSuccess: refetch });
```

Each action is a `GatedAction`: `{ run(...args), pending, error, result }`. `run`
routes through the shared **`runGated`** confirm helper (confirm → adapter method
→ on `NeedsConfirmError` re-prompt via `onNeedConfirm` + retry **once**) and
resolves an `ActionResult<T>` envelope — `{ ok:true, result }` or `{ ok:false,
error }` — never throwing. A success fires `onSuccess` (the host's SSR-style
refetch).

- `create.run(body: CommitBody)` → `CommitView`
- `edit.run(patch: EditPatch)` → `EditView` (needs a bound `id`)
- `pause.run()` / `resume.run()` → `ToggleView`
- `remove.run()` → `DeleteView` (a delete-locked system row surfaces the handler's 409 as `{ ok:false, error }`)

## Execution action hooks

Each returns `UseExecuteActionResult` = `{ run(...args): Promise<TView |
undefined>; pending; error; result? }`. `run` resolves the adapter body (or
`undefined` when it threw).

| Hook | `run` args | Body | Gate |
| --- | --- | --- | --- |
| `useExecuteNow` | `(id)` | `ExecuteView` | gated |
| `useTrigger` | `(id, args: RuntimeArgs)` | `ExecuteView` | gated |
| `useSimulate` | `(envelope: SimulateEnvelope)` | `SimulateView` | gated |
| `useStartBatch` | `(id, count)` | `StartBatchView` | gated |
| `useCancelBatch` | `(id)` | `CancelBatchView` | **confirm-free** (one-click stop, REQ-H09) |
| `useRecoverFire` | `(id, fireId, requestKey)` | `RecoverView` | gated (REQ-G09) |

**200-on-`ok:false`:** `executeNow` / `trigger` / `simulate` return the body even
when `result.ok` is false (a chain/build failure rides in `result.error`;
`queued:true` marks the 202 multi-tx path). Only a real transport error or a
declined confirm sets `error` and returns `undefined`. `requestKey` for
`recoverFire` must match `^[A-Za-z0-9_-]{40,48}$` (the handler validates; a 400
surfaces cleanly in `error`).
