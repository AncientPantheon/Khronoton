import type { CSSProperties, ReactNode } from "react";

import type { CodexCronotonFireRow } from "../server/index.js";
import type { RenderMultiTx } from "../provider/context.js";
import { explorerUrl } from "./explorer.js";

/**
 * Whether a fire should route through a multi-tx breakdown renderer.
 *
 * An ordinary single-tx fire has no tx keys; a lone `bulk` transfer is still
 * the single-tx shape. Only a non-bulk step (a `burn` or `continuation`, i.e.
 * the cross-chain legs of a pool payout) marks a fire as multi-tx — the case a
 * host-supplied `renderMultiTx` exists to expand.
 */
export function isMultiTx(fire: CodexCronotonFireRow): boolean {
  return fire.txKeys.some((key) => key.kind !== "bulk");
}

export interface StepKeyLinkProps {
  /** The request key for this transaction step. */
  requestKey: string;
  /** Explorer base URL from `config.explorerBase`. */
  base: string;
  /** Extra classes merged onto the anchor. */
  className?: string;
}

const STEP_LINK_STYLE: CSSProperties = {
  color: "var(--khr-mono)",
  fontFamily: "var(--khr-mono-font)",
  fontSize: "0.85em",
  textDecoration: "none",
  display: "inline-block",
  maxWidth: "22ch",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  verticalAlign: "bottom",
};

/**
 * A single transaction step rendered as a mono request-key link to the chain
 * explorer. Shared atom reused by the default single-tx cell and by any
 * consumer-supplied `renderMultiTx` breakdown (e.g. the Hub's per-step links).
 */
export function StepKeyLink({ requestKey, base, className }: StepKeyLinkProps): ReactNode {
  return (
    <a
      href={explorerUrl(base, requestKey)}
      target="_blank"
      rel="noopener noreferrer"
      title={requestKey}
      className={className}
      style={STEP_LINK_STYLE}
    >
      {requestKey}
    </a>
  );
}

export interface DefaultSingleTxProps {
  fire: CodexCronotonFireRow;
  /** Explorer base URL from `config.explorerBase`. */
  base: string;
}

/**
 * The DEFAULT tx-cell renderer used whenever no `config.renderMultiTx` is
 * registered — the ordinary single-tx display: the request key as an explorer
 * step link, the error message for a failed fire, else an em dash. Carries NO
 * pool-payout / N-of-18 breakdown; that lives only in a consumer's renderer.
 */
export function DefaultSingleTx({ fire, base }: DefaultSingleTxProps): ReactNode {
  if (fire.errorMessage) {
    return <span style={{ color: "var(--khr-error)" }}>{fire.errorMessage}</span>;
  }
  if (fire.requestKey) {
    return <StepKeyLink requestKey={fire.requestKey} base={base} />;
  }
  return <span style={{ color: "var(--khr-text-dim)" }}>—</span>;
}

export interface FireTxCellProps {
  fire: CodexCronotonFireRow;
  /** Explorer base URL from `config.explorerBase`. */
  base: string;
  /** Optional host-supplied breakdown for multi-tx fires (`config.renderMultiTx`). */
  renderMultiTx?: RenderMultiTx;
}

/**
 * The fire-history "Request key / error" cell. Delegates to a host-supplied
 * `renderMultiTx` only when one is registered AND the fire is multi-tx shaped;
 * otherwise it renders the generic single-tx default. This is the pluggable
 * seam (REQ-D08/G04) — the package ships the default, the host ships the
 * breakdown.
 */
export function FireTxCell({ fire, base, renderMultiTx }: FireTxCellProps): ReactNode {
  if (renderMultiTx && isMultiTx(fire)) {
    return <>{renderMultiTx(fire)}</>;
  }
  return <DefaultSingleTx fire={fire} base={base} />;
}
