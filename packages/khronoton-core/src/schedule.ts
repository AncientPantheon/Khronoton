/**
 * schedule — pure schedule model and timing math for @ancientpantheon/khronoton-core.
 *
 * Public surface:
 *   - ScheduleMode (7 literal values)
 *   - ScheduleConfig (discriminated union by `.mode`)
 *   - InvalidScheduleConfigError (typed reject)
 *   - computeNextFire(mode, config, now): Date | null
 *   - summariseSchedule(mode, config): string
 *
 * Contract:
 *   - TOTAL    — a valid (mode, config, now) triple never throws;
 *                InvalidScheduleConfigError is reserved for malformed
 *                configs. Recurring modes always yield a future Date; the
 *                terminal `one-time` mode legitimately yields `null` once
 *                its single fire is in the past (a valid result, not an
 *                error).
 *   - MONOTONIC — for the same RECURRING schedule, later `now` ->
 *                equal-or-later next-fire (when both `now`s sit
 *                at-or-after the same prior fire). Enforced by the
 *                algorithm shape: every recurring mode iterates strictly
 *                forward from `now`. (`one-time` is exempt: once spent it
 *                returns `null`, which is the monotonic terminal state.)
 *   - PURE     — no `Math.random`, no `Date.now()`. `now` is the
 *                explicit input. Two calls with identical args return
 *                identical results.
 *
 * Cron mode (5-field UTC):
 *   - Pruned in-tree parser; no `cron-parser` dependency added.
 *   - Standard 5-field shape: `minute hour dayOfMonth month dayOfWeek`.
 *   - Syntax supported per field:
 *       *           (any)
 *       N           (literal int)
 *       N,M,...     (comma list)
 *       N-M         (inclusive range)
 *       *<NN        (step from start)
 *       N/M         (step from N)
 *   - Out of scope (explicitly rejected): `@hourly` / `@daily` macros,
 *     seconds field, `L`/`W`/`#` Quartz extensions.
 *
 * The behavior of this engine is locked by the contract suites in
 * `tests/`: schedule-compute-next-fire.test.ts, schedule-extended-modes.test.ts,
 * schedule-new-modes.test.ts, and schedule-cron-dom-dow-or.test.ts.
 */

export type ScheduleMode =
  | 'daily-at-utc'
  | 'every-n-minutes'
  | 'weekly'
  | 'monthly'
  | 'cron-expression'
  | 'one-time'
  | 'several-times-per-day';

export type DailyAtUtcConfig = {
  mode: 'daily-at-utc';
  hours: number[];
  minute: number;
};

export type EveryNMinutesConfig = {
  mode: 'every-n-minutes';
  startDate: string;
  intervalMinutes: number;
};

export type WeeklyConfig = {
  mode: 'weekly';
  daysOfWeek: number[];
  hour: number;
  minute: number;
};

export type MonthlyConfig = {
  mode: 'monthly';
  daysOfMonth: number[];
  hour: number;
  minute: number;
};

export type CronExpressionConfig = {
  mode: 'cron-expression';
  expression: string;
};

export type OneTimeConfig = {
  mode: 'one-time';
  /** ISO8601 instant at which the schedule fires exactly once. */
  fireAt: string;
};

export type SeveralTimesPerDayConfig = {
  mode: 'several-times-per-day';
  /** Per-entry UTC time-of-day; fires at each one, every day. */
  times: { hour: number; minute: number }[];
};

export type ScheduleConfig =
  | DailyAtUtcConfig
  | EveryNMinutesConfig
  | WeeklyConfig
  | MonthlyConfig
  | CronExpressionConfig
  | OneTimeConfig
  | SeveralTimesPerDayConfig;

export class InvalidScheduleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScheduleConfigError';
  }
}

function assertNever(x: never): never {
  throw new InvalidScheduleConfigError(`unknown schedule mode: ${String(x)}`);
}

function isValidHour(h: number): boolean {
  return Number.isInteger(h) && h >= 0 && h <= 23;
}

function isValidMinute(m: number): boolean {
  return Number.isInteger(m) && m >= 0 && m <= 59;
}

function isValidDayOfWeek(d: number): boolean {
  return Number.isInteger(d) && d >= 0 && d <= 6;
}

function isValidDayOfMonth(d: number): boolean {
  return Number.isInteger(d) && d >= 1 && d <= 31;
}

/**
 * computeNextFire — pure helper. Returns the next Date strictly after
 * `now` at which the schedule fires. Throws InvalidScheduleConfigError
 * on malformed config. Returns `null` ONLY for the terminal `one-time`
 * mode once its single `fireAt` instant is at-or-before `now` (the fire
 * is spent/past). All recurring modes always return a future Date.
 */
export function computeNextFire(
  mode: ScheduleMode,
  config: ScheduleConfig,
  now: Date,
): Date | null {
  if (config.mode !== mode) {
    throw new InvalidScheduleConfigError(
      `mode/config mismatch: mode=${mode} config.mode=${config.mode}`,
    );
  }

  switch (config.mode) {
    case 'daily-at-utc':
      return nextDailyAtUtc(config, now);
    case 'every-n-minutes':
      return nextEveryNMinutes(config, now);
    case 'weekly':
      return nextWeekly(config, now);
    case 'monthly':
      return nextMonthly(config, now);
    case 'cron-expression':
      return nextCronExpression(config, now);
    case 'one-time':
      return nextOneTime(config, now);
    case 'several-times-per-day':
      return nextSeveralTimesPerDay(config, now);
    default:
      return assertNever(config);
  }
}

function nextOneTime(config: OneTimeConfig, now: Date): Date | null {
  const fireMs = Date.parse(config.fireAt);
  if (Number.isNaN(fireMs)) {
    throw new InvalidScheduleConfigError(
      `one-time: fireAt is not a valid ISO8601 string: ${config.fireAt}`,
    );
  }
  // Terminal: a single fire that has already elapsed yields no future fire.
  if (fireMs <= now.getTime()) return null;
  return new Date(fireMs);
}

/** Dedup + sort times by the composite key hour*60+minute. */
function sortedTimesOfDay(
  times: { hour: number; minute: number }[],
): { hour: number; minute: number }[] {
  const seen = new Set<number>();
  const unique: { hour: number; minute: number }[] = [];
  for (const t of times) {
    const key = t.hour * 60 + t.minute;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(t);
  }
  return unique.sort(
    (a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute),
  );
}

function nextSeveralTimesPerDay(
  config: SeveralTimesPerDayConfig,
  now: Date,
): Date {
  if (!Array.isArray(config.times) || config.times.length === 0) {
    throw new InvalidScheduleConfigError(
      'several-times-per-day requires a non-empty times array',
    );
  }
  if (
    !config.times.every((t) => isValidHour(t.hour) && isValidMinute(t.minute))
  ) {
    throw new InvalidScheduleConfigError(
      'several-times-per-day: each time must have hour in [0..23] and minute in [0..59] (integers)',
    );
  }
  const times = sortedTimesOfDay(config.times);
  // Try today, then tomorrow. One of them is guaranteed to be > now.
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    for (const t of times) {
      const candidate = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() + dayOffset,
          t.hour,
          t.minute,
          0,
          0,
        ),
      );
      if (candidate.getTime() > now.getTime()) {
        return candidate;
      }
    }
  }
  // Unreachable — the two-day sweep covers every possibility.
  throw new InvalidScheduleConfigError(
    'several-times-per-day: failed to find next-fire within 48h sweep',
  );
}

function nextDailyAtUtc(config: DailyAtUtcConfig, now: Date): Date {
  if (!Array.isArray(config.hours) || config.hours.length === 0) {
    throw new InvalidScheduleConfigError(
      'daily-at-utc requires a non-empty hours array',
    );
  }
  if (!config.hours.every(isValidHour)) {
    throw new InvalidScheduleConfigError(
      'daily-at-utc hours must be integers in [0..23]',
    );
  }
  if (!isValidMinute(config.minute)) {
    throw new InvalidScheduleConfigError(
      'daily-at-utc minute must be an integer in [0..59]',
    );
  }
  const sortedHours = [...new Set(config.hours)].sort((a, b) => a - b);
  // Try today, then tomorrow. One of them is guaranteed to be > now.
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    for (const h of sortedHours) {
      const candidate = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() + dayOffset,
          h,
          config.minute,
          0,
          0,
        ),
      );
      if (candidate.getTime() > now.getTime()) {
        return candidate;
      }
    }
  }
  // Unreachable — the two-day sweep covers every possibility.
  throw new InvalidScheduleConfigError(
    'daily-at-utc: failed to find next-fire within 48h sweep',
  );
}

function nextEveryNMinutes(config: EveryNMinutesConfig, now: Date): Date {
  if (
    !Number.isInteger(config.intervalMinutes) ||
    config.intervalMinutes <= 0
  ) {
    throw new InvalidScheduleConfigError(
      'every-n-minutes: intervalMinutes must be a positive integer',
    );
  }
  const startMs = Date.parse(config.startDate);
  if (Number.isNaN(startMs)) {
    throw new InvalidScheduleConfigError(
      `every-n-minutes: startDate is not a valid ISO8601 string: ${config.startDate}`,
    );
  }
  const intervalMs = config.intervalMinutes * 60_000;
  const nowMs = now.getTime();
  if (nowMs < startMs) return new Date(startMs);
  // Ceiling: strictly future fire after `now`.
  const elapsed = nowMs - startMs;
  const nextMs = startMs + (Math.floor(elapsed / intervalMs) + 1) * intervalMs;
  return new Date(nextMs);
}

function nextWeekly(config: WeeklyConfig, now: Date): Date {
  if (!Array.isArray(config.daysOfWeek) || config.daysOfWeek.length === 0) {
    throw new InvalidScheduleConfigError(
      'weekly: daysOfWeek must be a non-empty array',
    );
  }
  if (!config.daysOfWeek.every(isValidDayOfWeek)) {
    throw new InvalidScheduleConfigError(
      'weekly: daysOfWeek values must be integers in [0..6]',
    );
  }
  if (!isValidHour(config.hour)) {
    throw new InvalidScheduleConfigError(
      'weekly: hour must be an integer in [0..23]',
    );
  }
  if (!isValidMinute(config.minute)) {
    throw new InvalidScheduleConfigError(
      'weekly: minute must be an integer in [0..59]',
    );
  }
  const dows = new Set(config.daysOfWeek);
  for (let i = 0; i < 8; i++) {
    const probe = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + i,
        config.hour,
        config.minute,
        0,
        0,
      ),
    );
    if (!dows.has(probe.getUTCDay())) continue;
    if (probe.getTime() > now.getTime()) return probe;
  }
  throw new InvalidScheduleConfigError(
    'weekly: failed to find next-fire within 8-day sweep',
  );
}

function nextMonthly(config: MonthlyConfig, now: Date): Date {
  if (!Array.isArray(config.daysOfMonth) || config.daysOfMonth.length === 0) {
    throw new InvalidScheduleConfigError(
      'monthly: daysOfMonth must be a non-empty array',
    );
  }
  if (!config.daysOfMonth.every(isValidDayOfMonth)) {
    throw new InvalidScheduleConfigError(
      'monthly: daysOfMonth values must be integers in [1..31]',
    );
  }
  if (!isValidHour(config.hour)) {
    throw new InvalidScheduleConfigError(
      'monthly: hour must be an integer in [0..23]',
    );
  }
  if (!isValidMinute(config.minute)) {
    throw new InvalidScheduleConfigError(
      'monthly: minute must be an integer in [0..59]',
    );
  }
  // 33 days covers the worst case (31-of-month -> end-of-next-month).
  for (let i = 0; i < 33; i++) {
    const probe = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + i,
        config.hour,
        config.minute,
        0,
        0,
      ),
    );
    const probeDay = probe.getUTCDate();
    if (!config.daysOfMonth.includes(probeDay)) continue;
    if (probe.getTime() > now.getTime()) return probe;
  }
  throw new InvalidScheduleConfigError(
    'monthly: failed to find next-fire within 33-day sweep',
  );
}

/**
 * Parse one field of a 5-field UTC cron expression into the set of
 * matching integers in [min..max]. Supports `*`, `N`, `N,M,...`, `N-M`,
 * `* /STEP`, and `N/M`. Anything else throws.
 */
function parseCronField(raw: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  if (!raw || typeof raw !== 'string') {
    throw new InvalidScheduleConfigError(`cron-expression: empty field`);
  }
  for (const piece of raw.split(',')) {
    const p = piece.trim();
    if (!p) {
      throw new InvalidScheduleConfigError(`cron-expression: empty list slot`);
    }
    // Step syntax: BASE/STEP where BASE is `*` or `N` or `N-M`.
    if (p.includes('/')) {
      const [basePart, stepPart] = p.split('/');
      const step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) {
        throw new InvalidScheduleConfigError(
          `cron-expression: invalid step '${stepPart}'`,
        );
      }
      let rangeStart = min;
      let rangeEnd = max;
      if (basePart === '*') {
        // already min..max
      } else if (basePart.includes('-')) {
        const [s, e] = basePart.split('-').map(Number);
        if (
          !Number.isInteger(s) ||
          !Number.isInteger(e) ||
          s < min ||
          e > max ||
          s > e
        ) {
          throw new InvalidScheduleConfigError(
            `cron-expression: invalid range '${basePart}'`,
          );
        }
        rangeStart = s;
        rangeEnd = e;
      } else {
        const n = Number(basePart);
        if (!Number.isInteger(n) || n < min || n > max) {
          throw new InvalidScheduleConfigError(
            `cron-expression: invalid base '${basePart}'`,
          );
        }
        rangeStart = n;
        rangeEnd = max;
      }
      for (let v = rangeStart; v <= rangeEnd; v += step) {
        out.add(v);
      }
      continue;
    }
    if (p === '*') {
      for (let v = min; v <= max; v++) out.add(v);
      continue;
    }
    if (p.includes('-')) {
      const [s, e] = p.split('-').map(Number);
      if (
        !Number.isInteger(s) ||
        !Number.isInteger(e) ||
        s < min ||
        e > max ||
        s > e
      ) {
        throw new InvalidScheduleConfigError(
          `cron-expression: invalid range '${p}'`,
        );
      }
      for (let v = s; v <= e; v++) out.add(v);
      continue;
    }
    const n = Number(p);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new InvalidScheduleConfigError(
        `cron-expression: invalid literal '${p}'`,
      );
    }
    out.add(n);
  }
  if (out.size === 0) {
    throw new InvalidScheduleConfigError(
      `cron-expression: parsed an empty value set from '${raw}'`,
    );
  }
  return out;
}

type ParsedCron = {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
};

function parseCronExpression(expression: string): ParsedCron {
  if (typeof expression !== 'string') {
    throw new InvalidScheduleConfigError(
      'cron-expression: expression must be a string',
    );
  }
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new InvalidScheduleConfigError(
      `cron-expression: expected 5 fields, got ${fields.length} ('${expression}')`,
    );
  }
  return {
    minutes: parseCronField(fields[0]!, 0, 59),
    hours: parseCronField(fields[1]!, 0, 23),
    daysOfMonth: parseCronField(fields[2]!, 1, 31),
    months: parseCronField(fields[3]!, 1, 12),
    daysOfWeek: parseCronField(fields[4]!, 0, 6),
  };
}

function nextCronExpression(config: CronExpressionConfig, now: Date): Date {
  const parsed = parseCronExpression(config.expression);
  // Step minute-by-minute up to ~1 year. For repeating standard cron
  // expressions, a match always exists within ~366 days.
  const MAX_MINUTES = 366 * 24 * 60;
  // Start one minute past `now` (strictly future).
  const start = new Date(now.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  for (let i = 0; i < MAX_MINUTES; i++) {
    const probe = new Date(start.getTime() + i * 60_000);
    const minute = probe.getUTCMinutes();
    const hour = probe.getUTCHours();
    const dom = probe.getUTCDate();
    const month = probe.getUTCMonth() + 1;
    const dow = probe.getUTCDay();
    if (!parsed.minutes.has(minute)) continue;
    if (!parsed.hours.has(hour)) continue;
    if (!parsed.months.has(month)) continue;
    // Cron semantics: when both dayOfMonth and dayOfWeek are
    // restricted (not *), match either. When at least one is `*`,
    // require all set fields. We approximate "is this field *?" by
    // checking whether the parsed set covers the entire allowed range.
    const domAny = parsed.daysOfMonth.size === 31;
    const dowAny = parsed.daysOfWeek.size === 7;
    if (domAny && dowAny) {
      return probe;
    }
    if (domAny) {
      if (parsed.daysOfWeek.has(dow)) return probe;
      continue;
    }
    if (dowAny) {
      if (parsed.daysOfMonth.has(dom)) return probe;
      continue;
    }
    // Both restricted -> match either.
    if (parsed.daysOfMonth.has(dom) || parsed.daysOfWeek.has(dow)) {
      return probe;
    }
  }
  throw new InvalidScheduleConfigError(
    `cron-expression: no future fire found within ${MAX_MINUTES} minutes`,
  );
}

/**
 * Human-readable one-line summary of a schedule, so an operator sees
 * `Daily at 12:00 UTC` instead of the raw JSON config. Pure (no
 * Date.now() or system locale).
 */
export function summariseSchedule(
  mode: ScheduleMode,
  config: ScheduleConfig,
): string {
  if (config.mode !== mode) return `${mode} (config mismatch)`;
  switch (config.mode) {
    case 'daily-at-utc': {
      const hours = [...new Set(config.hours)].sort((a, b) => a - b);
      const pad = (n: number) => String(n).padStart(2, '0');
      const hourList = hours.map((h) => `${pad(h)}:${pad(config.minute)}`).join(', ');
      return `Daily at ${hourList} UTC`;
    }
    case 'every-n-minutes':
      return `Every ${config.intervalMinutes} minute${config.intervalMinutes === 1 ? '' : 's'} from ${config.startDate}`;
    case 'weekly': {
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const days = [...new Set(config.daysOfWeek)]
        .sort((a, b) => a - b)
        .map((d) => names[d])
        .join('/');
      const pad = (n: number) => String(n).padStart(2, '0');
      return `Weekly ${days} at ${pad(config.hour)}:${pad(config.minute)} UTC`;
    }
    case 'monthly': {
      const days = [...new Set(config.daysOfMonth)]
        .sort((a, b) => a - b)
        .join(', ');
      const pad = (n: number) => String(n).padStart(2, '0');
      return `Monthly day(s) ${days} at ${pad(config.hour)}:${pad(config.minute)} UTC`;
    }
    case 'cron-expression':
      return `Cron '${config.expression}' (UTC)`;
    case 'one-time':
      return `One-time at ${config.fireAt} UTC`;
    case 'several-times-per-day': {
      const pad = (n: number) => String(n).padStart(2, '0');
      const list = sortedTimesOfDay(config.times)
        .map((t) => `${pad(t.hour)}:${pad(t.minute)}`)
        .join(', ');
      return `Several times daily at ${list} UTC`;
    }
    default:
      return assertNever(config);
  }
}
