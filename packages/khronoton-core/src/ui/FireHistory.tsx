/**
 * `<FireHistory>` — the detail-screen fire-history card (parity inventory §2).
 *
 * Renders "Fire history ({total})" from `useCronotonFires(id)` (poller #1 lives
 * inside that hook) with the eight-column table the Hub inlines in `[id].tsx`,
 * genericized: Fired at · Mode (gated by `config.showMode`, REQ-G03) · Status ·
 * Request key / error (the pluggable `FireTxCell` seam, REQ-D08) · Result (a
 * hover tooltip over the pretty-printed chain response, REQ-D11) · Chain ·
 * Definition drift (REQ-D07) · Explorer deep link (REQ-D10). The 50-per-page
 * pager reads `page`/`pageCount`/`setPage` from the hook (REQ-D09), and the
 * previously UI-less recover affordance (REQ-G09) is wired here behind
 * `useRecoverFire` for an admin viewer.
 *
 * Theming is inline `var(--khr-*)` only (REQ-T02). This component owns no data
 * fetching or paging math — it reads the hook + `useKhronoton().config` and
 * renders; the auth tier arrives as the `access` prop (the provider carries no
 * role seam).
 */
import type { CSSProperties, ReactNode } from "react";

import { useCronotonFires, useRecoverFire, useKhronoton } from "../hooks/index.js";
import type { CodexCronotonFireRow } from "../server/index.js";
import { FireStatusBadge, ModeChip } from "./badges.js";
import { RelativeTime } from "./RelativeTime.js";
import { ExplorerLink } from "./explorer.js";
import { FireTxCell } from "./multi-tx.js";
import { Card, Table, Thead, Row, Cell, TextButton } from "./primitives.js";
import type { Access } from "./access.js";

const DIM: CSSProperties = { color: "var(--khr-text-dim)" };

/** Pretty-print a chain response for the Result tooltip: strings pass through,
 *  everything else is 2-space-indented JSON. Empty/absent responses yield "". */
function prettyChainResponse(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** The "Request key / error" cell: a nothing-fire shows the skip label, every
 *  other fire routes through the pluggable multi-tx seam (else the single-tx
 *  default). An admin gets the recover control on a failed fire. */
function TxCell({
  fire,
  base,
  renderMultiTx,
  canRecover,
  onRecover,
  recovering,
}: {
  fire: CodexCronotonFireRow;
  base: string;
  renderMultiTx?: (fire: CodexCronotonFireRow) => ReactNode;
  canRecover: boolean;
  onRecover: (fire: CodexCronotonFireRow) => void;
  recovering: boolean;
}): ReactNode {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
      {fire.status === "nothing" ? (
        <span style={{ color: "var(--khr-nothing)" }}>Nothing to pay</span>
      ) : (
        <FireTxCell fire={fire} base={base} renderMultiTx={renderMultiTx} />
      )}
      {canRecover && fire.status === "failure" ? (
        <TextButton
          onClick={() => onRecover(fire)}
          disabled={recovering}
          style={{ fontSize: "11px", padding: "2px 8px" }}
        >
          recover
        </TextButton>
      ) : null}
    </span>
  );
}

/** The Result cell: a gold dotted "result" affordance whose native tooltip holds
 *  the pretty chain response, or an em dash when the fire recorded none. */
function ResultCell({ fire }: { fire: CodexCronotonFireRow }): ReactNode {
  const pretty = prettyChainResponse(fire.chainResponse);
  if (!pretty) return <span style={DIM}>—</span>;
  return (
    <span
      title={pretty}
      style={{
        color: "var(--khr-accent)",
        borderBottom: "1px dotted var(--khr-accent)",
        cursor: "help",
      }}
    >
      result
    </span>
  );
}

/** The Definition-drift cell: quiet "·" when the fire matches the newest
 *  fingerprint on this page, amber "⚠ {fp8}" when it ran under an older one,
 *  and an em dash when the fire carries no fingerprint. */
function DriftCell({
  fingerprint,
  newest,
}: {
  fingerprint: string | null;
  newest: string | null;
}): ReactNode {
  if (!fingerprint) return <span style={DIM}>—</span>;
  if (fingerprint === newest) {
    return <span title="Definition matches the newest fingerprint on this page" style={DIM}>·</span>;
  }
  return (
    <span
      title={`Definition drift — this fire ran under an older definition (${fingerprint})`}
      style={{ color: "var(--khr-amber)" }}
    >
      ⚠ {fingerprint.slice(0, 8)}
    </span>
  );
}

const HEADING_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  margin: "0 0 12px",
  fontSize: "13px",
  color: "var(--khr-text)",
};

const PAGER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: "10px",
  padding: "10px 12px",
  borderTop: "1px solid var(--khr-border)",
  fontSize: "12px",
};

export interface FireHistoryProps {
  /** The cronoton whose fire history to render. */
  id: string;
  /** The viewer tier — the recover affordance is admin-only (REQ-G09). */
  access: Access;
  /** Injectable request-key prompt (defaults to `window.prompt`), used by recover. */
  promptRequestKey?: (fire: CodexCronotonFireRow) => string | null;
}

export function FireHistory({ id, access, promptRequestKey }: FireHistoryProps): ReactNode {
  const { config } = useKhronoton();
  const { fires, total, page, pageCount, setPage, refetch } = useCronotonFires(id);
  const recover = useRecoverFire();

  const showMode = config.showMode;
  const canRecover = access.tier === "admin";
  const newestFingerprint = fires[0]?.definitionFingerprint ?? null;
  const columnCount = showMode ? 8 : 7;

  const askKey =
    promptRequestKey ??
    ((fire: CodexCronotonFireRow) =>
      typeof window !== "undefined"
        ? window.prompt("Enter the request key to recover this fire.", fire.requestKey ?? "")
        : null);

  async function handleRecover(fire: CodexCronotonFireRow): Promise<void> {
    const key = askKey(fire)?.trim();
    if (!key) return;
    const result = await recover.run(id, fire.id, key);
    if (result?.ok) refetch();
  }

  const pageSize = config.pageSize;
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = page * pageSize + fires.length;

  return (
    <section>
      <h3 style={HEADING_STYLE}>
        <span>Fire history ({total})</span>
        {showMode ? (
          <span style={{ display: "inline-flex", gap: "6px" }} aria-label="mode legend">
            <ModeChip mode="live" />
            <ModeChip mode="test" />
          </span>
        ) : null}
      </h3>

      {total === 0 ? (
        <Card style={{ padding: "18px", fontSize: "13px", ...DIM }}>No fires yet.</Card>
      ) : (
        <Card style={{ overflow: "hidden" }}>
          <Table>
            <Thead>
              <Row>
                <Cell as="th">Fired at</Cell>
                {showMode ? <Cell as="th">Mode</Cell> : null}
                <Cell as="th">Status</Cell>
                <Cell as="th">Request key / error</Cell>
                <Cell as="th">Result</Cell>
                <Cell as="th">Chain</Cell>
                <Cell as="th">Definition</Cell>
                <Cell as="th">Explorer</Cell>
              </Row>
            </Thead>
            <tbody>
              {fires.map((fire) => (
                <Row key={fire.id}>
                  <Cell>
                    <RelativeTime iso={fire.firedAt} />
                  </Cell>
                  {showMode ? (
                    <Cell>
                      <ModeChip mode={fire.mode} />
                    </Cell>
                  ) : null}
                  <Cell>
                    <FireStatusBadge status={fire.status} />
                  </Cell>
                  <Cell>
                    <TxCell
                      fire={fire}
                      base={config.explorerBase}
                      renderMultiTx={config.renderMultiTx}
                      canRecover={canRecover}
                      onRecover={handleRecover}
                      recovering={recover.pending}
                    />
                  </Cell>
                  <Cell style={{ overflow: "visible" }}>
                    <ResultCell fire={fire} />
                  </Cell>
                  <Cell style={{ fontFamily: "var(--khr-mono-font)" }}>{fire.chainId ?? "—"}</Cell>
                  <Cell>
                    <DriftCell fingerprint={fire.definitionFingerprint} newest={newestFingerprint} />
                  </Cell>
                  <Cell>
                    {fire.status === "success" && fire.requestKey ? (
                      <ExplorerLink requestKey={fire.requestKey} base={config.explorerBase} />
                    ) : (
                      <span style={DIM}>—</span>
                    )}
                  </Cell>
                </Row>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={columnCount} style={{ padding: 0 }}>
                  <div style={PAGER_STYLE}>
                    <span style={DIM}>
                      Showing {from}–{to} of {total} fires · {pageSize} per page
                    </span>
                    {pageCount > 1 ? (
                      <span style={{ display: "inline-flex", gap: "4px", flexWrap: "wrap" }}>
                        <TextButton
                          disabled={page === 0}
                          onClick={() => setPage(0)}
                          style={{ fontSize: "11px", padding: "3px 8px" }}
                        >
                          « First
                        </TextButton>
                        <TextButton
                          disabled={page === 0}
                          onClick={() => setPage(page - 1)}
                          style={{ fontSize: "11px", padding: "3px 8px" }}
                        >
                          ‹ Prev
                        </TextButton>
                        {Array.from({ length: pageCount }, (_, i) => (
                          <TextButton
                            key={i}
                            onClick={() => setPage(i)}
                            aria-current={i === page ? "page" : undefined}
                            style={{
                              fontSize: "11px",
                              padding: "3px 9px",
                              ...(i === page
                                ? { color: "var(--khr-accent)", borderColor: "var(--khr-accent)" }
                                : null),
                            }}
                          >
                            {i + 1}
                          </TextButton>
                        ))}
                        <TextButton
                          disabled={page >= pageCount - 1}
                          onClick={() => setPage(page + 1)}
                          style={{ fontSize: "11px", padding: "3px 8px" }}
                        >
                          Next ›
                        </TextButton>
                        <TextButton
                          disabled={page >= pageCount - 1}
                          onClick={() => setPage(pageCount - 1)}
                          style={{ fontSize: "11px", padding: "3px 8px" }}
                        >
                          Last »
                        </TextButton>
                      </span>
                    ) : null}
                  </div>
                </td>
              </tr>
            </tfoot>
          </Table>
        </Card>
      )}
    </section>
  );
}
