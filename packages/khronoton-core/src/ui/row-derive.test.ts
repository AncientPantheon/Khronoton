import { describe, it, expect } from "vitest";

import type { CodexCronotonRow } from "../server/types.js";
import { isTriggerOnly } from "./row-derive.js";

describe("isTriggerOnly", () => {
  it("is true for an external-fireable row (evented, no runtime args)", () => {
    // external_fireable === 1 ⇒ the scheduler never auto-fires, regardless of
    // any persisted schedule/next-fire; both the list and detail must read "Evented".
    expect(isTriggerOnly({ external_fireable: 1, runtime_arg_keys: null } as CodexCronotonRow)).toBe(true);
  });

  it("is true for a row that declares runtime-arg keys", () => {
    // A runtime-arg cronoton is trigger-fired even when not external_fireable.
    expect(
      isTriggerOnly({ external_fireable: 0, runtime_arg_keys: JSON.stringify(["k"]) } as CodexCronotonRow),
    ).toBe(true);
  });

  it("is false for a plain scheduled row (no external fire, no runtime args)", () => {
    // The clock drives this row ⇒ its Schedule/next-fire cells show the real values.
    expect(isTriggerOnly({ external_fireable: 0, runtime_arg_keys: null } as CodexCronotonRow)).toBe(false);
  });

  it("is false when runtime_arg_keys is an empty array", () => {
    // An empty declared-keys array is not a trigger — it must not be mistaken for one.
    expect(isTriggerOnly({ external_fireable: 0, runtime_arg_keys: "[]" } as CodexCronotonRow)).toBe(false);
  });
});
