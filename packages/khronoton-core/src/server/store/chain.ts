/**
 * commitChainedCronoton — author a CHAINED codex-cronoton: one parent
 * `codex_cronotons` row + N ordered `codex_cronoton_steps` rows, with an optional
 * single-tx-first variant written into the parent's own fields.
 *
 * ── NOT atomic on its own (by design) ─────────────────────────────────────────
 * The package `Database` seam deliberately omits `transaction` (see `seams.ts`),
 * so this helper performs the write SEQUENCE (parent commit → insertStep × N →
 * enable the single-tx flag) but does NOT open a transaction. The CONSUMER wraps
 * this call in its own real transaction — e.g. the Hub's better-sqlite3
 * `db.transaction(() => commitChainedCronoton(input, { db }))`. That keeps the
 * package DB-agnostic while still owning the chained-commit logic.
 *
 * ── Parent row ────────────────────────────────────────────────────────────────
 * The engine gates the chained run on `steps.length > 0`, so by default the
 * parent's single-tx columns are inert placeholders that only satisfy the shared
 * table's NOT-NULL columns + the single-tx commit validation. When
 * `singleTxFirst` is supplied those same fields ARE the operator's one-shot
 * variant, and `try_single_tx_first` is enabled via a post-insert edit (the store
 * refuses the flag at commit time — "add steps first").
 */
import type { ScheduleConfig, ScheduleMode } from "../../schedule.js";
import { installSchema } from "../schema.js";
import type { DbDep } from "../seams.js";
import type { CodexGasPayer, CodexTxConfig } from "../types.js";
import {
  commitCodexCronoton,
  editCodexCronoton,
  type CommitCodexCronotonInput,
} from "./cronoton.js";
import { CodexCronotonValidationError } from "./errors.js";
import { assertAutoGasGate, assertGasPriceBufferAnu } from "./mappers.js";
import { insertStep, type InsertStepInput } from "./steps.js";
import {
  validateChain,
  validateSingleTxVariant,
  type ChainedStepInput,
} from "../pure/chained-validation.js";

/** A step as the chained-commit helper accepts it (the insert shape, minus ids). */
export type CommitChainStepInput = Omit<InsertStepInput, "codexCronotonId" | "stepIndex">;

/** The single-tx-first variant the parent row carries. */
export interface CommitChainSingleTxFirst {
  pactCode: string;
  config?: CodexTxConfig;
  payload?: Record<string, unknown>;
  gasPayer: CodexGasPayer;
  signers: CommitCodexCronotonInput["signers"];
}

/** The store-level input for a chained commit. */
export interface CommitChainedCronotonInput {
  name: string;
  description?: string | null;
  /** Present unless `externalFireable` (mutually exclusive). */
  schedule?: { mode: ScheduleMode; config: ScheduleConfig };
  externalFireable?: boolean;
  singleTxFirst?: CommitChainSingleTxFirst;
  steps: CommitChainStepInput[];
  createdBy: string;
}

/** A complete, inert placeholder config for a step-only chain's parent row. */
const PLACEHOLDER_PARENT_CONFIG: CodexTxConfig = {
  chainId: "0",
  gasPrice: 0,
  gasPriceBufferAnu: 0,
  gasLimit: 1,
  autoGasLimit: false,
  ttl: 600,
};

/** A valid default schedule (ignored when the row is scheduler-off). */
const DEFAULT_SCHEDULE: { mode: ScheduleMode; config: ScheduleConfig } = {
  mode: "daily-at-utc",
  config: { mode: "daily-at-utc", hours: [12], minute: 0 } as ScheduleConfig,
};

/**
 * Validate + write the parent row + every step + (for single-tx-first) enable the
 * flag. Returns the new id, its first scheduled fire, and the step ids. Throws
 * {@link CodexCronotonValidationError} on a bad chain/variant. NOT atomic — wrap
 * in the consumer's transaction.
 */
export function commitChainedCronoton(
  input: CommitChainedCronotonInput,
  dep: DbDep,
): { id: string; nextFireAt: string | null; stepIds: string[] } {
  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw new CodexCronotonValidationError("name must be a non-empty string");
  }
  const chain = validateChain(input.steps as ChainedStepInput[]);
  if (!chain.ok) throw new CodexCronotonValidationError(chain.reason);

  const stx = input.singleTxFirst;
  if (stx) {
    const variant = validateSingleTxVariant(stx);
    if (!variant.ok) throw new CodexCronotonValidationError(variant.reason);
  }

  // Per-step config bypasses `commitCodexCronoton`'s own guards entirely
  // (steps are written via `insertStep`, not that function), so the same two
  // gas-economics asserts it runs on the parent row are run here, per step,
  // BEFORE any write — a bad step N config must reject the whole commit, not
  // just skip that one step. Absent config is fine (both asserts no-op on it).
  for (const step of input.steps) {
    if (step.config && typeof step.config === "object") {
      const stepConfig = step.config as CodexTxConfig;
      assertGasPriceBufferAnu(stepConfig);
      assertAutoGasGate(stepConfig);
    }
  }

  // Idempotent — ensures codex_cronoton_steps exists even with the engine off.
  installSchema(dep.db);

  const schedule = input.schedule ?? DEFAULT_SCHEDULE;
  const parentInput: CommitCodexCronotonInput = {
    name: input.name,
    description: input.description ?? null,
    pactCode: stx ? stx.pactCode : "",
    config: stx?.config ?? PLACEHOLDER_PARENT_CONFIG,
    payload: stx?.payload ?? {},
    gasPayer: stx?.gasPayer ?? { type: "gas-station" },
    signers: stx?.signers ?? [],
    scheduleMode: schedule.mode,
    scheduleConfig: schedule.config,
    createdBy: input.createdBy,
    externalFireable: input.externalFireable,
  };
  const { id, nextFireAt } = commitCodexCronoton(parentInput, { db: dep.db });

  const stepIds = input.steps.map((step, i) =>
    insertStep({ ...step, codexCronotonId: id, stepIndex: i }, { db: dep.db }),
  );

  // Enable single-tx-first only AFTER the steps exist — the store refuses the
  // flag at commit time and the edit re-checks ≥1 step + mode='custom'.
  if (stx) {
    editCodexCronoton(id, { trySingleTxFirst: true, singleTxMode: "custom" }, { db: dep.db });
  }

  return { id, nextFireAt, stepIds };
}
