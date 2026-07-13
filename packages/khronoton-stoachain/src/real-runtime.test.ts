/**
 * Real-runtime integration test — NO @stoachain mocks. This calls the actual
 * factory against the installed `@stoachain/*@4.3.6` packages, which is the ONLY
 * path that catches a module-loading regression (the mocked unit tests in
 * `index.test.ts` never load the real ESM/CJS-interop modules).
 *
 * This is the guard that would have caught the Node-24 `ERR_INTERNAL_ASSERTION`
 * concurrent-import race the sequential `await import()` change fixes — do not
 * revert those imports to `Promise.all` without this staying green.
 */
import { describe, expect, it } from "vitest";

import { createStoachainRuntime } from "./index.js";

const CHAIN_RUNTIME_MEMBERS = [
  "Pact",
  "createClient",
  "isSignedTransaction",
  "universalSignTransaction",
  "calculateAutoGasLimit",
  "anuToStoa",
  "getPactUrl",
  "networkId",
  "namespace",
  "gasStationAccount",
] as const;

describe("createStoachainRuntime — real @stoachain runtime", () => {
  it("resolves to a ChainRuntime with every member present (no import crash)", async () => {
    const rt = await createStoachainRuntime();
    for (const m of CHAIN_RUNTIME_MEMBERS) {
      expect(rt[m as keyof typeof rt], `missing ChainRuntime member: ${m}`).toBeDefined();
    }
    expect(typeof rt.universalSignTransaction).toBe("function");
    expect(typeof rt.getPactUrl).toBe("function");
    // constants come from the real @stoachain packages
    expect(typeof rt.networkId).toBe("string");
    expect(typeof rt.namespace).toBe("string");
    expect(typeof rt.gasStationAccount).toBe("string");
  });

  it("default getPactUrl uses the @stoachain resolver; nodeBaseUrl overrides it", async () => {
    const def = await createStoachainRuntime();
    const defUrl = def.getPactUrl("0");
    expect(defUrl).toMatch(/\/chainweb\/0\.0\/.+\/chain\/0\/pact$/);

    const overridden = await createStoachainRuntime({ nodeBaseUrl: "http://127.0.0.1:1848" });
    expect(overridden.getPactUrl("0")).toBe(
      `http://127.0.0.1:1848/chainweb/0.0/${overridden.networkId}/chain/0/pact`,
    );
  });
});
