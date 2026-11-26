/**
 * StepWorkspace — the per-step dials for ONE chained step, REUSING the single-tx
 * builder's real tab components (ConfigTab / PayloadTab / GasPayerTab /
 * SignaturesTab) + the Pact editor.
 *
 * Rendered in TWO panes (the `pane` prop), so the chained builder can place them
 * in separate columns (editor in the big middle column, the per-tx fields in the
 * controls column):
 *   - `pane="editor"` → Mode / Yield-as / idempotent + the Pact editor (single)
 *     or the planner picker + params (planner). The step's "what runs" surface.
 *   - `pane="fields"` → the Config / Payload / Gas Payer / Signatures tab strip +
 *     the active tab. The step's "how it's configured/signed" surface.
 *   - `pane="both"` (default) → editor then fields stacked (back-compat).
 *
 * A step's tx subset (`pactCode`/`config`/`payload`/`gasPayer`/`signers`) is the
 * same shape a single cronoton carries, so we synthesize a `BuilderState` from the
 * `StepState`, hand it to the existing tabs, and map the tab's next `BuilderState`
 * back — ONE implementation of every dial. A `planner` step omits Pact + Payload
 * (the planner builds those; it STILL needs config/gas/signers to sign each leg).
 *
 * Per-step `serverResolver` is intentionally NOT offered yet — the
 * `codex_cronoton_steps` table has no `server_resolver` column and the chained
 * runner has no per-step resolver application. That is a separate follow-on.
 */
import { useState, type CSSProperties, type ReactNode } from "react";

import type { CodexSignerDescriptor } from "../../handlers/index.js";
import {
  makeEmptyBuilderState,
  type BuilderConfig,
  type BuilderState,
  type GasPayerState,
  type PayloadState,
  type SignerRow,
} from "../builder-state.js";
import { KNOWN_PLANNERS, type StepState } from "../chained-builder-state.js";
import { PactCodeEditor } from "../PactCodeEditor.js";
import { ConfigTab } from "../builder/ConfigTab.js";
import { GasPayerTab } from "../builder/GasPayerTab.js";
import { PayloadTab } from "../builder/PayloadTab.js";
import { SignaturesTab } from "../builder/SignaturesTab.js";

type StepTab = "config" | "payload" | "gas-payer" | "signatures";
type Pane = "editor" | "fields" | "both";

const ALL_TABS: { key: StepTab; label: string }[] = [
  { key: "config", label: "Config" },
  { key: "payload", label: "Payload" },
  { key: "gas-payer", label: "Gas Payer" },
  { key: "signatures", label: "Signatures" },
];

export interface StepWorkspaceProps {
  step: StepState;
  onChange: (next: StepState) => void;
  descriptors: CodexSignerDescriptor[];
  liveFloorAnu?: number | null;
  /** Yield names declared by EARLIER steps — referenceable via `{"$yield":"…"}`. */
  earlierYieldNames: string[];
  /** Live registered planner names; falls back to the known built-ins. */
  plannerNames?: string[];
  /** The Step-0 single-tx variant: always single, never yields — hide mode/yield. */
  variant?: boolean;
  /** Which pane to render (default "both"). */
  pane?: Pane;
  /** Pact editor height (the editor pane owns the tall column). */
  editorHeight?: number;
  /**
   * Fill the available height instead of using `editorHeight` — for the chained
   * builder's Pact pane, where the editor sits in a bounded flex column. Avoids
   * clipping when the mode/yield row above the editor changes height.
   */
  fillEditor?: boolean;
}

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--khr-text-dim)",
  marginBottom: 4,
};
const fieldStyle: CSSProperties = {
  width: "100%",
  background: "var(--khr-inset)",
  border: "1px solid var(--khr-border)",
  color: "var(--khr-text)",
  borderRadius: "var(--khr-radius)",
  padding: "6px 8px",
  fontSize: 12,
  outline: "none",
};

export function StepWorkspace({
  step,
  onChange,
  descriptors,
  liveFloorAnu,
  earlierYieldNames,
  plannerNames,
  variant = false,
  pane = "both",
  editorHeight = 300,
  fillEditor = false,
}: StepWorkspaceProps): ReactNode {
  const [tab, setTab] = useState<StepTab>("config");
  const patch = (next: Partial<StepState>): void => onChange({ ...step, ...next });

  // Synthesize a single-tx BuilderState so the real tabs drive this step.
  const synthetic: BuilderState = {
    ...makeEmptyBuilderState(),
    pactCode: step.pactCode,
    config: step.config,
    payload: step.payload,
    gasPayer: step.gasPayer,
    signers: step.signers,
  };
  const fromBuilder = (next: BuilderState): void =>
    onChange({
      ...step,
      pactCode: next.pactCode,
      config: next.config as BuilderConfig,
      payload: next.payload as PayloadState,
      gasPayer: next.gasPayer as GasPayerState,
      signers: next.signers as SignerRow[],
    });

  const isPlanner = step.mode === "planner";
  const planners = plannerNames && plannerNames.length > 0 ? plannerNames : [...KNOWN_PLANNERS];
  const tabs = isPlanner ? ALL_TABS.filter((t) => t.key !== "payload") : ALL_TABS;
  const activeTab: StepTab = tabs.some((t) => t.key === tab) ? tab : "config";

  const showEditor = pane === "editor" || pane === "both";
  const showFields = pane === "fields" || pane === "both";

  const editorPane = (
    // `flex: 1, minHeight: 0` — NOT `height: "100%"`. This div is a FLEX ITEM
    // of its parent (ChainedBuilder's Pact-pane `panel` card, itself
    // `flex:1, minHeight:0` in a column). A percentage height on a flex item
    // doesn't reliably propagate the way `flex:1` does (the item's own
    // height resolution and the parent's definite-height resolution are both
    // mid-flight in the same layout pass) — every OTHER layer in this exact
    // chain (the panel card itself; `PactCodeEditor.tsx`'s own inner wrapper
    // around the CodeMirror mount) already uses this idiom; this was the one
    // link that didn't, and the cause of the Pact editor not filling its
    // pane (see docs/work/chained-builder-layout-tweaks/design.md #1).
    <div style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1, minHeight: 0 }}>
      {/* Mode + yield + idempotent (hidden for the single-tx variant). */}
      {!variant && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12 }}>
          <div>
            <label style={labelStyle}>Mode</label>
            <div
              style={{
                display: "inline-flex",
                gap: 2,
                border: "1px solid var(--khr-border)",
                borderRadius: "var(--khr-radius)",
                padding: 2,
                background: "var(--khr-inset)",
              }}
            >
              {(["single", "planner"] as const).map((m) => {
                const active = step.mode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => patch({ mode: m })}
                    style={{
                      fontSize: 11,
                      padding: "4px 12px",
                      borderRadius: "var(--khr-radius)",
                      border: "none",
                      cursor: "pointer",
                      background: active ? "var(--khr-accent-tint)" : "transparent",
                      color: active ? "var(--khr-accent)" : "var(--khr-text-dim)",
                    }}
                  >
                    {m === "single" ? "Single tx" : "Planner"}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label style={labelStyle}>Yield as (names this step&rsquo;s result for a later step)</label>
            <input
              type="text"
              value={step.yieldAs}
              onChange={(e) => patch({ yieldAs: e.target.value })}
              placeholder="e.g. amount (optional)"
              style={fieldStyle}
            />
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              color: "var(--khr-text-dim)",
              cursor: "pointer",
              paddingBottom: 4,
            }}
          >
            <input
              type="checkbox"
              checked={step.idempotent}
              onChange={(e) => patch({ idempotent: e.target.checked })}
            />
            idempotent
          </label>
        </div>
      )}

      {earlierYieldNames.length > 0 && (
        <p style={{ fontSize: 10, color: "var(--khr-text-dim2)", margin: 0 }}>
          Earlier yields you can reference via{" "}
          <code style={{ color: "var(--khr-accent)" }}>{'{"$yield":"name"}'}</code>:{" "}
          {earlierYieldNames.map((y) => (
            <code key={y} style={{ color: "var(--khr-accent)", marginRight: 6 }}>
              {y}
            </code>
          ))}
        </p>
      )}

      {/* Pact editor (single) or planner picker + params (planner). */}
      {isPlanner ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label style={labelStyle}>Built-in planner</label>
            <select
              value={step.plannerName || planners[0] || ""}
              onChange={(e) => patch({ plannerName: e.target.value })}
              style={fieldStyle}
            >
              {planners.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <p style={{ fontSize: 10, color: "var(--khr-text-dim2)", marginTop: 4 }}>
              A registered khronoton built-in. It builds its own Pact + payload from the params;
              set Config / Gas Payer / Signatures so the executor can sign its legs.
            </p>
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
            <label style={labelStyle}>Planner params (JSON)</label>
            <textarea
              value={step.plannerParamsJson}
              onChange={(e) => patch({ plannerParamsJson: e.target.value })}
              spellCheck={false}
              placeholder={'{ "amount": { "$yield": "amount" } }'}
              style={{ ...fieldStyle, fontFamily: "var(--khr-mono-font)", flex: 1, minHeight: 180, resize: "vertical" }}
            />
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0 }}>
          <PactCodeEditor
            value={step.pactCode}
            onChange={(pactCode) => patch({ pactCode })}
            height={editorHeight}
            fill={fillEditor}
          />
        </div>
      )}
    </div>
  );

  const fieldsPane = (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Tab strip + the reused single-tx tabs. */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 2,
          border: "1px solid var(--khr-border)",
          borderRadius: "var(--khr-radius)",
          padding: 2,
          background: "var(--khr-inset)",
        }}
      >
        {tabs.map((t) => {
          const active = activeTab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              style={{
                flex: 1,
                fontSize: 11,
                padding: "6px 4px",
                borderRadius: "var(--khr-radius)",
                border: "none",
                cursor: "pointer",
                whiteSpace: "nowrap",
                background: active ? "var(--khr-accent-tint)" : "transparent",
                color: active ? "var(--khr-accent)" : "var(--khr-text-dim)",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {activeTab === "config" && (
        <ConfigTab state={synthetic} onChange={fromBuilder} liveFloorAnu={liveFloorAnu} />
      )}
      {activeTab === "payload" && !isPlanner && (
        <PayloadTab state={synthetic} onChange={(payload) => patch({ payload })} />
      )}
      {activeTab === "gas-payer" && (
        <GasPayerTab state={synthetic} onChange={fromBuilder} signers={descriptors} />
      )}
      {activeTab === "signatures" && (
        <SignaturesTab state={synthetic} onChange={fromBuilder} signers={descriptors} />
      )}
    </div>
  );

  if (pane === "editor") return editorPane;
  if (pane === "fields") return fieldsPane;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {showEditor && editorPane}
      {showFields && fieldsPane}
    </div>
  );
}
