/**
 * schema — shape verification for the consolidated `installSchema(db)` DDL.
 *
 * This is an infrastructure (DDL) surface, so the test verifies the SHAPE the
 * installer produces rather than business logic: the three tables exist, the
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
  it("creates all three codex tables", () => {
    const names = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'codex_%' ORDER BY name`,
      )
      .all()
      .map((r) => (r as { name: string }).name);

    expect(names).toEqual([
      "codex_cronoton_fires",
      "codex_cronoton_manual_batches",
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
});
