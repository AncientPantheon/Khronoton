/**
 * Builder "Config" tab — the Transaction Configuration form.
 *
 * A CONTROLLED presentational tab over the pure {@link BuilderConfig} slice of
 * {@link BuilderState}: it renders `state.config` and, on every edit, calls
 * `onChange` with a fresh `BuilderState` carrying the patched config. No math or
 * validation lives here — the Max Tx Fee figure is derived through
 * {@link maxTxFee} (gas price × gas limit) and the defaults/validation belong to
 * `builder-state.ts`. Every label and helper string is reproduced verbatim from
 * the Hub builder so the surface reads identically. Styling is inline
 * `var(--khr-*)` only.
 */

import type { CSSProperties, ReactNode } from "react";

import { Badge, Field, Title } from "../primitives.js";
import { maxTxFee, type BuilderConfig, type BuilderState } from "../builder-state.js";

export interface ConfigTabProps {
  /** The whole form state; the tab reads/writes only its `config` slice. */
  state: BuilderState;
  /** Called with the next `BuilderState` (config patched) on every edit. */
  onChange: (next: BuilderState) => void;
  /**
   * When AUTO gas is on and a successful Simulate has calibrated the limit, the
   * calibrated gas figure (from the Execute tab). Present ⇒ the helper reads
   * "Calibrated: {n} gas" instead of the run-Simulate prompt.
   */
  calibratedGasLimit?: number | null;
}

const INPUT_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  background: "var(--khr-panel)",
  border: "1px solid var(--khr-border)",
  borderRadius: "6px",
  color: "var(--khr-text)",
  fontSize: "12px",
  padding: "6px 9px",
};

const MONO_INPUT_STYLE: CSSProperties = {
  ...INPUT_STYLE,
  fontFamily: "var(--khr-mono-font)",
  color: "var(--khr-mono)",
};

const READONLY_INPUT_STYLE: CSSProperties = { opacity: 0.7 };

const HINT_STYLE: CSSProperties = {
  fontSize: "10px",
  color: "var(--khr-text-dim2)",
  margin: "4px 0 0",
  lineHeight: 1.5,
};

const DISPLAY_STYLE: CSSProperties = {
  background: "var(--khr-inset)",
  border: "1px solid var(--khr-border)",
  borderRadius: "6px",
  color: "var(--khr-mono)",
  fontSize: "12px",
  padding: "6px 9px",
};

const MUTED_STYLE: CSSProperties = { color: "var(--khr-text-dim2)" };

const TOGGLE_STYLE: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  fontSize: "11px",
  color: "var(--khr-accent)",
  cursor: "pointer",
  textDecoration: "underline",
};

const MANUAL_BADGE_STYLE: CSSProperties = {
  background: "var(--khr-inset)",
  color: "var(--khr-text-dim2)",
  border: "1px solid var(--khr-border)",
};

const AUTO_BADGE_STYLE: CSSProperties = {
  background: "var(--khr-accent-tint)",
  color: "var(--khr-accent)",
  border: "1px solid var(--khr-accent)",
};

const GAS_HEAD_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "5px",
};

const GAS_LABEL_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "7px",
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.09em",
  color: "var(--khr-text-dim)",
};

function Hint({ children }: { children: ReactNode }): ReactNode {
  return <p style={HINT_STYLE}>{children}</p>;
}

/** Thousands-grouped integer, e.g. 15000000 → "15,000,000" (locale-pinned). */
function formatThousands(n: number): string {
  return n.toLocaleString("en-US");
}

export function ConfigTab({ state, onChange, calibratedGasLimit }: ConfigTabProps): ReactNode {
  const config = state.config;

  const patch = (next: Partial<BuilderConfig>): void => {
    onChange({ ...state, config: { ...config, ...next } });
  };

  const auto = config.autoGasLimit;
  const calibrated = typeof calibratedGasLimit === "number";

  return (
    <div>
      <Title>Transaction Configuration</Title>

      <Field label="Chain ID">
        <input
          aria-label="Chain ID"
          style={MONO_INPUT_STYLE}
          value={config.chainId}
          onChange={(e) => patch({ chainId: e.target.value })}
        />
        <Hint>Single chain per job (Stoa Network).</Hint>
      </Field>

      <Field label="Gas Price (ANU)">
        <input
          aria-label="Gas Price (ANU)"
          type="number"
          style={INPUT_STYLE}
          value={config.gasPriceAnu}
          onChange={(e) => patch({ gasPriceAnu: Number(e.target.value) })}
        />
        <Hint>Minimum 10,000 ANU (protocol floor).</Hint>
      </Field>

      <div style={{ marginBottom: "14px" }}>
        <div style={GAS_HEAD_STYLE}>
          <span style={GAS_LABEL_STYLE}>
            Gas Limit
            <Badge style={auto ? AUTO_BADGE_STYLE : MANUAL_BADGE_STYLE}>
              {auto ? "AUTO" : "MANUAL"}
            </Badge>
          </span>
          <button
            type="button"
            style={TOGGLE_STYLE}
            onClick={() => patch({ autoGasLimit: !auto })}
          >
            {auto ? "Switch to manual" : "Switch to auto"}
          </button>
        </div>
        <input
          aria-label="Gas Limit"
          type="number"
          readOnly={auto}
          style={{ ...INPUT_STYLE, ...(auto ? READONLY_INPUT_STYLE : null) }}
          value={config.gasLimit}
          onChange={(e) => patch({ gasLimit: Number(e.target.value) })}
        />
        {auto ? (
          <Hint>
            {calibrated
              ? `Calibrated: ${formatThousands(calibratedGasLimit as number)} gas`
              : "Run Simulate to calibrate the auto gas limit."}
          </Hint>
        ) : null}
      </div>

      <Field label="Max Tx Fee (ANU)">
        <div style={DISPLAY_STYLE}>
          {formatThousands(maxTxFee(config))} ANU <span style={MUTED_STYLE}>(gas price x gas limit)</span>
        </div>
      </Field>

      <Field label="Time To Live (seconds)">
        <input
          aria-label="Time To Live (seconds)"
          type="number"
          style={INPUT_STYLE}
          value={config.ttl}
          onChange={(e) => patch({ ttl: Number(e.target.value) })}
        />
        <Hint>Range: 60s (1 min) to 86,400s (24 hours).</Hint>
      </Field>
    </div>
  );
}
