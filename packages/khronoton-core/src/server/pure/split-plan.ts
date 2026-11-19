/**
 * split-plan — the generic gas-probe-and-pack algorithm, ported faithfully
 * from OuroborosNetwork's OuronetUI (`src/lib/signing/measureSplit.ts`;
 * `evenSplit` from its `@ouronet/papyrus` dependency,
 * `node_modules/@ouronet/papyrus/dist/batch.js`). Full rationale in
 * `docs/work/khronoton-chained-runs-phase-4.1/design.md` §B.
 *
 * Given N items and a way to probe a candidate batch's real gas cost, this
 * produces the fewest batches that each fit under a ceiling, using at most
 * two cheap probes to SIZE the job (never probing the full selection, which
 * the real source's own comments document as the exact call a node times
 * out on) plus a small, strictly-bounded number of probes to CONFIRM and
 * then tighten the plan. No DB, no chain client, no I/O — pure and
 * dependency-free, following `run-advance.ts`/`capability.ts`'s convention
 * of keeping types local to the module that owns them.
 *
 * Deliberately NOT ported (per design.md §B): `onProgress` callbacks (UI
 * decoration) and the source's own "give up and submit one unmeasured
 * giant batch anyway" fallback — a failure here is a plain `{ok:false,
 * reason, ...}` return, never a thrown error and never a silently-accepted
 * oversized batch. The caller decides what to do with it.
 */

/** The size of the second sizing sample — large enough that the slope
 *  reading isn't swamped by measurement noise on the fixed cost, small
 *  enough that the probe is an ordinary, cheap batch. Clamped down to `n`
 *  when the selection is smaller, in which case this single probe also
 *  settles the whole question (see `measureSize`'s `fitsInOne` check). */
const SAMPLE_SIZE = 64;

/** Plan for this fraction of the ceiling when the model is still an
 *  EXTRAPOLATED two-point fit (probe(1), probe(<=64)) — the line carries
 *  real extrapolation error when stretched to a batch an order of
 *  magnitude larger, and a cheap margin is the fix. */
const PLANNING_MARGIN = 0.92;

/** How many times the confirmation probe may refuse before planFromSizing
 *  gives up on this capacity. */
const MAX_CONFIRMATIONS = 3;

/** Capacity shrink applied after each refused confirmation. A refusal
 *  carries no usable magnitude (execution halts AT the declared limit, so
 *  the reported floor UNDER-states the true cost) — shrinking by a
 *  constant factor rather than refitting is the honest response. */
const SHRINK = 0.75;

/** The margin applied ONCE the model has been refitted through a
 *  confirmed batch measured at the size actually being planned — a
 *  different, tighter margin for a different (anchored, not
 *  extrapolated) model. */
const CONFIRMED_MARGIN = 0.99;

/** How many times the plan may be refitted upward from a confirmed
 *  measurement. A growth probe that is refused, or comes back over
 *  ceiling, leaves the last confirmed plan standing — growth can never
 *  make the answer worse. */
const MAX_GROWTHS = 2;

export interface SplitModel {
  /** Gas a transaction costs before any item is processed. Clamped to >= 0. */
  fixed: number;
  /** Marginal gas per item. Clamped to > 0. */
  perItem: number;
}

/** What a probe of one candidate batch came back with. A refusal still
 *  carries information: `floor` is the gas the chain reported before
 *  stopping, a lower bound (never a total) on the true cost. */
export type ProbeOutcome = { ok: true; gas: number } | { ok: false; floor: number | null };

export type SplitSizing =
  | {
      ok: true;
      /** The whole selection fits in ONE transaction. MEASURED, not modelled. */
      fitsInOne: boolean;
      /** The measured gas of the whole selection — non-null only when `fitsInOne`. */
      measuredGas: number | null;
      /** `fixed + perItem * n`: what one transaction would cost. Modelled unless `fitsInOne`. */
      estimatedTotalGas: number;
      /** How many transactions a split is expected to need. Modelled; planning may differ. */
      estimatedTransactions: number;
      model: SplitModel;
      probes: number;
      /** Carried into `planFromSizing` so the two probes are not paid for twice. */
      readings: { one: { n: number; gas: number }; sample: { n: number; gas: number } };
    }
  | {
      ok: false;
      reason: string;
      /** Set when a SINGLE item already busts the ceiling — no split can fix that. */
      infeasible?: { singleItemGas: number; ceiling: number };
      estimatedTotalGas?: number;
      probes: number;
    };

export type SplitResult<T> =
  | {
      ok: true;
      /** In-selection-order slices; concatenating them reproduces the selection exactly. */
      batches: T[][];
      /** MEASURED gas of the largest batch in `batches` — not an estimate, not a total. */
      worstBatchGas: number;
      /** `fixed + perItem * n` for the whole selection — an ESTIMATE, labelled as one. */
      estimatedTotalGas: number;
      model: SplitModel;
      probes: number;
    }
  | {
      ok: false;
      reason: string;
      infeasible?: { singleItemGas: number; ceiling: number };
      estimatedTotalGas?: number;
      probes: number;
    };

/** Fit the exact line through two points, clamped to a physically meaningful model. */
export function lineThrough(
  a: { n: number; gas: number },
  b: { n: number; gas: number },
): SplitModel {
  if (a.n === b.n) {
    // No slope is determined by two readings at the same size. The only
    // honest reading left is a through-the-origin rate, which OVER-states
    // the marginal cost and so UNDER-states capacity — conservative in the
    // direction that cannot produce a refused transaction.
    return { fixed: 0, perItem: Math.max(a.gas / Math.max(a.n, 1), Number.MIN_VALUE) };
  }
  const slope = (b.gas - a.gas) / (b.n - a.n);
  if (!(slope > 0)) {
    // A non-positive slope is noise. The honest conservative reading of two
    // measurements that do not increase is the HIGHEST observed rate
    // through the origin: it over-states the marginal cost, so the plan
    // has more transactions than it needs, which costs signatures rather
    // than a refused transaction.
    const rate = Math.max(a.gas / Math.max(a.n, 1), b.gas / Math.max(b.n, 1));
    return { fixed: 0, perItem: Math.max(rate, Number.MIN_VALUE) };
  }
  const fixed = a.gas - slope * a.n;
  return { fixed: Math.max(0, fixed), perItem: slope };
}

/**
 * Items one transaction can carry under `ceiling`, per `model`, with a
 * safety margin. Pass `CONFIRMED_MARGIN` (0.99) when the model has been
 * refitted through a real measurement at the size being planned — see
 * that constant's own doc for why the two margins differ.
 */
export function capacityFor(model: SplitModel, ceiling: number, margin = PLANNING_MARGIN): number {
  const room = ceiling * margin - model.fixed;
  return room <= 0 ? 0 : Math.floor(room / model.perItem);
}

/**
 * Split `items` into `count` batches as EQUAL as possible — the first
 * `items.length % count` batches absorb one extra item each, never "full
 * chunks plus a near-empty remainder" (a near-empty last batch is one more
 * signature for almost nothing). Exact port of `@ouronet/papyrus`'s
 * `evenSplit` (`dist/batch.js`).
 */
export function evenSplit<T>(items: readonly T[], count: number): T[][] {
  const n = items.length;
  const batches = Math.max(1, Math.min(count, n || 1));
  if (n === 0) return [[]];
  const base = Math.floor(n / batches);
  const extra = n % batches; // the first `extra` batches absorb one extra item each
  const out: T[][] = [];
  let i = 0;
  for (let b = 0; b < batches; b++) {
    const size = base + (b < extra ? 1 : 0);
    out.push(items.slice(i, i + size));
    i += size;
  }
  return out;
}

/**
 * STAGE 1 — size the work. At most two probes, both bounded in size, never
 * the full selection: probe 1 item (fixed-cost reading), then probe
 * `min(n, SAMPLE_SIZE)` items (slope reading). `fitsInOne` is the one
 * claim here that is MEASURED rather than modelled: true only when the
 * sample call covered the whole selection and it came back under ceiling.
 */
export async function measureSize<T>(
  items: readonly T[],
  probe: (batch: readonly T[]) => Promise<ProbeOutcome>,
  ceiling: number,
): Promise<SplitSizing> {
  const n = items.length;
  let probes = 0;

  const run = async (batch: readonly T[]) => {
    probes++;
    return probe(batch);
  };

  if (n === 0) {
    return {
      ok: true,
      fitsInOne: true,
      measuredGas: 0,
      estimatedTotalGas: 0,
      estimatedTransactions: 1,
      model: { fixed: 0, perItem: 0 },
      probes: 0,
      readings: { one: { n: 0, gas: 0 }, sample: { n: 0, gas: 0 } },
    };
  }

  // 1] ONE ITEM — the fixed cost. Without this point the only line
  //    available passes through the origin, which charges every item a
  //    share of the per-transaction overhead and systematically
  //    under-splits. The single cheapest call the operation has.
  const one = await run(items.slice(0, 1));
  if (!one.ok) {
    return {
      ok: false,
      probes,
      reason:
        "a single item could not be simulated" +
        (one.floor != null ? ` (the chain stopped at ${one.floor.toLocaleString()} gas)` : "") +
        ".",
    };
  }
  if (one.gas > ceiling) {
    return {
      ok: false,
      probes,
      estimatedTotalGas: one.gas * n,
      infeasible: { singleItemGas: one.gas, ceiling },
      reason:
        `one item alone costs ${one.gas.toLocaleString()} gas, over the ` +
        `${ceiling.toLocaleString()} a transaction may use. No split can fix that — ` +
        `this operation needs a multi-step route.`,
    };
  }
  // A one-item selection is already answered — and it is a MEASUREMENT,
  // not a model.
  if (n === 1) {
    return {
      ok: true,
      fitsInOne: true,
      measuredGas: one.gas,
      estimatedTotalGas: one.gas,
      estimatedTransactions: 1,
      model: { fixed: 0, perItem: one.gas },
      probes,
      readings: { one: { n: 1, gas: one.gas }, sample: { n: 1, gas: one.gas } },
    };
  }

  // 2] A SAMPLE BATCH — the slope. Capped at SAMPLE_SIZE so this probe is
  //    always an ordinary batch, never the full selection.
  const sampleN = Math.min(n, SAMPLE_SIZE);
  const sample = await run(items.slice(0, sampleN));
  if (!sample.ok) {
    return {
      ok: false,
      probes,
      reason:
        `a ${sampleN}-item sample could not be simulated` +
        (sample.floor != null ? ` (the chain stopped at ${sample.floor.toLocaleString()} gas)` : "") +
        ". Try a smaller selection.",
    };
  }

  const model = lineThrough({ n: 1, gas: one.gas }, { n: sampleN, gas: sample.gas });
  const estimatedTotalGas = Math.round(model.fixed + model.perItem * n);
  const readings = { one: { n: 1, gas: one.gas }, sample: { n: sampleN, gas: sample.gas } };

  // THE WHOLE SELECTION ALREADY FITS, and the sample proves it when the
  // sample IS the selection.
  if (sampleN === n && sample.gas <= ceiling) {
    return {
      ok: true,
      fitsInOne: true,
      measuredGas: sample.gas,
      estimatedTotalGas,
      estimatedTransactions: 1,
      model,
      probes,
      readings,
    };
  }

  const capacity = capacityFor(model, ceiling);
  if (capacity < 1) {
    return {
      ok: false,
      probes,
      estimatedTotalGas,
      infeasible: { singleItemGas: one.gas, ceiling },
      reason:
        `the fixed cost of one transaction (about ` +
        `${Math.round(model.fixed).toLocaleString()} gas) leaves no room under the ` +
        `${ceiling.toLocaleString()} limit. This operation needs a multi-step route.`,
    };
  }

  return {
    ok: true,
    fitsInOne: false,
    measuredGas: null,
    estimatedTotalGas,
    estimatedTransactions: Math.max(1, Math.ceil(n / capacity)),
    model,
    probes,
    readings,
  };
}

/**
 * STAGE 2 — turn a sizing into a confirmed plan. Takes the sizing rather
 * than re-deriving it, so the two cheap probes `measureSize` already spent
 * are not paid for twice; `probes` continues from `sizing.probes`.
 */
export async function planFromSizing<T>(
  items: readonly T[],
  sizing: Extract<SplitSizing, { ok: true }>,
  probe: (batch: readonly T[]) => Promise<ProbeOutcome>,
  ceiling: number,
): Promise<SplitResult<T>> {
  const n = items.length;
  let probes = sizing.probes;
  const { model, estimatedTotalGas } = sizing;
  const one = sizing.readings.one;

  const run = async (batch: readonly T[]) => {
    probes++;
    return probe(batch);
  };

  let capacity = capacityFor(model, ceiling);
  if (capacity < 1) {
    return {
      ok: false,
      probes,
      estimatedTotalGas,
      infeasible: { singleItemGas: one.gas, ceiling },
      reason:
        `the fixed cost of one transaction (about ` +
        `${Math.round(model.fixed).toLocaleString()} gas) leaves no room under the ` +
        `${ceiling.toLocaleString()} limit. This operation needs a multi-step route.`,
    };
  }

  /** Cut the selection at a capacity and name the batch whose measurement describes the plan. */
  const planAt = (cap: number) => {
    const count = Math.max(1, Math.ceil(n / Math.max(1, cap)));
    const batches = evenSplit(items, count);
    const first = batches[0];
    if (first === undefined) return null;
    return { batches, largest: batches.reduce((a, b) => (b.length > a.length ? b : a), first) };
  };

  // CONFIRM THE PLAN ACTUALLY BEING RETURNED — the largest batch of the
  // exact split handed back, so `worstBatchGas` describes this plan, not a
  // nearby batch measured on the way.
  let best: { batches: T[][]; gas: number; size: number } | null = null;

  for (let attempt = 0; attempt < MAX_CONFIRMATIONS; attempt++) {
    const planned = planAt(capacity);
    if (!planned) {
      return { ok: false, probes, estimatedTotalGas, reason: "the split produced no batches." };
    }

    const got = await run(planned.largest);
    if (got.ok && got.gas <= ceiling) {
      best = { batches: planned.batches, gas: got.gas, size: planned.largest.length };
      break;
    }

    // Refused or over. The line under-estimated; shrink capacity and try
    // once more. A refusal carries no usable magnitude, which is why this
    // shrinks by a constant rather than refitting.
    const shrunk = Math.floor(capacity * SHRINK);
    if (shrunk < 1 || shrunk === capacity) break;
    capacity = shrunk;
  }

  if (!best) {
    return {
      ok: false,
      probes,
      estimatedTotalGas,
      reason:
        `could not confirm a batch size under ${ceiling.toLocaleString()} gas after ` +
        `${probes} simulation(s). Try a smaller selection.`,
    };
  }

  // PACK TIGHTER. The line from stage 1 is fitted at n=1 and n<=64 and
  // extrapolated to the operating size, which is why PLANNING_MARGIN
  // exists; stage 2 has just measured a real batch AT the planned size — a
  // point the fit never had, and the only point that actually matters.
  // Refitting through it replaces an extrapolation with an anchor, so the
  // margin can step aside for CONFIRMED_MARGIN. This can never make the
  // answer worse: `best` only ever advances on a confirmed measurement
  // under ceiling, so a refused or over-ceiling growth probe just breaks
  // the loop and leaves the previously confirmed plan exactly as it was.
  let fitted = model;
  for (let growth = 0; growth < MAX_GROWTHS; growth++) {
    fitted = lineThrough({ n: 1, gas: one.gas }, { n: best.size, gas: best.gas });
    const grown = capacityFor(fitted, ceiling, CONFIRMED_MARGIN);
    if (grown <= best.size) break;

    const planned = planAt(grown);
    // Fewer BATCHES is the only gain worth a probe. A larger capacity that
    // still rounds to the same transaction count buys nothing.
    if (!planned || planned.batches.length >= best.batches.length) break;

    const got = await run(planned.largest);
    if (!got.ok || got.gas > ceiling) break;
    best = { batches: planned.batches, gas: got.gas, size: planned.largest.length };
  }

  return {
    ok: true,
    batches: best.batches,
    worstBatchGas: best.gas,
    // Reported from the REFITTED line: it is anchored at the operating
    // size, so it is a better estimate of the whole job than the
    // small-sample line that produced the first plan.
    estimatedTotalGas: Math.round(fitted.fixed + fitted.perItem * n),
    model: fitted,
    probes,
  };
}

/**
 * Measure the selection and return the split, in one call — the ONE
 * function any planner in this codebase actually needs. `measureSize`/
 * `planFromSizing` stay exported separately only because the ported
 * source itself exports them separately (and splitting them keeps each
 * stage independently testable); the two-stage split exists in the
 * source only to let a human approve between sizing and planning, which
 * has no equivalent for a headless automaton here (design.md §B).
 *
 * Never throws for a probe failure — every failure path returns
 * `{ok: false, reason, ...}`. The caller decides what to do with it.
 */
export async function splitPlan<T>(
  items: readonly T[],
  probe: (batch: readonly T[]) => Promise<ProbeOutcome>,
  ceiling: number,
): Promise<SplitResult<T>> {
  const sizing = await measureSize(items, probe, ceiling);
  if (!sizing.ok) {
    return {
      ok: false,
      probes: sizing.probes,
      reason: sizing.reason,
      estimatedTotalGas: sizing.estimatedTotalGas,
      infeasible: sizing.infeasible,
    };
  }
  if (sizing.fitsInOne) {
    return {
      ok: true,
      batches: [[...items]],
      worstBatchGas: sizing.measuredGas ?? 0,
      estimatedTotalGas: sizing.estimatedTotalGas,
      model: sizing.model,
      probes: sizing.probes,
    };
  }
  return planFromSizing(items, sizing, probe, ceiling);
}
