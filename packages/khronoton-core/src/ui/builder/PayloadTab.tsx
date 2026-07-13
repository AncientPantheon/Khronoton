/**
 * Builder "Payload (env-data)" tab — the typed↔raw env-data editor.
 *
 * A controlled view over `BuilderState.payload`: every edit rebuilds the next
 * `PayloadState` and hands it to `onChange`; the tab holds no state of its own.
 * Typed mode edits env-data rows (each row's Value control adapts to its type)
 * and named keysets; raw mode edits a single JSON object. The amber banner is
 * non-blocking — it surfaces the undefined-keyset references `validatePayload`
 * derives from the Pact code so the user can define them, but it never gates the
 * commit. Styling is inline `var(--khr-*)` only, per the theming contract.
 */

import type { CSSProperties, ReactNode } from "react";

import type {
  BuilderState,
  KeysetPredicate,
  PayloadEntry,
  PayloadEntryType,
  PayloadState,
} from "../builder-state.js";
import { validatePayload } from "../builder-state.js";
import { Field, TextButton, Title } from "../primitives.js";

const ENTRY_TYPES: PayloadEntryType[] = ["string", "number", "boolean", "json"];
const PREDICATES: KeysetPredicate[] = ["keys-all", "keys-any", "keys-2"];

const INPUT_STYLE: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--khr-panel)",
  border: "1px solid var(--khr-border)",
  color: "var(--khr-text)",
  fontSize: "12px",
  padding: "6px 8px",
  borderRadius: "6px",
  font: "inherit",
};

const MONO_TEXTAREA_STYLE: CSSProperties = {
  ...INPUT_STYLE,
  fontFamily: "var(--khr-mono-font)",
  color: "var(--khr-mono)",
  resize: "vertical",
};

const SECTION_STYLE: CSSProperties = {
  marginTop: "18px",
  paddingTop: "16px",
  borderTop: "1px solid var(--khr-border)",
};

const ROW_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 110px 1.4fr auto",
  gap: "8px",
  alignItems: "start",
  marginBottom: "10px",
};

const KEYSET_CARD_STYLE: CSSProperties = {
  border: "1px solid var(--khr-border)",
  borderRadius: "var(--khr-radius)",
  padding: "12px",
  marginBottom: "12px",
  background: "var(--khr-inset)",
};

const WARNING_STYLE: CSSProperties = {
  background: "var(--khr-amber-bg)",
  border: "1px solid #92400e",
  color: "var(--khr-amber)",
  fontSize: "12px",
  padding: "8px 12px",
  borderRadius: "6px",
  marginBottom: "12px",
};

const HEADER_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "12px",
};

export interface PayloadTabProps {
  /** The whole builder state — `payload` is edited, `pactCode` seeds the keyset warning. */
  state: BuilderState;
  /** Called with the NEXT payload on every edit (typed rows, keysets, raw JSON, or toggle). */
  onChange: (payload: PayloadState) => void;
  /**
   * Non-blocking keyset warnings to surface. Defaults to the undefined-keyset
   * references `validatePayload` derives from the Pact code + payload.
   */
  warnings?: string[];
}

export function PayloadTab({ state, onChange, warnings }: PayloadTabProps): ReactNode {
  const payload = state.payload;
  const banners = warnings ?? validatePayload(state).warnings;

  const patch = (next: Partial<PayloadState>): void => onChange({ ...payload, ...next });

  const setEntry = (index: number, changed: Partial<PayloadEntry>): void => {
    patch({
      entries: payload.entries.map((entry, i) =>
        i === index ? { ...entry, ...changed } : entry,
      ),
    });
  };

  const changeEntryType = (index: number, type: PayloadEntryType): void => {
    const current = payload.entries[index];
    // A boolean row is driven by a checkbox, so normalise its text to a clean
    // "true"/"false" the moment the type flips; other types share plain text.
    const value = type === "boolean" && current.value !== "true" ? "false" : current.value;
    setEntry(index, { type, value });
  };

  return (
    <section>
      <div style={HEADER_ROW_STYLE}>
        <Title style={{ margin: 0 }}>Payload (env-data)</Title>
        <TextButton
          onClick={() => patch({ rawMode: !payload.rawMode })}
          style={{ padding: "4px 10px", fontSize: "11px" }}
        >
          {payload.rawMode ? "Switch to typed" : "Switch to raw JSON"}
        </TextButton>
      </div>

      {banners.map((message) => (
        <div key={message} role="alert" style={WARNING_STYLE}>
          {message}
        </div>
      ))}

      {payload.rawMode ? (
        <Field label="Raw payload JSON (object)" style={{ marginTop: "12px" }}>
          <textarea
            aria-label="Raw payload JSON (object)"
            rows={10}
            value={payload.rawJson}
            placeholder={'{ "amount": 1.0 }'}
            onChange={(e) => patch({ rawJson: e.target.value })}
            style={MONO_TEXTAREA_STYLE}
          />
        </Field>
      ) : (
        <div style={{ marginTop: "12px" }}>
          <EntryList
            entries={payload.entries}
            onEdit={setEntry}
            onEditType={changeEntryType}
            onRemove={(i) => patch({ entries: payload.entries.filter((_, j) => j !== i) })}
            onAdd={() =>
              patch({ entries: [...payload.entries, { key: "", type: "string", value: "" }] })
            }
          />

          <div style={SECTION_STYLE}>
            <Title>Keysets</Title>
            {payload.keysets.map((ks, index) => (
              <div key={index} style={KEYSET_CARD_STYLE}>
                <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
                  <input
                    aria-label="Keyset name"
                    value={ks.name}
                    placeholder="ks"
                    onChange={(e) =>
                      patch({
                        keysets: payload.keysets.map((k, i) =>
                          i === index ? { ...k, name: e.target.value } : k,
                        ),
                      })
                    }
                    style={INPUT_STYLE}
                  />
                  <select
                    aria-label="Keyset predicate"
                    value={ks.predicate}
                    onChange={(e) =>
                      patch({
                        keysets: payload.keysets.map((k, i) =>
                          i === index
                            ? { ...k, predicate: e.target.value as KeysetPredicate }
                            : k,
                        ),
                      })
                    }
                    style={{ ...INPUT_STYLE, width: "auto" }}
                  >
                    {PREDICATES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <TextButton
                    onClick={() =>
                      patch({ keysets: payload.keysets.filter((_, j) => j !== index) })
                    }
                    style={{ padding: "4px 10px", fontSize: "11px" }}
                  >
                    Remove
                  </TextButton>
                </div>
                <Field label="Keys (one 64-hex public key per line)" style={{ margin: 0 }}>
                  <textarea
                    aria-label="Keys (one 64-hex public key per line)"
                    rows={3}
                    value={ks.keysText}
                    onChange={(e) =>
                      patch({
                        keysets: payload.keysets.map((k, i) =>
                          i === index ? { ...k, keysText: e.target.value } : k,
                        ),
                      })
                    }
                    style={MONO_TEXTAREA_STYLE}
                  />
                </Field>
              </div>
            ))}
            <TextButton
              onClick={() =>
                patch({
                  keysets: [
                    ...payload.keysets,
                    { name: "", predicate: "keys-all", keysText: "" },
                  ],
                })
              }
              style={{ padding: "5px 12px", fontSize: "12px" }}
            >
              + Add keyset
            </TextButton>
          </div>
        </div>
      )}
    </section>
  );
}

interface EntryListProps {
  entries: PayloadEntry[];
  onEdit: (index: number, changed: Partial<PayloadEntry>) => void;
  onEditType: (index: number, type: PayloadEntryType) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
}

function EntryList({ entries, onEdit, onEditType, onRemove, onAdd }: EntryListProps): ReactNode {
  return (
    <div>
      {entries.map((entry, index) => (
        <div key={index} style={ROW_STYLE}>
          <input
            aria-label="Data entry key"
            value={entry.key}
            placeholder="amount"
            onChange={(e) => onEdit(index, { key: e.target.value })}
            style={INPUT_STYLE}
          />
          <select
            aria-label="Data entry type"
            value={entry.type}
            onChange={(e) => onEditType(index, e.target.value as PayloadEntryType)}
            style={INPUT_STYLE}
          >
            {ENTRY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <EntryValue entry={entry} onChange={(value) => onEdit(index, { value })} />
          <TextButton
            onClick={() => onRemove(index)}
            style={{ padding: "4px 10px", fontSize: "11px" }}
          >
            Remove
          </TextButton>
        </div>
      ))}
      <TextButton onClick={onAdd} style={{ padding: "5px 12px", fontSize: "12px" }}>
        + Add data entry
      </TextButton>
    </div>
  );
}

interface EntryValueProps {
  entry: PayloadEntry;
  onChange: (value: string) => void;
}

/** The adaptive Value control: checkbox for boolean, textarea for json, else input. */
function EntryValue({ entry, onChange }: EntryValueProps): ReactNode {
  if (entry.type === "boolean") {
    const checked = entry.value === "true";
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
        <input
          aria-label="Data entry value"
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked ? "true" : "false")}
        />
        <span style={{ fontSize: "12px", color: "var(--khr-text-dim)" }}>
          {checked ? "true" : "false"}
        </span>
      </span>
    );
  }

  if (entry.type === "json") {
    return (
      <textarea
        aria-label="Data entry value"
        rows={2}
        value={entry.value}
        placeholder={'{ "k": 1 }'}
        onChange={(e) => onChange(e.target.value)}
        style={MONO_TEXTAREA_STYLE}
      />
    );
  }

  return (
    <input
      aria-label="Data entry value"
      type={entry.type === "number" ? "number" : "text"}
      value={entry.value}
      onChange={(e) => onChange(e.target.value)}
      style={INPUT_STYLE}
    />
  );
}
