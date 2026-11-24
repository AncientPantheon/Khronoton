/**
 * StepRail — the left-hand step list for the chained builder.
 *
 * Implements the "Step 0" model by LABEL, not by moving content:
 *   - 1 step  → it is labeled "Step 0" (a plain single cronoton).
 *   - ≥2 steps → they are "Step 1 … N", and a "Step 0 · single-tx" variant slot
 *     appears at the top (the whole chain as one tx, tried first at fire).
 * Adding a 2nd step therefore just relabels the first from "Step 0" to "Step 1"
 * and reveals the (initially empty) variant slot — no step content ever moves.
 *
 * `selected` is the steps index, or `-1` for the variant slot.
 */
import type { CSSProperties, ReactNode } from "react";

import { stepLabel, type StepState } from "../chained-builder-state.js";

export const VARIANT_SELECTION = -1;

export interface StepRailProps {
  steps: StepState[];
  variant: StepState | null;
  selected: number;
  onSelect: (sel: number) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onMove: (index: number, delta: number) => void;
  onToggleVariant: (enable: boolean) => void;
}

const rowBase: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  textAlign: "left",
  padding: "8px 10px",
  borderRadius: "var(--khr-radius)",
  border: "1px solid var(--khr-border)",
  background: "var(--khr-panel)",
  color: "var(--khr-text)",
  cursor: "pointer",
  fontSize: 12,
};

function iconBtn(onClick: () => void, label: string, disabled = false): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        border: "1px solid var(--khr-border)",
        background: "var(--khr-inset)",
        color: disabled ? "var(--khr-text-dim2)" : "var(--khr-text-dim)",
        borderRadius: 4,
        width: 20,
        height: 20,
        lineHeight: "16px",
        fontSize: 11,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        padding: 0,
      }}
    >
      {label}
    </button>
  );
}

export function StepRail({
  steps,
  variant,
  selected,
  onSelect,
  onAdd,
  onRemove,
  onMove,
  onToggleVariant,
}: StepRailProps): ReactNode {
  const chained = steps.length >= 2;

  const highlight = (active: boolean): CSSProperties =>
    active
      ? { borderColor: "var(--khr-accent)", background: "var(--khr-accent-tint)" }
      : {};

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--khr-text-dim)",
        }}
      >
        Steps ({steps.length})
      </div>

      {/* Step 0 — the single-tx variant slot (only once chained). */}
      {chained && (
        <div style={{ ...rowBase, ...highlight(selected === VARIANT_SELECTION), flexDirection: "column", alignItems: "stretch", gap: 6 }}>
          <button
            type="button"
            onClick={() => onSelect(VARIANT_SELECTION)}
            style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
          >
            <span style={{ fontWeight: 600 }}>Step 0</span>
            <span style={{ color: "var(--khr-text-dim)" }}>· single-tx variant</span>
            <span style={{ marginLeft: "auto", fontSize: 10, color: variant ? "var(--khr-success)" : "var(--khr-text-dim2)" }}>
              {variant ? "set" : "empty"}
            </span>
          </button>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--khr-text-dim)" }}>
            <input
              type="checkbox"
              checked={variant !== null}
              onChange={(e) => onToggleVariant(e.target.checked)}
            />
            try single-tx first
          </label>
        </div>
      )}

      {/* The chain steps. */}
      {steps.map((step, i) => {
        const active = selected === i;
        return (
          <div key={step.key} style={{ ...rowBase, ...highlight(active) }} onClick={() => onSelect(i)}>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
              <span style={{ fontWeight: 600 }}>{stepLabel(steps, i)}</span>
              <span style={{ fontSize: 10, color: "var(--khr-text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {step.mode === "planner" ? step.plannerName || "planner" : "single tx"}
                {step.yieldAs ? ` → ${step.yieldAs}` : ""}
              </span>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {iconBtn(() => onMove(i, -1), "↑", i === 0)}
              {iconBtn(() => onMove(i, 1), "↓", i === steps.length - 1)}
              {iconBtn(() => onRemove(i), "✕", steps.length <= 1)}
            </div>
          </div>
        );
      })}

      <button
        type="button"
        onClick={onAdd}
        style={{
          ...rowBase,
          justifyContent: "center",
          borderStyle: "dashed",
          color: "var(--khr-accent)",
          background: "transparent",
        }}
      >
        + Add step
      </button>
    </div>
  );
}
