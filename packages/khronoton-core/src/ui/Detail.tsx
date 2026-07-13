/**
 * `<Detail>` — the codex-cronoton DETAIL / OBSERVE screen at Hub parity.
 *
 * A single-cronoton observe page over `useCronoton(id)` (SSR-style: no spinner —
 * the tree renders once the row is loaded, an error/absent panel otherwise). It
 * ASSEMBLES the already-built, self-contained pieces rather than re-implementing
 * them: the status/provenance badges, the two-column metadata grid, and the three
 * observe cards — `<ManualBatchCard>`, `<RuntimeArgTriggerCard>`, `<FireHistory>`
 * — each of which self-gates to `null` for the tiers/states it does not apply to.
 *
 * Header actions (Edit · Pause↔Resume · Execute Now · Delete) reuse the shared
 * `access.ts` disable predicates and the `confirm-flows.ts` native-confirm →
 * gated-mutation → SSR-refresh flow — the exact idioms `<CronotonList>` uses. Two
 * detail-specific twists: a successful delete NAVIGATES back to the list (there is
 * no row to refetch), and Execute Now is additionally blocked while a manual batch
 * runs — the batch card reports its active state up through `onExecuteBlockedChange`
 * and that feeds `executeDisabled`, so only one fire path runs at a time.
 *
 * Router-agnostic: the host resolves the viewer tier (`access`) and supplies the
 * navigation callbacks (`onBack`/`onEdit`/`onNavigateToList`). Theming is inline
 * `var(--khr-*)` only; the page assembly wraps this in `<KhronotonUiRoot>`.
 */
import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { useCronoton, useCronotonActions, useExecuteNow } from "../hooks/index.js";
import type { CodexCronotonRow } from "../server/types.js";
import type { ScheduleConfig } from "../schedule.js";
import { summariseSchedule } from "../schedule.js";
import { parseRuntimeArgKeys } from "../server/pure/runtime-args.js";
import { CronotonStatusBadge, ExternallyFireablePill, ServerResolverPill } from "./badges.js";
import { Card, LinkButton, MetaCell, TextButton } from "./primitives.js";
import {
  ADMIN_ONLY_TITLE,
  canMutate,
  deleteDisabled,
  executeDisabled,
  pauseResumeDisabled,
} from "./access.js";
import type { Access } from "./access.js";
import {
  deleteConfirm,
  deletePasswordConfirm,
  detailExecuteConfirm,
  pauseResumeConfirm,
  withConfirm,
} from "./confirm-flows.js";
import { RelativeTime } from "./RelativeTime.js";
import { ManualBatchCard } from "./ManualBatchCard.js";
import { RuntimeArgTriggerCard } from "./RuntimeArgTriggerCard.js";
import { FireHistory } from "./FireHistory.js";

/** The default `robots` policy — the detail page is readable but not indexable. */
export const DEFAULT_DETAIL_ROBOTS = "noindex,nofollow";

/** Terminal one-time states: a spent cronoton can no longer be batch-fired/triggered. */
const TERMINAL_STATUSES: ReadonlySet<CodexCronotonRow["status"]> = new Set(["completed", "error"]);

const DIM: CSSProperties = { color: "var(--khr-text-dim)" };
const MONO: CSSProperties = { fontFamily: "var(--khr-mono-font)", color: "var(--khr-mono)" };

const EM_DASH = <span style={DIM}>—</span>;

export interface DetailProps {
  /** The cronoton to observe. */
  id: string;
  /** The viewer tier (+ email) the host resolves; drives every disable rule. */
  access: Access;
  /** Return to the list screen (the back link). */
  onBack?: () => void;
  /** Navigate to this cronoton's edit screen (admin-only Edit action). */
  onEdit?: (id: string) => void;
  /** Navigate back to the list after a successful delete (the row is gone). */
  onNavigateToList?: () => void;
  /** The page `robots` meta content; defaults to noindex,nofollow. */
  robots?: string;
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

/** An instant cell: the raw ISO plus the self-refreshing relative label, or "—". */
function InstantCell({ iso }: { iso: string | null }): ReactNode {
  if (!iso) return EM_DASH;
  return (
    <span style={{ display: "inline-flex", gap: "8px", alignItems: "baseline", flexWrap: "wrap" }}>
      <span style={{ ...MONO, fontSize: "12px" }}>{iso}</span>
      <RelativeTime iso={iso} />
    </span>
  );
}

const EYEBROW_STYLE: CSSProperties = {
  color: "var(--khr-accent)",
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.09em",
  margin: "0 0 6px",
};

const GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: "14px",
};

export function Detail({
  id,
  access,
  onBack,
  onEdit,
  onNavigateToList,
  robots = DEFAULT_DETAIL_ROBOTS,
}: DetailProps): ReactNode {
  const { cronoton, loading, error, refetch } = useCronoton(id);
  const actions = useCronotonActions(id);
  const execute = useExecuteNow();
  const [batchActive, setBatchActive] = useState(false);

  const backLink = (
    <a
      onClick={() => onBack?.()}
      style={{ color: "var(--khr-accent)", cursor: "pointer", fontSize: "12px", textDecoration: "none" }}
    >
      ← Codex Cronotons
    </a>
  );

  let body: ReactNode = null;
  if (error) {
    body = (
      <Card style={{ marginTop: "18px", padding: "22px", color: "var(--khr-error)" }}>
        {error.message}
      </Card>
    );
  } else if (!cronoton && !loading) {
    body = (
      <Card style={{ marginTop: "18px", padding: "22px", ...DIM }}>
        This codex cronoton could not be found.
      </Card>
    );
  } else if (cronoton) {
    body = <Loaded
      cronoton={cronoton}
      access={access}
      actions={actions}
      execute={execute}
      refetch={refetch}
      batchActive={batchActive}
      setBatchActive={setBatchActive}
      onEdit={onEdit}
      onNavigateToList={onNavigateToList}
    />;
  }

  return (
    <>
      <meta name="robots" content={robots} />
      {backLink}
      {body}
    </>
  );
}

/**
 * The loaded observe tree. Split from {@link Detail} so the row is a non-null prop
 * (the action hooks stay at the parent level — they never sit behind an early
 * return — while the render logic reads a guaranteed row).
 */
function Loaded({
  cronoton,
  access,
  actions,
  execute,
  refetch,
  batchActive,
  setBatchActive,
  onEdit,
  onNavigateToList,
}: {
  cronoton: CodexCronotonRow;
  access: Access;
  actions: ReturnType<typeof useCronotonActions>;
  execute: ReturnType<typeof useExecuteNow>;
  refetch: () => void;
  batchActive: boolean;
  setBatchActive: (active: boolean) => void;
  onEdit?: (id: string) => void;
  onNavigateToList?: () => void;
}): ReactNode {
  const row = cronoton;
  const name = row.name;
  const terminal = TERMINAL_STATUSES.has(row.status);
  const runtimeArgKeys = parseRuntimeArgKeys(row.runtime_arg_keys);
  const triggerOnly = runtimeArgKeys.length > 0;

  const working =
    actions.pause.pending || actions.resume.pending || actions.remove.pending || execute.pending;

  const isPaused = row.status === "paused";
  const toggle = isPaused ? actions.resume : actions.pause;
  const toggleVerb = isPaused ? "resume" : "pause";
  const toggleLabel = isPaused ? "Resume" : "Pause";

  const del = deleteDisabled(access, row, { working });
  const pr = pauseResumeDisabled(access, row, { working });
  const ex = executeDisabled(access, row, { working, batchActive });

  const handleDelete = (): void => {
    // The inner (password) step owns the failure alert + the navigate-on-success;
    // the outer confirm must NOT re-inspect that inner result, or a failed delete
    // would surface the SAME alert twice. A no-op alert on the outer silences it.
    void withConfirm(
      deleteConfirm(name),
      () =>
        withConfirm(deletePasswordConfirm(name), () => actions.remove.run(), {
          onSuccess: onNavigateToList,
        }),
      { alert: () => {} },
    );
  };
  const handleToggle = (): void => {
    void withConfirm(pauseResumeConfirm(toggleVerb), () => toggle.run(), { onSuccess: refetch });
  };
  const handleExecute = async (): Promise<void> => {
    // Execute-tier hooks never throw: `run` resolves the fire body, or `undefined`
    // on a transport throw / a declined confirm. `withConfirm` can't distinguish
    // those, so we branch on the returned view ourselves rather than lean on its
    // ActionFail detection (which execute-tier hooks never produce). A returned
    // body means the server ran it and recorded a fire → refresh the history; an
    // `undefined` means nothing was recorded → no spurious refetch. The failure
    // itself is surfaced inline below via `execute.error` / `execute.result`.
    const view = await withConfirm(detailExecuteConfirm(name), () => execute.run(row.id));
    if (view !== undefined) refetch();
  };

  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "16px",
          flexWrap: "wrap",
          marginTop: "14px",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <p style={EYEBROW_STYLE}>Codex cronoton detail</p>
          <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
            <h1 style={{ margin: 0, color: "var(--khr-text)", fontSize: "22px" }}>{name}</h1>
            {row.server_resolver ? <ServerResolverPill /> : null}
            {row.external_fireable ? <ExternallyFireablePill /> : null}
          </div>
          {row.description ? (
            <p style={{ ...DIM, margin: "8px 0 0", maxWidth: "62ch", fontSize: "13px" }}>
              {row.description}
            </p>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {access.tier === "logged-out" ? (
            <span style={{ ...DIM, fontSize: "11px" }}>view only</span>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>

      {/* Execute-Now outcome — the fire tier never throws to the confirm layer, so
          its result/error is surfaced here rather than via an alert (a transport
          failure or a 200-on-`ok:false` fire is otherwise silent). */}
      {execute.error || execute.result ? (
        <p
          data-testid="execute-status"
          style={{
            margin: "10px 0 0",
            fontSize: "12px",
            color: execute.result && execute.result.ok ? "var(--khr-success)" : "var(--khr-error)",
          }}
        >
          {execute.error
            ? execute.error.message
            : execute.result && execute.result.ok
              ? `Fired · requestKey ${execute.result.requestKey ?? "—"}`
              : (execute.result?.error ?? "Execute failed.")}
        </p>
      ) : null}

      <Card style={{ marginTop: "18px", padding: "16px" }}>
        <div style={GRID_STYLE}>
          <MetaCell label="Schedule">
            {triggerOnly ? "Trigger-only — no schedule" : scheduleLine(row)}
          </MetaCell>
          <MetaCell label="Status">
            <CronotonStatusBadge status={row.status} />
          </MetaCell>
          <MetaCell label="Next fire">
            <InstantCell iso={row.next_fire_at} />
          </MetaCell>
          <MetaCell label="Last fire">
            <InstantCell iso={row.last_fire_at} />
          </MetaCell>
          <MetaCell label="Created by">
            <span style={MONO}>{row.created_by}</span>
          </MetaCell>
          <MetaCell label="Created at">
            <span style={{ ...MONO, fontSize: "12px" }}>{row.created_at}</span>
          </MetaCell>
        </div>
      </Card>

      <div style={{ marginTop: "20px" }}>
        <ManualBatchCard
          id={row.id}
          name={name}
          access={access}
          terminal={terminal}
          onExecuteBlockedChange={setBatchActive}
        />
      </div>

      <div style={{ marginTop: "20px" }}>
        <RuntimeArgTriggerCard
          id={row.id}
          name={name}
          status={row.status}
          runtimeArgKeys={runtimeArgKeys}
          access={access}
          terminal={terminal}
          onFired={refetch}
        />
      </div>

      <div style={{ marginTop: "24px" }}>
        <FireHistory id={row.id} access={access} />
      </div>
    </>
  );
}
