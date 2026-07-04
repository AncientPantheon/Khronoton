/**
 * Cron dayOfMonth/dayOfWeek OR-matching semantic pin.
 *
 * Newly-authored contract test (no equivalent exists in the carried hub
 * suites): locks the standard-cron rule for the day fields, observed ONLY
 * through `computeNextFire` with `cron-expression` configs — the parser is
 * module-internal and must never be imported directly.
 *
 * The rule under pin (matches the in-tree parser's documented behavior):
 *   - both dayOfMonth and dayOfWeek are `*`  -> match every day.
 *   - exactly one of them is `*`             -> the other field must match.
 *   - both are restricted (neither is `*`)   -> match if EITHER field matches
 *                                               (OR, not AND).
 * "Is this field `*`?" is decided by set size: a dayOfMonth set of size 31 or
 * a dayOfWeek set of size 7 is treated as `*` — so a literal `1-31` / `0-6`
 * full range is indistinguishable from `*` by design.
 *
 * Weekday facts (verified via `new Date(...).getUTCDay()` before writing):
 *   2026-06-01 = Monday, 2026-06-02 = Tuesday, 2026-06-05 = Friday,
 *   2026-06-08 = Monday, 2026-06-12 = Friday, 2026-06-13 = Saturday.
 */
import { describe, expect, it } from 'vitest';

import { computeNextFire, type ScheduleConfig } from '../src/schedule.js';

describe('computeNextFire — cron both-restricted day fields match via OR', () => {
  it("'0 12 13 * 5' fires on the next Friday when it precedes the next 13th", () => {
    // dom restricted to the 13th, dow restricted to Friday(5) -> OR.
    // now = Monday 2026-06-01; the next Friday (06-05) comes before the
    // next 13th (06-13), so the Friday branch wins even though 06-05 is
    // not the 13th.
    const config: ScheduleConfig = {
      mode: 'cron-expression',
      expression: '0 12 13 * 5',
    };
    const now = new Date('2026-06-01T00:00:00.000Z');
    const next = computeNextFire('cron-expression', config, now)!;
    // 2026-06-05 is a Friday.
    expect(next.toISOString()).toBe('2026-06-05T12:00:00.000Z');
  });

  it("'0 12 13 * 5' fires on the 13th even when it is not a Friday", () => {
    // now = Friday 2026-06-12 at 13:00 (past this week's Friday noon).
    // The next 13th (06-13, a Saturday) arrives before next Friday (06-19),
    // so the dayOfMonth branch wins via OR — proving dow=Friday-only does
    // NOT suppress a non-Friday 13th.
    const config: ScheduleConfig = {
      mode: 'cron-expression',
      expression: '0 12 13 * 5',
    };
    const now = new Date('2026-06-12T13:00:00.000Z');
    const next = computeNextFire('cron-expression', config, now)!;
    // 2026-06-13 is a Saturday.
    expect(next.toISOString()).toBe('2026-06-13T12:00:00.000Z');
  });
});

describe('computeNextFire — cron full-range day field is treated as *', () => {
  it("'0 12 1-31 * 1' treats dom 1-31 (size 31) as * -> dow-only, next Monday", () => {
    // dom = 1-31 is a full range (set size 31) so it reads as `*`, making
    // the expression dow-only (Monday). now = Tuesday 2026-06-02: an
    // erroneous OR-match against the restricted-LOOKING dom set would fire
    // at Tuesday noon; the correct behavior skips to the next Monday.
    const config: ScheduleConfig = {
      mode: 'cron-expression',
      expression: '0 12 1-31 * 1',
    };
    const now = new Date('2026-06-02T00:00:00.000Z');
    const next = computeNextFire('cron-expression', config, now)!;
    // 2026-06-08 is a Monday (not Tuesday 06-02).
    expect(next.toISOString()).toBe('2026-06-08T12:00:00.000Z');
  });

  it("'0 12 13 * 0-6' treats dow 0-6 (size 7) as * -> dom-only, next 13th", () => {
    // dow = 0-6 is a full range (set size 7) so it reads as `*`, making the
    // expression dom-only (the 13th). now = Monday 2026-06-01 -> next fire
    // is the 13th, NOT daily noon.
    const config: ScheduleConfig = {
      mode: 'cron-expression',
      expression: '0 12 13 * 0-6',
    };
    const now = new Date('2026-06-01T00:00:00.000Z');
    const next = computeNextFire('cron-expression', config, now)!;
    // 2026-06-13 is a Saturday.
    expect(next.toISOString()).toBe('2026-06-13T12:00:00.000Z');
  });
});

describe('computeNextFire — cron both-wildcard day fields fire daily', () => {
  it("'0 12 * * *' fires the very next noon", () => {
    // Both day fields `*` -> every day at noon. now = Monday 2026-06-01
    // midnight -> the same-day noon.
    const config: ScheduleConfig = {
      mode: 'cron-expression',
      expression: '0 12 * * *',
    };
    const now = new Date('2026-06-01T00:00:00.000Z');
    const next = computeNextFire('cron-expression', config, now)!;
    expect(next.toISOString()).toBe('2026-06-01T12:00:00.000Z');
  });
});
