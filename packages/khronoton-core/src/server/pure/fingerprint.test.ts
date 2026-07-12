/**
 * fingerprint — pure helper pins carried verbatim from the AncientHoldings hub
 * store unit suite (tests/unit/codex-cronoton/store.test.ts:109-168).
 *
 * `computeDefinitionFingerprint` is a stable sha256 hex over the
 * canonical-key-sorted JSON of the definition parts, so a historical fire stays
 * attributable to the exact definition that ran even after an edit. These pins
 * cover determinism, JSON-key-order independence, and per-part field
 * sensitivity (pactCode / schedule config / signers).
 */
import { describe, it, expect } from "vitest";

import { computeDefinitionFingerprint } from "./fingerprint.js";
import type { CodexCronotonRow } from "../types.js";

function baseRow(overrides: Partial<CodexCronotonRow> = {}): CodexCronotonRow {
  return {
    id: "cc-1",
    name: "Test",
    description: null,
    pact_code: '(coin.transfer "a" "b" 1.0)',
    config_json: JSON.stringify({
      chainId: "0",
      gasPrice: 1,
      gasLimit: 1500,
      autoGasLimit: false,
      ttl: 600,
    }),
    payload_json: JSON.stringify({ amount: "1.0" }),
    gas_payer_json: JSON.stringify({ type: "gas-station" }),
    signers_json: JSON.stringify([
      { publicKey: "a".repeat(64), capabilityMode: "scoped", capabilities: "(coin.GAS)" },
    ]),
    schedule_mode: "every-n-minutes",
    schedule_config_json: JSON.stringify({
      mode: "every-n-minutes",
      startDate: "2026-01-01T00:00:00.000Z",
      intervalMinutes: 60,
    }),
    status: "active",
    next_fire_at: "2026-06-08T00:00:00.000Z",
    last_fire_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    modified_at: "2026-01-01T00:00:00.000Z",
    created_by: "admin@x",
    ...overrides,
  };
}

describe("computeDefinitionFingerprint", () => {
  it("is deterministic — identical inputs hash to the same sha256 hex", () => {
    const row = baseRow();
    const a = computeDefinitionFingerprint(row);
    const b = computeDefinitionFingerprint(row);
    expect(a).toBe(b);
    // sha256 hex is 64 lowercase hex chars.
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is independent of JSON key order — re-ordered config JSON yields the SAME hash", () => {
    const ordered = baseRow();
    const reordered = baseRow({
      config_json: JSON.stringify({
        ttl: 600,
        autoGasLimit: false,
        gasLimit: 1500,
        gasPrice: 1,
        chainId: "0",
      }),
    });
    expect(computeDefinitionFingerprint(reordered)).toBe(
      computeDefinitionFingerprint(ordered),
    );
  });

  it("changes when pactCode changes (provenance: an edited tx is a different fire)", () => {
    const a = computeDefinitionFingerprint(baseRow());
    const b = computeDefinitionFingerprint(
      baseRow({ pact_code: '(coin.transfer "a" "c" 2.0)' }),
    );
    expect(b).not.toBe(a);
  });

  it("changes when the schedule config changes (edit-provenance over the schedule)", () => {
    const a = computeDefinitionFingerprint(baseRow());
    const b = computeDefinitionFingerprint(
      baseRow({
        schedule_config_json: JSON.stringify({
          mode: "every-n-minutes",
          startDate: "2026-01-01T00:00:00.000Z",
          intervalMinutes: 30,
        }),
      }),
    );
    expect(b).not.toBe(a);
  });

  it("changes when the signers change", () => {
    const a = computeDefinitionFingerprint(baseRow());
    const b = computeDefinitionFingerprint(
      baseRow({
        signers_json: JSON.stringify([
          { publicKey: "b".repeat(64), capabilityMode: "pure", capabilities: "" },
        ]),
      }),
    );
    expect(b).not.toBe(a);
  });
});
