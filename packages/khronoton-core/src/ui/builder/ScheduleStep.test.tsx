// @vitest-environment jsdom
//
// ScheduleStep suite. Opts into jsdom via the top-of-file docblock. The step is
// a controlled component over `BuilderState.schedule`; a small stateful harness
// feeds its own `onChange` back as `state` so mode switches and field edits
// re-render exactly as they will in the assembled builder. The Next-fire preview
// reads `new Date()` at render, so the preview specs pin a fixed system time with
// fake timers to make the emitted ISO deterministic.

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { KhronotonUiRoot } from "../KhronotonUiRoot.js";
import { ScheduleStep } from "./ScheduleStep.js";
import { makeEmptyBuilderState } from "../builder-state.js";
import type { BuilderState } from "../builder-state.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderStep(start: BuilderState = makeEmptyBuilderState()) {
  const spy = vi.fn<(next: BuilderState) => void>();
  function Harness() {
    const [state, setState] = React.useState<BuilderState>(start);
    return (
      <ScheduleStep
        state={state}
        onChange={(next) => {
          spy(next);
          setState(next);
        }}
      />
    );
  }
  render(
    <KhronotonUiRoot>
      <Harness />
    </KhronotonUiRoot>,
  );
  return { spy };
}

function oneTimeState(fireAt: string): BuilderState {
  return {
    ...makeEmptyBuilderState(),
    schedule: { mode: "one-time", config: { mode: "one-time", fireAt } },
  };
}

describe("ScheduleStep — mode selection + sub-forms", () => {
  it("defaults to the daily-at-utc mode and renders its hour toggles + minute field", () => {
    renderStep();
    expect((screen.getByLabelText("Mode") as HTMLSelectElement).value).toBe("daily-at-utc");
    // 00 and 23 prove the full 24-hour toggle grid is present.
    expect(screen.getByRole("button", { name: "00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "23" })).toBeTruthy();
    expect(screen.getByLabelText("Minute")).toBeTruthy();
  });

  it("switching to cron-expression renders the 5-field input and the verbatim UTC format helper", () => {
    renderStep();
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "cron-expression" } });
    expect(screen.getByLabelText("Cron expression")).toBeTruthy();
    expect(
      screen.getByText("Format: minute hour dayOfMonth month dayOfWeek. UTC."),
    ).toBeTruthy();
  });

  it("switching to weekly renders the Sun–Sat day toggles", () => {
    renderStep();
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "weekly" } });
    expect(screen.getByRole("button", { name: "Sun" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sat" })).toBeTruthy();
  });

  it("switching to several-times-per-day renders the Add time control", () => {
    renderStep();
    fireEvent.change(screen.getByLabelText("Mode"), {
      target: { value: "several-times-per-day" },
    });
    expect(screen.getByRole("button", { name: "+ Add time" })).toBeTruthy();
  });
});

describe("ScheduleStep — edits emit onChange", () => {
  it("toggling a daily hour calls onChange with that hour added to the config", () => {
    const { spy } = renderStep();
    fireEvent.click(screen.getByRole("button", { name: "13" }));
    const next = spy.mock.calls.at(-1)![0];
    expect(next.schedule.mode).toBe("daily-at-utc");
    // Default hours are [12]; toggling 13 must ADD it, not replace the selection.
    expect(next.schedule.config).toMatchObject({ mode: "daily-at-utc", hours: [12, 13] });
  });

  it("editing the daily minute calls onChange with the new minute value", () => {
    const { spy } = renderStep();
    fireEvent.change(screen.getByLabelText("Minute"), { target: { value: "30" } });
    const next = spy.mock.calls.at(-1)![0];
    expect(next.schedule.config).toMatchObject({ mode: "daily-at-utc", minute: 30 });
  });

  it("changing the mode emits a fresh config whose mode matches the selection", () => {
    const { spy } = renderStep();
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "weekly" } });
    const next = spy.mock.calls.at(-1)![0];
    expect(next.schedule.mode).toBe("weekly");
    // The emitted config's discriminant must stay in lock-step with the mode,
    // or computeNextFire would throw a mode/config mismatch on the next render.
    expect(next.schedule.config.mode).toBe("weekly");
  });
});

describe("ScheduleStep — live Next-fire preview", () => {
  it("shows a future ISO for a valid daily config", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T08:00:00.000Z"));
    renderStep(); // default daily {hours:[12], minute:0}
    expect(screen.getByTestId("next-fire-preview").textContent).toBe(
      "Next fire: 2026-07-13T12:00:00.000Z",
    );
  });

  it("computes the next cron fire from the supplied expression", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T08:00:00.000Z"));
    renderStep();
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "cron-expression" } });
    fireEvent.change(screen.getByLabelText("Cron expression"), {
      target: { value: "0 12 * * *" },
    });
    expect(screen.getByTestId("next-fire-preview").textContent).toBe(
      "Next fire: 2026-07-13T12:00:00.000Z",
    );
  });

  it("reports 'no future fires' and warns when a one-time fire is in the past", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T08:00:00.000Z"));
    renderStep(oneTimeState("2020-01-01T00:00:00.000Z"));
    expect(screen.getByTestId("next-fire-preview").textContent).toBe("Next fire: no future fires");
    expect(screen.getByText(/Fire time is in the past/)).toBeTruthy();
  });

  it("surfaces the invalid-config message for an incomplete cron expression", () => {
    renderStep();
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "cron-expression" } });
    // The fresh cron config has an empty expression, which computeNextFire rejects.
    expect(screen.getByTestId("next-fire-preview").textContent).toMatch(/^Next fire: invalid: /);
  });
});
