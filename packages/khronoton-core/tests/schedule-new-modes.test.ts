/**
 * New schedule modes: one-time + several-times-per-day.
 *
 * Carried from AncientHoldings/tests/unit/cronoton-schedule-new-modes.test.ts.
 *
 * Pins the contract extensions:
 *   - one-time:            fire-once -> terminal. Returns the fireAt Date when
 *                          fireAt > now; returns null once spent (fireAt <= now).
 *                          Invalid/non-ISO fireAt throws (TOTAL: valid configs
 *                          never throw — but here a valid config may return null).
 *   - several-times-per-day: N fixed UTC times/day. Earliest configured time
 *                          strictly after now, sweeping today then tomorrow.
 *                          Always a Date (never null). Composite-key ordering
 *                          (hour*60+minute) so same-hour entries sort by minute.
 */
import { describe, expect, it } from 'vitest';

import {
  computeNextFire,
  summariseSchedule,
  InvalidScheduleConfigError,
  type ScheduleConfig,
} from '../src/schedule.js';

describe('computeNextFire — one-time', () => {
  it('future fireAt returns that exact instant', () => {
    const config: ScheduleConfig = {
      mode: 'one-time',
      fireAt: '2026-07-01T12:00:00.000Z',
    };
    const now = new Date('2026-06-01T00:00:00.000Z');
    const next = computeNextFire('one-time', config, now);
    expect(next).toBeInstanceOf(Date);
    expect(next!.toISOString()).toBe('2026-07-01T12:00:00.000Z');
  });

  it('past fireAt returns null (single fire spent)', () => {
    const config: ScheduleConfig = {
      mode: 'one-time',
      fireAt: '2026-05-01T12:00:00.000Z',
    };
    const now = new Date('2026-06-01T00:00:00.000Z');
    expect(computeNextFire('one-time', config, now)).toBeNull();
  });

  it('fireAt exactly equal to now returns null (strictly future required)', () => {
    const config: ScheduleConfig = {
      mode: 'one-time',
      fireAt: '2026-06-01T00:00:00.000Z',
    };
    const now = new Date('2026-06-01T00:00:00.000Z');
    expect(computeNextFire('one-time', config, now)).toBeNull();
  });

  it('non-ISO fireAt throws InvalidScheduleConfigError (not a silent null)', () => {
    const config: ScheduleConfig = {
      mode: 'one-time',
      fireAt: 'not a date',
    };
    const now = new Date('2026-06-01T00:00:00.000Z');
    expect(() => computeNextFire('one-time', config, now)).toThrow(
      InvalidScheduleConfigError,
    );
  });

  it('purity: two identical calls return identical instants', () => {
    const config: ScheduleConfig = {
      mode: 'one-time',
      fireAt: '2026-07-01T12:00:00.000Z',
    };
    const now = new Date('2026-06-01T00:00:00.000Z');
    const a = computeNextFire('one-time', config, now)!;
    const b = computeNextFire('one-time', config, now)!;
    expect(a.getTime()).toBe(b.getTime());
  });
});

describe('summariseSchedule — one-time', () => {
  it('summary names the mode and the fireAt instant', () => {
    const summary = summariseSchedule('one-time', {
      mode: 'one-time',
      fireAt: '2026-07-01T12:00:00.000Z',
    });
    expect(summary).toMatch(/one-time/i);
    expect(summary).toContain('2026-07-01T12:00:00.000Z');
  });
});

describe('computeNextFire — several-times-per-day', () => {
  it('mid-day now selects the next configured time today', () => {
    const config: ScheduleConfig = {
      mode: 'several-times-per-day',
      times: [
        { hour: 6, minute: 0 },
        { hour: 12, minute: 30 },
        { hour: 18, minute: 0 },
      ],
    };
    const now = new Date('2026-06-01T10:00:00.000Z');
    const next = computeNextFire('several-times-per-day', config, now)!;
    expect(next.toISOString()).toBe('2026-06-01T12:30:00.000Z');
  });

  it('after the last time today rolls to the first time tomorrow', () => {
    const config: ScheduleConfig = {
      mode: 'several-times-per-day',
      times: [
        { hour: 6, minute: 0 },
        { hour: 18, minute: 0 },
      ],
    };
    const now = new Date('2026-06-01T20:00:00.000Z');
    const next = computeNextFire('several-times-per-day', config, now)!;
    expect(next.toISOString()).toBe('2026-06-02T06:00:00.000Z');
  });

  it('exact-now boundary is excluded (strictly future)', () => {
    const config: ScheduleConfig = {
      mode: 'several-times-per-day',
      times: [
        { hour: 12, minute: 0 },
        { hour: 18, minute: 0 },
      ],
    };
    const now = new Date('2026-06-01T12:00:00.000Z');
    const next = computeNextFire('several-times-per-day', config, now)!;
    expect(next.toISOString()).toBe('2026-06-01T18:00:00.000Z');
  });

  it('same-hour out-of-order entries sort by composite key (minute breaks ties)', () => {
    const config: ScheduleConfig = {
      mode: 'several-times-per-day',
      times: [
        { hour: 6, minute: 30 },
        { hour: 6, minute: 0 },
      ],
    };
    const now = new Date('2026-06-01T05:00:00.000Z');
    const next = computeNextFire('several-times-per-day', config, now)!;
    expect(next.toISOString()).toBe('2026-06-01T06:00:00.000Z');
  });

  it('monotonic: later now never yields an earlier next-fire', () => {
    const config: ScheduleConfig = {
      mode: 'several-times-per-day',
      times: [
        { hour: 6, minute: 0 },
        { hour: 18, minute: 0 },
      ],
    };
    const n1 = new Date('2026-06-01T05:00:00.000Z');
    const n2 = new Date('2026-06-01T07:00:00.000Z');
    const next1 = computeNextFire('several-times-per-day', config, n1)!;
    const next2 = computeNextFire('several-times-per-day', config, n2)!;
    expect(next2.getTime()).toBeGreaterThanOrEqual(next1.getTime());
  });

  it('purity: two identical calls return identical instants', () => {
    const config: ScheduleConfig = {
      mode: 'several-times-per-day',
      times: [{ hour: 9, minute: 15 }],
    };
    const now = new Date('2026-06-01T00:00:00.000Z');
    const a = computeNextFire('several-times-per-day', config, now)!;
    const b = computeNextFire('several-times-per-day', config, now)!;
    expect(a.getTime()).toBe(b.getTime());
  });

  it('empty times array throws InvalidScheduleConfigError', () => {
    const config: ScheduleConfig = {
      mode: 'several-times-per-day',
      times: [],
    };
    const now = new Date('2026-06-01T00:00:00.000Z');
    expect(() =>
      computeNextFire('several-times-per-day', config, now),
    ).toThrow(InvalidScheduleConfigError);
  });

  it('out-of-range hour throws InvalidScheduleConfigError', () => {
    const config: ScheduleConfig = {
      mode: 'several-times-per-day',
      times: [{ hour: 24, minute: 0 }],
    };
    const now = new Date('2026-06-01T00:00:00.000Z');
    expect(() =>
      computeNextFire('several-times-per-day', config, now),
    ).toThrow(InvalidScheduleConfigError);
  });

  it('non-integer hour throws InvalidScheduleConfigError', () => {
    const config: ScheduleConfig = {
      mode: 'several-times-per-day',
      times: [{ hour: 6.5, minute: 0 }],
    };
    const now = new Date('2026-06-01T00:00:00.000Z');
    expect(() =>
      computeNextFire('several-times-per-day', config, now),
    ).toThrow(InvalidScheduleConfigError);
  });
});

describe('summariseSchedule — several-times-per-day', () => {
  it('summary lists the configured times in composite-key order', () => {
    const summary = summariseSchedule('several-times-per-day', {
      mode: 'several-times-per-day',
      times: [
        { hour: 18, minute: 0 },
        { hour: 6, minute: 0 },
        { hour: 12, minute: 30 },
      ],
    });
    expect(summary).toMatch(/several/i);
    expect(summary).toContain('06:00');
    expect(summary).toContain('12:30');
    expect(summary).toContain('18:00');
    expect(summary.indexOf('06:00')).toBeLessThan(summary.indexOf('12:30'));
    expect(summary.indexOf('12:30')).toBeLessThan(summary.indexOf('18:00'));
  });
});
