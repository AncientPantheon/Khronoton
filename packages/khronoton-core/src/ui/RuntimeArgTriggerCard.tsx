/**
 * "Trigger with runtime args" — the detail-screen card that fires a runtime-arg
 * cronoton once, on demand, with operator-supplied values.
 *
 * A runtime-arg cronoton is trigger-only: it never auto-fires on a schedule, and
 * at fire time it reads each declared key via `read-string`. This card exposes one
 * text input per declared key, then routes the collected map through the native
 * confirm (`withConfirm`) into the confirm-gated `useTrigger().run(id, args)`. A
 * successful fire shows its requestKey inline and calls {@link
 * RuntimeArgTriggerCardProps.onFired} so the Detail can refetch its history (the
 * Hub hard-reloads here; the package refetches instead). A recorded fire failure
 * (a 200-on-`ok:false` body) is shown as an inline error, not a refetch trigger.
 *
 * Visibility mirrors the Hub: the card renders ONLY for an admin viewing a live
 * (non-terminal) cronoton that declares at least one runtime-arg key — every other
 * tier renders nothing. The Trigger control is additionally gated on the cronoton
 * being `active` (a paused job must be resumed first), the disabled reason shown
 * as the button title.
 */

import { useState, type CSSProperties, type ReactNode } from "react";

import { useTrigger } from "../hooks/index.js";
import type { RuntimeArgs } from "../server/index.js";
import type { CodexCronotonRow } from "../server/types.js";
import { Card, Title, TextButton } from "./primitives.js";
import { triggerConfirm, withConfirm } from "./confirm-flows.js";
import { canMutate, type Access } from "./access.js";

/** The subset of the cronoton the card needs plus its viewer/lifecycle context. */
export interface RuntimeArgTriggerCardProps {
  /** The cronoton id `useTrigger().run` fires against. */
  readonly id: string;
  /** The cronoton name, interpolated into the confirm prompt. */
  readonly name: string;
  /** The lifecycle status — the Trigger control is enabled only when `active`. */
  readonly status: CodexCronotonRow["status"];
  /** The declared runtime-arg keys; one text input is rendered per key. */
  readonly runtimeArgKeys: readonly string[];
  /** The viewer tier — the whole card is admin-only. */
  readonly access: Access;
  /** True for a spent one-time job ({completed,error}); the card is hidden then. */
  readonly terminal: boolean;
  /** Called after a successful fire so the host can refetch the fire history. */
  readonly onFired?: () => void;
}

const BLURB_STYLE: CSSProperties = {
  color: "var(--khr-text-dim)",
  fontSize: "12.5px",
  lineHeight: 1.5,
  margin: "0 0 14px",
};

const CODE_STYLE: CSSProperties = {
  fontFamily: "var(--khr-mono-font)",
  color: "var(--khr-mono)",
};

const KEY_LABEL_STYLE: CSSProperties = {
  display: "block",
  fontFamily: "var(--khr-mono-font)",
  color: "var(--khr-mono)",
  fontSize: "12px",
  marginBottom: "5px",
};

const INPUT_STYLE: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--khr-inset)",
  border: "1px solid var(--khr-border)",
  borderRadius: "6px",
  color: "var(--khr-text)",
  padding: "8px 10px",
  font: "inherit",
  fontSize: "12.5px",
};

const RESULT_BASE_STYLE: CSSProperties = { marginTop: "12px", fontSize: "12.5px" };

/** The title shown on the disabled Trigger button when the cronoton isn't active. */
function resumeHint(status: CodexCronotonRow["status"]): string {
  return `Resume before triggering (status: ${status})`;
}

export function RuntimeArgTriggerCard({
  id,
  name,
  status,
  runtimeArgKeys,
  access,
  terminal,
  onFired,
}: RuntimeArgTriggerCardProps): ReactNode {
  const trigger = useTrigger();
  const [values, setValues] = useState<Record<string, string>>({});

  // The card is an admin-only control on a live trigger-only cronoton; every other
  // tier (public/non-admin, terminal, or a plain scheduled job) renders nothing.
  if (!canMutate(access) || terminal || runtimeArgKeys.length === 0) return null;

  const active = status === "active";
  const disabled = !canMutate(access) || !active || trigger.pending;

  async function handleTrigger(): Promise<void> {
    const args: RuntimeArgs = {};
    for (const key of runtimeArgKeys) args[key] = values[key] ?? "";

    const result = await withConfirm(triggerConfirm(name), () => trigger.run(id, args));
    // Only a fire that actually landed (ok:true) mutates history — mirror the Hub's
    // reload-on-ok by asking the host to refetch just then.
    if (result?.ok) onFired?.();
  }

  const { result, error } = trigger;
  let resultLine: ReactNode = null;
  if (result?.ok) {
    resultLine = (
      <div style={{ ...RESULT_BASE_STYLE, color: "var(--khr-success)" }}>
        Fired · requestKey {result.requestKey ?? "—"}
      </div>
    );
  } else if (result && !result.ok) {
    resultLine = (
      <div style={{ ...RESULT_BASE_STYLE, color: "var(--khr-error)" }}>{result.error}</div>
    );
  } else if (error) {
    resultLine = (
      <div style={{ ...RESULT_BASE_STYLE, color: "var(--khr-error)" }}>{error.message}</div>
    );
  }

  return (
    <Card style={{ padding: "16px" }}>
      <Title>Trigger with runtime args</Title>
      <p style={BLURB_STYLE}>
        This cronoton reads operator-supplied values at fire time (via{" "}
        <code style={CODE_STYLE}>read-string</code>). Fill each argument and fire once —
        signed server-side by the hub codex, recorded in the history below.
      </p>

      {runtimeArgKeys.map((key) => (
        <label key={key} style={{ display: "block", marginBottom: "12px" }}>
          <span style={KEY_LABEL_STYLE}>{key}</span>
          <input
            type="text"
            value={values[key] ?? ""}
            placeholder={`value for ${key}`}
            onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
            style={INPUT_STYLE}
          />
        </label>
      ))}

      <TextButton
        onClick={handleTrigger}
        disabled={disabled}
        title={active ? undefined : resumeHint(status)}
      >
        {trigger.pending ? "Triggering…" : "Trigger"}
      </TextButton>

      {resultLine}
    </Card>
  );
}
