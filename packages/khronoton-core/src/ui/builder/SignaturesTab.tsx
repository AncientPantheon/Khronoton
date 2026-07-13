/**
 * Builder "Signatures" tab — the signer roster for the codex-cronoton form.
 *
 * The roster has two kinds of entry, mirroring the Hub verbatim:
 * - The **locked gas-payer signer** is DERIVED from `state.gasPayer`, never
 *   stored in `state.signers`. The executor synthesizes its capability from the
 *   gas payer (see {@link ../builder-state.js}), so the UI renders it read-only
 *   with the exact capability line the executor will sign
 *   (`(ouronet-ns.DALOS.GAS_PAYER "" 0 0.0)` for the gas station, `coin.GAS`
 *   for a codex account) and never emits it into the commit body.
 * - **Manual signers** are the editable `state.signers` rows: each carries a
 *   provenance badge, a remove control, and a pure/scoped capability toggle
 *   that reveals a capabilities textarea only when scoped.
 *
 * Fully controlled: every mutation calls `onChange` with the next `BuilderState`.
 * The title count combines both kinds via `effectiveSignerCount` so it matches
 * the "at least one signer" commit gate.
 */

import type { CSSProperties, ReactNode } from "react";
import { Lock, AlertTriangle } from "lucide-react";

import type { CodexSignerDescriptor } from "../../handlers/index.js";
import {
  effectiveSignerCount,
  type BuilderState,
  type GasPayerState,
  type SignerRow,
} from "../builder-state.js";
import { Badge, Title } from "../primitives.js";

export interface SignaturesTabProps {
  state: BuilderState;
  onChange: (next: BuilderState) => void;
  /** The codex keys the host can sign for, offered in the "Add Signer" list. */
  signers?: CodexSignerDescriptor[];
}

/** The public key the gas payer signs with, if it has been chosen yet. */
function gasPayerPublicKey(gasPayer: GasPayerState): string | undefined {
  return gasPayer.type === "gas-station" ? gasPayer.signingKey : gasPayer.address;
}

/** The exact capability line the executor synthesizes for the gas-payer signer. */
function gasPayerCapabilityLine(gasPayer: GasPayerState): string {
  return gasPayer.type === "gas-station"
    ? '(ouronet-ns.DALOS.GAS_PAYER "" 0 0.0)'
    : "coin.GAS";
}

let signerIdSeq = 0;
function nextSignerId(): string {
  signerIdSeq += 1;
  return `signer-${signerIdSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

const MONO_STYLE: CSSProperties = {
  fontFamily: "var(--khr-mono-font)",
  color: "var(--khr-mono)",
  fontSize: "12px",
};

const SIGNER_BOX: CSSProperties = {
  border: "1px solid var(--khr-border)",
  borderRadius: "var(--khr-radius)",
  padding: "12px",
  marginBottom: "10px",
  background: "var(--khr-panel)",
};

const AMBER_BADGE: CSSProperties = {
  background: "var(--khr-amber-bg)",
  color: "var(--khr-amber)",
  border: "1px solid #92400e",
};

const BLUE_BADGE: CSSProperties = {
  background: "var(--khr-blue-bg)",
  color: "var(--khr-blue)",
};

function LockedGasPayerSigner({ gasPayer }: { gasPayer: GasPayerState }): ReactNode {
  const publicKey = gasPayerPublicKey(gasPayer);
  if (!publicKey) return null;

  return (
    <div style={{ ...SIGNER_BOX, borderColor: "var(--khr-amber)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <Lock size={13} color="var(--khr-amber)" aria-hidden />
        <span style={MONO_STYLE}>{publicKey}</span>
        <Badge style={AMBER_BADGE}>Gas Payer</Badge>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          color: "var(--khr-amber)",
          fontSize: "11.5px",
          margin: "8px 0",
        }}
      >
        <AlertTriangle size={12} aria-hidden />
        <span>Auto-added from the gas payer — its capability is managed for you.</span>
      </div>
      <div
        style={{
          ...MONO_STYLE,
          display: "flex",
          alignItems: "center",
          gap: "6px",
          color: "var(--khr-accent)",
          background: "var(--khr-accent-tint)",
          border: "1px solid var(--khr-accent)",
          borderRadius: "6px",
          padding: "6px 8px",
        }}
      >
        <Lock size={12} aria-hidden />
        <span>{gasPayerCapabilityLine(gasPayer)}</span>
      </div>
    </div>
  );
}

const SEG_BUTTON: CSSProperties = {
  border: "1px solid var(--khr-border)",
  background: "var(--khr-panel)",
  color: "var(--khr-text-dim)",
  padding: "4px 12px",
  cursor: "pointer",
  font: "inherit",
  fontSize: "11px",
};

const SEG_BUTTON_ON: CSSProperties = {
  background: "var(--khr-accent-tint)",
  color: "var(--khr-accent)",
  borderColor: "var(--khr-accent)",
};

function ManualSigner({
  row,
  onRemove,
  onModeChange,
  onCapabilitiesChange,
}: {
  row: SignerRow;
  onRemove: () => void;
  onModeChange: (mode: SignerRow["capabilityMode"]) => void;
  onCapabilitiesChange: (value: string) => void;
}): ReactNode {
  const scoped = row.capabilityMode === "scoped";
  return (
    <div style={SIGNER_BOX}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={MONO_STYLE}>{row.publicKey}</span>
        <Badge style={BLUE_BADGE}>{row.source}</Badge>
        <button
          type="button"
          aria-label={`Remove signer ${row.publicKey}`}
          onClick={onRemove}
          style={{
            marginLeft: "auto",
            border: "none",
            background: "none",
            color: "var(--khr-error)",
            cursor: "pointer",
            font: "inherit",
            fontSize: "13px",
          }}
        >
          x
        </button>
      </div>
      <div style={{ display: "inline-flex", marginTop: "8px", borderRadius: "6px", overflow: "hidden" }}>
        <button
          type="button"
          onClick={() => onModeChange("pure")}
          style={{ ...SEG_BUTTON, ...(scoped ? null : SEG_BUTTON_ON) }}
        >
          pure
        </button>
        <button
          type="button"
          onClick={() => onModeChange("scoped")}
          style={{ ...SEG_BUTTON, ...(scoped ? SEG_BUTTON_ON : null) }}
        >
          scoped
        </button>
      </div>
      {scoped ? (
        <label style={{ display: "block", marginTop: "8px" }}>
          <span
            style={{
              display: "block",
              fontSize: "11px",
              color: "var(--khr-text-dim)",
              marginBottom: "4px",
            }}
          >
            Capabilities (one per line, e.g. (coin.GAS))
          </span>
          <textarea
            rows={2}
            placeholder="(coin.GAS)"
            value={row.capabilities}
            onChange={(e) => onCapabilitiesChange(e.target.value)}
            style={{
              width: "100%",
              ...MONO_STYLE,
              background: "var(--khr-panel)",
              border: "1px solid var(--khr-border)",
              borderRadius: "6px",
              padding: "6px 8px",
              resize: "vertical",
            }}
          />
        </label>
      ) : null}
    </div>
  );
}

const PICK_ITEM: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "8px 10px",
  border: "1px solid var(--khr-border)",
  borderRadius: "6px",
  marginBottom: "6px",
  fontSize: "12px",
};

export function SignaturesTab({ state, onChange, signers = [] }: SignaturesTabProps): ReactNode {
  const count = effectiveSignerCount(state);
  const gasKey = gasPayerPublicKey(state.gasPayer);

  const addSigner = (descriptor: CodexSignerDescriptor) => {
    onChange({
      ...state,
      signers: [
        ...state.signers,
        {
          id: nextSignerId(),
          publicKey: descriptor.publicKey,
          label: "",
          source: descriptor.display,
          capabilityMode: "pure",
          capabilities: "",
        },
      ],
    });
  };

  const removeSigner = (id: string) => {
    onChange({ ...state, signers: state.signers.filter((s) => s.id !== id) });
  };

  const updateSigner = (id: string, patch: Partial<SignerRow>) => {
    onChange({
      ...state,
      signers: state.signers.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  };

  return (
    <div>
      <Title>Signers ({count})</Title>

      {count === 0 ? (
        <p style={{ color: "var(--khr-text-dim)", fontSize: "12.5px", margin: "0 0 12px" }}>
          No signers added. Select a gas payer or add codex keys below.
        </p>
      ) : null}

      <LockedGasPayerSigner gasPayer={state.gasPayer} />

      {state.signers.map((row) => (
        <ManualSigner
          key={row.id}
          row={row}
          onRemove={() => removeSigner(row.id)}
          onModeChange={(mode) => updateSigner(row.id, { capabilityMode: mode })}
          onCapabilitiesChange={(value) => updateSigner(row.id, { capabilities: value })}
        />
      ))}

      {signers.length > 0 ? (
        <div
          data-testid="add-signer-list"
          style={{ borderTop: "1px solid var(--khr-border)", marginTop: "12px", paddingTop: "12px" }}
        >
          <p
            style={{
              color: "var(--khr-accent)",
              fontSize: "11px",
              textTransform: "uppercase",
              letterSpacing: "0.09em",
              margin: "0 0 10px",
            }}
          >
            Add Signer (Codex Keys)
          </p>
          {signers.map((descriptor) => {
            const isGasPayer = gasKey !== undefined && descriptor.publicKey === gasKey;
            const isAdded = state.signers.some((s) => s.publicKey === descriptor.publicKey);
            return (
              <div key={descriptor.publicKey} style={PICK_ITEM}>
                <span style={MONO_STYLE}>{descriptor.publicKey}</span>
                <Badge style={BLUE_BADGE}>Codex Keys</Badge>
                <span style={{ marginLeft: "auto" }}>
                  {isGasPayer ? (
                    <Badge style={AMBER_BADGE}>Gas Payer</Badge>
                  ) : isAdded ? (
                    <span style={{ color: "var(--khr-text-dim)", fontSize: "12px" }}>Added</span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Add signer ${descriptor.publicKey}`}
                      onClick={() => addSigner(descriptor)}
                      style={{
                        border: "1px solid var(--khr-border)",
                        background: "var(--khr-panel)",
                        color: "var(--khr-accent)",
                        padding: "4px 10px",
                        borderRadius: "6px",
                        cursor: "pointer",
                        font: "inherit",
                        fontSize: "12px",
                      }}
                    >
                      + Add
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
