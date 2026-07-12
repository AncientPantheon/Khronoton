/**
 * Runtime-arg injection for codex-cronotons.
 *
 * Ordinarily a codex-cronoton's transaction is fully frozen at definition time.
 * A RUNTIME-ARG cronoton instead DECLARES a set of env-data keys
 * (`runtime_arg_keys`) whose values are supplied by the TRIGGER — the external
 * Pythia endpoint or the ancient manual form — at fire time and merged into the
 * payload, so the Pact code reads them via `(read-string "key")`.
 *
 * SAFETY: values are always strings and flow through env-data (`addData`), NEVER
 * string-concatenated into `pactCode` — so there is no code-injection surface.
 * And a runtime arg can NEVER clobber a fixed payload key (e.g. a keyset): the
 * declared keys must be disjoint from the template payload (enforced at commit),
 * and `applyRuntimeArgs` throws on any collision as a defense-in-depth net.
 *
 * These helpers are pure + `@stoachain`-free, so they are unit-testable and
 * importable by both the API routes and the worker.
 */
import crypto from 'node:crypto';
import type { CodexTxDefinition } from '../types.js';

/** A validated bag of runtime args — every value is a string (Pact `read-string`). */
export type RuntimeArgs = Record<string, string>;

/** Parse the row's `runtime_arg_keys` JSON column to a string[] (empty on null/garbage). */
export function parseRuntimeArgKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((k): k is string => typeof k === 'string' && k.length > 0);
}

export type ValidateRuntimeArgsResult =
  | { ok: true; args: RuntimeArgs }
  | { ok: false; error: string };

/**
 * Validate supplied args against the declared keys. The supplied object must
 * carry EXACTLY the declared keys (no missing, no extra) and every value must be
 * a string. Rejects when the cronoton declares no runtime args (declaredKeys
 * empty) — such a cronoton is not runtime-arg-fireable.
 */
export function validateRuntimeArgs(
  declaredKeys: string[],
  supplied: unknown,
): ValidateRuntimeArgsResult {
  if (declaredKeys.length === 0) {
    return { ok: false, error: 'this cronoton declares no runtime args' };
  }
  if (supplied == null || typeof supplied !== 'object' || Array.isArray(supplied)) {
    return { ok: false, error: 'args must be an object' };
  }
  const obj = supplied as Record<string, unknown>;
  const declared = new Set(declaredKeys);
  for (const k of Object.keys(obj)) {
    if (!declared.has(k)) return { ok: false, error: `unexpected arg "${k}"` };
  }
  // Null-prototype + own-property checks so a (self-declared) key like `__proto__`
  // is handled by identity — never swallowed by an inherited setter or a
  // false-positive `in` on Object.prototype.
  const args: RuntimeArgs = Object.create(null);
  for (const k of declaredKeys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return { ok: false, error: `missing arg "${k}"` };
    const v = obj[k];
    if (typeof v !== 'string') return { ok: false, error: `arg "${k}" must be a string` };
    args[k] = v;
  }
  return { ok: true, args };
}

/**
 * Merge validated runtime args into a definition's payload (env-data). Throws if
 * any arg key collides with a fixed payload key — a runtime arg must never be able
 * to override a keyset or other fixed data (defense-in-depth; commit-time
 * validation already forbids the overlap).
 */
export function applyRuntimeArgs(definition: CodexTxDefinition, args: RuntimeArgs): CodexTxDefinition {
  for (const k of Object.keys(args)) {
    if (Object.prototype.hasOwnProperty.call(definition.payload, k)) {
      throw new Error(`runtime arg "${k}" collides with a fixed payload key`);
    }
  }
  return { ...definition, payload: { ...definition.payload, ...args } };
}

/** True when any declared runtime-arg key overlaps the fixed payload keys (a misconfiguration). */
export function runtimeArgKeysCollide(payload: Record<string, unknown>, declaredKeys: string[]): boolean {
  return declaredKeys.some((k) => Object.prototype.hasOwnProperty.call(payload, k));
}

/**
 * A stable sha256 over the canonical (key-sorted) args — recorded per fire for
 * provenance. The arg VALUES themselves go on-chain via the request key; the hash
 * lets an auditor tie a fire row to the exact args without storing them verbatim.
 */
export function hashRuntimeArgs(args: RuntimeArgs): string {
  const sorted = Object.keys(args)
    .sort()
    .reduce<RuntimeArgs>((o, k) => {
      o[k] = args[k];
      return o;
    }, {});
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}
