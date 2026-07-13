/**
 * Manual-batch card — the observe-screen "Execute multiple times" surface.
 *
 * Fires a cronoton `count` times, once per minute, server-side. Two states:
 *  - IDLE   → a count input (whole 2–60, default 10) + an "Execute ×N" control
 *             that validates the count, confirms with the verbatim start string,
 *             and starts the batch through the confirm-gated `useStartBatch`.
 *  - ACTIVE → live `completed/total` progress (poller #2 in `useManualBatch` keeps
 *             it fresh at `config.pollCadenceMs`), the next-fire ETA, the
 *             safe-to-close note, and a Cancel control. Cancel is confirm-FREE at
 *             the gate (a runaway batch halts in one click) but still shows the
 *             native `window.confirm` so a stray click never stops a batch.
 *
 * The card is suppressed entirely for a non-admin viewer or a terminal cronoton
 * (a spent one-time job cannot be batch-fired). While active it reports through
 * `onExecuteBlockedChange` so the Detail can disable its "Execute Now" button —
 * only one fire path runs at a time.
 *
 * Style is inline `var(--khr-*)` only (the theming contract). The start-confirm
 * copy is the verbatim Hub string, kept local rather than reusing the count-only
 * `startBatchConfirm` builder because the real line interpolates the name too.
 */

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { Card, Title, TextButton } from "./primitives.js";
import { RelativeTime } from "./RelativeTime.js";
import { withConfirm, cancelBatchConfirm } from "./confirm-flows.js";
import { canMutate } from "./access.js";
import type { Access } from "./access.js";
import { useManualBatch, useStartBatch, useCancelBatch } from "../hooks/index.js";

const MIN_COUNT = 2;
const MAX_COUNT = 60;
const DEFAULT_COUNT = 10;

/** The alert shown when the count is not a whole number in the inclusive 2–60 range. */
export const BATCH_COUNT_ALERT = "Enter a whole number between 2 and 60.";

/** The safe-to-close note under an active batch (fires continue server-side). */
const SAFE_TO_CLOSE_NOTE =
  "One fire per minute · Execute Now is blocked until the batch finishes. Runs server-side — safe to close this tab.";

/**
 * Parse a batch-count field to a valid fire count, or `null` when it is not a
 * whole number in `[2, 60]`. Rejects fractions, signs, and non-numeric junk so a
 * batch never starts with 1 fire, 61 fires, or a partial count.
 */
export function parseBatchCount(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < MIN_COUNT || n > MAX_COUNT) return null;
  return n;
}

/** The verbatim batch-start confirm — interpolates both the name and the count. */
function batchStartConfirm(name: string, count: number): string {
  return `Confirm to execute "${name}" ${count} times, once per minute (server-side, signed by the hub codex).`;
}

const INPUT_STYLE: CSSProperties = {
  width: "64px",
  background: "var(--khr-inset)",
  border: "1px solid var(--khr-border)",
  borderRadius: "6px",
  color: "var(--khr-text)",
  padding: "6px 8px",
  font: "inherit",
  fontSize: "12px",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  flexWrap: "wrap",
  fontSize: "12.5px",
};

const NOTE_STYLE: CSSProperties = {
  color: "var(--khr-text-dim)",
  fontSize: "11.5px",
  margin: "8px 0 0",
};

export interface ManualBatchCardProps {
  /** The cronoton id the batch fires against. */
  id: string;
  /** The cronoton name, interpolated into the start confirm. */
  name: string;
  /** The viewer tier — the card renders only for the admin tier. */
  access: Access;
  /** True for a spent one-time cronoton; the card is suppressed when terminal. */
  terminal: boolean;
  /** Notified with the active flag so a parent can block its "Execute Now" path. */
  onExecuteBlockedChange?: (active: boolean) => void;
}

/**
 * The "Execute multiple times" card. Renders `null` unless the viewer is an admin
 * and the cronoton is non-terminal.
 */
export function ManualBatchCard({
  id,
  name,
  access,
  terminal,
  onExecuteBlockedChange,
}: ManualBatchCardProps): ReactNode {
  const { batch, active, refetch } = useManualBatch(id);
  const start = useStartBatch();
  const cancel = useCancelBatch();
  const [countText, setCountText] = useState(String(DEFAULT_COUNT));

  useEffect(() => {
    onExecuteBlockedChange?.(active);
  }, [active, onExecuteBlockedChange]);

  if (!canMutate(access) || terminal) return null;

  const onStart = (): void => {
    const count = parseBatchCount(countText);
    if (count === null) {
      window.alert(BATCH_COUNT_ALERT);
      return;
    }
    void withConfirm(batchStartConfirm(name, count), () => start.run(id, count), {
      onSuccess: () => void refetch(),
    });
  };

  const onCancel = (): void => {
    void withConfirm(cancelBatchConfirm, () => cancel.run(id), {
      onSuccess: () => void refetch(),
    });
  };

  return (
    <>
      <Title>Execute multiple times</Title>
      <Card style={{ padding: "14px" }}>
        {active && batch ? (
          <div>
            <div style={ROW_STYLE}>
              <span>
                Batch running: {batch.completed}/{batch.total} fired
              </span>
              {batch.remaining > 0 && batch.nextAt ? (
                <span style={{ color: "var(--khr-text-dim)" }}>
                  · next <RelativeTime iso={batch.nextAt} />
                </span>
              ) : null}
              <TextButton onClick={onCancel} disabled={cancel.pending}>
                Cancel batch
              </TextButton>
            </div>
            <p style={NOTE_STYLE}>{SAFE_TO_CLOSE_NOTE}</p>
          </div>
        ) : (
          <div style={ROW_STYLE}>
            <span>Fire</span>
            <input
              type="number"
              min={MIN_COUNT}
              max={MAX_COUNT}
              value={countText}
              onChange={(event) => setCountText(event.target.value)}
              style={INPUT_STYLE}
              aria-label="Number of fires"
            />
            <span>times, once per minute (2–60).</span>
            <TextButton onClick={onStart} disabled={start.pending}>
              Execute ×{countText}
            </TextButton>
          </div>
        )}
      </Card>
    </>
  );
}
