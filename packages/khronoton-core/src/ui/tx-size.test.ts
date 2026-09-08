import { describe, it, expect } from "vitest";
import { makeEmptyBuilderState, type BuilderState, type SignerRow } from "./builder-state.js";
import {
  estimateTxSize,
  estimateFallbackBytes,
  STOA_TX_BYTE_CEILING,
  PROXY_SOFT_LIMIT,
} from "./tx-size.js";

/** A minimal signer row — only the fields `builderToCommit` reads matter here. */
function makeSignerRow(): SignerRow {
  return {
    id: "signer-1",
    publicKey: "a".repeat(64),
    label: "",
    source: "foreign",
    capabilityMode: "pure",
    capabilities: "",
  };
}

describe("estimateTxSize", () => {
  it("exposes the byte-ceiling constants used by the meter's tick marks", () => {
    expect(STOA_TX_BYTE_CEILING).toBe(2 * 1024 * 1024);
    expect(PROXY_SOFT_LIMIT).toBe(1 * 1024 * 1024);
  });

  it("estimates a positive, under-ceiling byte size for a fresh empty state", async () => {
    const estimate = await estimateTxSize(makeEmptyBuilderState());
    expect(estimate.bytes).toBeGreaterThan(0);
    expect(estimate.over).toBe(false);
    expect(estimate.ceiling).toBe(STOA_TX_BYTE_CEILING);
  });

  it("flags over === true and permille > 1000 once pact code alone exceeds the ceiling", async () => {
    const state: BuilderState = makeEmptyBuilderState();
    state.pactCode = "(x)".repeat(1_000_000);
    const estimate = await estimateTxSize(state);
    expect(estimate.over).toBe(true);
    expect(estimate.permille).toBeGreaterThan(1000);
  });

  it("adds at least 140 bytes (the per-signature allowance) per signer in the state", async () => {
    const withoutSigner = makeEmptyBuilderState();
    const withSigner = makeEmptyBuilderState();
    withSigner.signers = [makeSignerRow()];

    const [without, withOne] = await Promise.all([
      estimateTxSize(withoutSigner),
      estimateTxSize(withSigner),
    ]);

    expect(withOne.bytes - without.bytes).toBeGreaterThanOrEqual(140);
  });

  it("never rejects even when pact code is empty and the raw payload JSON is invalid", async () => {
    const state = makeEmptyBuilderState();
    state.pactCode = "";
    state.payload = { entries: [], keysets: [], rawMode: true, rawJson: "{not valid json" };

    await expect(estimateTxSize(state)).resolves.toBeDefined();
  });

  it("grows the estimate when a large gasPriceBufferAnu adds digits to the serialized price", async () => {
    const withoutBuffer = makeEmptyBuilderState();
    const withBuffer = makeEmptyBuilderState();
    withBuffer.config.gasPriceBufferAnu = 999999999999;

    const [without, buffered] = await Promise.all([
      estimateTxSize(withoutBuffer),
      estimateTxSize(withBuffer),
    ]);

    expect(buffered.bytes).toBeGreaterThan(without.bytes);
  });

  it("prices via a SINGLE conversion of the summed ANU — not two summed STOA floats (precision fix)", async () => {
    // The "grows" test above only proves the estimate reacts to a buffer at
    // all — a REGRESSED implementation that summed `anuToStoa(floor) +
    // anuToStoa(buffer)` as two separately-converted STOA floats (the exact
    // bug class fixed in `blockchain/stoachain.ts`'s `gasMeta`) would ALSO
    // grow the byte count as the buffer grows, so it wouldn't be caught by a
    // mere "grows" assertion. This test proves the byte DELTA matches the
    // correct single-conversion formula specifically, mirroring
    // `stoachain.test.ts`'s "sums floor+buffer in ANU before the ONE
    // conversion" technique.
    const { minGasPriceAnu, anuToStoaNumber } = await import("@stoachain/stoa-core/gas");
    const nowS = Math.floor(Date.now() / 1000);
    const floor = minGasPriceAnu(nowS);

    const baselineBytes = new TextEncoder().encode(JSON.stringify(anuToStoaNumber(floor))).length;
    const deltaFor = (str: string): number =>
      new TextEncoder().encode(str).length - baselineBytes;

    // Search for a buffer value that actually diverges between the correct
    // and buggy formulas' BYTE-LENGTH deltas for the CURRENT live floor —
    // computed at runtime rather than hardcoded, so the test keeps working
    // as the floor rises. Deliberately checks byte-length divergence, not
    // mere value inequality: two different decimal strings can still have
    // the SAME length, which the test below couldn't distinguish, so the
    // search must stop only once it has found what it actually needs.
    let buffer = -1;
    let correctDelta = 0;
    let buggyDelta = 0;
    for (let candidate = 1; candidate <= 5000; candidate++) {
      const correct = deltaFor(JSON.stringify(anuToStoaNumber(floor + candidate)));
      const buggy = deltaFor(
        JSON.stringify(anuToStoaNumber(floor) + anuToStoaNumber(candidate)),
      );
      if (correct !== buggy) {
        buffer = candidate;
        correctDelta = correct;
        buggyDelta = buggy;
        break;
      }
    }
    expect(buffer).toBeGreaterThan(0); // sanity: a divergent pair must exist
    // sanity: the two formulas must actually disagree on byte length too,
    // or this test couldn't tell correct from buggy either (redundant with
    // the loop's own break condition, kept as a readable, explicit check).
    expect(correctDelta).not.toBe(buggyDelta);

    const withoutBuffer = makeEmptyBuilderState();
    const withBuffer = makeEmptyBuilderState();
    withBuffer.config.gasPriceBufferAnu = buffer;
    const [without, buffered] = await Promise.all([
      estimateTxSize(withoutBuffer),
      estimateTxSize(withBuffer),
    ]);

    expect(buffered.bytes - without.bytes).toBe(correctDelta);
  });
});

describe("estimateFallbackBytes", () => {
  // `estimateTxSize`'s catch branch calls this exact function when the
  // accurate `Pact.builder` build throws (e.g. an optional StoaChain peer
  // isn't resolvable). `builderToCommit` sanitizes invalid raw-JSON payloads
  // to `{}` before `estimateTxSize`'s try-block ever runs, and the real
  // StoaChain SDK doesn't reject empty/malformed-looking-but-valid input —
  // so neither alone drives that catch branch from the OUTSIDE (see the
  // "never rejects" test above, which exercises the ACCURATE path
  // successfully, not the fallback), and forcing the accurate path itself to
  // throw would require mocking the real, already-installed
  // `@stoachain/kadena-stoic-legacy/client` package's dynamic import, which
  // did not reliably intercept in this environment. Testing the formula
  // directly proves the thing that actually matters — that the fallback
  // computes the right byte count — without depending on that.
  it("computes the UTF-8 byte length of pactCode + JSON.stringify(payload) — the exact formula the catch branch uses", () => {
    // Independently-derived literal byte counts (NOT re-derived via the same
    // TextEncoder/JSON.stringify expression the implementation itself uses —
    // that would only prove TextEncoder is deterministic, not that the
    // formula is correct): "(defun x () 1)" is 14 ASCII chars, "{}" is 2 →
    // 16 bytes. "" is 0 chars, `{"a":1,"b":"two"}` is 17 ASCII chars → 17
    // bytes. Both counted by hand and cross-checked with a standalone
    // TextEncoder call outside this test file before being hardcoded here.
    expect(estimateFallbackBytes("(defun x () 1)", {})).toBe(16);
    expect(estimateFallbackBytes("", { a: 1, b: "two" })).toBe(17);
  });

  it("grows with payload size, proving it actually measures the payload rather than ignoring it", () => {
    const small = estimateFallbackBytes("(x)", { k: "v" });
    const large = estimateFallbackBytes("(x)", { k: "v".repeat(1000) });
    expect(large).toBeGreaterThan(small);
  });
});
