/**
 * ScheduleStep — the builder's schedule editor (7 modes + live Next-fire preview).
 *
 * A controlled view over `BuilderState.schedule`: it never holds local schedule
 * state, and every edit emits the whole next `BuilderState` through `onChange`
 * so the builder assembly stays the single owner of the form. Each of the seven
 * modes renders its own sub-form and, on selection, resets to a valid default
 * config for that mode so `state.schedule.mode` and `state.schedule.config.mode`
 * never drift apart.
 *
 * The Next-fire preview REUSES the root schedule engine (`computeNextFire`) —
 * the timing math is never reimplemented here. It reads `new Date()` at render,
 * so the preview refreshes on every edit; an `InvalidScheduleConfigError` renders
 * as `invalid: {msg}` and the terminal one-time `null` renders as
 * `no future fires`.
 */

import type { CSSProperties, ReactNode } from "react";

import { computeNextFire, InvalidScheduleConfigError } from "../../index.js";
import type {
  CronExpressionConfig,
  DailyAtUtcConfig,
  EveryNMinutesConfig,
  MonthlyConfig,
  OneTimeConfig,
  ScheduleConfig,
  ScheduleMode,
  SeveralTimesPerDayConfig,
  WeeklyConfig,
} from "../../index.js";
import type { BuilderState } from "../builder-state.js";
import { Field, Title } from "../primitives.js";

export interface ScheduleStepProps {
  /** The full builder form state; only `state.schedule` is read + written here. */
  state: BuilderState;
  /** Emits the next full builder state whenever the schedule changes. */
  onChange: (next: BuilderState) => void;
}

const MODE_OPTIONS: { value: ScheduleMode; label: string }[] = [
  { value: "daily-at-utc", label: "Daily at UTC" },
  { value: "every-n-minutes", label: "Every N minutes" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "cron-expression", label: "Cron expression" },
  { value: "one-time", label: "One-time" },
  { value: "several-times-per-day", label: "Several times per day" },
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS_0_23 = Array.from({ length: 24 }, (_, i) => i);
const DAYS_1_31 = Array.from({ length: 31 }, (_, i) => i + 1);

/** A valid default config for each mode, applied when the operator switches modes. */
function defaultConfigFor(mode: ScheduleMode): ScheduleConfig {
  switch (mode) {
    case "daily-at-utc":
      return { mode, hours: [12], minute: 0 };
    case "every-n-minutes":
      return { mode, startDate: "", intervalMinutes: 60 };
    case "weekly":
      return { mode, daysOfWeek: [1], hour: 12, minute: 0 };
    case "monthly":
      return { mode, daysOfMonth: [1], hour: 12, minute: 0 };
    case "cron-expression":
      return { mode, expression: "" };
    case "one-time":
      return { mode, fireAt: "" };
    case "several-times-per-day":
      return { mode, times: [{ hour: 12, minute: 0 }] };
  }
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

const inputStyle: CSSProperties = {
  background: "var(--khr-inset)",
  border: "1px solid var(--khr-border)",
  color: "var(--khr-text)",
  fontSize: "12px",
  padding: "6px 8px",
  borderRadius: "var(--khr-radius)",
  width: "100%",
  boxSizing: "border-box",
};

const helperStyle: CSSProperties = {
  marginTop: "4px",
  fontSize: "11px",
  color: "var(--khr-text-dim)",
};

const warnStyle: CSSProperties = {
  marginTop: "6px",
  fontSize: "11px",
  color: "var(--khr-amber)",
};

const gridStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "5px",
  marginBottom: "12px",
};

const rowStyle: CSSProperties = {
  display: "flex",
  gap: "10px",
  alignItems: "center",
  marginBottom: "8px",
};

const previewStyle: CSSProperties = {
  marginTop: "14px",
  paddingTop: "12px",
  borderTop: "1px solid var(--khr-border)",
  fontFamily: "var(--khr-mono)",
  fontSize: "12px",
  color: "var(--khr-accent)",
};

function toggleStyle(selected: boolean): CSSProperties {
  return {
    padding: "5px 8px",
    minWidth: "34px",
    fontSize: "11px",
    fontFamily: "var(--khr-mono)",
    borderRadius: "var(--khr-radius)",
    border: `1px solid ${selected ? "var(--khr-accent)" : "var(--khr-border)"}`,
    background: selected ? "var(--khr-accent-tint)" : "var(--khr-inset)",
    color: selected ? "var(--khr-accent)" : "var(--khr-text-dim)",
    cursor: "pointer",
  };
}

/** Toggle membership of `value` in a sorted numeric selection array. */
function toggleMember(list: number[], value: number): number[] {
  return list.includes(value)
    ? list.filter((x) => x !== value)
    : [...list, value].sort((a, b) => a - b);
}

function isoToLocalInput(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

function localInputToIso(value: string): string {
  if (!value) return "";
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toISOString();
}

/** Render the live Next-fire line, reusing the root engine (never reimplemented). */
function previewText(mode: ScheduleMode, config: ScheduleConfig, now: Date): string {
  try {
    const next = computeNextFire(mode, config, now);
    return next === null ? "no future fires" : next.toISOString();
  } catch (err) {
    if (err instanceof InvalidScheduleConfigError) return `invalid: ${err.message}`;
    throw err;
  }
}

export function ScheduleStep({ state, onChange }: ScheduleStepProps): ReactNode {
  const { schedule } = state;
  const { config } = schedule;

  const emit = (nextConfig: ScheduleConfig): void => {
    onChange({ ...state, schedule: { mode: nextConfig.mode, config: nextConfig } });
  };

  const onModeChange = (mode: ScheduleMode): void => {
    emit(defaultConfigFor(mode));
  };

  return (
    <div>
      <Title>Schedule</Title>

      <Field label="Mode">
        <select
          style={inputStyle}
          value={schedule.mode}
          onChange={(e) => onModeChange(e.target.value as ScheduleMode)}
        >
          {MODE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </Field>

      {renderSubForm(config, emit)}

      <div style={previewStyle} data-testid="next-fire-preview">
        {`Next fire: ${previewText(schedule.mode, config, new Date())}`}
      </div>
    </div>
  );
}

function renderSubForm(
  config: ScheduleConfig,
  emit: (next: ScheduleConfig) => void,
): ReactNode {
  switch (config.mode) {
    case "daily-at-utc":
      return <DailyForm config={config} emit={emit} />;
    case "every-n-minutes":
      return <EveryNForm config={config} emit={emit} />;
    case "weekly":
      return <WeeklyForm config={config} emit={emit} />;
    case "monthly":
      return <MonthlyForm config={config} emit={emit} />;
    case "cron-expression":
      return <CronForm config={config} emit={emit} />;
    case "one-time":
      return <OneTimeForm config={config} emit={emit} />;
    case "several-times-per-day":
      return <SeveralTimesForm config={config} emit={emit} />;
  }
}

interface SubProps<C extends ScheduleConfig> {
  config: C;
  emit: (next: ScheduleConfig) => void;
}

function NumberField({
  label,
  value,
  min,
  max,
  onValue,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onValue: (n: number) => void;
}): ReactNode {
  return (
    <Field label={label} style={{ marginBottom: 0 }}>
      <input
        type="number"
        min={min}
        max={max}
        style={inputStyle}
        value={value}
        onChange={(e) => onValue(Number(e.target.value))}
      />
    </Field>
  );
}

function DailyForm({ config, emit }: SubProps<DailyAtUtcConfig>): ReactNode {
  return (
    <div>
      <div style={gridStyle}>
        {HOURS_0_23.map((h) => (
          <button
            key={h}
            type="button"
            aria-pressed={config.hours.includes(h)}
            style={toggleStyle(config.hours.includes(h))}
            onClick={() => emit({ ...config, hours: toggleMember(config.hours, h) })}
          >
            {pad2(h)}
          </button>
        ))}
      </div>
      <NumberField
        label="Minute"
        value={config.minute}
        min={0}
        max={59}
        onValue={(n) => emit({ ...config, minute: n })}
      />
    </div>
  );
}

function EveryNForm({ config, emit }: SubProps<EveryNMinutesConfig>): ReactNode {
  return (
    <div>
      <Field label="Start (ISO)">
        <input
          type="text"
          style={inputStyle}
          placeholder="2026-05-24T00:00:00.000Z"
          value={config.startDate}
          onChange={(e) => emit({ ...config, startDate: e.target.value })}
        />
      </Field>
      <NumberField
        label="Interval (minutes)"
        value={config.intervalMinutes}
        min={1}
        max={1440}
        onValue={(n) => emit({ ...config, intervalMinutes: n })}
      />
    </div>
  );
}

function WeeklyForm({ config, emit }: SubProps<WeeklyConfig>): ReactNode {
  return (
    <div>
      <div style={gridStyle}>
        {WEEKDAYS.map((name, d) => (
          <button
            key={name}
            type="button"
            aria-pressed={config.daysOfWeek.includes(d)}
            style={toggleStyle(config.daysOfWeek.includes(d))}
            onClick={() => emit({ ...config, daysOfWeek: toggleMember(config.daysOfWeek, d) })}
          >
            {name}
          </button>
        ))}
      </div>
      <div style={rowStyle}>
        <NumberField
          label="Hour"
          value={config.hour}
          min={0}
          max={23}
          onValue={(n) => emit({ ...config, hour: n })}
        />
        <NumberField
          label="Minute"
          value={config.minute}
          min={0}
          max={59}
          onValue={(n) => emit({ ...config, minute: n })}
        />
      </div>
    </div>
  );
}

function MonthlyForm({ config, emit }: SubProps<MonthlyConfig>): ReactNode {
  return (
    <div>
      <div style={gridStyle}>
        {DAYS_1_31.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={config.daysOfMonth.includes(d)}
            style={toggleStyle(config.daysOfMonth.includes(d))}
            onClick={() => emit({ ...config, daysOfMonth: toggleMember(config.daysOfMonth, d) })}
          >
            {d}
          </button>
        ))}
      </div>
      <div style={rowStyle}>
        <NumberField
          label="Hour"
          value={config.hour}
          min={0}
          max={23}
          onValue={(n) => emit({ ...config, hour: n })}
        />
        <NumberField
          label="Minute"
          value={config.minute}
          min={0}
          max={59}
          onValue={(n) => emit({ ...config, minute: n })}
        />
      </div>
    </div>
  );
}

function CronForm({ config, emit }: SubProps<CronExpressionConfig>): ReactNode {
  return (
    <Field label="Cron expression">
      <input
        type="text"
        aria-label="Cron expression"
        style={{ ...inputStyle, fontFamily: "var(--khr-mono)" }}
        placeholder="0 12 * * 1-5"
        value={config.expression}
        onChange={(e) => emit({ ...config, expression: e.target.value })}
      />
      <div style={helperStyle}>Format: minute hour dayOfMonth month dayOfWeek. UTC.</div>
    </Field>
  );
}

function OneTimeForm({ config, emit }: SubProps<OneTimeConfig>): ReactNode {
  const fireMs = Date.parse(config.fireAt);
  const isPast = !Number.isNaN(fireMs) && fireMs <= Date.now();
  return (
    <Field label="Fire time">
      <input
        type="datetime-local"
        aria-label="Fire time"
        style={inputStyle}
        value={isoToLocalInput(config.fireAt)}
        onChange={(e) => emit({ ...config, fireAt: localInputToIso(e.target.value) })}
      />
      {isPast ? (
        <div style={warnStyle}>Fire time is in the past — this cronoton will never fire.</div>
      ) : null}
    </Field>
  );
}

function SeveralTimesForm({ config, emit }: SubProps<SeveralTimesPerDayConfig>): ReactNode {
  const updateTime = (index: number, patch: Partial<{ hour: number; minute: number }>): void => {
    emit({
      ...config,
      times: config.times.map((t, i) => (i === index ? { ...t, ...patch } : t)),
    });
  };
  const addTime = (): void => emit({ ...config, times: [...config.times, { hour: 12, minute: 0 }] });
  const removeTime = (index: number): void =>
    emit({ ...config, times: config.times.filter((_, i) => i !== index) });

  return (
    <div>
      {config.times.map((t, i) => (
        <div key={i} style={rowStyle}>
          <NumberField
            label="Hour"
            value={t.hour}
            min={0}
            max={23}
            onValue={(n) => updateTime(i, { hour: n })}
          />
          <NumberField
            label="Minute"
            value={t.minute}
            min={0}
            max={59}
            onValue={(n) => updateTime(i, { minute: n })}
          />
          <button
            type="button"
            style={{ ...toggleStyle(false), alignSelf: "flex-end" }}
            onClick={() => removeTime(i)}
          >
            Remove
          </button>
        </div>
      ))}
      <button type="button" style={toggleStyle(false)} onClick={addTime}>
        + Add time
      </button>
    </div>
  );
}
