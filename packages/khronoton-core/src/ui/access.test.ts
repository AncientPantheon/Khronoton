import { describe, it, expect } from "vitest";

import {
  canMutate,
  deleteDisabled,
  pauseResumeDisabled,
  executeDisabled,
  newCronotonTier,
  ADMIN_ONLY_TITLE,
  SYSTEM_CRONOTON_DELETE_TITLE,
  TERMINAL_PAUSE_RESUME_TITLE,
  TERMINAL_EXECUTE_TITLE,
  BATCH_ACTIVE_TITLE,
  type Access,
} from "./access.js";
import type { CodexCronotonRow } from "../server/types.js";

const LOGGED_OUT: Access = { tier: "logged-out" };
const NON_ADMIN: Access = { tier: "non-admin", email: "reader@stoa" };
const ADMIN: Access = { tier: "admin", email: "ancient@stoa" };

type Row = Pick<CodexCronotonRow, "status" | "server_resolver">;
const row = (over: Partial<Row> = {}): Row => ({
  status: "active",
  server_resolver: null,
  ...over,
});

describe("canMutate", () => {
  it("grants mutation only to the admin tier so the public/non-admin views stay read-only", () => {
    expect(canMutate(ADMIN)).toBe(true);
    expect(canMutate(NON_ADMIN)).toBe(false);
    expect(canMutate(LOGGED_OUT)).toBe(false);
  });
});

describe("deleteDisabled", () => {
  it("blocks a system (server-resolver) cronoton for an admin with the system-lock title, since it must be paused not deleted", () => {
    expect(deleteDisabled(ADMIN, row({ server_resolver: "stoicism-mint" }))).toEqual({
      disabled: true,
      title: SYSTEM_CRONOTON_DELETE_TITLE,
    });
  });

  it("announces the system-lock title even to a non-admin, because the row lock takes precedence over the access tier", () => {
    expect(
      deleteDisabled(NON_ADMIN, row({ server_resolver: "stoicism-mint" })).title,
    ).toBe(SYSTEM_CRONOTON_DELETE_TITLE);
  });

  it("blocks an ordinary cronoton for a non-admin with the admins-only title", () => {
    expect(deleteDisabled(NON_ADMIN, row())).toEqual({
      disabled: true,
      title: ADMIN_ONLY_TITLE,
    });
  });

  it("enables delete for an admin on an ordinary cronoton", () => {
    expect(deleteDisabled(ADMIN, row())).toEqual({ disabled: false, title: undefined });
  });

  it("disables (without a tooltip) while a mutation is in flight for an admin, so double-fires are impossible", () => {
    expect(deleteDisabled(ADMIN, row(), { working: true })).toEqual({
      disabled: true,
      title: undefined,
    });
  });
});

describe("pauseResumeDisabled", () => {
  it.each(["completed", "error"] as const)(
    "blocks a terminal (%s) cronoton with the terminal title even for an admin",
    (status) => {
      expect(pauseResumeDisabled(ADMIN, row({ status }), { working: false })).toEqual({
        disabled: true,
        title: TERMINAL_PAUSE_RESUME_TITLE,
      });
    },
  );

  it("announces the terminal title before the access tier for a non-admin on a terminal row", () => {
    expect(
      pauseResumeDisabled(NON_ADMIN, row({ status: "completed" }), { working: false }).title,
    ).toBe(TERMINAL_PAUSE_RESUME_TITLE);
  });

  it("blocks a non-admin on a live cronoton with the admins-only title", () => {
    expect(pauseResumeDisabled(NON_ADMIN, row({ status: "active" }), { working: false })).toEqual({
      disabled: true,
      title: ADMIN_ONLY_TITLE,
    });
  });

  it("enables pause/resume for an admin on an active or paused cronoton", () => {
    expect(pauseResumeDisabled(ADMIN, row({ status: "active" }), { working: false }).disabled).toBe(
      false,
    );
    expect(pauseResumeDisabled(ADMIN, row({ status: "paused" }), { working: false }).disabled).toBe(
      false,
    );
  });

  it("disables without a tooltip while a mutation is in flight for an admin on a live row", () => {
    expect(pauseResumeDisabled(ADMIN, row({ status: "active" }), { working: true })).toEqual({
      disabled: true,
      title: undefined,
    });
  });
});

describe("executeDisabled", () => {
  it("blocks a non-admin with the admins-only title", () => {
    expect(
      executeDisabled(NON_ADMIN, row(), { working: false, batchActive: false }),
    ).toEqual({ disabled: true, title: ADMIN_ONLY_TITLE });
  });

  it("blocks an admin while a batch is running, with the batch title so the user waits or cancels", () => {
    expect(executeDisabled(ADMIN, row(), { working: false, batchActive: true })).toEqual({
      disabled: true,
      title: BATCH_ACTIVE_TITLE,
    });
  });

  it("shows the admins-only title before the batch title for a non-admin during a batch", () => {
    expect(
      executeDisabled(NON_ADMIN, row(), { working: false, batchActive: true }).title,
    ).toBe(ADMIN_ONLY_TITLE);
  });

  it("enables execute for an admin when idle and no batch is running", () => {
    expect(executeDisabled(ADMIN, row(), { working: false, batchActive: false })).toEqual({
      disabled: false,
      title: undefined,
    });
  });

  it("disables without a tooltip while an execute is in flight for an admin", () => {
    expect(executeDisabled(ADMIN, row(), { working: true, batchActive: false })).toEqual({
      disabled: true,
      title: undefined,
    });
  });

  it.each(["completed", "error"] as const)(
    "blocks a terminal (%s) cronoton even for an idle admin — the server rejects a spent fire",
    (status) => {
      expect(executeDisabled(ADMIN, row({ status }), { working: false, batchActive: false })).toEqual({
        disabled: true,
        title: TERMINAL_EXECUTE_TITLE,
      });
    },
  );

  it("announces the terminal title before the batch title, so a spent cronoton never looks fireable", () => {
    expect(
      executeDisabled(ADMIN, row({ status: "completed" }), { working: false, batchActive: true }).title,
    ).toBe(TERMINAL_EXECUTE_TITLE);
  });
});

describe("newCronotonTier", () => {
  it("renders an enabled link for an admin", () => {
    expect(newCronotonTier(ADMIN)).toEqual({ kind: "link" });
  });

  it("renders a disabled control with the admins-only title for a non-admin", () => {
    expect(newCronotonTier(NON_ADMIN)).toEqual({ kind: "disabled", title: ADMIN_ONLY_TITLE });
  });

  it("hides the control entirely for a logged-out viewer", () => {
    expect(newCronotonTier(LOGGED_OUT)).toEqual({ kind: "hidden" });
  });
});
