/**
 * computeNextFire(mode, config, now) helper pins.
 *
 * Carried from AncientHoldings/tests/unit/cronoton-schedule-compute-next-fire.test.ts.
 *
 * Total + monotonic contract:
 *   - TOTAL: every valid (mode, config, now) triple yields a Date.
 *   - MONOTONIC: for the same schedule, a later `now` never yields an
 *     earlier next-fire than an earlier `now` (when both `now`s are
 *     at-or-after the same prior fire).
 *
 * Per-mode pins:
 *   - daily-at-utc:        boundary precision at 12:00:00.000Z
 *   - every-n-minutes:     ceiling rounding from arbitrary now
 *   - weekly:              Monday/Wednesday/Friday at noon UTC
 *   - monthly:             day-15-of-each-month at midnight UTC
 *   - cron-expression:     '0 12 * * 1-5' on a Saturday -> next Monday noon
 *
 * Invalid-config sanity: InvalidScheduleConfigError thrown on
 * intervalMinutes <= 0, daysOfWeek out of [0..6], daysOfMonth out of
 * [1..31], malformed cron expression.
 */
import { describe, expect, it } from 'vitest';

import {
  computeNextFire,
  InvalidScheduleConfigError,
  type ScheduleMode,
  type ScheduleConfig,
} from '../src/schedule.js';

describe('computeNextFire — TOTAL pin (every mode returns a Date)', () => {
  const now = new Date('2026-05-24T12:00:00.000Z');
  const cases: Array<{ mode: ScheduleMode; config: ScheduleConfig }> = [
    {
      mode: 'daily-at-utc',
      config: { mode: 'daily-at-utc', hours: [12, 18], minute: 0 },
    },
    {
      mode: 'every-n-minutes',
      config: {
        mode: 'every-n-minutes',
        startDate: '2026-05-24T00:00:00.000Z',
        intervalMinutes: 15,
      },
    },
    {
      mode: 'weekly',
      config: {
        mode: 'weekly',
        daysOfWeek: [1, 3, 5],
        hour: 12,
        minute: 0,
      },
    },
    {
      mode: 'monthly',
      config: {
        mode: 'monthly',
        daysOfMonth: [1, 15],
        hour: 0,
        minute: 0,
      },
    },
    {
      mode: 'cron-expression',
      config: { mode: 'cron-expression', expression: '0 12 * * *' },
    },
  ];

  for (const c of cases) {
    it(`${c.mode} returns a future Date`, () => {
      const next = computeNextFire(c.mode, c.config, now);
      expect(next).toBeInstanceOf(Date);
      expect(next!.getTime()).toBeGreaterThan(now.getTime());
    });
  }
});

describe('computeNextFire — MONOTONIC pin per mode', () => {
  it('daily-at-utc: later now never yields an earlier next-fire', () => {
    const config: ScheduleConfig = {
      mode: 'daily-at-utc',
      hours: [12],
      minute: 0,
    };
    const n1 = new Date('2026-05-24T10:00:00.000Z');
    const n2 = new Date('2026-05-24T11:30:00.000Z');
    const next1 = computeNextFire('daily-at-utc', config, n1)!;
    const next2 = computeNextFire('daily-at-utc', config, n2)!;
    expect(next2.getTime()).toBeGreaterThanOrEqual(next1.getTime());
  });

  it('every-n-minutes: later now never yields an earlier next-fire', () => {
    const config: ScheduleConfig = {
      mode: 'every-n-minutes',
      startDate: '2026-05-24T00:00:00.000Z',
      intervalMinutes: 15,
    };
    const n1 = new Date('2026-05-24T00:05:00.000Z');
    const n2 = new Date('2026-05-24T00:20:00.000Z');
    const next1 = computeNextFire('every-n-minutes', config, n1)!;
    const next2 = computeNextFire('every-n-minutes', config, n2)!;
    expect(next2.getTime()).toBeGreaterThanOrEqual(next1.getTime());
  });
});

describe('computeNextFire — daily-at-utc boundary precision', () => {
  it('at T-1ms (11:59:59.999Z) returns 12:00:00.000Z (same day)', () => {
    const config: ScheduleConfig = {
      mode: 'daily-at-utc',
      hours: [12],
      minute: 0,
    };
    const now = new Date('2026-05-24T11:59:59.999Z');
    const next = computeNextFire('daily-at-utc', config, now)!;
    expect(next.toISOString()).toBe('2026-05-24T12:00:00.000Z');
  });

  it('at T+1ms (12:00:00.001Z) returns next-day 12:00:00.000Z', () => {
    const config: ScheduleConfig = {
      mode: 'daily-at-utc',
      hours: [12],
      minute: 0,
    };
    const now = new Date('2026-05-24T12:00:00.001Z');
    const next = computeNextFire('daily-at-utc', config, now)!;
    expect(next.toISOString()).toBe('2026-05-25T12:00:00.000Z');
  });

  it('multi-hour daily-at-utc returns earliest hour-of-day after now', () => {
    const config: ScheduleConfig = {
      mode: 'daily-at-utc',
      hours: [17, 18, 19],
      minute: 0,
    };
    const now = new Date('2026-05-24T17:30:00.000Z');
    const next = computeNextFire('daily-at-utc', config, now)!;
    expect(next.toISOString()).toBe('2026-05-24T18:00:00.000Z');
  });
});

describe('computeNextFire — every-n-minutes', () => {
  it('every 15m: now 7m after startDate -> startDate + 15m', () => {
    const config: ScheduleConfig = {
      mode: 'every-n-minutes',
      startDate: '2026-05-24T00:00:00.000Z',
      intervalMinutes: 15,
    };
    const now = new Date('2026-05-24T00:07:00.000Z');
    const next = computeNextFire('every-n-minutes', config, now)!;
    expect(next.toISOString()).toBe('2026-05-24T00:15:00.000Z');
  });

  it('every 15m: now exactly at boundary (00:15:00.000Z) -> next boundary (00:30)', () => {
    const config: ScheduleConfig = {
      mode: 'every-n-minutes',
      startDate: '2026-05-24T00:00:00.000Z',
      intervalMinutes: 15,
    };
    const now = new Date('2026-05-24T00:15:00.000Z');
    const next = computeNextFire('every-n-minutes', config, now)!;
    expect(next.toISOString()).toBe('2026-05-24T00:30:00.000Z');
  });

  it('every 15m: now before startDate returns startDate', () => {
    const config: ScheduleConfig = {
      mode: 'every-n-minutes',
      startDate: '2026-05-25T00:00:00.000Z',
      intervalMinutes: 15,
    };
    const now = new Date('2026-05-24T12:00:00.000Z');
    const next = computeNextFire('every-n-minutes', config, now)!;
    expect(next.toISOString()).toBe('2026-05-25T00:00:00.000Z');
  });
});

describe('computeNextFire — weekly', () => {
  it('Mon/Wed/Fri at noon UTC, on Tuesday 13:00 -> Wednesday noon', () => {
    // 2026-05-24 is a Sunday. 2026-05-26 is a Tuesday.
    const config: ScheduleConfig = {
      mode: 'weekly',
      daysOfWeek: [1, 3, 5],
      hour: 12,
      minute: 0,
    };
    const now = new Date('2026-05-26T13:00:00.000Z');
    const next = computeNextFire('weekly', config, now)!;
    // Next Wed = 2026-05-27 at noon UTC.
    expect(next.toISOString()).toBe('2026-05-27T12:00:00.000Z');
  });
});

describe('computeNextFire — monthly', () => {
  it('day-15-at-midnight on May 16 -> June 15 midnight', () => {
    const config: ScheduleConfig = {
      mode: 'monthly',
      daysOfMonth: [15],
      hour: 0,
      minute: 0,
    };
    const now = new Date('2026-05-16T00:00:00.000Z');
    const next = computeNextFire('monthly', config, now)!;
    expect(next.toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });

  it('day-1-and-15 at midnight on May 16 -> June 1 midnight', () => {
    const config: ScheduleConfig = {
      mode: 'monthly',
      daysOfMonth: [1, 15],
      hour: 0,
      minute: 0,
    };
    const now = new Date('2026-05-16T00:00:00.000Z');
    const next = computeNextFire('monthly', config, now)!;
    expect(next.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('computeNextFire — cron-expression', () => {
  it("'0 12 * * 1-5' (weekday noon) on Saturday -> next Monday noon", () => {
    // 2026-05-23 is a Saturday.
    const config: ScheduleConfig = {
      mode: 'cron-expression',
      expression: '0 12 * * 1-5',
    };
    const now = new Date('2026-05-23T08:00:00.000Z');
    const next = computeNextFire('cron-expression', config, now)!;
    // 2026-05-25 is Monday.
    expect(next.toISOString()).toBe('2026-05-25T12:00:00.000Z');
  });

  it("'*/5 * * * *' (every 5 min) on :02 -> :05", () => {
    const config: ScheduleConfig = {
      mode: 'cron-expression',
      expression: '*/5 * * * *',
    };
    const now = new Date('2026-05-24T12:02:00.000Z');
    const next = computeNextFire('cron-expression', config, now)!;
    expect(next.toISOString()).toBe('2026-05-24T12:05:00.000Z');
  });
});

describe('computeNextFire — determinism', () => {
  it('repeated calls with the same (mode, config, now) return the same Date', () => {
    const config: ScheduleConfig = {
      mode: 'daily-at-utc',
      hours: [12],
      minute: 0,
    };
    const now = new Date('2026-05-24T11:00:00.000Z');
    const r1 = computeNextFire('daily-at-utc', config, now)!;
    const r2 = computeNextFire('daily-at-utc', config, now)!;
    const r3 = computeNextFire('daily-at-utc', config, now)!;
    expect(r1.getTime()).toBe(r2.getTime());
    expect(r2.getTime()).toBe(r3.getTime());
  });
});

describe('computeNextFire — invalid config throws InvalidScheduleConfigError', () => {
  const now = new Date('2026-05-24T12:00:00.000Z');

  it('every-n-minutes with intervalMinutes <= 0 throws', () => {
    expect(() =>
      computeNextFire(
        'every-n-minutes',
        {
          mode: 'every-n-minutes',
          startDate: '2026-05-24T00:00:00.000Z',
          intervalMinutes: 0,
        },
        now,
      ),
    ).toThrow(InvalidScheduleConfigError);
  });

  it('weekly with daysOfWeek out of [0..6] throws', () => {
    expect(() =>
      computeNextFire(
        'weekly',
        {
          mode: 'weekly',
          daysOfWeek: [7],
          hour: 12,
          minute: 0,
        },
        now,
      ),
    ).toThrow(InvalidScheduleConfigError);
  });

  it('monthly with daysOfMonth out of [1..31] throws', () => {
    expect(() =>
      computeNextFire(
        'monthly',
        {
          mode: 'monthly',
          daysOfMonth: [32],
          hour: 0,
          minute: 0,
        },
        now,
      ),
    ).toThrow(InvalidScheduleConfigError);
  });

  it('cron-expression with malformed expression throws', () => {
    expect(() =>
      computeNextFire(
        'cron-expression',
        { mode: 'cron-expression', expression: 'not a cron' },
        now,
      ),
    ).toThrow(InvalidScheduleConfigError);
  });
});

describe('summariseSchedule (helper for the list view)', () => {
  it('produces a human-readable summary per mode', async () => {
    const { summariseSchedule } = await import('../src/schedule.js');
    expect(
      summariseSchedule('daily-at-utc', {
        mode: 'daily-at-utc',
        hours: [12],
        minute: 0,
      }),
    ).toMatch(/daily/i);
    expect(
      summariseSchedule('every-n-minutes', {
        mode: 'every-n-minutes',
        startDate: '2026-05-24T00:00:00.000Z',
        intervalMinutes: 15,
      }),
    ).toMatch(/15/);
    expect(
      summariseSchedule('weekly', {
        mode: 'weekly',
        daysOfWeek: [1, 3, 5],
        hour: 12,
        minute: 0,
      }),
    ).toMatch(/weekly/i);
    expect(
      summariseSchedule('monthly', {
        mode: 'monthly',
        daysOfMonth: [1, 15],
        hour: 0,
        minute: 0,
      }),
    ).toMatch(/monthly/i);
    expect(
      summariseSchedule('cron-expression', {
        mode: 'cron-expression',
        expression: '0 12 * * *',
      }),
    ).toContain('0 12 * * *');
  });
});
