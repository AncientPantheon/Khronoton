/**
 * Tx Size + Gas metering strip — the `subBar` rendered between the Pact editor's
 * header and its CodeMirror body (see `docs/work/khronoton-builder-pact-editor/
 * design.md`, Change 3). Two labeled rows:
 *
 *  - Tx Size: `estimateTxSize(state)`'s async byte estimate against the fixed
 *    2 MB Chainweb ceiling, recomputed on every relevant state change.
 *  - Gas: the shared `useSimulate()` result's `gasUsed` (hoisted to `Builder.tsx`
 *    so this meter and `ExecuteTab`'s own summary read the SAME simulate state,
 *    not two independent calls) against the configured gas limit.
 *
 * Pure props component — takes `state`/`sim` directly, calls no hook of its own
 * beyond its local `useEffect`/`useState` for the async size estimate.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import type { UseExecuteActionResult } from "../../hooks/index.js";
import type { SimulateEnvelope, SimulateView } from "../../provider/index.js";
import type { BuilderState } from "../builder-state.js";
import { estimateTxSize, PROXY_SOFT_LIMIT, type TxSizeEstimate } from "../tx-size.js";
import { formatThousands } from "./format.js";

export interface TxMetersProps {
  /** The whole builder form state — read-only here, drives the size estimate. */
  state: BuilderState;
  /** The shared `useSimulate()` result, hoisted to `Builder.tsx`. */
  sim: UseExecuteActionResult<[envelope: SimulateEnvelope], SimulateView>;
}

const WRAP_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  fontSize: "11px",
};

const LABEL_STYLE: CSSProperties = {
  color: "var(--khr-text-dim)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  minWidth: "46px",
};

const TRACK_STYLE: CSSProperties = {
  flex: 1,
  height: "6px",
  borderRadius: "999px",
  backgroundColor: "var(--khr-inset)",
  overflow: "hidden",
  display: "flex",
};

const VALUE_STYLE: CSSProperties = {
  fontFamily: "var(--khr-mono-font)",
  minWidth: "120px",
  textAlign: "right",
};

/** `< 1024` → bytes, `< 1024*1024` → KB (2dp), else MB (3dp). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${(n / 1024 / 1024).toFixed(3)} MB`;
}


export function TxMeters({ state, sim }: TxMetersProps): ReactNode {
  const [estimate, setEstimate] = useState<TxSizeEstimate | null>(null);

  // Recompute the size estimate on every relevant state change. Guarded with the
  // same `active`-flag idiom Builder.tsx's own signers-fetch effect uses, so a
  // stale resolve from a superseded run can never clobber a newer one's result.
  useEffect(() => {
    let active = true;
    void (async () => {
      const next = await estimateTxSize(state);
      if (active) setEstimate(next);
    })();
    return () => {
      active = false;
    };
    // `state.payload` (object reference), not `JSON.stringify(state.payload)`:
    // every tab's onChange other than Payload's spreads `...state` and patches
    // only its own slice (see Builder.tsx's own "onChange contract per tab"
    // docblock), so the payload object keeps its identity across unrelated
    // edits — depending on the reference avoids re-stringifying a
    // possibly-non-trivial payload body on every keystroke in Config/Gas
    // Payer/Signatures/Schedule, while still firing whenever Payload actually
    // replaces it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.pactCode,
    state.config.chainId,
    state.config.gasLimit,
    state.config.gasPriceAnu,
    state.config.ttl,
    state.payload,
    state.signers.length,
    state.gasPayer,
  ]);

  const sizeTier: "error" | "amber" | "ok" | "pending" = !estimate
    ? "pending"
    : estimate.over
      ? "error"
      : estimate.bytes > PROXY_SOFT_LIMIT
        ? "amber"
        : "ok";

  const sizeColor =
    sizeTier === "error"
      ? "var(--khr-error)"
      : sizeTier === "amber"
        ? "var(--khr-amber)"
        : sizeTier === "ok"
          ? "var(--khr-success)"
          : "var(--khr-text-dim)";

  const sizeValue = estimate
    ? `${formatBytes(estimate.bytes)} · ${estimate.permille.toFixed(4)} ‰${estimate.over ? " ⚠" : ""}`
    : "…";

  const used = sim.result?.gasUsed;
  const limit = state.config.gasLimit;
  // `sim.result?.ok` isn't checked by the bundled server's own responses
  // today (a failed simulate never sets `gasUsed`), but `SimulateView` is a
  // plain interface, not a discriminated union — nothing stops a third-party
  // `KhronotonAdapter` from returning `{ ok: false, gasUsed: N }`. Gating on
  // `ok` too matches ExecuteTab.tsx's own discipline for the same `sim`
  // result, so this meter can't render a "successful" bar for a failed
  // simulate.
  const hasSim = sim.result?.ok === true && typeof used === "number" && limit > 0;
  const overLimit = hasSim && (used as number) > limit;
  const usedFraction = hasSim ? Math.min(((used as number) / limit) * 100, 100) : 0;

  const gasValue = hasSim
    ? overLimit
      ? `${formatThousands(used as number)} > ${formatThousands(limit)} ⚠`
      : `${formatThousands(used as number)} / ${formatThousands(limit)}`
    : "Run Simulate";

  return (
    <div style={WRAP_STYLE}>
      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>Tx Size</span>
        <div style={TRACK_STYLE}>
          <div
            style={{
              width: estimate ? `${Math.min(estimate.fraction * 100, 100)}%` : "0%",
              backgroundColor: sizeColor,
            }}
          />
        </div>
        <span style={{ ...VALUE_STYLE, color: sizeColor }}>{sizeValue}</span>
      </div>

      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>Gas</span>
        <div style={TRACK_STYLE}>
          {hasSim ? (
            overLimit ? (
              <div style={{ width: "100%", backgroundColor: "var(--khr-error)" }} />
            ) : (
              <>
                <div style={{ width: `${usedFraction}%`, backgroundColor: "var(--khr-amber)" }} />
                <div
                  style={{ width: `${100 - usedFraction}%`, backgroundColor: "var(--khr-error)" }}
                />
              </>
            )
          ) : null}
        </div>
        <span
          style={{ ...VALUE_STYLE, color: hasSim ? "var(--khr-text)" : "var(--khr-text-dim)" }}
        >
          {gasValue}
        </span>
      </div>
    </div>
  );
}
