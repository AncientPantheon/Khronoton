// Confirm-flow UX helper suite. Pure module — no jsdom needed: the browser
// `confirm`/`alert` seams are injected, and the SSR-safe default path is exercised
// in the plain node env where `window` is undefined.
//
// This layer sits BEFORE the confirm-gate (`runGated`) the action hooks already
// own: it adds the native "are you sure?" prompt, surfaces a mutation failure via
// `window.alert` (the Hub's no-toast pattern), and fires the host's SSR-refresh on
// success. The strings are reproduced verbatim from the parity inventory so the
// generic package matches the Hub byte-for-byte.

import { describe, it, expect, vi } from "vitest";

import {
  deleteConfirm,
  deletePasswordConfirm,
  pauseResumeConfirm,
  listExecuteConfirm,
  detailExecuteConfirm,
  triggerConfirm,
  startBatchConfirm,
  cancelBatchConfirm,
  reConfirmExpired,
  withConfirm,
} from "./confirm-flows.js";

describe("verbatim confirm strings", () => {
  it("delete native-confirm warns fire history is removed too", () => {
    expect(deleteConfirm("Daily payout")).toBe(
      'Delete codex cronoton "Daily payout"? Fire history is removed too.',
    );
  });

  it("delete password-confirm names the cronoton being deleted", () => {
    expect(deletePasswordConfirm("Daily payout")).toBe(
      'Confirm to delete codex cronoton "Daily payout".',
    );
  });

  it("pause/resume confirm interpolates the verb without averaging the two", () => {
    expect(pauseResumeConfirm("pause")).toBe("Confirm to pause this codex cronoton.");
    expect(pauseResumeConfirm("resume")).toBe("Confirm to resume this codex cronoton.");
  });

  it("list execute-now confirm flags the immediate on-chain fire", () => {
    expect(listExecuteConfirm("Daily payout")).toBe(
      'Confirm to execute "Daily payout" now (fires immediately on-chain).',
    );
  });

  it("detail execute confirm flags firing outside the schedule", () => {
    expect(detailExecuteConfirm("Daily payout")).toBe(
      'Confirm to fire "Daily payout" now, outside its schedule.',
    );
  });

  it("trigger confirm names the runtime-arg fire", () => {
    expect(triggerConfirm("Daily payout")).toBe(
      'Confirm to trigger "Daily payout" now with the supplied runtime args.',
    );
  });

  it("start-batch confirm interpolates the whole count", () => {
    expect(startBatchConfirm(10)).toContain("10 times, once per minute");
  });

  it("cancel-batch confirm reassures finished fires remain", () => {
    expect(cancelBatchConfirm).toBe(
      "Cancel the running batch? Fires already done remain; no further fires happen.",
    );
  });

  it("re-confirm-expired uses the normalized list wording everywhere", () => {
    expect(reConfirmExpired).toBe("Your confirmation expired. Please re-confirm.");
  });
});

describe("withConfirm orchestration", () => {
  it("short-circuits without running when the user declines the native confirm", async () => {
    const run = vi.fn(async () => "ran");
    const alert = vi.fn();

    const result = await withConfirm("Sure?", run, {
      confirm: () => false,
      alert,
    });

    expect(result).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("runs and fires the SSR-refresh once when the user accepts", async () => {
    const run = vi.fn(async () => "ran");
    const onSuccess = vi.fn();

    const result = await withConfirm("Sure?", run, {
      confirm: () => true,
      onSuccess,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toBe("ran");
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("surfaces a thrown mutation error via alert and skips the SSR-refresh", async () => {
    const run = vi.fn(async () => {
      throw new Error("network down");
    });
    const alert = vi.fn();
    const onSuccess = vi.fn();

    const result = await withConfirm("Sure?", run, {
      confirm: () => true,
      alert,
      onSuccess,
    });

    expect(result).toBeUndefined();
    expect(alert).toHaveBeenCalledWith("network down");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("alerts a lifecycle ActionFail envelope's error and skips the SSR-refresh", async () => {
    const run = vi.fn(async () => ({
      ok: false as const,
      error: new Error("System cronoton — cannot be deleted."),
    }));
    const alert = vi.fn();
    const onSuccess = vi.fn();

    const result = await withConfirm("Sure?", run, {
      confirm: () => true,
      alert,
      onSuccess,
    });

    expect(alert).toHaveBeenCalledWith("System cronoton — cannot be deleted.");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: new Error("System cronoton — cannot be deleted.") });
  });

  it("treats a 200-on-ok:false execution view as a normal result, not an alert", async () => {
    // Execution views carry `error` as a STRING (a chain/build failure), unlike the
    // lifecycle ActionFail whose `error` is an Error — the screen renders the result
    // line, so withConfirm must NOT alert it and MUST fire the SSR-refresh.
    const view = { ok: false, error: "chain rejected the tx" };
    const run = vi.fn(async () => view);
    const alert = vi.fn();
    const onSuccess = vi.fn();

    const result = await withConfirm("Sure?", run, {
      confirm: () => true,
      alert,
      onSuccess,
    });

    expect(alert).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(result).toBe(view);
  });

  it("is SSR-safe: with no confirm seam and no browser window it declines silently", async () => {
    const run = vi.fn(async () => "ran");

    const result = await withConfirm("Sure?", run);

    expect(result).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });
});
