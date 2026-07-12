import { parseRuntimeArgKeys } from '../pure/runtime-args.js';
import type {
  CodexCronotonRow,
  CodexManualBatchRow,
  CodexTxConfig,
  CodexTxDefinition,
  ManualBatchView,
} from '../types.js';
import { AutoGasGateError } from './errors.js';

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
