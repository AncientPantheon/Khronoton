/**
 * The codex-cronoton builder header block — Rows A/B/C of the "New/Edit" form.
 *
 * This owns only the metadata rows above the two-pane editor (the page eyebrow,
 * title, description and footer belong to the builder assembly). It is a fully
 * controlled slice of `BuilderState`: every edit produces a patched state passed
 * to `onChange`, and it holds no local state of its own.
 *
 * Two Hub couplings stay genericized:
 * - Row B's server-resolver `<select>` is REGISTRY-DRIVEN (REQ-G05): the base
 *   "None (ordinary cronoton)" option is always present, and the remaining
 *   options come from `serverResolverOptions` (the prop, else the provider
 *   config). No `stoicism-mint` is baked in — a host registers it, and its
 *   optional `note` renders as the conditional gold side-note.
 * - Row C (externally-fireable + runtime-arg-keys) is CREATE-ONLY (REQ-G06):
 *   it is hidden entirely in edit mode, matching the create-only rehydration
 *   rule in `detailToBuilderState`.
 */
import { useContext } from "react";
import type { CSSProperties, ReactNode } from "react";

import { Field } from "../primitives.js";
import type { BuilderState } from "../builder-state.js";
import { KhronotonStaticContext } from "../../provider/context.js";
import type { ServerResolverOption } from "../../provider/context.js";

const BASE_RESOLVER_OPTION: ServerResolverOption = {
  value: "",
  label: "None (ordinary cronoton)",
};

const RUNTIME_ARG_KEYS_HELPER =
  "env-data keys a trigger supplies at fire time (read via read-string). " +
  "Declaring any key makes this cronoton trigger-only — the scheduler will not " +
  "auto-fire it. Leave empty for an ordinary fixed cronoton.";

const INPUT_STYLE: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--khr-inset)",
  border: "1px solid var(--khr-border)",
  borderRadius: "var(--khr-radius)",
  color: "var(--khr-text)",
  font: "inherit",
  fontSize: "12px",
  padding: "6px 8px",
};

const ROW_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "14px",
};

const HELPER_STYLE: CSSProperties = {
  marginTop: "5px",
  fontSize: "11px",
  color: "var(--khr-text-dim)",
  lineHeight: 1.4,
};

const NOTE_STYLE: CSSProperties = {
  marginTop: "6px",
  fontSize: "11px",
  color: "var(--khr-accent)",
  lineHeight: 1.4,
};

/** Props for the controlled builder header block. */
export interface BuilderHeaderProps {
  state: BuilderState;
  onChange: (next: BuilderState) => void;
  /** In edit mode the create-only Row C (external-fire + runtime args) is hidden. */
  isEdit: boolean;
  /** Registry-driven resolver options; falls back to the provider config. */
  serverResolverOptions?: ServerResolverOption[];
}

/** Read the resolver registry from the prop, else the provider config, else empty. */
function useResolverOptions(override?: ServerResolverOption[]): ServerResolverOption[] {
  const ctx = useContext(KhronotonStaticContext);
  if (override) return override;
  return ctx?.config.serverResolverOptions ?? [];
}

export function BuilderHeader({
  state,
  onChange,
  isEdit,
  serverResolverOptions,
}: BuilderHeaderProps): ReactNode {
  const registry = useResolverOptions(serverResolverOptions);
  const resolverOptions = [
    BASE_RESOLVER_OPTION,
    ...registry.filter((opt) => opt.value !== ""),
  ];
  const selectedNote = state.serverResolver
    ? registry.find((opt) => opt.value === state.serverResolver)?.note
    : undefined;

  const patch = (fields: Partial<BuilderState>): void => onChange({ ...state, ...fields });

  return (
    <div>
      <div style={ROW_STYLE}>
        <Field label="Name">
          <input
            style={INPUT_STYLE}
            placeholder="Daily payout"
            value={state.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>
        <Field label="Description (optional)">
          <input
            style={INPUT_STYLE}
            placeholder="What this codex cronoton does"
            value={state.description}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </Field>
      </div>

      <Field label="Server resolver">
        <select
          style={INPUT_STYLE}
          value={state.serverResolver ?? ""}
          onChange={(e) => patch({ serverResolver: e.target.value || undefined })}
        >
          {resolverOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {selectedNote ? <div style={NOTE_STYLE}>{selectedNote}</div> : null}
      </Field>

      {isEdit ? null : (
        <div style={ROW_STYLE}>
          <label style={{ display: "flex", alignItems: "flex-start", gap: "8px", marginBottom: "14px" }}>
            <input
              type="checkbox"
              checked={state.externalFireable}
              onChange={(e) => patch({ externalFireable: e.target.checked })}
            />
            <span style={{ fontSize: "12px", color: "var(--khr-text)" }}>
              Externally fireable (allow the external HMAC trigger endpoint to fire this)
            </span>
          </label>
          <Field label="Runtime arg keys (optional)">
            <input
              style={INPUT_STYLE}
              placeholder="comma or newline separated, e.g. amount, recipient"
              value={state.runtimeArgKeysText}
              onChange={(e) => patch({ runtimeArgKeysText: e.target.value })}
            />
            <div style={HELPER_STYLE}>{RUNTIME_ARG_KEYS_HELPER}</div>
          </Field>
        </div>
      )}
    </div>
  );
}
