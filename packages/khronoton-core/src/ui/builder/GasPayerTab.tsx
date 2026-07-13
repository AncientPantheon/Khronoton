/**
 * Builder "Gas Payer" tab — the three-radio-card selector from the codex
 * cronoton builder spec.
 *
 * Controlled: it reads {@link BuilderState.gasPayer} and emits a whole next
 * `BuilderState` through `onChange`; the builder assembly owns the state. Three
 * mutually exclusive cards mirror the Hub:
 *
 *  - **Pay with Codex Key** — a grouped account picker (Seed Accounts / Pure
 *    Keys) writing `{ type: "codex", address }`.
 *  - **Pay with Foreign Key** — permanently disabled: the Hub signs scheduled
 *    codex transactions only from the sealed codex, never a foreign key.
 *  - **Ouronet Gas Station** — the default; a signing-key picker writes
 *    `{ type: "gas-station", signingKey }` for the `DALOS.GAS_PAYER` capability.
 *
 * `signers` is the secret-free descriptor list the builder fetches once and
 * passes down. When it is absent the pickers render as empty shells (the host
 * hasn't wired a key store yet) — the warn lines still gate the commit.
 */
import type { CSSProperties, ReactNode } from "react";
import { AlertTriangle, Check, Fuel, KeyRound, Wallet } from "lucide-react";

import type { BuilderState, GasPayerState } from "../builder-state.js";
import type { CodexSignerDescriptor } from "../../handlers/index.js";
import { Field, Title } from "../primitives.js";

export interface GasPayerTabProps {
  state: BuilderState;
  onChange: (next: BuilderState) => void;
  /** Secret-free codex key descriptors for the account/key pickers. */
  signers?: CodexSignerDescriptor[];
}

const GAS_STATION_CHIP = "Ouronet Gas Station (STOA_AUTONOMIC_OURONETGASSTATION)";
const FOREIGN_REASON =
  "Foreign-key gas payment isn't available for scheduled codex transactions — the Hub signs only from the sealed codex.";
const GAS_STATION_EXPL =
  "The Ouronet Gas Station pays gas on the job's behalf. Pick the codex key that signs the DALOS.GAS_PAYER capability.";
const WARN_CODEX_ACCOUNT = "Select a codex account to pay gas.";
const WARN_GAS_STATION_KEY = "Select a key to sign the DALOS.GAS_PAYER capability.";

const CARD_STYLE: CSSProperties = {
  display: "block",
  border: "1px solid var(--khr-border)",
  borderRadius: "var(--khr-radius)",
  padding: "13px 14px",
  marginBottom: "10px",
  background: "var(--khr-panel)",
};

const CARD_SELECTED_STYLE: CSSProperties = {
  ...CARD_STYLE,
  borderColor: "var(--khr-accent)",
  background: "var(--khr-accent-tint)",
};

const CARD_DISABLED_STYLE: CSSProperties = {
  ...CARD_STYLE,
  opacity: 0.55,
  cursor: "not-allowed",
};

const HEAD_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "9px",
  cursor: "pointer",
};

const TITLE_TEXT_STYLE: CSSProperties = { fontSize: "13px", fontWeight: 600, color: "var(--khr-text)" };

const SUB_STYLE: CSSProperties = {
  fontSize: "12px",
  color: "var(--khr-text-dim)",
  margin: "9px 0 0",
  lineHeight: 1.45,
};

const CHIP_STYLE: CSSProperties = {
  display: "inline-block",
  fontSize: "11.5px",
  fontFamily: "var(--khr-mono-font)",
  color: "var(--khr-accent)",
  background: "var(--khr-accent-tint)",
  border: "1px solid var(--khr-border)",
  borderRadius: "6px",
  padding: "3px 8px",
  margin: "9px 0 0",
};

const UNAVAILABLE_BADGE_STYLE: CSSProperties = {
  fontSize: "10.5px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--khr-amber)",
  background: "var(--khr-amber-bg)",
  border: "1px solid var(--khr-border)",
  borderRadius: "999px",
  padding: "1px 8px",
};

const SELECT_STYLE: CSSProperties = {
  width: "100%",
  background: "var(--khr-panel)",
  border: "1px solid var(--khr-border)",
  color: "var(--khr-text)",
  fontSize: "12.5px",
  padding: "6px 8px",
  borderRadius: "6px",
};

const WARN_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  fontSize: "12px",
  color: "var(--khr-amber)",
  margin: "8px 0 0",
};

const OK_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  fontSize: "12px",
  color: "var(--khr-success)",
  margin: "8px 0 0",
};

function Warn({ children }: { children: ReactNode }): ReactNode {
  return (
    <p style={WARN_STYLE}>
      <AlertTriangle size={14} aria-hidden />
      {children}
    </p>
  );
}

function Ok({ children }: { children: ReactNode }): ReactNode {
  return (
    <p style={OK_STYLE}>
      <Check size={14} aria-hidden />
      {children}
    </p>
  );
}

/** A single descriptor as a picker `<option>` (public key is the value + label). */
function descriptorOption(d: CodexSignerDescriptor): ReactNode {
  return (
    <option key={d.publicKey} value={d.publicKey}>
      {d.publicKey}
    </option>
  );
}

/** The Codex Key card's grouped picker: Seed Accounts (derived) then Pure Keys (foreign). */
function GroupedAccountPicker({
  label,
  value,
  signers,
  onPick,
}: {
  label: string;
  value: string;
  signers: CodexSignerDescriptor[];
  onPick: (publicKey: string) => void;
}): ReactNode {
  const seed = signers.filter((s) => s.display === "derived");
  const pure = signers.filter((s) => s.display === "foreign");
  return (
    <Field label={label}>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onPick(e.target.value)}
        style={SELECT_STYLE}
      >
        <option value="">Select an account…</option>
        <optgroup label="Seed Accounts">{seed.map(descriptorOption)}</optgroup>
        <optgroup label="Pure Keys">{pure.map(descriptorOption)}</optgroup>
      </select>
    </Field>
  );
}

/** The gas-station card's single signing-key picker. */
function SigningKeyPicker({
  label,
  value,
  signers,
  onPick,
}: {
  label: string;
  value: string;
  signers: CodexSignerDescriptor[];
  onPick: (publicKey: string) => void;
}): ReactNode {
  return (
    <Field label={label}>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onPick(e.target.value)}
        style={SELECT_STYLE}
      >
        <option value="">Select a signing key…</option>
        {signers.map(descriptorOption)}
      </select>
    </Field>
  );
}

export function GasPayerTab({ state, onChange, signers }: GasPayerTabProps): ReactNode {
  const gasPayer = state.gasPayer;
  const descriptors = signers ?? [];
  const isCodex = gasPayer.type === "codex";
  const isGasStation = gasPayer.type === "gas-station";

  const setGasPayer = (next: GasPayerState): void => {
    onChange({ ...state, gasPayer: next });
  };

  const codexAddress = isCodex ? (gasPayer.address ?? "") : "";
  const signingKey = isGasStation ? (gasPayer.signingKey ?? "") : "";

  return (
    <div>
      <Title>Gas Payer</Title>
      <div role="radiogroup" aria-label="Gas Payer">
        {/* A — Pay with Codex Key */}
        <div style={isCodex ? CARD_SELECTED_STYLE : CARD_STYLE}>
          <label style={HEAD_STYLE}>
            <input
              type="radio"
              name="gas-payer"
              aria-label="Pay with Codex Key"
              checked={isCodex}
              onChange={() => setGasPayer({ type: "codex" })}
            />
            <Wallet size={16} aria-hidden style={{ color: "var(--khr-accent)" }} />
            <span style={TITLE_TEXT_STYLE}>Pay with Codex Key</span>
          </label>
          {isCodex ? (
            <div style={{ marginTop: "11px" }}>
              <GroupedAccountPicker
                label="Codex Account"
                value={codexAddress}
                signers={descriptors}
                onPick={(address) =>
                  setGasPayer(address ? { type: "codex", address } : { type: "codex" })
                }
              />
              {codexAddress ? <Ok>Codex account selected.</Ok> : <Warn>{WARN_CODEX_ACCOUNT}</Warn>}
            </div>
          ) : null}
        </div>

        {/* B — Pay with Foreign Key (permanently unavailable) */}
        <div style={CARD_DISABLED_STYLE}>
          <label style={{ ...HEAD_STYLE, cursor: "not-allowed" }}>
            <input
              type="radio"
              name="gas-payer"
              aria-label="Pay with Foreign Key"
              disabled
              checked={false}
              readOnly
            />
            <KeyRound size={16} aria-hidden style={{ color: "var(--khr-text-dim)" }} />
            <span style={TITLE_TEXT_STYLE}>Pay with Foreign Key</span>
            <span style={UNAVAILABLE_BADGE_STYLE}>Unavailable</span>
          </label>
          <p style={SUB_STYLE}>{FOREIGN_REASON}</p>
        </div>

        {/* C — Ouronet Gas Station (default) */}
        <div style={isGasStation ? CARD_SELECTED_STYLE : CARD_STYLE}>
          <label style={HEAD_STYLE}>
            <input
              type="radio"
              name="gas-payer"
              aria-label="Ouronet Gas Station"
              checked={isGasStation}
              onChange={() => setGasPayer({ type: "gas-station" })}
            />
            <Fuel size={16} aria-hidden style={{ color: "var(--khr-accent)" }} />
            <span style={TITLE_TEXT_STYLE}>Ouronet Gas Station</span>
          </label>
          {isGasStation ? (
            <div style={{ marginTop: "11px" }}>
              <div style={CHIP_STYLE}>{GAS_STATION_CHIP}</div>
              <p style={SUB_STYLE}>{GAS_STATION_EXPL}</p>
              <div style={{ marginTop: "11px" }}>
                <SigningKeyPicker
                  label="Signing Key (DALOS.GAS_PAYER capability)"
                  value={signingKey}
                  signers={descriptors}
                  onPick={(key) =>
                    setGasPayer(key ? { type: "gas-station", signingKey: key } : { type: "gas-station" })
                  }
                />
                {signingKey ? (
                  <Ok>Signing key selected.</Ok>
                ) : (
                  <Warn>{WARN_GAS_STATION_KEY}</Warn>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
