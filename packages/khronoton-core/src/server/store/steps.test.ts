/**
 * steps — the decision-free CRUD layer for `codex_cronoton_steps` (the STATIC
 * step definitions of a chained run, per `docs/work/khronoton-chained-runs/
 * design.md`'s Phase 1). Exercised against a REAL in-memory better-sqlite3 DB
 * (never a SQL-string mock), mirroring `claim.test.ts`'s own stated rationale:
 * a mock that always reports `changes: 1` cannot prove the UNIQUE
 * `(codex_cronoton_id, step_index)` index is actually enforced.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getStepByIndex, insertStep, listStepsForCronoton } from "./steps.js";
import { StepAlreadyExistsError } from "./errors.js";
import { installSchema } from "../schema.js";

let db: Database.Database;

/** Raw-SQL-inserted `codex_cronotons` parent row, mirroring `claim.test.ts`'s own `seedCronoton` helper. */
function seedCronoton(id = "cc-1"): void {
  db.prepare(
    `INSERT INTO codex_cronotons
       (id, name, pact_code, config_json, gas_payer_json, signers_json,
        schedule_mode, schedule_config_json, status, next_fire_at, last_fire_at,
        created_at, modified_at, created_by, runtime_arg_keys)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "n",
    "(code)",
    "{}",
    "{}",
    "[]",
    "every-n-minutes",
    JSON.stringify({ mode: "every-n-minutes", startDate: "2026-01-01T00:00:00.000Z", intervalMinutes: 60 }),
    "active",
    null,
    null,
    "t0",
    "t0",
    "op",
    null,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  installSchema(db);
  seedCronoton();
});

afterEach(() => {
  db.close();
});

describe("insertStep / listStepsForCronoton — single mode", () => {
  it("persists pact_code/config_json/payload_json/gas_payer_json/signers_json and reads back identically", () => {
    const id = insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 0,
        mode: "single",
        pactCode: "(my-module.do-thing)",
        config: { chainId: "0" },
        payload: { amount: 10 },
        gasPayer: { type: "fixed", account: "gas-station" },
        signers: [{ pubKey: "abc" }],
      },
      { db },
    );

    const steps = listStepsForCronoton("cc-1", { db });

    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe(id);
    expect(steps[0].mode).toBe("single");
    expect(steps[0].pact_code).toBe("(my-module.do-thing)");
    expect(steps[0].config_json).toBe(JSON.stringify({ chainId: "0" }));
    expect(steps[0].payload_json).toBe(JSON.stringify({ amount: 10 }));
    expect(steps[0].gas_payer_json).toBe(JSON.stringify({ type: "fixed", account: "gas-station" }));
    expect(steps[0].signers_json).toBe(JSON.stringify([{ pubKey: "abc" }]));
  });
});

describe("insertStep / listStepsForCronoton — planner mode", () => {
  it("persists planner_name/planner_params_json and reads back identically", () => {
    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 0,
        mode: "planner",
        plannerName: "ouronet.aqp-inject",
        plannerParams: { cursorSize: 25 },
      },
      { db },
    );

    const steps = listStepsForCronoton("cc-1", { db });

    expect(steps).toHaveLength(1);
    expect(steps[0].mode).toBe("planner");
    expect(steps[0].planner_name).toBe("ouronet.aqp-inject");
    expect(steps[0].planner_params_json).toBe(JSON.stringify({ cursorSize: 25 }));
    // A planner-mode step carries no single-tx fields.
    expect(steps[0].pact_code).toBeNull();
  });
});

describe("listStepsForCronoton — ordering", () => {
  it("returns steps ordered by step_index ascending regardless of insertion order", () => {
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 2, mode: "single", pactCode: "(step-2)" },
      { db },
    );
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 0, mode: "single", pactCode: "(step-0)" },
      { db },
    );
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 1, mode: "single", pactCode: "(step-1)" },
      { db },
    );

    const steps = listStepsForCronoton("cc-1", { db });

    expect(steps.map((s) => s.step_index)).toEqual([0, 1, 2]);
  });
});

describe("insertStep — idempotent flag", () => {
  it("round-trips a truthy idempotent field, stored as 1 and projected as a number for the raw row", () => {
    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 0,
        mode: "single",
        pactCode: "(idempotent-step)",
        idempotent: true,
      },
      { db },
    );

    const steps = listStepsForCronoton("cc-1", { db });

    expect(steps[0].idempotent).toBe(1);
  });

  it("defaults idempotent to 0 (falsy) when not supplied", () => {
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 0, mode: "single", pactCode: "(default-step)" },
      { db },
    );

    const steps = listStepsForCronoton("cc-1", { db });

    expect(steps[0].idempotent).toBe(0);
  });
});

describe("insertStep — yieldAs", () => {
  it("persists yield_as on a mode:'single' step, readable via listStepsForCronoton", () => {
    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 0,
        mode: "single",
        pactCode: "(drain-miner)",
        yieldAs: "drainedAmount",
      },
      { db },
    );

    const steps = listStepsForCronoton("cc-1", { db });

    expect(steps[0].yield_as).toBe("drainedAmount");
  });

  it("persists yield_as on a mode:'planner' step, readable via listStepsForCronoton", () => {
    insertStep(
      {
        codexCronotonId: "cc-1",
        stepIndex: 0,
        mode: "planner",
        plannerName: "ouronet.stoa-wrap",
        yieldAs: "wrappedAmount",
      },
      { db },
    );

    const steps = listStepsForCronoton("cc-1", { db });

    expect(steps[0].yield_as).toBe("wrappedAmount");
  });

  it("leaves yield_as null when omitted (backward compatible with every existing insertStep call)", () => {
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 0, mode: "single", pactCode: "(no-yield)" },
      { db },
    );

    const steps = listStepsForCronoton("cc-1", { db });

    expect(steps[0].yield_as).toBeNull();
  });
});

describe("insertStep — prepared statement caching", () => {
  it("prepares the INSERT statement once across N calls against the same db instance, still inserting every row", () => {
    const prepareSpy = vi.spyOn(db, "prepare");

    insertStep({ codexCronotonId: "cc-1", stepIndex: 0, mode: "single", pactCode: "(step-0)" }, { db });
    insertStep({ codexCronotonId: "cc-1", stepIndex: 1, mode: "single", pactCode: "(step-1)" }, { db });
    insertStep({ codexCronotonId: "cc-1", stepIndex: 2, mode: "single", pactCode: "(step-2)" }, { db });

    // Re-parsing the identical INSERT SQL on every call (rather than
    // preparing once and reusing the compiled statement) is exactly the
    // per-call recompilation `commitChainedCronoton` (chain.ts) would
    // otherwise pay N times over for an N-step chain.
    expect(prepareSpy).toHaveBeenCalledTimes(1);

    const steps = listStepsForCronoton("cc-1", { db });
    expect(steps.map((s) => s.pact_code)).toEqual(["(step-0)", "(step-1)", "(step-2)"]);
  });
});

describe("insertStep — UNIQUE (codex_cronoton_id, step_index)", () => {
  it("throws the typed StepAlreadyExistsError (not a raw SqliteError) on a second insert for the same (codexCronotonId, stepIndex) pair", () => {
    insertStep(
      { codexCronotonId: "cc-1", stepIndex: 0, mode: "single", pactCode: "(first)" },
      { db },
    );

    expect(() =>
      insertStep(
        { codexCronotonId: "cc-1", stepIndex: 0, mode: "single", pactCode: "(second)" },
        { db },
      ),
    ).toThrow(StepAlreadyExistsError);

    // The first row is untouched — exactly one step exists at step_index 0.
    expect(listStepsForCronoton("cc-1", { db })).toHaveLength(1);
  });
});

describe("getStepByIndex", () => {
  it("returns the step row at the given (codexCronotonId, stepIndex) slot via a direct lookup, not a full-list scan", () => {
    insertStep({ codexCronotonId: "cc-1", stepIndex: 0, mode: "single", pactCode: "(zero)" }, { db });
    insertStep({ codexCronotonId: "cc-1", stepIndex: 1, mode: "single", pactCode: "(one)" }, { db });

    const step = getStepByIndex("cc-1", 1, { db });

    expect(step).not.toBeNull();
    expect(step?.pact_code).toBe("(one)");
    expect(step?.step_index).toBe(1);
  });

  it("returns null for a step_index that does not exist for the cronoton", () => {
    insertStep({ codexCronotonId: "cc-1", stepIndex: 0, mode: "single", pactCode: "(zero)" }, { db });

    expect(getStepByIndex("cc-1", 7, { db })).toBeNull();
  });

  it("never returns a different cronoton's step at the same index (scoped by codexCronotonId, not step_index alone)", () => {
    seedCronoton("cc-2");
    insertStep({ codexCronotonId: "cc-1", stepIndex: 0, mode: "single", pactCode: "(cc-1 step 0)" }, { db });
    insertStep({ codexCronotonId: "cc-2", stepIndex: 0, mode: "single", pactCode: "(cc-2 step 0)" }, { db });

    expect(getStepByIndex("cc-1", 0, { db })?.pact_code).toBe("(cc-1 step 0)");
    expect(getStepByIndex("cc-2", 0, { db })?.pact_code).toBe("(cc-2 step 0)");
  });
});
