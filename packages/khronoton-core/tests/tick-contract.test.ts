/**
 * tickOnce — contract pins for the injected-hooks tick engine.
 *
 * Generalized from the AncientHoldings hub loop (lib/cronoton-tick.ts): the
 * hub's three couplings — the better-sqlite3 SELECT, `enqueueJobWithAudit`,
 * and the three-column UPDATE — are inverted into the injected hooks
 * `loadDue(now)`, `enqueueFire(row)`, `persistNextFire(id, nextDate, firedAt)`.
 * Because the hooks are ARGUMENTS (not module imports), these tests need no
 * module mocking at all: the hooks are plain `vi.fn()` / closure spies, and
 * the real `computeNextFire` (Phase 2) runs un-mocked so every asserted
 * instant is real engine ground truth.
 *
 * This suite pins the FIRE PATH, the enqueue-before-persist ORDERING, and the
 * fired-vs-skipped MEMBERSHIP mapping. Isolation, batch cap, mutation, and the
 * config forms live in tick-invariants.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import { tickOnce, type TickDeps, type TickRow } from '../src/tick.js';

describe('tickOnce — fire-and-advance path (REQ-07)', () => {
  it('fires a due daily-at-utc row, advances 24h, and passes now as firedAt', () => {
    const now = new Date('2026-05-24T12:00:00.500Z');
    const row = {
      id: 'row-1',
      mode: 'daily-at-utc' as const,
      config: { mode: 'daily-at-utc' as const, hours: [12], minute: 0 },
      name: 'host-extra',
    };
    const loadDue = vi.fn((_now: Date) => [row]);
    const enqueueFire = vi.fn();
    const persistNextFire = vi.fn();

    const result = tickOnce(now, { loadDue, enqueueFire, persistNextFire });

    // Fired-only membership: the single due row advanced cleanly.
    expect(result).toEqual({ firedIds: ['row-1'], skippedIds: [] });

    // The batch load reads the tick's own `now`, exactly once.
    expect(loadDue).toHaveBeenCalledTimes(1);
    expect(loadDue).toHaveBeenCalledWith(now);

    // enqueueFire receives the FULL host row (the generic TRow pass-through) —
    // the extra `name` field survives untouched to the host's audit detail.
    expect(enqueueFire).toHaveBeenCalledTimes(1);
    expect(enqueueFire).toHaveBeenCalledWith(row);
    expect(enqueueFire.mock.calls[0]![0]).toHaveProperty('name', 'host-extra');

    // persistNextFire receives (id, nextDate, firedAt): the advance instant is
    // exactly 24h on (real computeNextFire), and firedAt IS the tick's `now`.
    expect(persistNextFire).toHaveBeenCalledTimes(1);
    const [id, nextDate, firedAt] = persistNextFire.mock.calls[0]!;
    expect(id).toBe('row-1');
    expect(nextDate).toBeInstanceOf(Date);
    expect((nextDate as Date).toISOString()).toBe('2026-05-25T12:00:00.000Z');
    expect(firedAt).toBe(now);
  });

  it('returns a plain object synchronously, not a Promise (REQ-07)', () => {
    const now = new Date('2026-05-24T12:00:00.500Z');
    const row: TickRow = {
      id: 'sync-1',
      mode: 'daily-at-utc',
      config: { mode: 'daily-at-utc', hours: [12], minute: 0 },
    };
    const deps: TickDeps = {
      loadDue: () => [row],
      enqueueFire: () => {},
      persistNextFire: () => {},
    };

    const result = tickOnce(now, deps);

    // A Promise-returning engine would force the hub tick + its suites async,
    // breaking the Phase 4 no-regression gate; the return is read synchronously.
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.firedIds).toEqual(['sync-1']);
    expect(result.skippedIds).toEqual([]);
  });
});

describe('tickOnce — enqueue-before-persist ordering (REQ-08)', () => {
  it('enqueues strictly before it persists for a firing row', () => {
    const now = new Date('2026-05-24T12:00:00.500Z');
    const calls: string[] = [];
    const row: TickRow = {
      id: 'row-1',
      mode: 'daily-at-utc',
      config: { mode: 'daily-at-utc', hours: [12], minute: 0 },
    };
    const deps: TickDeps = {
      loadDue: () => [row],
      enqueueFire: (r) => {
        calls.push('enqueue:' + r.id);
      },
      persistNextFire: (id) => {
        calls.push('persist:' + id);
      },
    };

    tickOnce(now, deps);

    // Persist-only-after-enqueue-success: the queue write lands before the
    // durable advance, so a crash between them re-fires (never silently skips).
    expect(calls).toEqual(['enqueue:row-1', 'persist:row-1']);
  });

  it('an enqueueFire throw leaves persist uncalled for that row while the tick continues', () => {
    const now = new Date('2026-05-24T12:00:00.500Z');
    const first: TickRow = {
      id: 'row-1',
      mode: 'daily-at-utc',
      config: { mode: 'daily-at-utc', hours: [12], minute: 0 },
    };
    const second: TickRow = {
      id: 'row-2',
      mode: 'daily-at-utc',
      config: { mode: 'daily-at-utc', hours: [12], minute: 0 },
    };
    const persistNextFire = vi.fn();
    const deps: TickDeps = {
      loadDue: () => [first, second],
      enqueueFire: vi.fn((r) => {
        if (r.id === 'row-1') throw new Error('queue down');
      }),
      persistNextFire,
      logError: vi.fn(),
    };

    const result = tickOnce(now, deps);

    // A firing failure leaves the row UN-ADVANCED: persist was never reached
    // for row-1, so it stays due and re-fires next tick (no lost fire).
    const persistedIds = persistNextFire.mock.calls.map((c) => c[0]);
    expect(persistedIds).not.toContain('row-1');
    expect(result.skippedIds).toContain('row-1');

    // Per-row isolation: the second row fires normally despite the first failing.
    expect(result.firedIds).toContain('row-2');
    expect(persistedIds).toContain('row-2');
  });
});

describe('tickOnce — fired-vs-skipped membership mapping (REQ-09)', () => {
  const now = new Date('2026-05-24T12:00:00.500Z');
  const dailyRow = (id: string): TickRow => ({
    id,
    mode: 'daily-at-utc',
    config: { mode: 'daily-at-utc', hours: [12], minute: 0 },
  });

  it('(a) both hooks succeed → id in firedIds only', () => {
    const deps: TickDeps = {
      loadDue: () => [dailyRow('ok-1')],
      enqueueFire: () => {},
      persistNextFire: () => {},
    };

    const result = tickOnce(now, deps);

    expect(result.firedIds).toEqual(['ok-1']);
    expect(result.skippedIds).not.toContain('ok-1');
  });

  it('(b) enqueueFire throws → id in skippedIds, never firedIds, persist uncalled', () => {
    const persistNextFire = vi.fn();
    const deps: TickDeps = {
      loadDue: () => [dailyRow('enq-fail')],
      enqueueFire: () => {
        throw new Error('enqueue exploded');
      },
      persistNextFire,
      logError: vi.fn(),
    };

    const result = tickOnce(now, deps);

    expect(result.skippedIds).toContain('enq-fail');
    expect(result.firedIds).not.toContain('enq-fail');
    expect(persistNextFire).not.toHaveBeenCalled();
  });

  it('(c) persistNextFire throws after a successful enqueue → id in skippedIds, never firedIds', () => {
    const enqueueFire = vi.fn();
    const deps: TickDeps = {
      loadDue: () => [dailyRow('persist-fail')],
      enqueueFire,
      persistNextFire: () => {
        throw new Error('disk full');
      },
      logError: vi.fn(),
    };

    const result = tickOnce(now, deps);

    // Fired-set membership requires BOTH hooks to succeed: an enqueued-but-
    // unpersisted row is skipped (it re-fires next tick), never fired.
    expect(enqueueFire).toHaveBeenCalledTimes(1);
    expect(result.skippedIds).toContain('persist-fail');
    expect(result.firedIds).not.toContain('persist-fail');
  });

  it('(d) spent one-time → skipped with both hooks uncalled and no logError (not an error)', () => {
    const enqueueFire = vi.fn();
    const persistNextFire = vi.fn();
    const logError = vi.fn();
    const spent: TickRow = {
      id: 'spent-1',
      mode: 'one-time',
      config: { mode: 'one-time', fireAt: '2026-05-24T12:00:00.000Z' },
    };
    const deps: TickDeps = {
      loadDue: () => [spent],
      enqueueFire,
      persistNextFire,
      logError,
    };

    // fireAt is at-or-before now → real computeNextFire yields null.
    const result = tickOnce(now, deps);

    // Spent one-time is skipped WITHOUT firing or advancing, and is NOT an
    // error — no enqueue, no persist, and crucially no logError for this row.
    expect(result.skippedIds).toContain('spent-1');
    expect(result.firedIds).not.toContain('spent-1');
    expect(enqueueFire).not.toHaveBeenCalled();
    expect(persistNextFire).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('(e) multi-row mixed tick → firedIds and skippedIds are disjoint and cover exactly the processed rows', () => {
    const rows: TickRow[] = [
      dailyRow('mix-fire'),
      {
        id: 'mix-spent',
        mode: 'one-time',
        config: { mode: 'one-time', fireAt: '2026-05-24T12:00:00.000Z' },
      },
      dailyRow('mix-enqfail'),
    ];
    const deps: TickDeps = {
      loadDue: () => rows,
      enqueueFire: (r) => {
        if (r.id === 'mix-enqfail') throw new Error('boom');
      },
      persistNextFire: () => {},
      logError: vi.fn(),
    };

    const result = tickOnce(now, deps);

    // Disjoint: no id appears in both sets.
    const overlap = result.firedIds.filter((id) =>
      result.skippedIds.includes(id),
    );
    expect(overlap).toEqual([]);

    // Cover exactly the processed rows: every loaded row landed in one set,
    // and nothing extra was invented.
    const covered = [...result.firedIds, ...result.skippedIds].sort();
    expect(covered).toEqual(['mix-enqfail', 'mix-fire', 'mix-spent']);

    // And the specific mapping: fire path fired; spent + enqueue-failure skipped.
    expect(result.firedIds).toEqual(['mix-fire']);
    expect(result.skippedIds).toEqual(['mix-spent', 'mix-enqfail']);
  });
});
