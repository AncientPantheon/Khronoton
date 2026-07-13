import { describe, it, expect, vi } from "vitest";

import { runGated } from "./runGated.js";
import { NeedsConfirmError } from "./adapter.js";

// `runGated` is the single confirm-retry implementation every mutating action
// hook (create/edit/pause/resume/delete/executeNow/trigger/recover/start-batch)
// reuses. It normalizes the Hub's detail-page no-retry inconsistency: retry once,
// everywhere. These tests pin each branch of that contract so a downstream hook
// author can trust the shared helper without re-reading it.
describe("runGated", () => {
  it("passes the fn result straight through on first success and never re-prompts", async () => {
    const fn = vi.fn(async () => ({ ok: true, value: 42 }));
    const onNeedConfirm = vi.fn(async () => true);

    const result = await runGated(fn, { onNeedConfirm });

    expect(result).toEqual({ ok: true, value: 42 });
    // fn is called exactly once, carrying the fresh-confirm signal the backend gate reads.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ confirmed: true });
    // A first success must not bother the host with a re-confirm prompt.
    expect(onNeedConfirm).not.toHaveBeenCalled();
  });

  it("retries exactly once with a fresh confirm when the gate expired and the host re-confirms", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new NeedsConfirmError())
      .mockResolvedValueOnce({ ok: true });
    const onNeedConfirm = vi.fn(async () => true);

    const result = await runGated(fn, { onNeedConfirm });

    expect(result).toEqual({ ok: true });
    expect(onNeedConfirm).toHaveBeenCalledTimes(1);
    // Initial call + exactly one retry; the retry re-sends confirmed:true.
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(2, { confirmed: true });
  });

  it("surfaces the NeedsConfirmError without retrying when the host declines the re-confirm", async () => {
    const expired = new NeedsConfirmError();
    const fn = vi.fn().mockRejectedValue(expired);
    const onNeedConfirm = vi.fn(async () => false);

    await expect(runGated(fn, { onNeedConfirm })).rejects.toBe(expired);
    expect(onNeedConfirm).toHaveBeenCalledTimes(1);
    // A declined re-confirm must NOT fire the adapter a second time.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("surfaces the NeedsConfirmError when no re-confirm gate was supplied", async () => {
    const expired = new NeedsConfirmError();
    const fn = vi.fn().mockRejectedValue(expired);

    await expect(runGated(fn)).rejects.toBe(expired);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("surfaces a second NeedsConfirmError after the single retry (the retry is not a loop)", async () => {
    const fn = vi.fn().mockRejectedValue(new NeedsConfirmError());
    const onNeedConfirm = vi.fn(async () => true);

    await expect(runGated(fn, { onNeedConfirm })).rejects.toBeInstanceOf(NeedsConfirmError);
    // Initial + exactly one retry, then the second expiry surfaces (no infinite re-prompt).
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onNeedConfirm).toHaveBeenCalledTimes(1);
  });

  it("surfaces a non-confirm error immediately without re-prompting or retrying", async () => {
    const transport = new Error("HTTP 500");
    const fn = vi.fn().mockRejectedValue(transport);
    const onNeedConfirm = vi.fn(async () => true);

    await expect(runGated(fn, { onNeedConfirm })).rejects.toBe(transport);
    // Only an expired-confirm signal triggers the re-prompt path; a plain error does not.
    expect(onNeedConfirm).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
