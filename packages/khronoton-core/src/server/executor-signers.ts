/**
 * Signer-planning helpers for the headless codex executor.
 *
 * These three helpers are pure (string / signer-list in, signer-list out) and
 * carry NO chain dependency: the namespace and gas-station account are plain
 * string params, so the executor's gas-payer self-heal is unit-testable without
 * any chain runtime. `buildTransaction` (the executor) consumes
 * `effectiveSigners` + `deriveSenderAccount` to plan the signer set and sender.
 */

import type { CodexTxDefinition, CodexSigner } from "./types.js";

/** Strip a leading `k:` prefix from an address if present. */
export function stripPrefix(addr: string): string {
  return addr.startsWith("k:") ? addr.slice(2) : addr;
}

/** Derive the Pact `senderAccount` string from the gas-payer reference. */
export function deriveSenderAccount(
  gasPayer: CodexTxDefinition["gasPayer"],
  gasStation: string,
): string {
  if (gasPayer.type === "gas-station") return gasStation;
  return `k:${stripPrefix(gasPayer.address || "")}`;
}

/**
 * Resolve the effective signer set the executor builds + signs, reconciling the
 * gas-payer's auto-managed signer with the definition's own signers:
 *
 *   - codex gas-payer: it must sign `coin.GAS`. If the gas-payer pubkey is
 *     absent it is auto-included as a `pure` signer; if already present (e.g. a
 *     prepended `coin.GAS` scoped signer) it is left untouched — never
 *     duplicated.
 *   - gas-station gas-payer: the gas station pays, but a codex key must sign the
 *     namespaced `DALOS.GAS_PAYER` capability. A scoped signer for
 *     `gasStationSignerKey` is SYNTHESIZED here (server-side, so the client stays
 *     free of the namespace constant). A missing key is a contract violation
 *     surfaced as a throw (caught + structured on fire).
 */
export function effectiveSigners(
  definition: CodexTxDefinition,
  kadenaNamespace: string,
): CodexSigner[] {
  const signers = [...definition.signers];

  if (definition.gasPayer.type === "codex" && definition.gasPayer.address) {
    const gasPub = stripPrefix(definition.gasPayer.address);
    if (!signers.some((s) => s.publicKey === gasPub)) {
      signers.push({
        publicKey: gasPub,
        capabilityMode: "pure",
        capabilities: "",
      });
    }
  }

  if (definition.gasPayer.type === "gas-station") {
    const gasKey = definition.gasPayer.gasStationSignerKey;
    if (!gasKey) {
      throw new Error(
        "Gas-station gas payer requires a signing key for the DALOS.GAS_PAYER capability.",
      );
    }
    if (!signers.some((s) => s.publicKey === gasKey)) {
      signers.push({
        publicKey: gasKey,
        capabilityMode: "scoped",
        capabilities: `(${kadenaNamespace}.DALOS.GAS_PAYER "" 0 0.0)`,
      });
    }
  }

  return signers;
}
