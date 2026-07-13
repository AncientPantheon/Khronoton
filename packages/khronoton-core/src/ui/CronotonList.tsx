/**
 * `<CronotonList>` — the codex-cronoton LIST screen at Hub parity.
 *
 * A single-card table over `useCronotons()`: the three-tier "+ New" control, the
 * six parity columns (Name · Operation/Schedule · Next fire · Last fire · Status ·
 * Actions), the per-row Edit/Pause↔Resume/Execute-Now/Delete actions gated by the
 * shared `access.ts` disable rules, and the native confirm → gated mutation →
 * SSR-style refetch flow from `confirm-flows.ts`. No sort/filter/search/bulk/
 * refresh-button/toasts — the Hub had none (REQ-L09).
 *
 * Router-agnostic: the host resolves the viewer tier (the `access` prop) and
 * supplies navigation callbacks (`onOpen`/`onEdit`/`onNew`) instead of framework
 * `<Link>`s. Theming is inline `var(--khr-*)` only; the page assembly wraps this in
 * `<KhronotonUiRoot>` (this component renders no theming boundary of its own).
 *
 * ── The "Last fire" status ────────────────────────────────────────────────────
 * The Hub coloured the Last-fire cell from a per-row last-fire-status subquery. The
 * generic `CodexCronotonRow` does not carry that natively (the built-in store
 * projection omits it), so the cell reads an OPTIONAL `last_fire_status` a host read
 * may attach; absent ⇒ the "—" placeholder. See {@link CronotonListRow}.
 */
import type { CSSProperties, ReactNode } from "react";

import { useCronotons, useCronotonActions, useExecuteNow } from "../hooks/index.js";
import type { CodexCronotonRow } from "../server/types.js";
import type { ScheduleConfig } from "../schedule.js";
import { summariseSchedule } from "../schedule.js";
import { CronotonStatusBadge, FireStatusBadge, ServerResolverPill } from "./badges.js";
import type { FireStatus } from "./badges.js";
import { Card, Cell, LinkButton, Row, Table, TextButton, Thead } from "./primitives.js";
import {
  ADMIN_ONLY_TITLE,
  canMutate,
  deleteDisabled,
  executeDisabled,
  newCronotonTier,
  pauseResumeDisabled,
} from "./access.js";
import type { Access } from "./access.js";
import {
  deleteConfirm,
  deletePasswordConfirm,
  listExecuteConfirm,
  pauseResumeConfirm,
  withConfirm,
} from "./confirm-flows.js";
import { RelativeTime } from "./RelativeTime.js";

/** The default `robots` policy — the list is publicly readable but not indexable. */
export const DEFAULT_LIST_ROBOTS = "noindex,nofollow";

/**
 * A list row plus the optional last-fire status the host read may attach (the
 * generic {@link CodexCronotonRow} does not model it; see the module note).
 */
export type CronotonListRow = CodexCronotonRow & {
  last_fire_status?: FireStatus | null;
};

export interface CronotonListProps {
  /** The viewer tier (+ email) the host resolves; drives every disable rule. */
  access: Access;
  /** Open a cronoton's detail/observe screen (the Name link + logged-out view). */
  onOpen?: (id: string) => void;
  /** Navigate to a cronoton's edit screen (admin-only Edit action). */
  onEdit?: (id: string) => void;
  /** Navigate to the create builder (admin-only "+ New Codex Cronoton"). */
  onNew?: () => void;
  /** The page `robots` meta content (REQ-G07); defaults to noindex,nofollow. */
  robots?: string;
}

const DIM: CSSProperties = { color: "var(--khr-text-dim)" };
const MONO: CSSProperties = {
  fontFamily: "var(--khr-mono-font)",
  color: "var(--khr-mono)",
  fontSize: "12px",
};

const EM_DASH = <span style={DIM}>—</span>;

const PACT_PREVIEW_MAX = 60;

/** First-glance pact preview: whitespace-collapsed, capped at 60 chars, or "(empty)". */
function pactPreview(pactCode: string): string {
  const collapsed = pactCode.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "(empty)";
  return collapsed.length > PACT_PREVIEW_MAX
    ? `${collapsed.slice(0, PACT_PREVIEW_MAX)}…`
    : collapsed;
}

/** Trigger-only ⇒ the scheduler never auto-fires: it declares ≥1 runtime-arg key. */
function isTriggerOnly(row: CodexCronotonRow): boolean {
  const raw = row.runtime_arg_keys;
  if (!raw) return false;
  try {
    const keys = JSON.parse(raw) as unknown;
    return Array.isArray(keys) && keys.length > 0;
  } catch {
    return false;
  }
}

/** The human schedule summary via the shipped summariser (never re-implemented). */
function scheduleLine(row: CodexCronotonRow): string {
  try {
    const config = JSON.parse(row.schedule_config_json) as ScheduleConfig;
    return summariseSchedule(row.schedule_mode, config);
  } catch {
    return row.schedule_mode;
  }
}

/** The Last-fire cell: the ok/fail fire badge, or "—" when there is no last fire. */
function lastFireCell(row: CronotonListRow): ReactNode {
  if (!row.last_fire_at || !row.last_fire_status) return EM_DASH;
  return <FireStatusBadge status={row.last_fire_status} />;
}

/**
 * One list row. Each row owns its action hooks (a per-row component keeps the
 * hooks legal — never called in a loop) and shares the parent's `refetch` as the
 * SSR-style refresh every successful mutation triggers.
 */
function CronotonListRowView({
  row,
  access,
  onOpen,
  onEdit,
  refetch,
}: {
  row: CronotonListRow;
  access: Access;
  onOpen?: (id: string) => void;
  onEdit?: (id: string) => void;
  refetch: () => void;
}): ReactNode {
  const actions = useCronotonActions(row.id, { onSuccess: refetch });
  const execute = useExecuteNow();

  const working =
    actions.pause.pending ||
    actions.resume.pending ||
    actions.remove.pending ||
    execute.pending;

  const isPaused = row.status === "paused";
  const toggle = isPaused ? actions.resume : actions.pause;
  const toggleVerb = isPaused ? "resume" : "pause";
  const toggleLabel = isPaused ? "Resume" : "Pause";

  const del = deleteDisabled(access, row, { working });
  const pr = pauseResumeDisabled(access, row, { working });
  const ex = executeDisabled(access, row, { working, batchActive: false });

  const handleDelete = (): void => {
    void withConfirm(deleteConfirm(row.name), () =>
      withConfirm(deletePasswordConfirm(row.name), () => actions.remove.run()),
    );
  };
  const handleToggle = (): void => {
    void withConfirm(pauseResumeConfirm(toggleVerb), () => toggle.run());
  };
  const handleExecute = (): void => {
    void withConfirm(listExecuteConfirm(row.name), () => execute.run(row.id), {
      onSuccess: refetch,
    });
  };

  return (
    <Row>
      <Cell>
        <a
          onClick={() => onOpen?.(row.id)}
          style={{
            color: "var(--khr-accent)",
            fontWeight: 600,
            cursor: "pointer",
            textDecoration: "none",
          }}
        >
          {row.name}
        </a>
        <div
          style={{
            ...DIM,
            fontSize: "11px",
            marginTop: "3px",
            display: "flex",
            gap: "6px",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {row.description ? <span>{row.description}</span> : null}
          {row.server_resolver ? <ServerResolverPill /> : null}
        </div>
      </Cell>

      <Cell>
        <div style={MONO}>{pactPreview(row.pact_code)}</div>
        <div style={{ ...DIM, fontSize: "11px", marginTop: "3px" }}>
          {isTriggerOnly(row) ? "External trigger" : scheduleLine(row)}
        </div>
      </Cell>

      <Cell>{row.next_fire_at ? <RelativeTime iso={row.next_fire_at} /> : EM_DASH}</Cell>

      <Cell>{lastFireCell(row)}</Cell>

      <Cell>
        <CronotonStatusBadge status={row.status} />
      </Cell>

      <Cell>
        {access.tier === "logged-out" ? (
          <span style={{ ...DIM, fontSize: "11px" }}>view only</span>
        ) : (
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {canMutate(access) ? (
              <LinkButton onClick={() => onEdit?.(row.id)} style={{ cursor: "pointer" }}>
                Edit
              </LinkButton>
            ) : (
              <TextButton disabled title={ADMIN_ONLY_TITLE}>
                Edit
              </TextButton>
            )}
            <TextButton disabled={pr.disabled} title={pr.title} onClick={handleToggle}>
              {toggleLabel}
            </TextButton>
            <TextButton disabled={ex.disabled} title={ex.title} onClick={handleExecute}>
              Execute Now
            </TextButton>
            <TextButton disabled={del.disabled} title={del.title} onClick={handleDelete}>
              Delete
            </TextButton>
          </div>
        )}
      </Cell>
    </Row>
  );
}

const COLUMNS = ["Name", "Operation / Schedule", "Next fire", "Last fire", "Status", "Actions"];

export function CronotonList({
  access,
  onOpen,
  onEdit,
  onNew,
  robots = DEFAULT_LIST_ROBOTS,
}: CronotonListProps): ReactNode {
  const { cronotons, loading, error, refetch } = useCronotons();
  const rows = cronotons as CronotonListRow[];
  const newTier = newCronotonTier(access);
  const signedIn = access.tier !== "logged-out";

  return (
    <>
      <meta name="robots" content={robots} />

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "16px",
          flexWrap: "wrap",
        }}
      >
        <div>
          <p
            style={{
              color: "var(--khr-accent)",
              fontSize: "11px",
              textTransform: "uppercase",
              letterSpacing: "0.09em",
              margin: "0 0 6px",
            }}
          >
            Codex-signed scheduled transactions
          </p>
          <h1 style={{ margin: "0 0 6px", color: "var(--khr-text)", fontSize: "22px" }}>
            Codex Cronotons
          </h1>
          <p style={{ ...DIM, margin: 0, maxWidth: "62ch", fontSize: "13px" }}>
            Scheduled, codex-signed on-chain transactions. Edits apply at the next fire;
            one-time jobs are terminal once they run. Use Simulate as a pre-flight.
          </p>
        </div>
        {newTier.kind === "link" ? (
          <LinkButton
            onClick={onNew}
            style={{
              cursor: "pointer",
              color: "var(--khr-accent)",
              borderColor: "color-mix(in srgb, var(--khr-accent) 40%, transparent)",
              background: "var(--khr-accent-tint)",
            }}
          >
            + New Codex Cronoton
          </LinkButton>
        ) : newTier.kind === "disabled" ? (
          <TextButton disabled title={newTier.title}>
            + New Codex Cronoton
          </TextButton>
        ) : null}
      </div>

      <Card style={{ marginTop: "18px", overflow: "hidden" }}>
        <Table>
          <Thead>
            <Row>
              {COLUMNS.map((col) => (
                <Cell as="th" key={col}>
                  {col}
                </Cell>
              ))}
            </Row>
          </Thead>
          <tbody>
            {error ? (
              <Row>
                <Cell colSpan={COLUMNS.length} style={{ color: "var(--khr-error)" }}>
                  {error.message}
                </Cell>
              </Row>
            ) : !loading && rows.length === 0 ? (
              <Row>
                <Cell colSpan={COLUMNS.length} style={{ ...DIM, textAlign: "center", padding: "26px" }}>
                  No codex cronotons yet. Click “+ New Codex Cronoton” to create one.
                </Cell>
              </Row>
            ) : (
              rows.map((row) => (
                <CronotonListRowView
                  key={row.id}
                  row={row}
                  access={access}
                  onOpen={onOpen}
                  onEdit={onEdit}
                  refetch={refetch}
                />
              ))
            )}
          </tbody>
        </Table>
      </Card>

      <p style={{ ...DIM, marginTop: "14px", fontSize: "12px" }}>
        {signedIn ? (
          <>
            Signed in as{" "}
            <span style={{ fontFamily: "var(--khr-mono-font)", color: "var(--khr-mono)" }}>
              {access.email}
            </span>
            .
          </>
        ) : (
          "Public view — read only. Sign in as an Ancient admin to manage."
        )}
      </p>
    </>
  );
}
