/**
 * Pure, side-effect-free definition-fingerprint helper ported verbatim from the
 * AncientHoldings hub store (lib/codex-cronoton/store.ts:168-206). Kept
 * dependency-free (only `node:crypto`) so a fire can be pinned to the exact
 * definition that ran, deterministically and key-order-independently.
 */
import crypto from "node:crypto";

import type { CodexCronotonRow } from "../types.js";

/** Recursively sort object keys so JSON.stringify is order-independent. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function parseJson<T>(json: string | null, fallback: T): T {
  if (json == null) return fallback;
  return JSON.parse(json) as T;
}

/**
 * Stable sha256 hex over the canonical-key-sorted JSON of the definition parts.
 * Computed at FIRE time from the row-as-it-then-is so a historical fire is
 * attributable to the exact definition that ran even after an edit. Pure +
 * deterministic + key-order-independent.
 */
export function computeDefinitionFingerprint(row: CodexCronotonRow): string {
  const parts = {
    pactCode: row.pact_code,
    config: parseJson<Record<string, unknown>>(row.config_json, {}),
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    gasPayer: parseJson<Record<string, unknown>>(row.gas_payer_json, {}),
    signers: parseJson<unknown[]>(row.signers_json, []),
    scheduleMode: row.schedule_mode,
    scheduleConfig: parseJson<Record<string, unknown>>(row.schedule_config_json, {}),
  };
  const canonical = JSON.stringify(canonicalize(parts));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
