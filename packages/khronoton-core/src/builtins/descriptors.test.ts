/**
 * `src/builtins/descriptors.ts` tests — Wave 1 (T1) covers only the 3
 * standalone-only built-ins (`ouronet.aqp-inject`/`ouronet.aqp-evict`/
 * `ouronet.aqp-unstall`); the 4 composable built-ins are added in Wave 2
 * (T2) with their own `toFragment` snapshot tests.
 *
 * The param-field-matching test (`describe("params match the real planner
 * interfaces")`) reads each real planner file's own `*PlannerParams`
 * interface TEXT directly off disk and parses its field names, rather than
 * hardcoding an expected field list here — a hardcoded list could silently
 * drift from the real interface if a planner's params shape ever changes
 * without this test file being updated in lockstep. See
 * `extractInterfaceFieldNames` below.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BUILTIN_DESCRIPTORS } from "./descriptors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const plannersDir = resolve(__dirname, "../server/planners");

/**
 * Parses the field NAMES (not types) of a named TypeScript `interface` out
 * of a source file's raw text. Strips block (`/** ... *​/`) and line (`//`)
 * comments from the interface body first, so a doc-comment's own prose
 * (e.g. `InjectPlannerParams.executor`'s multi-line doc) never gets
 * misread as a field. Deliberately simple (no real TS parser) — correct
 * for the straightforward single-level, no-nested-object interfaces this
 * codebase's `*PlannerParams` shapes actually use.
 */
function extractInterfaceFieldNames(filePath: string, interfaceName: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const interfaceMatch = source.match(new RegExp(`interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`));
  if (!interfaceMatch) {
    throw new Error(`could not find "interface ${interfaceName}" in ${filePath}`);
  }
  const body = interfaceMatch[1]
    .replace(/\/\*\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const fieldNames: string[] = [];
  const fieldPattern = /^\s*([A-Za-z_$][\w$]*)\??\s*:/gm;
  let match: RegExpExecArray | null;
  while ((match = fieldPattern.exec(body)) !== null) {
    fieldNames.push(match[1]);
  }
  return fieldNames;
}

describe("params match the real planner interfaces (exact set equality)", () => {
  it("ouronet.aqp-inject's params match InjectPlannerParams's own fields exactly", () => {
    const realFields = extractInterfaceFieldNames(resolve(plannersDir, "inject.ts"), "InjectPlannerParams");
    const descriptorFields = BUILTIN_DESCRIPTORS["ouronet.aqp-inject"].params.map((f) => f.name);

    expect(new Set(descriptorFields)).toEqual(new Set(realFields));
  });

  it("ouronet.aqp-evict's params match EvictPlannerParams's own fields exactly", () => {
    const realFields = extractInterfaceFieldNames(resolve(plannersDir, "evict.ts"), "EvictPlannerParams");
    const descriptorFields = BUILTIN_DESCRIPTORS["ouronet.aqp-evict"].params.map((f) => f.name);

    expect(new Set(descriptorFields)).toEqual(new Set(realFields));
  });

  it("ouronet.aqp-unstall's params match UnstallPlannerParams's own fields exactly", () => {
    const realFields = extractInterfaceFieldNames(resolve(plannersDir, "unstall.ts"), "UnstallPlannerParams");
    const descriptorFields = BUILTIN_DESCRIPTORS["ouronet.aqp-unstall"].params.map((f) => f.name);

    expect(new Set(descriptorFields)).toEqual(new Set(realFields));
  });
});

describe("preview() reports the real entrypoint(s), in the real try-this-then-that order", () => {
  it("ouronet.aqp-inject previews the finalize-then-inject fallback order", () => {
    const preview = BUILTIN_DESCRIPTORS["ouronet.aqp-inject"].preview?.({
      fvtId: "fvt-1",
      patronAccount: "k:patron",
      executor: "Ѻ.exec",
      rewardDptfId: "dptf-1",
      amount: "5.0",
    });

    expect(preview).toEqual({
      summary: "Inject 5.0 to fvt fvt-1",
      entrypoints: ["CC_InjectFinalize", "CC_Inject"],
    });
  });

  it("ouronet.aqp-evict previews the full-then-fan-out order", () => {
    const preview = BUILTIN_DESCRIPTORS["ouronet.aqp-evict"].preview?.({
      fvtId: "fvt-1",
      patronAccount: "k:patron",
    });

    expect(preview?.entrypoints).toEqual(["CC_FullEvictRewards", "CC_EvictSingleReward (fan-out)"]);
  });

  it("ouronet.aqp-unstall previews the fan-out-only entrypoint", () => {
    const preview = BUILTIN_DESCRIPTORS["ouronet.aqp-unstall"].preview?.({
      fvtId: "fvt-1",
      patronAccount: "k:patron",
      rewardDptfId: "dptf-1",
    });

    expect(preview?.entrypoints).toEqual(["CCp_FvtFixSlice (fan-out)"]);
  });
});

describe("standalone built-ins never emit a fragment", () => {
  it.each(["ouronet.aqp-inject", "ouronet.aqp-evict", "ouronet.aqp-unstall"] as const)(
    "%s is kind:'standalone' with no toFragment",
    (name) => {
      const descriptor = BUILTIN_DESCRIPTORS[name];

      expect(descriptor.kind).toBe("standalone");
      expect(descriptor.toFragment).toBeUndefined();
    },
  );
});

// --- Wave 2 (T2): composable `toFragment` support ---------------------------

const STOA_AUTONOMIC_LIQUIDPOT = "c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI";

describe("ouronet.stoa-wrap toFragment", () => {
  it("emits a read-decimal splice + literal payload + patron->LIQUIDPOT cap for a literal amount", () => {
    // Guards the literal-amount path: the executed code must read the amount
    // from env-data (never interpolate it), and the payload must actually
    // carry that value for the executor to supply at run time.
    const fragment = BUILTIN_DESCRIPTORS["ouronet.stoa-wrap"].toFragment?.({
      patronAccount: "k:patron1",
      amount: "5.0",
      amountCeiling: "5.0",
      namespace: "ouronet-ns",
    });

    expect(fragment).toEqual({
      pactExpr: '(ouronet-ns.TS01-C2.LQD|C_WrapStoa (read-string "patron") (read-string "executor") (read-decimal "amount"))',
      payload: { patron: "k:patron1", amount: "5.0" },
      requiredCaps: [
        { line: `(coin.TRANSFER "k:patron1" "${STOA_AUTONOMIC_LIQUIDPOT}" 5.0)` },
      ],
    });
  });

  it("splices an operator-authored Pact expression verbatim and carries no amount payload key", () => {
    // Guards the allowExpr path: a composed-in runtime expression (e.g. a
    // prior leg's drained amount) must be spliced directly into the Pact
    // source, not routed through env-data, since its value isn't known yet
    // at compose time.
    const fragment = BUILTIN_DESCRIPTORS["ouronet.stoa-wrap"].toFragment?.({
      patronAccount: "k:patron1",
      amount: '(at "drained" ctx)',
      amountCeiling: "100.0",
      namespace: "ouronet-ns",
    });

    expect(fragment?.pactExpr).toBe(
      '(ouronet-ns.TS01-C2.LQD|C_WrapStoa (read-string "patron") (read-string "executor") (at "drained" ctx))',
    );
    expect(fragment?.payload).not.toHaveProperty("amount");
  });

  it("sources the coin.TRANSFER cap's literal amount from amountCeiling, never amount", () => {
    // The whole reason amountCeiling exists as a separate field (design.md's
    // Design decision 1) — a mismatch here would silently under- or
    // over-reserve the managed capability.
    const fragment = BUILTIN_DESCRIPTORS["ouronet.stoa-wrap"].toFragment?.({
      patronAccount: "k:patron1",
      amount: "5.0",
      amountCeiling: "999.0",
      namespace: "ouronet-ns",
    });

    expect(fragment?.requiredCaps[0].line).toBe(
      `(coin.TRANSFER "k:patron1" "${STOA_AUTONOMIC_LIQUIDPOT}" 999.0)`,
    );
    expect(fragment?.requiredCaps[0].line).not.toContain(" 5.0)");
  });
});

describe("ouronet.stoa-unwrap toFragment", () => {
  it("emits a read-decimal splice + literal payload + LIQUIDPOT->target cap for a literal amount (needsCreate: no)", () => {
    const fragment = BUILTIN_DESCRIPTORS["ouronet.stoa-unwrap"].toFragment?.({
      patronAccount: "k:patron1",
      amount: "5.0",
      amountCeiling: "5.0",
      targetAccount: "c:target1",
      needsCreate: "no",
      namespace: "ouronet-ns",
    });

    expect(fragment).toEqual({
      pactExpr: '(ouronet-ns.TS01-C2.LQD|C_UnwrapStoa (read-string "patron") (read-string "executor") (read-decimal "amount"))',
      payload: { patron: "k:patron1", amount: "5.0" },
      requiredCaps: [
        { line: `(coin.TRANSFER "${STOA_AUTONOMIC_LIQUIDPOT}" "c:target1" 5.0)` },
      ],
    });
  });

  it("splices an operator-authored Pact expression verbatim and carries no amount payload key", () => {
    const fragment = BUILTIN_DESCRIPTORS["ouronet.stoa-unwrap"].toFragment?.({
      patronAccount: "k:patron1",
      amount: '(at "drained" ctx)',
      amountCeiling: "100.0",
      targetAccount: "c:target1",
      needsCreate: "no",
      namespace: "ouronet-ns",
    });

    expect(fragment?.pactExpr).toBe(
      '(ouronet-ns.TS01-C2.LQD|C_UnwrapStoa (read-string "patron") (read-string "executor") (at "drained" ctx))',
    );
    expect(fragment?.payload).not.toHaveProperty("amount");
  });

  it("sources the coin.TRANSFER cap's literal amount from amountCeiling, never amount", () => {
    const fragment = BUILTIN_DESCRIPTORS["ouronet.stoa-unwrap"].toFragment?.({
      patronAccount: "k:patron1",
      amount: "5.0",
      amountCeiling: "999.0",
      targetAccount: "c:target1",
      needsCreate: "no",
      namespace: "ouronet-ns",
    });

    expect(fragment?.requiredCaps[0].line).toBe(
      `(coin.TRANSFER "${STOA_AUTONOMIC_LIQUIDPOT}" "c:target1" 999.0)`,
    );
    expect(fragment?.requiredCaps[0].line).not.toContain(" 5.0)");
  });

  it("needsCreate: yes composes a create-account form ahead of the unwrap form, with ks/target payload keys", () => {
    // Composable mode has no chain read to probe account existence (design
    // decision 2) — this is the operator-supplied substitute, and it must
    // produce the identical two-form shape the real planner's own live probe
    // would have produced.
    const fragment = BUILTIN_DESCRIPTORS["ouronet.stoa-unwrap"].toFragment?.({
      patronAccount: "k:patron1",
      amount: "5.0",
      amountCeiling: "5.0",
      targetAccount: "k:abc123",
      needsCreate: "yes",
      namespace: "ouronet-ns",
    });

    expect(fragment?.pactExpr).toBe(
      '(coin.C_CreateAccount (read-string "target") (read-keyset "ks"))\n' +
        '(ouronet-ns.TS01-C2.LQD|C_UnwrapStoa (read-string "patron") (read-string "executor") (read-decimal "amount"))',
    );
    expect(fragment?.payload).toMatchObject({
      target: "k:abc123",
      ks: { keys: ["abc123"], pred: "keys-all" },
    });
  });

  it("needsCreate: no emits the single unwrap form only, with neither ks nor target payload keys", () => {
    const fragment = BUILTIN_DESCRIPTORS["ouronet.stoa-unwrap"].toFragment?.({
      patronAccount: "k:patron1",
      amount: "5.0",
      amountCeiling: "5.0",
      targetAccount: "c:target1",
      needsCreate: "no",
      namespace: "ouronet-ns",
    });

    expect(fragment?.pactExpr).toBe(
      '(ouronet-ns.TS01-C2.LQD|C_UnwrapStoa (read-string "patron") (read-string "executor") (read-decimal "amount"))',
    );
    expect(fragment?.payload).not.toHaveProperty("ks");
    expect(fragment?.payload).not.toHaveProperty("target");
  });
});

describe.each([
  {
    name: "ouronet.stoa-transmit" as const,
    transmitCall: "coin.C_Transmit",
    anewCall: "coin.C_TransmitAnew",
    capName: "coin.TRANSMIT",
  },
  {
    name: "ouronet.urstoa-transmit" as const,
    transmitCall: "coin.C_UR|Transmit",
    anewCall: "coin.C_UR|TransmitAnew",
    capName: "coin.UR|TRANSMIT",
  },
])("$name toFragment", ({ name, transmitCall, anewCall, capName }) => {
  it("emits a read-decimal splice + literal payload for a literal amount (variant: transmit)", () => {
    const fragment = BUILTIN_DESCRIPTORS[name].toFragment?.({
      sender: "k:sender1",
      receiver: "k:receiver1",
      variant: "transmit",
      amount: "5.0",
      capAmount: "5.0",
    });

    expect(fragment).toEqual({
      pactExpr: `(${transmitCall} (read-string "sender") (read-string "receiver") (read-decimal "amount"))`,
      payload: { sender: "k:sender1", receiver: "k:receiver1", amount: "5.0" },
      requiredCaps: [{ line: `(${capName} "k:sender1" "k:receiver1" 5.0)` }],
    });
  });

  it("splices an operator-authored Pact expression verbatim and carries no amount payload key (variant: transmit)", () => {
    const fragment = BUILTIN_DESCRIPTORS[name].toFragment?.({
      sender: "k:sender1",
      receiver: "k:receiver1",
      variant: "transmit",
      amount: '(at "drained" ctx)',
      capAmount: "100.0",
    });

    expect(fragment?.pactExpr).toBe(
      `(${transmitCall} (read-string "sender") (read-string "receiver") (at "drained" ctx))`,
    );
    expect(fragment?.payload).not.toHaveProperty("amount");
  });

  it("sources the coin.TRANSMIT cap's literal amount from capAmount, never amount", () => {
    // TRANSMIT is unmanaged (design decision 3) — there is no ceiling slack,
    // so this must be the exact value the operator promised, not the
    // (possibly different, possibly dynamic) transfer amount.
    const fragment = BUILTIN_DESCRIPTORS[name].toFragment?.({
      sender: "k:sender1",
      receiver: "k:receiver1",
      variant: "transmit",
      amount: "5.0",
      capAmount: "999.0",
    });

    expect(fragment?.requiredCaps[0].line).toBe(`(${capName} "k:sender1" "k:receiver1" 999.0)`);
    expect(fragment?.requiredCaps[0].line).not.toContain(" 5.0)");
  });

  it("variant: transmit-anew adds the receiver-guard keyset read + payload, absent for plain transmit", () => {
    const anew = BUILTIN_DESCRIPTORS[name].toFragment?.({
      sender: "k:sender1",
      receiver: "k:receiver1",
      variant: "transmit-anew",
      amount: "5.0",
      capAmount: "5.0",
      receiverPublicKey: "abc123",
    });

    expect(anew?.pactExpr).toBe(
      `(${anewCall} (read-string "sender") (read-string "receiver") (read-keyset "receiver-guard") (read-decimal "amount"))`,
    );
    expect(anew?.payload).toMatchObject({
      "receiver-guard": { keys: ["abc123"], pred: "keys-all" },
    });

    const plain = BUILTIN_DESCRIPTORS[name].toFragment?.({
      sender: "k:sender1",
      receiver: "k:receiver1",
      variant: "transmit",
      amount: "5.0",
      capAmount: "5.0",
    });

    expect(plain?.pactExpr).not.toContain("receiver-guard");
    expect(plain?.payload).not.toHaveProperty("receiver-guard");
  });
});

describe("amountCeiling vs capAmount help text", () => {
  it("are distinct strings, with capAmount's mentioning the hard-revert/exact-match consequence", () => {
    // Design decision 3's whole point: collapsing these two fields' framing
    // under one copy-pasted string would misrepresent the unmanaged
    // capability's actual (unforgiving) behavior to whoever reads the form.
    const ceilingHelp = BUILTIN_DESCRIPTORS["ouronet.stoa-wrap"].params.find(
      (f) => f.name === "amountCeiling",
    )?.help;
    const capAmountHelp = BUILTIN_DESCRIPTORS["ouronet.stoa-transmit"].params.find(
      (f) => f.name === "capAmount",
    )?.help;

    expect(ceilingHelp).toBeTruthy();
    expect(capAmountHelp).toBeTruthy();
    expect(capAmountHelp).not.toBe(ceilingHelp);
    expect(capAmountHelp).toMatch(/revert|exact/i);
  });
});

// Regression (review finding): account-typed/decimal-typed/namespace fields
// were spliced raw into `requiredCaps[].line`/`pactExpr` with zero shape
// validation — a value containing `"` or `)` could break out of its quoted
// or numeric slot and restructure the signed capability line or the
// executed Pact source itself. These pin that every composable descriptor
// now rejects a malformed value BEFORE it reaches either place.
describe("composable descriptors reject malformed account/decimal/namespace fields before splicing them anywhere", () => {
  it("ouronet.stoa-wrap rejects a patronAccount containing a quote, before building any fragment", () => {
    expect(() =>
      BUILTIN_DESCRIPTORS["ouronet.stoa-wrap"].toFragment?.({
        patronAccount: 'k:a" (coin.TRANSFER "attacker" "victim" 999999.0',
        amount: "5.0",
        amountCeiling: "5.0",
        namespace: "ouronet-ns",
      }),
    ).toThrow(/patronAccount/);
  });

  it("ouronet.stoa-wrap rejects a non-decimal amountCeiling, before building any fragment", () => {
    expect(() =>
      BUILTIN_DESCRIPTORS["ouronet.stoa-wrap"].toFragment?.({
        patronAccount: "k:patron1",
        amount: "5.0",
        amountCeiling: '1.0) (coin.TRANSFER "attacker" "victim" 999999.0',
        namespace: "ouronet-ns",
      }),
    ).toThrow(/amountCeiling/);
  });

  it("ouronet.stoa-wrap rejects a namespace containing a closing paren, before building any fragment", () => {
    expect(() =>
      BUILTIN_DESCRIPTORS["ouronet.stoa-wrap"].toFragment?.({
        patronAccount: "k:patron1",
        amount: "5.0",
        amountCeiling: "5.0",
        namespace: 'ouronet-ns) (coin.TRANSFER "x" "y" 1.0',
      }),
    ).toThrow(/namespace/);
  });

  it("ouronet.stoa-unwrap rejects a malformed targetAccount even on the needsCreate:'no' path (the cap-line-only path the prior guard missed)", () => {
    expect(() =>
      BUILTIN_DESCRIPTORS["ouronet.stoa-unwrap"].toFragment?.({
        patronAccount: "k:patron1",
        amount: "5.0",
        amountCeiling: "5.0",
        targetAccount: 'c:target1" (coin.TRANSFER "attacker" "victim" 999999.0',
        needsCreate: "no",
        namespace: "ouronet-ns",
      }),
    ).toThrow(/targetAccount/);
  });

  it.each(["ouronet.stoa-transmit", "ouronet.urstoa-transmit"])(
    "%s rejects a malformed sender/receiver/capAmount before building any fragment",
    (name) => {
      expect(() =>
        BUILTIN_DESCRIPTORS[name].toFragment?.({
          sender: 'k:a" (coin.TRANSMIT "x" "y" 1.0',
          receiver: "k:receiver1",
          variant: "transmit",
          amount: "5.0",
          capAmount: "5.0",
        }),
      ).toThrow(/sender/);

      expect(() =>
        BUILTIN_DESCRIPTORS[name].toFragment?.({
          sender: "k:sender1",
          receiver: 'k:a" (coin.TRANSMIT "x" "y" 1.0',
          variant: "transmit",
          amount: "5.0",
          capAmount: "5.0",
        }),
      ).toThrow(/receiver/);

      expect(() =>
        BUILTIN_DESCRIPTORS[name].toFragment?.({
          sender: "k:sender1",
          receiver: "k:receiver1",
          variant: "transmit",
          amount: "5.0",
          capAmount: '1.0) (coin.TRANSMIT "attacker" "victim" 999999.0',
        }),
      ).toThrow(/capAmount/);
    },
  );

  it.each(["ouronet.stoa-transmit", "ouronet.urstoa-transmit"])(
    "%s rejects variant:'transmit-anew' with a missing receiverPublicKey, instead of silently emitting a malformed keyset",
    (name) => {
      expect(() =>
        BUILTIN_DESCRIPTORS[name].toFragment?.({
          sender: "k:sender1",
          receiver: "k:receiver1",
          variant: "transmit-anew",
          amount: "5.0",
          capAmount: "5.0",
          // receiverPublicKey deliberately omitted
        }),
      ).toThrow(/receiverPublicKey/);

      expect(() =>
        BUILTIN_DESCRIPTORS[name].toFragment?.({
          sender: "k:sender1",
          receiver: "k:receiver1",
          variant: "transmit-anew",
          amount: "5.0",
          capAmount: "5.0",
          receiverPublicKey: "",
        }),
      ).toThrow(/receiverPublicKey/);
    },
  );
});
