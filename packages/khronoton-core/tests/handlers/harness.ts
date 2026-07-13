/**
 * Shared handler test harness — the single seam the four Wave-2 group tests
 * (read / cronoton / execute / batch) build their fixtures on.
 *
 * It stands up a REAL in-memory `better-sqlite3` + `installSchema` (mirroring
 * `src/server/store/*.test.ts`), a MOCK `ChainRuntime` + `KeyResolver` (the
 * shapes from `src/server/executor.test.ts`), a spy `onAudit`, a fixed
 * `resolveFireMode: () => 'live'`, and a full `Config`, then assembles them into
 * a {@link HandlerContext}. Swappable auth seams (default-open, read-deny,
 * confirm-required) let a group test drive the gate branches, and `seedCronoton`
 * commits a real row through the store so a handler's side-effects can be queried
 * back. This file lives under `tests/` so nothing test-only ships in `dist/`
 * (`tsconfig.build.json` excludes `tests/**`).
 */
import BetterSqlite3 from "better-sqlite3";
import { vi } from "vitest";

import {
  commitCodexCronoton,
  installSchema,
  type ChainRuntime,
  type Config,
  type KeyResolver,
  type CommitCodexCronotonInput,
} from "../../src/server/index.js";
import {
  defaultOpenAuth,
  type AuthSeam,
  type HandlerContext,
} from "../../src/handlers/context.js";
import { json, type HandlerRequest } from "../../src/handlers/http.js";

// ── Mock chain runtime + resolver (the executor-test shapes) ──────────────────

/** The configurable client spies a group test tunes per-case (dirty-read / submit / listen). */
export interface RuntimeMocks {
  dirtyRead: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
  universalSignTransaction: ReturnType<typeof vi.fn>;
  isSignedTransaction: ReturnType<typeof vi.fn>;
}

function makeRuntime(): { runtime: ChainRuntime; mocks: RuntimeMocks } {
  const dirtyRead = vi.fn(async () => ({ result: { status: "success", data: "OK" }, gas: 700 }));
  const submit = vi.fn(async () => ({ requestKey: "RK-TEST" }));
  const listen = vi.fn(async () => ({ result: { status: "success", data: "DONE" }, reqKey: "RK-TEST" }));
  const universalSignTransaction = vi.fn(async () => ({ cmd: "SIGNED", sigs: [{ sig: "x" }] }));
  const isSignedTransaction = vi.fn(() => true);

  const runtime: ChainRuntime = {
    Pact: {
      builder: {
        execution: (code: string) => {
          const builder: Record<string, unknown> = {};
          const chain = () => builder;
          builder.setMeta = chain;
          builder.setNetworkId = chain;
          builder.addData = chain;
          builder.addSigner = chain;
          builder.createTransaction = () => ({ cmd: code, sigs: [] });
          return builder;
        },
      },
    },
    createClient: () => ({ dirtyRead, submit, listen }),
    isSignedTransaction,
    universalSignTransaction,
    calculateAutoGasLimit: (gas: number) => gas * 2,
    anuToStoa: (anu: number) => anu / 1e12,
    getPactUrl: (chainId: string) => `https://node/${chainId}`,
    networkId: "stoa",
    namespace: "ouronet-ns",
    gasStationAccount: "c:GASSTATION",
  };
  return { runtime, mocks: { dirtyRead, submit, listen, universalSignTransaction, isSignedTransaction } };
}

function makeResolver(pubs: string[] = []): KeyResolver {
  return {
    getKeyPairByPublicKey: vi.fn(async (publicKey: string) => ({
      publicKey,
      privateKey: "deadbeef",
      seedType: "koala",
    })),
    listCodexPubs: vi.fn(async () => new Set(pubs)),
  };
}

// ── Full config (every field set — a handler never falls back to a default) ───

const FULL_CONFIG: Config = {
  tickIntervalMs: 30_000,
  listenTimeoutMs: 300_000,
  autoGasCeiling: 2_000_000,
  singleTxGasGuard: 1_600_000,
  tickBatchLimit: 100,
  manualBatch: { min: 2, max: 60, intervalSeconds: 60 },
};

// ── Swappable auth seams (drive the gate branches) ────────────────────────────

/** A read gate that always denies with 403 — asserts a `withRead` short-circuit. */
export const denyReadAuth: AuthSeam = {
  requireRead: () => ({ ok: false, response: json(403, { error: "forbidden" }) }),
  requireConfirm: () => ({ ok: true, identity: {} }),
};

/**
 * A confirm gate that always denies with 401 `admin_confirm_required` regardless
 * of `req.confirmed` — asserts the confirm-required branch deterministically.
 */
export const confirmRequiredAuth: AuthSeam = {
  requireRead: () => ({ ok: true, identity: {} }),
  requireConfirm: () => ({ ok: false, response: json(401, { error: "admin_confirm_required" }) }),
};

// ── The harness ───────────────────────────────────────────────────────────────

export interface TestHarness {
  ctx: HandlerContext;
  db: BetterSqlite3.Database;
  onAudit: ReturnType<typeof vi.fn>;
  runtime: RuntimeMocks;
  resolver: KeyResolver;
  /** Close the in-memory DB (call in `afterEach`). */
  close(): void;
}

/**
 * Build a ready-to-drive {@link HandlerContext} over a fresh in-memory DB. Pass
 * `overrides` to swap any seam — e.g. `{ auth: denyReadAuth }` to exercise a
 * read-deny, `{ signers }` to inject a richer signer source. The mock runtime's
 * client spies are reachable via the returned `runtime` for per-case tuning.
 */
export function buildTestCtx(overrides: Partial<HandlerContext> = {}): TestHarness {
  const db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  installSchema(db);

  const { runtime, mocks } = makeRuntime();
  const resolver = makeResolver();
  const onAudit = vi.fn();

  const ctx: HandlerContext = {
    db,
    runtime,
    resolver,
    resolveFireMode: () => "live",
    onAudit,
    config: FULL_CONFIG,
    auth: defaultOpenAuth,
    ...overrides,
  };

  return {
    ctx,
    db,
    onAudit,
    runtime: mocks,
    resolver,
    close: () => db.close(),
  };
}

// ── Request builder ───────────────────────────────────────────────────────────

/** Build a {@link HandlerRequest} with sensible empty defaults; spread `init` to override. */
export function req(init: Partial<HandlerRequest> = {}): HandlerRequest {
  return { params: {}, query: {}, body: undefined, ...init };
}

// ── Seed helper (commits a real row through the store) ────────────────────────

const FUTURE_ONE_TIME = {
  mode: "one-time" as const,
  fireAt: "2099-01-01T00:00:00.000Z",
};

/** A valid commit input; override any field to shape a fixture row. */
export function validCommitInput(
  overrides: Partial<CommitCodexCronotonInput> = {},
): CommitCodexCronotonInput {
  return {
    name: "Harness cronoton",
    description: null,
    pactCode: '(coin.transfer "a" "b" 1.0)',
    config: { chainId: "0", gasPrice: 1, gasLimit: 1500, autoGasLimit: false, ttl: 600 },
    payload: {},
    gasPayer: { type: "gas-station" },
    signers: [],
    scheduleMode: "one-time",
    scheduleConfig: FUTURE_ONE_TIME,
    createdBy: "admin@x",
    ...overrides,
  };
}

/** Commit a real cronoton row into the harness DB and return its id + nextFireAt. */
export function seedCronoton(
  db: BetterSqlite3.Database,
  overrides: Partial<CommitCodexCronotonInput> = {},
): { id: string; nextFireAt: string | null } {
  return commitCodexCronoton(validCommitInput(overrides), { now: new Date(), db });
}
