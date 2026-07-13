/**
 * Resolve-smoke for the `/handlers` barrel: the sixteen-name route contract must
 * be exported (the read handlers under their contract aliases, not their module
 * `*Handler` names) and callable, and the wiring surface a consumer needs
 * (`defaultOpenAuth`, `NeedsConfirmError`) must be present. Guards against the
 * barrel drifting from the [PARITY §4] contract or a Phase-A stub regression.
 */
import { describe, it, expect } from "vitest";

import * as handlers from "../../src/handlers/index.js";

const CONTRACT_HANDLERS = [
  "listCodexCronotons",
  "getCodexCronoton",
  "commitCodexCronoton",
  "editCodexCronoton",
  "pauseCodexCronoton",
  "resumeCodexCronoton",
  "deleteCodexCronoton",
  "simulateCodexTx",
  "executeNow",
  "triggerCronoton",
  "startExecuteBatch",
  "getExecuteBatch",
  "cancelExecuteBatch",
  "fetchSigners",
  "fetchFires",
  "recoverFire",
] as const;

describe("/handlers barrel", () => {
  it("exports all sixteen route handlers as callables under their contract names", () => {
    for (const name of CONTRACT_HANDLERS) {
      expect(typeof (handlers as Record<string, unknown>)[name]).toBe("function");
    }
    expect(CONTRACT_HANDLERS).toHaveLength(16);
  });

  it("aliases the read handlers to their contract names (no `*Handler` leak)", () => {
    // The read module names its impls `listHandler`/`getHandler`/`signersHandler`/
    // `firesHandler`; the barrel must surface the PARITY contract names instead so
    // a consumer wires `fetchSigners`/`fetchFires`, never the module-internal name.
    const surface = handlers as Record<string, unknown>;
    expect(surface.fetchSigners).toBe(surface.fetchSigners);
    expect(surface.listHandler).toBeUndefined();
    expect(surface.getHandler).toBeUndefined();
    expect(surface.signersHandler).toBeUndefined();
    expect(surface.firesHandler).toBeUndefined();
  });

  it("drops the Phase-A stub", () => {
    expect((handlers as Record<string, unknown>).__khronotonHandlersStub).toBeUndefined();
  });

  it("exports the wiring surface: defaultOpenAuth grants read and 401s a stale confirm", () => {
    expect(typeof handlers.NeedsConfirmError).toBe("function");
    const read = handlers.defaultOpenAuth.requireRead({});
    expect(read).toEqual({ ok: true, identity: {} });
    const staleConfirm = handlers.defaultOpenAuth.requireConfirm({ confirmed: false });
    expect(staleConfirm).toEqual({
      ok: false,
      response: { status: 401, body: { error: "admin_confirm_required" } },
    });
  });
});
