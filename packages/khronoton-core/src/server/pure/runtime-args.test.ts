import { describe, it, expect } from 'vitest';
import {
  parseRuntimeArgKeys,
  validateRuntimeArgs,
  applyRuntimeArgs,
  runtimeArgKeysCollide,
  hashRuntimeArgs,
} from './runtime-args.js';
import type { CodexTxDefinition } from '../types.js';

const DECLARED = ['standard-apollo', 'smart-apollo'];

function defWith(payload: Record<string, unknown>): CodexTxDefinition {
  return {
    pactCode: '(m.f (read-string "standard-apollo") (read-string "smart-apollo"))',
    config: { chainId: '0', gasPrice: 1, gasLimit: 1000, autoGasLimit: false, ttl: 600 },
    payload,
    gasPayer: { type: 'gas-station' },
    signers: [],
  };
}

describe('parseRuntimeArgKeys', () => {
  it('parses a JSON string array', () => {
    expect(parseRuntimeArgKeys('["a","b"]')).toEqual(['a', 'b']);
  });
  it('returns empty on null / garbage / non-array', () => {
    expect(parseRuntimeArgKeys(null)).toEqual([]);
    expect(parseRuntimeArgKeys('')).toEqual([]);
    expect(parseRuntimeArgKeys('not json')).toEqual([]);
    expect(parseRuntimeArgKeys('{"a":1}')).toEqual([]);
  });
  it('drops non-string / empty entries', () => {
    expect(parseRuntimeArgKeys('["a", 3, "", "b"]')).toEqual(['a', 'b']);
  });
});

describe('validateRuntimeArgs', () => {
  it('accepts exactly the declared keys as strings', () => {
    const r = validateRuntimeArgs(DECLARED, { 'standard-apollo': 'x', 'smart-apollo': 'y' });
    expect(r).toEqual({ ok: true, args: { 'standard-apollo': 'x', 'smart-apollo': 'y' } });
  });
  it('rejects a cronoton with no declared runtime args', () => {
    expect(validateRuntimeArgs([], { a: 'x' })).toMatchObject({ ok: false });
  });
  it('rejects a missing key', () => {
    expect(validateRuntimeArgs(DECLARED, { 'standard-apollo': 'x' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('missing'),
    });
  });
  it('rejects an unexpected extra key', () => {
    expect(
      validateRuntimeArgs(DECLARED, { 'standard-apollo': 'x', 'smart-apollo': 'y', evil: 'z' }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('unexpected') });
  });
  it('rejects a non-string value', () => {
    expect(validateRuntimeArgs(DECLARED, { 'standard-apollo': 'x', 'smart-apollo': 5 })).toMatchObject({
      ok: false,
      error: expect.stringContaining('must be a string'),
    });
  });
  it('rejects a non-object payload', () => {
    expect(validateRuntimeArgs(DECLARED, null)).toMatchObject({ ok: false });
    expect(validateRuntimeArgs(DECLARED, ['x', 'y'])).toMatchObject({ ok: false });
    expect(validateRuntimeArgs(DECLARED, 'x')).toMatchObject({ ok: false });
  });
  it('handles a declared __proto__ key by identity (own-property check, not swallowed by inheritance)', () => {
    // A cronoton that declares `__proto__` as a runtime-arg key must round-trip its
    // own-property value — never silently drop it or match Object.prototype.
    const r = validateRuntimeArgs(['__proto__'], JSON.parse('{"__proto__":"payload"}'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args['__proto__']).toBe('payload');
    // and a MISSING __proto__ is still rejected (not a false-positive via inheritance)
    expect(validateRuntimeArgs(['__proto__'], {})).toMatchObject({ ok: false });
  });
});

describe('applyRuntimeArgs + runtimeArgKeysCollide', () => {
  it('merges args into the payload', () => {
    const def = defWith({ 'ouronet-ns.pythia-cronoton-keyset': { keys: ['k'], pred: 'keys-any' } });
    const merged = applyRuntimeArgs(def, { 'standard-apollo': 'x', 'smart-apollo': 'y' });
    expect(merged.payload).toEqual({
      'ouronet-ns.pythia-cronoton-keyset': { keys: ['k'], pred: 'keys-any' },
      'standard-apollo': 'x',
      'smart-apollo': 'y',
    });
    // original untouched (immutable merge)
    expect(def.payload).not.toHaveProperty('standard-apollo');
  });
  it('THROWS if a runtime arg collides with a fixed payload key (never clobber a keyset)', () => {
    const def = defWith({ 'standard-apollo': 'FIXED' });
    expect(() => applyRuntimeArgs(def, { 'standard-apollo': 'x', 'smart-apollo': 'y' })).toThrow(
      /collides/,
    );
  });
  it('runtimeArgKeysCollide detects overlap with the fixed payload', () => {
    expect(runtimeArgKeysCollide({ keyset: {} }, ['standard-apollo'])).toBe(false);
    expect(runtimeArgKeysCollide({ 'standard-apollo': 'x' }, ['standard-apollo'])).toBe(true);
  });
});

describe('hashRuntimeArgs', () => {
  it('is stable + key-order-independent', () => {
    const a = hashRuntimeArgs({ 'standard-apollo': 'x', 'smart-apollo': 'y' });
    const b = hashRuntimeArgs({ 'smart-apollo': 'y', 'standard-apollo': 'x' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('differs when a value differs', () => {
    expect(hashRuntimeArgs({ 'standard-apollo': 'x' })).not.toBe(
      hashRuntimeArgs({ 'standard-apollo': 'z' }),
    );
  });
});
