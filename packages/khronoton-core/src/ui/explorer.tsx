import type { CSSProperties, ReactNode } from "react";

/**
 * Build the chain-explorer deep link for a transaction request key.
 *
 * Pure and host-agnostic: the `base` is the consumer's `config.explorerBase`
 * knob (default `DEFAULT_EXPLORER_BASE`), and the key is percent-encoded so a
 * malformed key can never alter the URL's path structure.
 */
export function explorerUrl(base: string, requestKey: string): string {
  return `${base}/${encodeURIComponent(requestKey)}`;
}

export interface ExplorerLinkProps {
  /** The transaction request key to deep-link. */
  requestKey: string;
  /** The explorer base URL — comes from `config.explorerBase` at the consumer. */
  base: string;
  /** Extra classes merged onto the anchor. */
  className?: string;
}

const LINK_STYLE: CSSProperties = {
  color: "var(--khr-accent)",
  textDecoration: "none",
  whiteSpace: "nowrap",
};

/**
 * Presentational explorer affordance: an accent-colored new-tab link to the
 * chain explorer for a request key. `rel="noopener noreferrer"` keeps the
 * opener isolated from the untrusted external explorer page.
 */
export function ExplorerLink({ requestKey, base, className }: ExplorerLinkProps): ReactNode {
  return (
    <a
      href={explorerUrl(base, requestKey)}
      target="_blank"
      rel="noopener noreferrer"
      title="chain explorer"
      className={className}
      style={LINK_STYLE}
    >
      explorer ↗
    </a>
  );
}
