/**
 * schema — shape verification for the consolidated `installSchema(db)` DDL.
 *
 * This is an infrastructure (DDL) surface, so the test verifies the SHAPE the
 * installer produces rather than business logic: the seven tables exist, the
 * genericization deltas hold (no `jobs(id)` FK on `job_id`, no CHECK on
 * `fires.status`), the `ON DELETE CASCADE` from a cronoton reaches its fires and
 * manual batches, and a re-run is idempotent. A real `better-sqlite3` handle
 * (dev-dependency) structurally satisfies the `Database` seam `installSchema`
 * is typed against, so this doubles as proof the injected handle works end to end.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installSchema } from "./schema.js";

let db: Database.Database;

function insertCronoton(id: string): void {
  db.prepare(
    `INSERT INTO codex_cronotons
       (id, name, pact_code, config_json, gas_payer_json, signers_json,
        schedule_mode, schedule_config_json, created_at, modified_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, "n", "(code)", "{}", "{}", "[]", "one-time", "{}", "t0", "t0", "op");
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  installSchema(db);
});

afterEach(() => {
  db.close();
});

describe("installSchema", () => {
  it("creates all seven codex tables", () => {
    const names = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'codex_%' ORDER BY name`,
      )
      .all()
      .map((r) => (r as { name: string }).name);

    expect(names).toEqual([
      "codex_cronoton_fires",
      "codex_cronoton_manual_batches",
      "codex_cronoton_run_legs",
      "codex_cronoton_run_yields",
      "codex_cronoton_runs",
      "codex_cronoton_steps",
      "codex_cronotons",
    ]);
  });

  it("carries the genericized codex_cronotons columns (server_resolver, external_fireable, runtime_arg_keys)", () => {
    const cols = db
      .prepare(`PRAGMA table_info(codex_cronotons)`)
      .all()
      .map((c) => (c as { name: string }).name);

    for (const expected of [
      "server_resolver",
      "fire_mode_override",
      "external_fireable",
      "runtime_arg_keys",
      "next_fire_at",
      "public_token",
      "public_observable",
    ]) {
      expect(cols).toContain(expected);
    }
  });

  it("defaults external_fireable to 0 without an explicit value", () => {
    insertCronoton("c-default");
    const row = db
      .prepare(`SELECT external_fireable FROM codex_cronotons WHERE id = ?`)
      .get("c-default") as { external_fireable: number };
    expect(row.external_fireable).toBe(0);
  });

  it("allows a fire row with a job_id that references no jobs table (FK dropped)", () => {
    insertCronoton("c1");
    const insert = () =>
      db
        .prepare(
          `INSERT INTO codex_cronoton_fires (id, codex_cronoton_id, job_id, fired_at, status)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("f1", "c1", "job-that-does-not-exist", "t1", "success");

    expect(insert).not.toThrow();
  });

  it("accepts a fire status outside success/failure (status CHECK dropped)", () => {
    insertCronoton("c2");
    const insert = () =>
      db
        .prepare(
          `INSERT INTO codex_cronoton_fires (id, codex_cronoton_id, fired_at, status)
           VALUES (?, ?, ?, ?)`,
        )
        .run("f2", "c2", "t1", "nothing");

    expect(insert).not.toThrow();
    const row = db
      .prepare(`SELECT status, mode FROM codex_cronoton_fires WHERE id = ?`)
      .get("f2") as { status: string; mode: string };
    expect(row.status).toBe("nothing");
    expect(row.mode).toBe("test");
  });

  it("rejects a fire whose codex_cronoton_id has no parent (CASCADE FK still enforced)", () => {
    const insert = () =>
      db
        .prepare(
          `INSERT INTO codex_cronoton_fires (id, codex_cronoton_id, fired_at, status)
           VALUES (?, ?, ?, ?)`,
        )
        .run("orphan", "no-such-cronoton", "t1", "success");

    expect(insert).toThrow(/FOREIGN KEY/i);
  });

  it("cascades a cronoton delete to its fires and manual batches", () => {
    insertCronoton("c3");
    db.prepare(
      `INSERT INTO codex_cronoton_fires (id, codex_cronoton_id, fired_at, status)
       VALUES (?, ?, ?, ?)`,
    ).run("f3", "c3", "t1", "success");
    db.prepare(
      `INSERT INTO codex_cronoton_manual_batches
         (id, codex_cronoton_id, total, created_at, modified_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("b3", "c3", 5, "t0", "t0", "op");

    db.prepare(`DELETE FROM codex_cronotons WHERE id = ?`).run("c3");

    const fires = db
      .prepare(`SELECT COUNT(*) AS n FROM codex_cronoton_fires WHERE codex_cronoton_id = ?`)
      .get("c3") as { n: number };
    const batches = db
      .prepare(
        `SELECT COUNT(*) AS n FROM codex_cronoton_manual_batches WHERE codex_cronoton_id = ?`,
      )
      .get("c3") as { n: number };

    expect(fires.n).toBe(0);
    expect(batches.n).toBe(0);
  });

  it("is idempotent — a second installSchema call is a no-op and preserves data", () => {
    insertCronoton("c4");
    expect(() => installSchema(db)).not.toThrow();

    const row = db
      .prepare(`SELECT id FROM codex_cronotons WHERE id = ?`)
      .get("c4") as { id: string } | undefined;
    expect(row?.id).toBe("c4");
  });

  it("ensureColumn adds public_token/public_observable to a pre-existing table", () => {
    const legacyDb = new Database(":memory:");
    legacyDb.exec(`
      CREATE TABLE codex_cronotons (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        pact_code            TEXT NOT NULL,
        config_json          TEXT NOT NULL,
        gas_payer_json       TEXT NOT NULL,
        signers_json         TEXT NOT NULL,
        schedule_mode        TEXT NOT NULL,
        schedule_config_json TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'active',
        next_fire_at         TEXT,
        last_fire_at         TEXT,
        created_at           TEXT NOT NULL,
        modified_at          TEXT NOT NULL,
        created_by           TEXT NOT NULL
      );
    `);
    legacyDb
      .prepare(
        `INSERT INTO codex_cronotons
           (id, name, pact_code, config_json, gas_payer_json, signers_json,
            schedule_mode, schedule_config_json, created_at, modified_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("legacy-1", "n", "(code)", "{}", "{}", "[]", "one-time", "{}", "t0", "t0", "op");

    expect(() => installSchema(legacyDb)).not.toThrow();

    const cols = legacyDb
      .prepare(`PRAGMA table_info(codex_cronotons)`)
      .all()
      .map((c) => (c as { name: string }).name);
    expect(cols).toContain("public_token");
    expect(cols).toContain("public_observable");

    const row = legacyDb
      .prepare(`SELECT id, public_observable FROM codex_cronotons WHERE id = ?`)
      .get("legacy-1") as { id: string; public_observable: number };
    expect(row.id).toBe("legacy-1");
    expect(row.public_observable).toBe(0);

    legacyDb.close();
  });

  it("creates the three chained-run tables (codex_cronoton_steps, codex_cronoton_runs, codex_cronoton_run_legs)", () => {
    const names = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);

    expect(names).toContain("codex_cronoton_steps");
    expect(names).toContain("codex_cronoton_runs");
    expect(names).toContain("codex_cronoton_run_legs");
  });

  it("enforces the partial unique self-block index: only one non-terminal run per cronoton", () => {
    insertCronoton("c-run");
    const insertRun = (id: string, status: string) =>
      db
        .prepare(
          `INSERT INTO codex_cronoton_runs
             (id, codex_cronoton_id, status, step_count, started_at, modified_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, "c-run", status, 3, "t0", "t0");

    expect(() => insertRun("run-1", "awaiting")).not.toThrow();

    expect(() => insertRun("run-2", "planning")).toThrow(/UNIQUE constraint/i);

    db.prepare(`UPDATE codex_cronoton_runs SET status = ? WHERE id = ?`).run("failed", "run-1");

    expect(() => insertRun("run-3", "awaiting")).not.toThrow();
  });

  it("enforces codex_cronoton_steps' mode-shape CHECK (single needs pact_code, planner needs planner_name)", () => {
    insertCronoton("c-step");
    const insertStep = (
      id: string,
      stepIndex: number,
      mode: string,
      pactCode: string | null,
      plannerName: string | null,
    ) =>
      db
        .prepare(
          `INSERT INTO codex_cronoton_steps
             (id, codex_cronoton_id, step_index, mode, pact_code, planner_name, created_at, modified_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, "c-step", stepIndex, mode, pactCode, plannerName, "t0", "t0");

    expect(() => insertStep("s1", 0, "single", "(code)", null)).not.toThrow();
    expect(() => insertStep("s2", 1, "single", null, null)).toThrow(/CHECK constraint/i);
    expect(() => insertStep("s3", 2, "planner", null, "evict-planner")).not.toThrow();
    expect(() => insertStep("s4", 3, "planner", null, null)).toThrow(/CHECK constraint/i);
  });

  it("re-creates the three chained-run tables on installSchema when upgrading from a pre-this-change db", () => {
    db.exec(`DROP TABLE codex_cronoton_run_legs`);
    db.exec(`DROP TABLE codex_cronoton_runs`);
    db.exec(`DROP TABLE codex_cronoton_steps`);

    const namesBefore = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(namesBefore).not.toContain("codex_cronoton_steps");
    expect(namesBefore).not.toContain("codex_cronoton_runs");
    expect(namesBefore).not.toContain("codex_cronoton_run_legs");

    expect(() => installSchema(db)).not.toThrow();

    const namesAfter = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(namesAfter).toContain("codex_cronoton_steps");
    expect(namesAfter).toContain("codex_cronoton_runs");
    expect(namesAfter).toContain("codex_cronoton_run_legs");
  });

  it("creates codex_cronoton_run_yields with the expected columns and a UNIQUE index on (run_id, name), on both a fresh install and a re-run", () => {
    const expectedColumns = ["id", "run_id", "name", "value_json", "step_index", "created_at"];

    const assertShape = (handle: Database.Database) => {
      const cols = handle
        .prepare(`PRAGMA table_info(codex_cronoton_run_yields)`)
        .all()
        .map((c) => (c as { name: string }).name);
      for (const expected of expectedColumns) {
        expect(cols).toContain(expected);
      }

      const indexes = handle
        .prepare(`PRAGMA index_list(codex_cronoton_run_yields)`)
        .all() as Array<{ name: string; unique: number }>;
      const nameIndex = indexes.find((idx) => {
        const indexCols = handle
          .prepare(`PRAGMA index_info(${idx.name})`)
          .all()
          .map((c) => (c as { name: string }).name);
        return indexCols.includes("run_id") && indexCols.includes("name");
      });
      expect(nameIndex).toBeDefined();
      expect(nameIndex?.unique).toBe(1);
    };

    // Fresh install (already installed in beforeEach).
    assertShape(db);

    // Re-run against an already-provisioned DB is idempotent.
    expect(() => installSchema(db)).not.toThrow();
    assertShape(db);
  });

  it("adds a nullable yield_as TEXT column to codex_cronoton_steps, on both a fresh install and a re-run", () => {
    const assertHasYieldAs = (handle: Database.Database) => {
      const cols = handle
        .prepare(`PRAGMA table_info(codex_cronoton_steps)`)
        .all() as Array<{ name: string; notnull: number }>;
      const yieldAs = cols.find((c) => c.name === "yield_as");
      expect(yieldAs).toBeDefined();
      expect(yieldAs?.notnull).toBe(0);
    };

    assertHasYieldAs(db);

    expect(() => installSchema(db)).not.toThrow();
    assertHasYieldAs(db);
  });

  it("public_token has a unique index that still allows multiple NULLs", () => {
    const freshDb = new Database(":memory:");
    installSchema(freshDb);

    const insert = (id: string, publicToken: string | null) =>
      freshDb
        .prepare(
          `INSERT INTO codex_cronotons
             (id, name, pact_code, config_json, gas_payer_json, signers_json,
              schedule_mode, schedule_config_json, created_at, modified_at, created_by, public_token)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, "n", "(code)", "{}", "{}", "[]", "one-time", "{}", "t0", "t0", "op", publicToken);

    expect(() => insert("n1", null)).not.toThrow();
    expect(() => insert("n2", null)).not.toThrow();
    expect(() => insert("n3", "tok-abc")).not.toThrow();
    expect(() => insert("n4", "tok-abc")).toThrow(/UNIQUE constraint/i);

    freshDb.close();
  });
});
