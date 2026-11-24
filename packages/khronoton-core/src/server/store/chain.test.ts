/**
 * chain — `commitChainedCronoton`'s write ORDER (parent row → N step inserts →
 * optional single-tx-first edit) and its two validation-reject short-circuits,
 * exercised against a REAL in-memory better-sqlite3 DB, mirroring
 * `cronoton.test.ts`/`steps.test.ts`'s own stated rationale: a mock that always
 * reports success cannot prove nothing was written on a reject, or that the
 * single-tx-first edit truly only lands once the steps it depends on exist.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  commitChainedCronoton,
  type CommitChainedCronotonInput,
} from "./chain.js";
import { getCodexCronoton } from "./cronoton.js";
import { AutoGasGateError, CodexCronotonValidationError } from "./errors.js";
import { listStepsForCronoton } from "./steps.js";
import { installSchema } from "../schema.js";

let db: Database.Database;

function validChainInput(
  overrides: Partial<CommitChainedCronotonInput> = {},
): CommitChainedCronotonInput {
  return {
    name: "a chained cronoton",
    createdBy: "admin@x",
    steps: [
      { mode: "single", pactCode: "(step-0)" },
      { mode: "single", pactCode: "(step-1)" },
    ],
    ...overrides,
  };
}

function countCronotonRows(): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM codex_cronotons`).get() as { n: number }
  ).n;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  installSchema(db);
});

afterEach(() => {
  db.close();
});

describe("commitChainedCronoton — success write order", () => {
  it("creates the parent row first, then inserts each step in order, and returns stepIds matching input.steps.length", () => {
    const result = commitChainedCronoton(validChainInput(), { db });

    expect(result.stepIds).toHaveLength(2);

    const parent = getCodexCronoton(result.id, { db });
    expect(parent).not.toBeNull();
    expect(parent!.name).toBe("a chained cronoton");

    const steps = listStepsForCronoton(result.id, { db });
    expect(steps).toHaveLength(2);
    // Each step was inserted against the just-created parent id, at the
    // index matching its position in input.steps — proving the parent row
    // existed BEFORE any insertStep call (a foreign-key-less insert could
    // otherwise succeed against a nonexistent parent, but the index/order
    // pairing below is what the consumer actually relies on).
    expect(steps.map((s) => s.codex_cronoton_id)).toEqual([result.id, result.id]);
    expect(steps.map((s) => s.step_index)).toEqual([0, 1]);
    expect(steps.map((s) => s.pact_code)).toEqual(["(step-0)", "(step-1)"]);
    expect(steps.map((s) => s.id)).toEqual(result.stepIds);
  });
});

describe("commitChainedCronoton — validateChain rejection short-circuits before any write", () => {
  it("rejects a step with mode:'single' and no pactCode, and writes NEITHER the parent row nor any step", () => {
    let caught: unknown;
    try {
      commitChainedCronoton(
        validChainInput({ steps: [{ mode: "single" }] }),
        { db },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CodexCronotonValidationError);
    expect((caught as Error).message).toMatch(/pactCode/);
    // No parent row and no step row exist — the reject happened before
    // commitCodexCronoton (or insertStep) ever ran.
    expect(countCronotonRows()).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM codex_cronoton_steps`).get()).toEqual({
      n: 0,
    });
  });
});

describe("commitChainedCronoton — validateSingleTxVariant rejection short-circuits before any write", () => {
  it("rejects a singleTxFirst variant with an empty pactCode, and writes NEITHER the parent row nor any step", () => {
    let caught: unknown;
    try {
      commitChainedCronoton(
        validChainInput({
          singleTxFirst: {
            pactCode: "",
            gasPayer: { type: "gas-station" },
            signers: [],
          },
        }),
        { db },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CodexCronotonValidationError);
    expect((caught as Error).message).toMatch(/single-tx-first requires a non-empty/);
    // Same short-circuit guarantee as the validateChain reject above: a bad
    // single-tx variant must never leave a half-written chain behind.
    expect(countCronotonRows()).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM codex_cronoton_steps`).get()).toEqual({
      n: 0,
    });
  });
});

describe("commitChainedCronoton — per-step config gas-economics guards", () => {
  it("rejects a step with a negative config.gasPriceBufferAnu, and writes NEITHER the parent row nor any step", () => {
    let caught: unknown;
    try {
      commitChainedCronoton(
        validChainInput({
          steps: [
            { mode: "single", pactCode: "(step-0)" },
            {
              mode: "single",
              pactCode: "(step-1)",
              config: { chainId: "0", gasPriceBufferAnu: -1 },
            },
          ],
        }),
        { db },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CodexCronotonValidationError);
    expect((caught as Error).message).toMatch(/gasPriceBufferAnu/);
    // The whole commit must reject up front — a bad step 1 config must not
    // leave step 0 (or the parent row) already written.
    expect(countCronotonRows()).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM codex_cronoton_steps`).get()).toEqual({
      n: 0,
    });
  });

  it("rejects a step with autoGasLimit:true and no concrete gasLimit, and writes NEITHER the parent row nor any step", () => {
    let caught: unknown;
    try {
      commitChainedCronoton(
        validChainInput({
          steps: [
            {
              mode: "single",
              pactCode: "(step-0)",
              config: { chainId: "0", autoGasLimit: true },
            },
          ],
        }),
        { db },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AutoGasGateError);
    expect((caught as Error).message).toMatch(/gasLimit/);
    expect(countCronotonRows()).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM codex_cronoton_steps`).get()).toEqual({
      n: 0,
    });
  });
});

describe("commitChainedCronoton — single-tx-first enablement timing", () => {
  it("enables try_single_tx_first/single_tx_mode only when a variant was requested, and only after every step row exists", () => {
    const result = commitChainedCronoton(
      validChainInput({
        singleTxFirst: {
          pactCode: "(whole-chain-as-one-tx)",
          gasPayer: { type: "gas-station" },
          signers: [],
        },
      }),
      { db },
    );

    // The steps exist — if the editCodexCronoton call had run BEFORE the step
    // inserts, the row's own "no steps yet" guard (exercised directly in
    // cronoton.test.ts's "edit rejects enabling trySingleTxFirst on a row
    // with zero steps") would have thrown instead of succeeding here.
    expect(listStepsForCronoton(result.id, { db })).toHaveLength(2);

    const parent = getCodexCronoton(result.id, { db })!;
    expect(parent.try_single_tx_first).toBe(1);
    expect(parent.single_tx_mode).toBe("custom");
  });

  it("leaves try_single_tx_first: 0 / single_tx_mode: null when no singleTxFirst variant was requested", () => {
    const result = commitChainedCronoton(validChainInput(), { db });

    const parent = getCodexCronoton(result.id, { db })!;
    expect(parent.try_single_tx_first).toBe(0);
    expect(parent.single_tx_mode).toBeNull();
  });
});
