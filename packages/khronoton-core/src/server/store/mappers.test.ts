import { describe, it, expect } from 'vitest';

import {
  rowToDefinition,
  rowExternalFireable,
  rowRuntimeArgKeys,
  assertAutoGasGate,
  manualBatchView,
} from './mappers.js';
import { AutoGasGateError, TerminalCronotonError } from './errors.js';
import type {
  CodexCronotonRow,
  CodexManualBatchRow,
  CodexTxConfig,
} from '../types.js';

function baseRow(overrides: Partial<CodexCronotonRow> = {}): CodexCronotonRow {
  return {
    id: 'cc-1',
    name: 'Test',
    description: null,
    pact_code: '(coin.transfer "a" "b" 1.0)',
    config_json: JSON.stringify({
      chainId: '0',
      gasPrice: 1,
      gasLimit: 1500,
      autoGasLimit: false,
      ttl: 600,
    }),
    payload_json: JSON.stringify({ amount: '1.0' }),
    gas_payer_json: JSON.stringify({ type: 'gas-station' }),
    signers_json: JSON.stringify([
      { publicKey: 'a'.repeat(64), capabilityMode: 'scoped', capabilities: '(coin.GAS)' },
    ]),
    schedule_mode: 'every-n-minutes',
    schedule_config_json: JSON.stringify({
      mode: 'every-n-minutes',
      startDate: '2026-01-01T00:00:00.000Z',
      intervalMinutes: 60,
    }),
    status: 'active',
    next_fire_at: '2026-06-08T00:00:00.000Z',
    last_fire_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    modified_at: '2026-01-01T00:00:00.000Z',
    created_by: 'admin@x',
    ...overrides,
  };
}

function batchRow(over: Partial<CodexManualBatchRow> = {}): CodexManualBatchRow {
  return {
    id: 'b-1',
    codex_cronoton_id: 'cc-1',
    total: 42,
    completed: 0,
    interval_seconds: 60,
    status: 'active',
    next_at: '2026-06-09T02:25:00.000Z',
    created_at: '2026-06-09T02:25:00.000Z',
    modified_at: '2026-06-09T02:25:00.000Z',
    created_by: 'admin@x',
    ...over,
  };
}

describe('rowToDefinition', () => {
  it('parses the four JSON columns into the CodexTxDefinition shape', () => {
    const def = rowToDefinition(baseRow());
    expect(def.pactCode).toBe('(coin.transfer "a" "b" 1.0)');
    expect(def.config.chainId).toBe('0');
    expect(def.config.gasLimit).toBe(1500);
    expect(def.payload).toEqual({ amount: '1.0' });
    expect(def.gasPayer.type).toBe('gas-station');
    expect(def.signers).toHaveLength(1);
    expect(def.signers[0]!.publicKey).toBe('a'.repeat(64));
  });

  it("derives scheduleKind='one-time' ONLY for the one-time mode", () => {
    const def = rowToDefinition(baseRow({ schedule_mode: 'one-time' }));
    expect(def.scheduleKind).toBe('one-time');
  });

  it.each([
    'daily-at-utc',
    'every-n-minutes',
    'weekly',
    'monthly',
    'cron-expression',
    'several-times-per-day',
  ] as const)(
    "derives scheduleKind='recurring' for the recurring mode %s",
    (mode) => {
      const def = rowToDefinition(baseRow({ schedule_mode: mode }));
      expect(def.scheduleKind).toBe('recurring');
    },
  );

  it('treats a null payload column as an empty payload object', () => {
    const def = rowToDefinition(baseRow({ payload_json: null }));
    expect(def.payload).toEqual({});
  });

  it('carries the server_resolver name (undefined when the column is null)', () => {
    expect(rowToDefinition(baseRow({ server_resolver: 'stoicism-mint' })).serverResolver).toBe(
      'stoicism-mint',
    );
    expect(rowToDefinition(baseRow({ server_resolver: null })).serverResolver).toBeUndefined();
  });
});

describe('rowExternalFireable', () => {
  it('is true ONLY when external_fireable === 1', () => {
    expect(rowExternalFireable(baseRow({ external_fireable: 1 }))).toBe(true);
    expect(rowExternalFireable(baseRow({ external_fireable: 0 }))).toBe(false);
    expect(rowExternalFireable(baseRow())).toBe(false);
  });
});

describe('rowRuntimeArgKeys', () => {
  it('parses the declared runtime-arg keys and empties an absent column', () => {
    expect(rowRuntimeArgKeys(baseRow({ runtime_arg_keys: JSON.stringify(['apollo', 'zeus']) }))).toEqual([
      'apollo',
      'zeus',
    ]);
    expect(rowRuntimeArgKeys(baseRow({ runtime_arg_keys: null }))).toEqual([]);
  });
});

describe('assertAutoGasGate (AUTO-gas commit-gate)', () => {
  const cfg = (over: Partial<CodexTxConfig>): CodexTxConfig => ({
    chainId: '0',
    gasPrice: 1,
    gasLimit: 1500,
    autoGasLimit: false,
    ttl: 600,
    ...over,
  });

  it('rejects autoGasLimit=true with no concrete positive gasLimit', () => {
    expect(() => assertAutoGasGate(cfg({ gasLimit: 0, autoGasLimit: true }))).toThrow(
      AutoGasGateError,
    );
  });

  it('rejects autoGasLimit=true with a non-numeric gasLimit', () => {
    expect(() => assertAutoGasGate(cfg({ gasLimit: NaN, autoGasLimit: true }))).toThrow(
      AutoGasGateError,
    );
  });

  it('accepts autoGasLimit=true WITH a concrete positive gasLimit', () => {
    expect(() => assertAutoGasGate(cfg({ gasLimit: 1500, autoGasLimit: true }))).not.toThrow();
  });

  it('accepts autoGasLimit=false regardless (manual gas is always concrete)', () => {
    expect(() => assertAutoGasGate(cfg({ gasLimit: 1500, autoGasLimit: false }))).not.toThrow();
  });
});

describe('manualBatchView', () => {
  it('clamps remaining to >= 0 and projects progress', () => {
    expect(manualBatchView(batchRow({ total: 42, completed: 12 })).remaining).toBe(30);
    expect(manualBatchView(batchRow({ total: 42, completed: 50 })).remaining).toBe(0);
  });

  it('projects the row fields onto the client-facing view', () => {
    const view = manualBatchView(batchRow({ total: 5, completed: 2, next_at: null }));
    expect(view.codexCronotonId).toBe('cc-1');
    expect(view.total).toBe(5);
    expect(view.completed).toBe(2);
    expect(view.remaining).toBe(3);
    expect(view.intervalSeconds).toBe(60);
    expect(view.nextAt).toBeNull();
  });
});

describe('TerminalCronotonError exported shape', () => {
  it('is exported for the route to map to a 400', () => {
    expect(typeof TerminalCronotonError).toBe('function');
    const e = new TerminalCronotonError('completed');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toMatch(/terminal|completed|spent/i);
  });
});
