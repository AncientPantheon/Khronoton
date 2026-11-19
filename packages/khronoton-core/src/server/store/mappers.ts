import { parseRuntimeArgKeys } from '../pure/runtime-args.js';
import type {
  CodexCronotonRow,
  CodexManualBatchRow,
  CodexTxConfig,
  CodexTxDefinition,
  ManualBatchView,
} from '../types.js';
import { AutoGasGateError, CodexCronotonValidationError } from './errors.js';
import type { CodexCronotonStepRow } from './steps.js';

function parseJson<T>(json: string | null, fallback: T): T {
  if (json == null) return fallback;
  return JSON.parse(json) as T;
}

/**
 * The single mapper from a `codex_cronotons` row to the `CodexTxDefinition`
 * consumed by the executor. `scheduleKind` is `'one-time'` ONLY for the
 * one-time mode; all other six modes map to `'recurring'`.
 */
export function rowToDefinition(row: CodexCronotonRow): CodexTxDefinition {
  return {
    pactCode: row.pact_code,
    config: parseJson<CodexTxConfig>(row.config_json, {} as CodexTxConfig),
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    gasPayer: parseJson<CodexTxDefinition['gasPayer']>(row.gas_payer_json, {
      type: 'gas-station',
    }),
    signers: parseJson<CodexTxDefinition['signers']>(row.signers_json, []),
    scheduleKind: row.schedule_mode === 'one-time' ? 'one-time' : 'recurring',
    serverResolver: row.server_resolver ?? undefined,
  };
}

/**
 * Mirrors {@link rowToDefinition} for a `codex_cronoton_steps` row — the
 * STATIC per-step definition a `mode: 'single'` step carries. Omits
 * `scheduleKind`/`serverResolver` entirely, since a step row has neither
 * column (those two fields belong to the cronoton's own schedule, not a
 * step inside a chained run). `pact_code` falls back to `""` when `null`
 * — only ever non-null for a `mode: 'single'` step, the only mode any
 * current caller passes to this function.
 */
export function stepRowToDefinition(step: CodexCronotonStepRow): CodexTxDefinition {
  return {
    pactCode: step.pact_code ?? '',
    config: parseJson<CodexTxConfig>(step.config_json, {} as CodexTxConfig),
    payload: parseJson<Record<string, unknown>>(step.payload_json, {}),
    gasPayer: parseJson<CodexTxDefinition['gasPayer']>(step.gas_payer_json, {
      type: 'gas-station',
    }),
    signers: parseJson<CodexTxDefinition['signers']>(step.signers_json, []),
  };
}

/** True when the row is opted into external (HMAC-endpoint) firing. */
export function rowExternalFireable(row: CodexCronotonRow): boolean {
  return row.external_fireable === 1;
}

/** The declared runtime-arg keys for the row; empty for ordinary rows. */
export function rowRuntimeArgKeys(row: CodexCronotonRow): string[] {
  return parseRuntimeArgKeys(row.runtime_arg_keys);
}

/**
 * AUTO-gas commit-gate: an `autoGasLimit === true` row cannot be committed
 * without a concrete positive numeric `gasLimit` (the prior simulate's
 * calibrated output, supplied by the client). The API does NOT re-run a
 * simulate at commit time — it enforces the presence of a concrete limit so the
 * autonomous fire always has one (the tick never has a human to calibrate).
 */
export function assertAutoGasGate(config: CodexTxConfig): void {
  if (config.autoGasLimit !== true) return;
  if (!Number.isFinite(config.gasLimit) || config.gasLimit <= 0) {
    throw new AutoGasGateError();
  }
}

/**
 * `gasPriceBufferAnu` is a PREMIUM above the live network floor, never a
 * discount — a negative or non-finite value would let a fire underprice
 * below the floor (the guarantee the whole buffer redesign exists to
 * provide). Called identically at commit and edit time, same as
 * {@link assertAutoGasGate}, so a caller reaching the store directly
 * (bypassing the Builder UI's own `validateConfig`) can't persist a row that
 * silently underprices every future fire. `blockchain/stoachain.ts`'s
 * `gasMeta` seam also clamps defensively as a second line of defense for any
 * `CodexTxDefinition` built outside this store. Absent is fine — only a
 * present-and-invalid value is rejected.
 */
export function assertGasPriceBufferAnu(config: CodexTxConfig): void {
  if (config.gasPriceBufferAnu == null) return;
  if (!Number.isFinite(config.gasPriceBufferAnu) || config.gasPriceBufferAnu < 0) {
    throw new CodexCronotonValidationError(
      'config.gasPriceBufferAnu must be a non-negative finite number',
    );
  }
}

/** Project a raw batch row onto the client-facing view (clamping remaining). */
export function manualBatchView(row: CodexManualBatchRow): ManualBatchView {
  return {
    id: row.id,
    codexCronotonId: row.codex_cronoton_id,
    total: row.total,
    completed: row.completed,
    remaining: Math.max(0, row.total - row.completed),
    intervalSeconds: row.interval_seconds,
    status: row.status,
    nextAt: row.next_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
