/**
 * tick-invariants — red-phase invariant pins for the injectable tick engine.
 *
 * Companion to tick-contract.test.ts. Where the contract suite pins the
 * fire-and-advance happy path plus ordering/membership, THIS suite pins the
 * operational invariants generalized from the AncientHoldings hub loop
 * (lib/cronoton-tick.ts): per-row error isolation, the per-tick batch cap,
 * no row/status mutation, restart-safe statelessness, both host config forms
 * (typed object OR JSON string), the injectable logger with its console
 * default, and loadDue-throw propagation.
 *
 * Import discipline (Phase 1 contract, matched with tick-contract.test.ts):
 *   - explicit vitest imports (no globals — the vitest config declares none);
 *   - the engine is imported RELATIVELY as '../src/tick.js' (never the bare
 *     package specifier), so CI's typecheck -> test -> build order works
 *     without a built dist/;
 *   - host hooks are plain vi.fn()/closure spies — NO vi.doMock. The whole
 *     point of the injected-deps seam is that no module mocking is needed;
 *   - the real computeNextFire from Phase 2 (src/schedule.ts) is exercised
 *     un-mocked through real configs, so asserted skips/fires are genuine
 *     engine outcomes (e.g. the mode/config-mismatch throw, the spent
 *     one-time null).
 *
 * RED expectation: '../src/tick.js' does not exist yet, so this whole file
 * fails to resolve its import — the Phase 2 lift red pattern.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  tickOnce,
  type TickDeps,
  type TickRow,
} from '../src/tick.js';
import type { DailyAtUtcConfig } from '../src/schedule.js';

/** The hub throttle-test instant: a half-second past a due noon boundary. */
const NOW = new Date('2026-05-24T12:00:00.500Z');

/**
 * A daily-at-utc config that is due at NOW and advances to the next noon.
 * Typed explicitly as DailyAtUtcConfig (rather than `as const`) so `mode`
 * stays narrowed for discrimination while `hours` keeps its mutable
 * `number[]` type — an `as const` tuple would be `readonly` and reject
 * against the ScheduleConfig union.
 */
const DAILY_NOON: DailyAtUtcConfig = { mode: 'daily-at-utc', hours: [12], minute: 0 };
const DAILY_NOON_NEXT_ISO = '2026-05-25T12:00:00.000Z';

/**
 * Recursively freeze an object graph. Object.freeze alone is shallow — it
 * would leave the nested `config` object writable, letting a mutating engine
 * silently modify it. Deep-freezing turns any write attempt into a strict-mode
 * TypeError so the no-mutation invariant is genuinely enforced.
 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Build a fresh deps object with fresh spies for every call site. */
function makeDeps(
  rows: TickRow[],
  overrides: Partial<TickDeps> = {},
): TickDeps & {
  loadDue: ReturnType<typeof vi.fn>;
  enqueueFire: ReturnType<typeof vi.fn>;
  persistNextFire: ReturnType<typeof vi.fn>;
} {
  return {
    loadDue: vi.fn(() => rows),
    enqueueFire: vi.fn(),
    persistNextFire: vi.fn(),
    ...overrides,
  } as TickDeps & {
    loadDue: ReturnType<typeof vi.fn>;
    enqueueFire: ReturnType<typeof vi.fn>;
    persistNextFire: ReturnType<typeof vi.fn>;
  };
}

describe('tickOnce — per-row isolation (REQ-10)', () => {
  it('isolates a bad JSON-string config: the bad row skips, the good row fires, enqueue runs once', () => {
    const badRow: TickRow = { id: 'bad-json', mode: 'daily-at-utc', config: 'not json' };
    const goodRow: TickRow = { id: 'good', mode: 'daily-at-utc', config: { ...DAILY_NOON } };
    const deps = makeDeps([badRow, goodRow]);

    const result = tickOnce(NOW, deps);

    expect(result.skippedIds).toContain('bad-json');
    expect(result.firedIds).toEqual(['good']);
    expect(result.firedIds).not.toContain('bad-json');
    // Only the good row reached the enqueue step; the bad row failed at parse.
    expect(deps.enqueueFire).toHaveBeenCalledTimes(1);
  });

  it('isolates a mode/config-mismatch row (real computeNextFire throws) so a later row still fires', () => {
    // weekly mode paired with a daily-at-utc config -> real computeNextFire
    // throws InvalidScheduleConfigError; isolation must convert it to a skip.
    const mismatchRow: TickRow = {
      id: 'mismatch',
      mode: 'weekly',
      config: { ...DAILY_NOON },
    };
    const goodRow: TickRow = { id: 'after', mode: 'daily-at-utc', config: { ...DAILY_NOON } };
    const deps = makeDeps([mismatchRow, goodRow]);

    const result = tickOnce(NOW, deps);

    expect(result.skippedIds).toContain('mismatch');
    expect(result.firedIds).toEqual(['after']);
    expect(deps.enqueueFire).toHaveBeenCalledTimes(1);
    expect(deps.enqueueFire).toHaveBeenCalledWith(goodRow);
  });
});

describe('tickOnce — injectable logger (REQ-10)', () => {
  it('calls the injected logError with a message containing the row id AND the error message on an isolated skip', () => {
    const logError = vi.fn();
    const badRow: TickRow = { id: 'mismatch', mode: 'weekly', config: { ...DAILY_NOON } };
    const deps = makeDeps([badRow], { logError });

    tickOnce(NOW, deps);

    expect(logError).toHaveBeenCalledTimes(1);
    const message = logError.mock.calls[0]![0] as string;
    expect(message).toContain('mismatch');
    // The hub's exact msg derivation is err.message; the mismatch guard's
    // message is "mode/config mismatch: ...".
    expect(message).toContain('mode/config mismatch');
  });

  it('does NOT call logError on a clean tick where every row fires', () => {
    const logError = vi.fn();
    const rows: TickRow[] = [
      { id: 'a', mode: 'daily-at-utc', config: { ...DAILY_NOON } },
      { id: 'b', mode: 'daily-at-utc', config: { ...DAILY_NOON } },
    ];
    const deps = makeDeps(rows, { logError });

    const result = tickOnce(NOW, deps);

    expect(result.firedIds).toEqual(['a', 'b']);
    expect(logError).not.toHaveBeenCalled();
  });

  it('does NOT call logError on a spent one-time skip (a skip is not an error)', () => {
    const logError = vi.fn();
    // fireAt equal to a past half-second -> nextOneTime returns null -> skip,
    // not an error; no logError for the terminal-schedule case.
    const spent: TickRow = {
      id: 'spent',
      mode: 'one-time',
      config: { mode: 'one-time', fireAt: '2026-05-24T12:00:00.000Z' },
    };
    const deps = makeDeps([spent], { logError });

    const result = tickOnce(NOW, deps);

    expect(result.skippedIds).toEqual(['spent']);
    expect(logError).not.toHaveBeenCalled();
  });

  it('falls back to console.error when logError is OMITTED, logging the row id once', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const badRow: TickRow = { id: 'mismatch', mode: 'weekly', config: { ...DAILY_NOON } };
      const deps = makeDeps([badRow]); // logError intentionally omitted

      tickOnce(NOW, deps);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const message = consoleSpy.mock.calls[0]![0] as string;
      expect(message).toContain('mismatch');
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe('tickOnce — batch cap (REQ-10)', () => {
  it('processes at most maxBatch rows; the overflow row is in NEITHER result set', () => {
    const rows: TickRow[] = [
      { id: 'r1', mode: 'daily-at-utc', config: { ...DAILY_NOON } },
      { id: 'r2', mode: 'daily-at-utc', config: { ...DAILY_NOON } },
      { id: 'r3', mode: 'daily-at-utc', config: { ...DAILY_NOON } },
    ];
    const deps = makeDeps(rows, { maxBatch: 2 });

    const result = tickOnce(NOW, deps);

    expect(deps.enqueueFire).toHaveBeenCalledTimes(2);
    expect(result.firedIds).toEqual(['r1', 'r2']);
    // r3 was never processed — it stays due for the next tick (SQL-LIMIT semantic).
    expect(result.firedIds).not.toContain('r3');
    expect(result.skippedIds).not.toContain('r3');
  });

  it('applies the default cap of 100 when maxBatch is omitted; the 101st row is in neither set', () => {
    const rows: TickRow[] = Array.from({ length: 101 }, (_, i) => ({
      id: `row-${i}`,
      mode: 'daily-at-utc' as const,
      config: { ...DAILY_NOON },
    }));
    const deps = makeDeps(rows); // maxBatch omitted -> default 100

    const result = tickOnce(NOW, deps);

    expect(deps.enqueueFire).toHaveBeenCalledTimes(100);
    expect(result.firedIds).toHaveLength(100);
    expect(result.firedIds).not.toContain('row-100');
    expect(result.skippedIds).not.toContain('row-100');
  });

  it('throws RangeError for maxBatch: 0 without calling any hook (predicate branch v <= 0)', () => {
    const deps = makeDeps([{ id: 'r', mode: 'daily-at-utc', config: { ...DAILY_NOON } }], {
      maxBatch: 0,
    });

    expect(() => tickOnce(NOW, deps)).toThrow(RangeError);
    expect(deps.loadDue).not.toHaveBeenCalled();
    expect(deps.enqueueFire).not.toHaveBeenCalled();
    expect(deps.persistNextFire).not.toHaveBeenCalled();
  });

  it('throws RangeError for maxBatch: -1 without calling any hook (predicate branch v <= 0)', () => {
    const deps = makeDeps([{ id: 'r', mode: 'daily-at-utc', config: { ...DAILY_NOON } }], {
      maxBatch: -1,
    });

    expect(() => tickOnce(NOW, deps)).toThrow(RangeError);
    expect(deps.loadDue).not.toHaveBeenCalled();
    expect(deps.enqueueFire).not.toHaveBeenCalled();
    expect(deps.persistNextFire).not.toHaveBeenCalled();
  });

  it('throws RangeError for maxBatch: 1.5 without calling any hook (predicate branch !Number.isInteger)', () => {
    const deps = makeDeps([{ id: 'r', mode: 'daily-at-utc', config: { ...DAILY_NOON } }], {
      maxBatch: 1.5,
    });

    expect(() => tickOnce(NOW, deps)).toThrow(RangeError);
    expect(deps.loadDue).not.toHaveBeenCalled();
    expect(deps.enqueueFire).not.toHaveBeenCalled();
    expect(deps.persistNextFire).not.toHaveBeenCalled();
  });

  it('throws RangeError for maxBatch: NaN without calling any hook (predicate branch !Number.isInteger)', () => {
    const deps = makeDeps([{ id: 'r', mode: 'daily-at-utc', config: { ...DAILY_NOON } }], {
      maxBatch: NaN,
    });

    expect(() => tickOnce(NOW, deps)).toThrow(RangeError);
    expect(deps.loadDue).not.toHaveBeenCalled();
    expect(deps.enqueueFire).not.toHaveBeenCalled();
    expect(deps.persistNextFire).not.toHaveBeenCalled();
  });
});

describe('tickOnce — no mutation / no status writes (REQ-10)', () => {
  it('fires deep-frozen rows (no swallowed mutation), never calls logError, and leaves rows unchanged', () => {
    const rowA = deepFreeze({
      id: 'frozen-a',
      mode: 'daily-at-utc' as const,
      config: { mode: 'daily-at-utc' as const, hours: [12], minute: 0 },
      status: 'active',
    });
    const rowB = deepFreeze({
      id: 'frozen-b',
      mode: 'daily-at-utc' as const,
      config: { mode: 'daily-at-utc' as const, hours: [12], minute: 0 },
      status: 'active',
    });
    const snapshotA = {
      id: 'frozen-a',
      mode: 'daily-at-utc',
      config: { mode: 'daily-at-utc', hours: [12], minute: 0 },
      status: 'active',
    };
    const snapshotB = {
      id: 'frozen-b',
      mode: 'daily-at-utc',
      config: { mode: 'daily-at-utc', hours: [12], minute: 0 },
      status: 'active',
    };
    const logError = vi.fn();
    const deps = makeDeps([rowA, rowB], { logError });

    const result = tickOnce(NOW, deps);

    // (1) Load-bearing: a mutating engine would throw a strict-mode TypeError
    // on the frozen row, which per-row isolation would swallow into a skip.
    // Fired-membership proves no such swallowed mutation attempt happened.
    expect(result.firedIds).toEqual(['frozen-a', 'frozen-b']);
    expect(result.skippedIds).toEqual([]);
    // (2) A swallowed mutation would also have logged — an uncalled logger
    // is the second witness that the tick never attempted a write.
    expect(logError).not.toHaveBeenCalled();
    // (3) Rows deep-equal their pre-tick snapshots.
    expect(rowA).toEqual(snapshotA);
    expect(rowB).toEqual(snapshotB);
  });
});

describe('tickOnce — restart safety / statelessness (REQ-10)', () => {
  it('two consecutive calls with independently-constructed identical inputs produce identical results, synchronously', () => {
    const build = (): TickRow[] => [
      { id: 'row-1', mode: 'daily-at-utc', config: { mode: 'daily-at-utc', hours: [12], minute: 0 } },
      {
        id: 'spent',
        mode: 'one-time',
        config: { mode: 'one-time', fireAt: '2026-05-24T12:00:00.000Z' },
      },
    ];

    const first = tickOnce(NOW, makeDeps(build()));
    const second = tickOnce(NOW, makeDeps(build()));

    // Results readable immediately (no Promise, no timer) — the synchronous,
    // stateless design: nothing is carried across calls inside the module.
    expect(first).not.toBeInstanceOf(Promise);
    expect(second).not.toBeInstanceOf(Promise);
    expect(second).toEqual(first);
    expect(first.firedIds).toEqual(['row-1']);
    expect(first.skippedIds).toEqual(['spent']);
  });
});

describe('tickOnce — typed-config form (REQ-07/REQ-11)', () => {
  it('a row with an object config fires identically to its JSON-string twin', () => {
    const objectRow: TickRow = {
      id: 'obj',
      mode: 'daily-at-utc',
      config: { mode: 'daily-at-utc', hours: [12], minute: 0 },
    };
    const stringRow: TickRow = {
      id: 'str',
      mode: 'daily-at-utc',
      config: JSON.stringify({ mode: 'daily-at-utc', hours: [12], minute: 0 }),
    };

    const objectDeps = makeDeps([objectRow]);
    const stringDeps = makeDeps([stringRow]);
    const objectResult = tickOnce(NOW, objectDeps);
    const stringResult = tickOnce(NOW, stringDeps);

    expect(objectResult.firedIds).toEqual(['obj']);
    expect(stringResult.firedIds).toEqual(['str']);
    // Both host representations advance to the same next-fire instant.
    const objNext = objectDeps.persistNextFire.mock.calls[0]![1] as Date;
    const strNext = stringDeps.persistNextFire.mock.calls[0]![1] as Date;
    expect(objNext.toISOString()).toBe(DAILY_NOON_NEXT_ISO);
    expect(strNext.toISOString()).toBe(DAILY_NOON_NEXT_ISO);
  });
});

describe('tickOnce — loadDue throw propagation', () => {
  it('propagates a loadDue throw to the caller (isolation is per-row, not batch-level)', () => {
    const boom = new Error('SELECT failed');
    const deps = makeDeps([], {
      loadDue: vi.fn(() => {
        throw boom;
      }),
    });

    expect(() => tickOnce(NOW, deps)).toThrow(boom);
    expect(deps.enqueueFire).not.toHaveBeenCalled();
    expect(deps.persistNextFire).not.toHaveBeenCalled();
  });
});
