/**
 * The KhronotonAdapter seam guards. `assertAdapter` is the runtime contract the
 * provider (T4.5) runs on its `adapter` prop before mounting: a host that omits
 * a method must fail loudly at mount, not silently at the first call. These tests
 * pin (a) a complete adapter passes, (b) EVERY one of the 16 methods is required
 * — the omission is named in the throw so the host knows what to add, (c) the
 * `recover` method is required (REQ-G09, the wired-through-end gap), (d) a
 * non-object input is rejected, and (e) `emptySnapshot()` seeds are independent
 * so seeding one MemoryAdapter never leaks into another.
 */
import { describe, it, expect } from "vitest";

import { assertAdapter, emptySnapshot } from "./adapter.js";

/** The 16 operations every KhronotonAdapter must implement (mirrors the interface). */
const ADAPTER_METHODS = [
  "list",
  "get",
  "fires",
  "signers",
  "commit",
  "edit",
  "pause",
  "resume",
  "delete",
  "simulate",
  "executeNow",
  "trigger",
  "startBatch",
  "getBatch",
  "cancelBatch",
  "recover",
] as const;

/** A structurally-complete adapter double: every method present as a function. */
function completeAdapter(): Record<string, unknown> {
  const adapter: Record<string, unknown> = {};
  for (const method of ADAPTER_METHODS) {
    adapter[method] = async () => ({ ok: true });
  }
  return adapter;
}

describe("assertAdapter", () => {
  it("passes a structurally-complete adapter (all 16 methods present)", () => {
    expect(() => assertAdapter(completeAdapter())).not.toThrow();
  });

  it("throws naming the specific missing method for each omitted operation", () => {
    for (const missing of ADAPTER_METHODS) {
      const adapter = completeAdapter();
      delete adapter[missing];
      expect(() => assertAdapter(adapter)).toThrow(new RegExp(missing));
    }
  });

  it("requires the recover method (the wired-through-end gap)", () => {
    const adapter = completeAdapter();
    delete adapter.recover;
    expect(() => assertAdapter(adapter)).toThrow(/recover/);
  });

  it("rejects a method that is present but not callable", () => {
    const adapter = completeAdapter();
    adapter.commit = "not-a-function";
    expect(() => assertAdapter(adapter)).toThrow(/commit/);
  });

  it("rejects a non-object input", () => {
    expect(() => assertAdapter(null)).toThrow();
    expect(() => assertAdapter(undefined)).toThrow();
    expect(() => assertAdapter(42)).toThrow();
  });
});

describe("emptySnapshot", () => {
  it("returns an empty cronoton seed", () => {
    expect(emptySnapshot()).toEqual({ cronotons: [] });
  });

  it("returns an independent copy each call so seeds never alias", () => {
    const a = emptySnapshot();
    const b = emptySnapshot();
    a.cronotons.push({} as never);
    expect(b.cronotons).toEqual([]);
  });
});
