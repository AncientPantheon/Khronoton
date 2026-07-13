# Khronoton — Retainer 01

> **Purpose.** A self-contained knowledge handoff so a fresh conversation (new context,
> post-plugin-load) retains everything learned building khronoton-core up through
> **v0.4.0**. Read this first. Retainers are numbered (01, 02, …); newer ones amend
> older — treat the highest-numbered as authoritative where they conflict.
>
> **As of:** 2026-07-13 · **Latest published:** `@ancientpantheon/khronoton-core@0.4.0`

---

## 1. What Khronoton is

The **"When do I act?" Constructor** of the AncientPantheon stack — the heartbeat that
separates an autonomous **Automaton** from a human-triggered **Daimon**. It is a headless,
framework-agnostic scheduler that decides *when* things are due and *what* to fire; hosts
inject storage + firing.

- npm: **`@ancientpantheon/khronoton-core`** · license **UNLICENSED** (proprietary)
- repo: `github.com/AncientPantheon/Khronoton` · npm scope `@ancientpantheon`
- Extracted + generalised from the AncientHoldings Hub's inline scheduler ("Cronoton" /
  "codex-cronoton", ~4,250 lines).

**Repo layout** (working dir `D:\_Claude\AncientPantheon\Khronoton`, branch `main`):
- `packages/khronoton-core/` — the single published package (npm workspace `packages/*`).
- `.bee/` — Bee workflow spec + state (**gitignored**). Active spec:
  `.bee/specs/2026-07-13-khronoton-experience-layer/`. `.bee/STATE.md` is the project state.
- `preview/index.html` — the ancient-approved localhost mockup (Hub palette, 4 screens,
  50/page fire pager, theme switcher). Untracked; handed to Mnemosyne's localhost agent.
- Persistent memory: `C:\Users\bicam\.claude\projects\D---Claude-AncientPantheon-Khronoton\memory\`
  (`MEMORY.md` is the index).

---

## 2. Current published state (v0.4.0)

`latest` on public npm. **8 JS subpaths + `/ui.css`**, every JS subpath dual-condition
`{types,import,require}`:

| Subpath | Since | What it is |
|---|---|---|
| `.` | 0.1.0 | 7-mode schedule math + injectable `tickOnce` (byte-unchanged since 0.1.0) |
| `/server` | 0.2.0 | Stand-alone automaton engine behind 6 seams (byte-unchanged since 0.2.0) |
| `/handlers` | 0.3.0 | Framework-agnostic HTTP route handlers over store+executor |
| `/provider` | 0.3.0 | React data layer root + 16-method adapter seam + reference adapters |
| `/hooks` | 0.3.0 | Data + action hooks |
| `/ui` + `/ui.css` | 0.3.0 | Four screens at full Hub parity, `--khr-*` themed |
| `/blockchain/stoachain` | 0.4.0 | `createStoachainRuntime()` → the `ChainRuntime` seam over `@stoachain/*` |

**Version trail:** `0.0.1` skeleton → `0.1.0` schedule+tick → `0.1.1` CJS drop-in fix →
`0.2.0` server/automaton → `0.3.0` experience layer → `0.4.0` chain-polyglot. Release
commit for 0.4.0: `1753361` (tag `v0.4.0`).

---

## 3. Architecture — khronoton is chain-**POLYGLOT**

**User's firm decision (2026-07-13):** khronoton is *not* chain-agnostic — it natively
speaks every supported chain's language (cf. the zodiac-of-chains logo). The chain
adapters live as **`/blockchain/<chain>` subpaths INSIDE core**, NOT as separate npm
packages per chain.

- Root `.` and `/server` stay **chain-free** — they orchestrate. `/blockchain/<chain>`
  subpaths **implement** the `ChainRuntime` seam (defined in `/server`) for each chain.
- `/blockchain/stoachain` → `createStoachainRuntime(config?) → Promise<ChainRuntime>`
  wrapping `@stoachain/kadena-stoic-legacy`, `@stoachain/stoa-core`, `@stoachain/ouronet-core`.
- **Each chain SDK is an OPTIONAL peer dependency, imported LAZILY** (all
  `await import("@stoachain/…")` live *inside* the factory — no top-level import). So
  `npm install @ancientpantheon/khronoton-core` pulls **zero** chain SDKs; importing the
  subpath costs nothing; only calling the factory needs the SDK. A consumer carries only
  the SDK(s) for the chain(s) it imports. One package, one version, one drop-in.
- Future chains (`/blockchain/arweave`, …) land as sibling subpaths the same way.
- **This reversed an earlier plan** (a separate `@ancientpantheon/khronoton-stoachain`
  package, held unpublished). That standalone package was **deleted**; its code →
  `src/blockchain/stoachain.ts`, its tests → `src/blockchain/*.test.ts` / `*.real.test.ts`.
- Intended consumers: **Mnemosyne, Caduceus, Aletheia** (≥3 StoaChain automatons).

---

## 4. The seams & how a consumer wires it

`/server` exposes **6 injection seams** (host provides all): `KeyResolver` (codex signing),
`ChainRuntime` (chain client/constants — satisfy via `/blockchain/<chain>`), `Database`
(a minimal structural interface; `better-sqlite3` satisfies it), `onAudit`,
`resolveFireMode` (**must be synchronous** — an async return binds a Promise into the fire
INSERT and every fire silently fails), and a 6-field `Config`.

- **Load-bearing invariant:** exactly-once firing via an **atomic claim-before-fire** — a
  conditional `UPDATE` that re-asserts the due predicate and advances `next_fire_at` in the
  same statement, firing only on `changes === 1`. Two overlapping ticks fire a row once.
  A double-fire = double-signing a real on-chain tx. No leader election.
- Provider/adapter pattern (mirrors `@ancientpantheon/codex`): `<KhronotonProvider adapter>`,
  the 16-method `KhronotonAdapter` seam, reference adapters `createFetchAdapter` (HTTP) /
  `createMemoryAdapter` (in-process handlers), `runGated` (confirm → retry-once on
  `NeedsConfirmError`).
- **Auth tier is a component prop (`access`), NOT provider config** — the provider only
  carries the confirm gate. `Access = { tier: 'logged-out'|'non-admin'|'admin'; email? }`.
- Theming: components style ONLY via inline `var(--khr-*)`; tokens on `:root, .khronoton-ui`
  in `ui.css`; consumers recolor at `body .khronoton-ui`. `<KhronotonUiRoot>` scopes it.
  No Tailwind, no bundled assets.

---

## 5. Build discipline (do not break)

- **Byte-stability:** `.`/`/server`/`/handlers` build via **`tsc`** (`tsconfig.build.json`).
  Their `dist` output is **SHA-256 byte-identical across versions** (verified 42/42 for
  `dist/index.*` + `dist/schedule.*` + `dist/server/**` on every release). Before shipping
  any change that touches UI/handlers, capture SHA of that set, build, diff — must be 0
  changed.
- **`.tsx` / CSS / `/blockchain`** build via **`tsup`** (ESM), externals: `react`,
  `react-dom`, `/^@codemirror/`, `@uiw/react-codemirror`, `/^@stoachain/`.
  `tsconfig.build.json` **excludes** `src/provider`, `src/hooks`, `src/ui`, `src/blockchain`
  (so `tsc` never emits them → no collision with tsup).
- CSS concat: `scripts/bundle-css.mjs` → `dist/ui.css`. Build script:
  `tsc -p tsconfig.build.json && tsup && node scripts/bundle-css.mjs`.
- **Dual-condition exports are mandatory** (0.1.1 lesson: ESM-only breaks CJS `require`
  with `ERR_PACKAGE_PATH_NOT_EXPORTED`). Package is `"type": "module"`; `require` points at
  the same ESM `.js` and Node ≥20.19/22.12/24 loads it via `require(esm)`.
- **React + `@stoachain/*` are optional peers** (`peerDependenciesMeta.*.optional = true`),
  each dev-installed so tests run.
- **Dist smoke:** `scripts/smoke.all.cjs` (require) + `scripts/smoke.all.mjs` (import)
  assert every subpath resolves via the exports map. Run both after every build.

---

## 6. Testing

- `vitest`. Global env `node` (keeps `/server` + `better-sqlite3` native). Hook/UI tests are
  `*.test.tsx` with **first line `// @vitest-environment jsdom`** + `afterEach(cleanup)`.
- **Gate suite: 799 tests.** Mount UI with `<KhronotonProvider adapter={createMemoryAdapter({db})}>`
  or a fake 16-method adapter.
- **`*.real.test.ts` (real `@stoachain` SDK) are EXCLUDED from the gate** —
  `vitest.config.ts` excludes `**/*.real.test.ts`; they run via
  **`npm run test:integration`** (`vitest.integration.config.ts`). They are the Node-24
  sequential-import regression guard, not a release gate (a release must not depend on the
  external chain SDK behaving in CI).
- Reviews earn their keep: adversarial bug-detectors over *assembled* surfaces caught real
  bugs the green suite hid (runaway batch-cancel, the Node-24 crash, a stale-response race,
  a Builder **stale-`editId` overwrite**, an `executeDisabled` **terminal-gate gap**). Always
  review integration/assembly code adversarially; ask "does the test prove it, or encode the
  same wrong assumption as the code?".

---

## 7. Publish mechanics

- **Tag-triggered, immutable.** Push `git tag v<X.Y.Z>` where `X.Y.Z` == core's
  `package.json` version → `.github/workflows/publish.yml` → `npm publish --provenance`.
- **`publish.yml` is CORE-ONLY** (`--workspace=@ancientpantheon/khronoton-core`). The gate
  step is **split** into separate **Typecheck / Build / Test** steps so a failure localises
  from the run summary alone.
- **3 doc gates** (grep, must pass): README `## Status` block leads with
  `` `X.Y.Z` on public npmjs ``; README history has `^**vX.Y.Z** `; CHANGELOG first `## `
  heading is `## X.Y.Z`.
- Idempotent (skips if the version is already on npm). `NPM_TOKEN` = AncientPantheon GitHub
  org secret. **CI runs Node 22**; local is Node 24.
- **Release pattern for this repo: commit on `main` + tag** (releases are main-based, not
  feature-branched — see `289f8a4`, `8a77fb3`, `1753361`).
- **Monitoring (no `gh` CLI here; Actions logs API is 403 unauthenticated):**
  - poll `npm view @ancientpantheon/khronoton-core version` until it flips.
  - step-level status: `curl -s https://api.github.com/repos/AncientPantheon/Khronoton/actions/runs?per_page=2`
    then `.../actions/runs/{id}/jobs` (public JSON — shows each step's conclusion).
  - the browser tool struggles with the Actions SPA (renders 0×0 / hangs) — don't rely on it.

---

## 8. Hard-won gotchas (read before any release)

1. **NEVER regenerate the lockfile with `rm package-lock.json && npm install --package-lock-only --prefer-offline`.**
   During 0.4.0 this pruned the tree **330 → 305 packages**, dropping `better-sqlite3`'s
   transitive deps. CI's install went *green* but `better-sqlite3` failed at runtime →
   all 14 server-store suites failed (`db` undefined). **Burned two failed publish runs.**
   To update a lockfile: run a normal full `npm install` (network), then surgically delete
   any stale workspace entry (a tiny node script) rather than nuking the file. Verify the
   package count stays near the known-good baseline and native deps survive.
2. **Reproduce CI Node 22** with `npx node@22` — but the git-bash shim is broken; `find` the
   real exe: `C:/Users/bicam/AppData/Local/npm-cache/_npx/*/node_modules/node/bin/node.exe`
   and invoke tools directly (`"$N22" node_modules/typescript/bin/tsc …`). **Caveat:**
   `better-sqlite3` built for Node 24 fails on Node 22 with an ABI mismatch (`db` undefined) —
   a **local artifact**, not the CI cause. Rebuild or discount those failures.
3. **Node-24 `@stoachain` import race:** loading the 5 `@stoachain/*` modules via
   `Promise.all` crashes Node 24 (`ERR_INTERNAL_ASSERTION`). Fix = **sequential
   `await import()`**. Guarded by `src/blockchain/stoachain.real.test.ts` (integration run).
4. **`resolveFireMode` must be synchronous** (async → Promise in the fire INSERT → silent
   fire failure). **JSON.parse of config inside the claim try/catch** (corrupt config → NULL
   branch, not a fire-storm).
5. **Test-file typecheck nits:** `vi.fn(async () => …)` with no params makes `.mock.calls[0][0]`
   a `[]`-tuple index error under `noUnusedLocals`/tuple checks — type the mock params. And
   `ok: true` infers `boolean` not `true` — add `as const`.

---

## 9. Staged-integration gate (user policy)

**Do NOT wire consumers onto khronoton until all three Constructors — Pythia, Codex,
Khronoton — are finalized.** The Hub rewire onto 0.1.1 was deliberately reverted for this.
Mnemosyne is the first intended consuming Automaton; its wire-in is technically unblocked
(it can inject `createStoachainRuntime()` + host seams) but **held** until the gate clears.

---

## 10. Working boundaries & style (user)

- Drive to done autonomously; don't ask unless you truly can't proceed. **"publish" /
  "commit" are durable authorization.**
- **Mnemosyne is a SEPARATE repo with its own localhost agent.** Deliver changes to it via
  **short handoff docs** (`D:/_Claude/AncientPantheon/Mnemosyne/docs/handoffs/`) — do NOT
  edit Mnemosyne directly or run its dev servers.
- Bee workflow: spec → plan-phase → ship (implementer agents per wave, TDD) → review
  (bug-detector) → verify. Disk-is-truth, no auto-commit, checkbox tracking in `TASKS.md`.
  Background agents occasionally die mid-write on API errors — if so, complete the file
  directly against the (verified) test.

---

## 11. Forward feature idea (recorded, NOT built)

**Automaton provenance marker.** Embed an identifier in fired txs (e.g. Kadena
`nonce = "khronoton:<automatonId>:<cronotonId>:<fingerprint>"` + a signer registry for
verifiability) so **StoaExplorer** can badge automaton transactions and deep-link them back
to the cronoton's public read-only view. Not scoped/planned yet — a candidate for a future
retainer/spec.

---

## 12. Quick pointers

- **Full published detail + seams:** memory `khronoton-core-published.md`.
- **Why chain-polyglot / subpaths:** memory `khronoton-chain-polyglot-architecture.md`.
- **Lockfile lesson:** memory `khronoton-lockfile-regen-caution.md`.
- **User style:** memory `khronoton-user-working-style.md`.
- **Provenance idea:** memory `khronoton-automaton-provenance-idea.md`.
- **Spec/plan/waves + decisions log:** `.bee/STATE.md` + the active spec dir.
- Recon grounding docs (Hub parity, builder fields, adapter spec) live under `.bee/recon/`.
