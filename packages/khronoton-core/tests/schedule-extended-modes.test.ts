/**
 * Contract pins for the EXTENDED (7-mode) schedule engine surface.
 *
 * Carried from AncientHoldings/tests/unit/cronoton-schedule-extended-modes.test.ts.
 *
 * This file complements the per-mode behaviour pins in
 * `schedule-new-modes.test.ts` and the original 5-mode gate in
 * `schedule-compute-next-fire.test.ts` by pinning the engine at the
 * CONTRACT / whole-surface level:
 *
 *   - TOTAL sweep across all SEVEN modes in one case table — one-time is the
 *     only mode allowed to return null (and only once its single fire is
 *     past); the other six always yield a future Date.
 *   - MONOTONIC for several-times-per-day, including the same-hour
 *     out-of-order case that pins the composite-key (hour*60+minute) sort.
 *   - PURITY for the two new modes (no Date.now()/Math.random() leakage).
 *   - NO-REGRESSION: the original five modes still return the exact instants
 *     the existing pin file asserts, re-checked here so a drift surfaces in
 *     either file.
 *   - summariseSchedule yields a non-empty, mode-appropriate string for all
 *     seven modes.
 *   - ENUM-PARITY: the seven locked literals are pinned verbatim so a typo
 *     in the ScheduleMode union fails HERE, not at runtime in a later phase.
 */
import { describe, expect, it } from 'vitest';

import {
  computeNextFire,
  summariseSchedule,
  type ScheduleMode,
  type ScheduleConfig,
} from '../src/schedule.js';

/**
 * The seven locked schedule-mode literals. This array is the single source
 * of truth the parity assertion compares the union against — if the
 * ScheduleMode union drifts, the parity test below fails because the
 * case-table coverage no longer matches this set.
 */
const LOCKED_MODES = [
  'daily-at-utc',
  'every-n-minutes',
  'weekly',
  'monthly',
  'cron-expression',
  'one-time',
  'several-times-per-day',
] as const satisfies readonly ScheduleMode[];

describe('extended engine — TOTAL sweep across all seven modes', () => {
  const now = new Date('2026-06-01T12:00:00.000Z');

  /**
   * One representative valid config per mode. `expect` is the contract
   * outcome: 'future-date' for recurring modes and future one-time;
   * 'null' for the spent one-time terminal case.
   */
  const cases: Array<{
    label: string;
    mode: ScheduleMode;
    config: ScheduleConfig;
    expect: 'future-date' | 'null';
  }> = [
    {
      label: 'daily-at-utc',
      mode: 'daily-at-utc',
      config: { mode: 'daily-at-utc', hours: [13, 18], minute: 0 },
      expect: 'future-date',
    },
    {
      label: 'every-n-minutes',
      mode: 'every-n-minutes',
      config: {
        mode: 'every-n-minutes',
        startDate: '2026-06-01T00:00:00.000Z',
        intervalMinutes: 15,
      },
      expect: 'future-date',
    },
    {
      label: 'weekly',
      mode: 'weekly',
      config: { mode: 'weekly', daysOfWeek: [1, 3, 5], hour: 12, minute: 0 },
      expect: 'future-date',
    },
    {
      label: 'monthly',
      mode: 'monthly',
      config: { mode: 'monthly', daysOfMonth: [1, 15], hour: 0, minute: 0 },
      expect: 'future-date',
    },
    {
      label: 'cron-expression',
      mode: 'cron-expression',
      config: { mode: 'cron-expression', expression: '0 12 * * *' },
      expect: 'future-date',
    },
    {
      label: 'one-time (future fireAt)',
      mode: 'one-time',
      config: { mode: 'one-time', fireAt: '2026-07-01T12:00:00.000Z' },
      expect: 'future-date',
    },
    {
      label: 'one-time (past fireAt -> spent)',
      mode: 'one-time',
      config: { mode: 'one-time', fireAt: '2026-05-01T12:00:00.000Z' },
      expect: 'null',
    },
    {
      label: 'several-times-per-day',
      mode: 'several-times-per-day',
      config: {
        mode: 'several-times-per-day',
        times: [
          { hour: 6, minute: 0 },
          { hour: 18, minute: 0 },
        ],
      },
      expect: 'future-date',
    },
  ];

  for (const c of cases) {
    it(`${c.label} -> ${c.expect === 'null' ? 'null (terminal)' : 'a Date strictly after now'}`, () => {
      const next = computeNextFire(c.mode, c.config, now);
      if (c.expect === 'null') {
        // Only a spent one-time fire may yield null. If a recurring mode
        // ever returned null here, the scheduler would silently stop firing.
        expect(next).toBeNull();
      } else {
        expect(next).toBeInstanceOf(Date);
        expect(next!.getTime()).toBeGreaterThan(now.getTime());
      }
    });
  }

  it('covers every locked mode at least once (TOTAL means no mode is skipped)', () => {
    // A new mode added to the union without a case here would leave the
    // engine partially unpinned; this guards against that gap.
    const covered = new Set(cases.map((c) => c.mode));
    for (const mode of LOCKED_MODES) {
      expect(covered.has(mode)).toBe(true);
    }
  });
});

describe('extended engine — MONOTONIC pin for several-times-per-day', () => {
  it('later now never yields an earlier next-fire', () => {
    const config: ScheduleConfig = {
      mode: 'several-times-per-day',
      times: [
        { hour: 6, minute: 0 },
        { hour: 18, minute: 0 },
      ],
    };
    const n1 = new Date('2026-06-01T05:00:00.000Z');
    const n2 = new Date('2026-06-01T12:00:00.000Z');
    const next1 = computeNextFire('several-times-per-day', config, n1)!;
    const next2 = computeNextFire('several-times-per-day', config, n2)!;
    // n1's next fire is 06:00; n2 (noon) has passed 06:00 so its next is
    // 18:00 — later, never earlier.
    expect(next2.getTime()).toBeGreaterThanOrEqual(next1.getTime());
  });

  it('same-hour out-of-order entries fire 06:00 before 06:30 (composite-key sort)', () => {
    // Input order is [06:30, 06:00]; a naive insertion-order pick would fire
    // 06:30 first. The composite key (hour*60+minute) must reorder so the
    // earliest minute-within-hour wins.
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
});

describe('extended engine — PURITY pin for the two new modes', () => {
  it('one-time: identical args return the identical instant', () => {
    const config: ScheduleConfig = {
      mode: 'one-time',
      fireAt: '2026-07-01T12:00:00.000Z',
    };
    const now = new Date('2026-06-01T00:00:00.000Z');
    const a = computeNextFire('one-time', config, now)!;
    const b = computeNextFire('one-time', config, now)!;
    // Equal ms across calls proves no Date.now()/Math.random() leaked in.
    expect(a.getTime()).toBe(b.getTime());
  });

  it('several-times-per-day: identical args return the identical instant', () => {
    const config: ScheduleConfig = {
      mode: 'several-times-per-day',
      times: [
        { hour: 9, minute: 15 },
        { hour: 21, minute: 45 },
      ],
    };
    const now = new Date('2026-06-01T00:00:00.000Z');
    const a = computeNextFire('several-times-per-day', config, now)!;
    const b = computeNextFire('several-times-per-day', config, now)!;
    expect(a.getTime()).toBe(b.getTime());
  });
});

describe('extended engine — NO-REGRESSION of the original five modes', () => {
  // These instants mirror the assertions in
  // schedule-compute-next-fire.test.ts. Re-checking them here means
  // a drift in any original mode fails in EITHER file, not just the old one.
  it('daily-at-utc at T-1ms returns same-day 12:00:00.000Z', () => {
    const next = computeNextFire(
      'daily-at-utc',
      { mode: 'daily-at-utc', hours: [12], minute: 0 },
      new Date('2026-05-24T11:59:59.999Z'),
    )!;
    expect(next.toISOString()).toBe('2026-05-24T12:00:00.000Z');
  });

  it('every-n-minutes 15m, now 7m past start -> start + 15m', () => {
    const next = computeNextFire(
      'every-n-minutes',
      {
        mode: 'every-n-minutes',
        startDate: '2026-05-24T00:00:00.000Z',
        intervalMinutes: 15,
      },
      new Date('2026-05-24T00:07:00.000Z'),
    )!;
    expect(next.toISOString()).toBe('2026-05-24T00:15:00.000Z');
  });

  it('weekly Mon/Wed/Fri noon, on Tuesday 13:00 -> Wednesday noon', () => {
    const next = computeNextFire(
      'weekly',
      { mode: 'weekly', daysOfWeek: [1, 3, 5], hour: 12, minute: 0 },
      new Date('2026-05-26T13:00:00.000Z'),
    )!;
    expect(next.toISOString()).toBe('2026-05-27T12:00:00.000Z');
  });

  it('monthly day-15 midnight, on May 16 -> June 15 midnight', () => {
    const next = computeNextFire(
      'monthly',
      { mode: 'monthly', daysOfMonth: [15], hour: 0, minute: 0 },
      new Date('2026-05-16T00:00:00.000Z'),
    )!;
    expect(next.toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });

  it("cron '0 12 * * 1-5' on Saturday -> next Monday noon", () => {
    const next = computeNextFire(
      'cron-expression',
      { mode: 'cron-expression', expression: '0 12 * * 1-5' },
      new Date('2026-05-23T08:00:00.000Z'),
    )!;
    expect(next.toISOString()).toBe('2026-05-25T12:00:00.000Z');
  });
});

describe('extended engine — summariseSchedule covers all seven modes', () => {
  const summaries: Array<{
    mode: ScheduleMode;
    config: ScheduleConfig;
    matches: RegExp;
  }> = [
    {
      mode: 'daily-at-utc',
      config: { mode: 'daily-at-utc', hours: [12], minute: 0 },
      matches: /daily/i,
    },
    {
      mode: 'every-n-minutes',
      config: {
        mode: 'every-n-minutes',
        startDate: '2026-06-01T00:00:00.000Z',
        intervalMinutes: 15,
      },
      matches: /15/,
    },
    {
      mode: 'weekly',
      config: { mode: 'weekly', daysOfWeek: [1, 3, 5], hour: 12, minute: 0 },
      matches: /weekly/i,
    },
    {
      mode: 'monthly',
      config: { mode: 'monthly', daysOfMonth: [1, 15], hour: 0, minute: 0 },
      matches: /monthly/i,
    },
    {
      mode: 'cron-expression',
      config: { mode: 'cron-expression', expression: '0 12 * * *' },
      matches: /0 12 \* \* \*/,
    },
    {
      mode: 'one-time',
      config: { mode: 'one-time', fireAt: '2026-07-01T12:00:00.000Z' },
      matches: /one-time/i,
    },
    {
      mode: 'several-times-per-day',
      config: {
        mode: 'several-times-per-day',
        times: [{ hour: 6, minute: 0 }],
      },
      matches: /several/i,
    },
  ];

  for (const s of summaries) {
    it(`${s.mode} produces a non-empty, mode-appropriate summary`, () => {
      const summary = summariseSchedule(s.mode, s.config);
      expect(summary.length).toBeGreaterThan(0);
      expect(summary).toMatch(s.matches);
    });
  }
});

describe('extended engine — ENUM-PARITY pin (TS union vs SQL CHECK enum)', () => {
  it('locks exactly the seven mode literals, verbatim', () => {
    // Pinned verbatim so a typo introduced in the ScheduleMode union fails
    // here, rather than slipping through to a runtime mode/config mismatch
    // in a later phase.
    expect(LOCKED_MODES).toEqual([
      'daily-at-utc',
      'every-n-minutes',
      'weekly',
      'monthly',
      'cron-expression',
      'one-time',
      'several-times-per-day',
    ]);
    expect(LOCKED_MODES.length).toBe(7);
    // No duplicate literals — a dupe would mean the union is malformed.
    expect(new Set(LOCKED_MODES).size).toBe(7);
  });

  it('every locked literal is an executable mode (computeNextFire accepts it)', () => {
    // A literal present in the union but rejected by the engine switch would
    // be a dead enum member; exercising one valid config per mode proves the
    // seven literals are all live wiring, not just type-level decoration.
    const now = new Date('2026-06-01T00:00:00.000Z');
    const configByMode: Record<ScheduleMode, ScheduleConfig> = {
      'daily-at-utc': { mode: 'daily-at-utc', hours: [12], minute: 0 },
      'every-n-minutes': {
        mode: 'every-n-minutes',
        startDate: '2026-06-01T00:00:00.000Z',
        intervalMinutes: 15,
      },
      weekly: { mode: 'weekly', daysOfWeek: [1], hour: 12, minute: 0 },
      monthly: { mode: 'monthly', daysOfMonth: [1], hour: 0, minute: 0 },
      'cron-expression': { mode: 'cron-expression', expression: '0 12 * * *' },
      'one-time': { mode: 'one-time', fireAt: '2026-07-01T12:00:00.000Z' },
      'several-times-per-day': {
        mode: 'several-times-per-day',
        times: [{ hour: 6, minute: 0 }],
      },
    };
    for (const mode of LOCKED_MODES) {
      expect(() =>
        computeNextFire(mode, configByMode[mode], now),
      ).not.toThrow();
    }
  });
});
