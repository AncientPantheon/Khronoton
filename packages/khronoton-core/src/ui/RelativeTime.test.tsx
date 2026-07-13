// @vitest-environment jsdom
//
// RelativeTime suite. Opts into jsdom via the top-of-file docblock (the
// convention every `*.test.tsx` in this phase copies). Fake timers drive both
// the pure formatter (nowMs passed explicitly) and the self-refresh cadence.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";

import { RelativeTime, formatRelative } from "./RelativeTime.js";

const BASE = Date.parse("2026-07-13T12:00:00.000Z");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const iso = (offsetMs: number): string => new Date(BASE + offsetMs).toISOString();

describe("formatRelative (pure)", () => {
  it("renders 'just now' when the target is within 60s either side of now", () => {
    // Under a minute in the past OR future collapses to the same near-now bucket,
    // matching the 60s window that also drives the 1s refresh cadence.
    expect(formatRelative(iso(0), BASE)).toBe("just now");
    expect(formatRelative(iso(-30_000), BASE)).toBe("just now");
    expect(formatRelative(iso(59_000), BASE)).toBe("just now");
  });

  it("renders '{m}m ago' for a past target under an hour", () => {
    // Sub-hour deltas show whole minutes only — no seconds, no hours component.
    expect(formatRelative(iso(-12 * 60_000), BASE)).toBe("12m ago");
  });

  it("renders 'in {h}h {m}m' for a future target within a day", () => {
    // 16h34m ahead: hours + remainder minutes, prefixed 'in' for future direction.
    expect(formatRelative(iso((16 * 3600 + 34 * 60) * 1000), BASE)).toBe("in 16h 34m");
  });

  it("renders '{d}d {h}h' with day+hour granularity beyond 24h", () => {
    // 3d4h: days + remainder hours (minutes dropped at this magnitude).
    expect(formatRelative(iso((3 * 86400 + 4 * 3600) * 1000), BASE)).toBe("in 3d 4h");
    expect(formatRelative(iso(-(3 * 86400 + 4 * 3600) * 1000), BASE)).toBe("3d 4h ago");
  });

  it("rolls exactly 60s into the minute bucket, not 'just now'", () => {
    // Boundary: <60s is near-now, >=60s is the first '1m' tick the refresh reveals.
    expect(formatRelative(iso(-60_000), BASE)).toBe("1m ago");
  });

  it("returns an empty string for an unparseable ISO input", () => {
    // Callers render their own em-dash for missing timestamps; a bad string must
    // not throw or emit 'NaN'.
    expect(formatRelative("not-a-date", BASE)).toBe("");
  });
});

describe("<RelativeTime /> self-refresh", () => {
  it("renders the formatted label for the current instant", () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    render(<RelativeTime iso={iso((16 * 3600 + 34 * 60) * 1000)} />);
    expect(screen.getByText("in 16h 34m")).toBeTruthy();
  });

  it("ticks every 1s while the target is within 60s of now", () => {
    // Proximity < 60s must schedule the fast cadence so 'just now' can flip live.
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    render(<RelativeTime iso={iso(10_000)} />);
    expect(setIntervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 1000);
  });

  it("ticks every 30s when the target is farther than 60s away", () => {
    // Far targets barely move minute-to-minute, so the slow cadence conserves work.
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    render(<RelativeTime iso={iso(5 * 3600 * 1000)} />);
    expect(setIntervalSpy).toHaveBeenLastCalledWith(expect.any(Function), 30_000);
  });

  it("re-renders a fresh label as wall-clock time advances", () => {
    // End-to-end proof the interval actually updates state: 'just now' becomes
    // '1m ago' once 60s of fake time elapses.
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    render(<RelativeTime iso={iso(0)} />);
    expect(screen.getByText("just now")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("1m ago")).toBeTruthy();
  });

  it("clears its interval on unmount", () => {
    // No orphaned timer may keep calling setState after the node is gone.
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = render(<RelativeTime iso={iso(10_000)} />);
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
