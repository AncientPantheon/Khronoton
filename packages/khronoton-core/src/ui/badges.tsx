import type { CSSProperties, ReactNode } from "react";

import type {
  CodexCronotonRow,
  CodexCronotonFireRow,
  CodexFireMode,
} from "../server/types.js";

/**
 * Presentational status/mode atoms for the codex-cronoton surfaces. Every atom
 * styles ONLY via inline `var(--khr-*)` tokens (see `ui.css`); the state → color
 * + label decisions live in the pure `*Style` maps below so they can be unit
 * tested and reused (e.g. a status legend) without mounting React.
 */

export type CronotonStatus = CodexCronotonRow["status"];
export type FireStatus = CodexCronotonFireRow["status"];
export type FireMode = CodexFireMode;

export interface BadgeStyle {
  /** Foreground token — also the dot color via `currentColor`. */
  color: string;
  /** Pill background token. */
  background: string;
  /** Optional visible border (only `nothing` uses one). */
  borderColor?: string;
  /** Human-facing label. */
  label: string;
  /** True for the in-flight `running` fire — drives the pulse animation. */
  pulse?: boolean;
}

export interface ModeChipStyle {
  color: string;
  borderColor: string;
  label: string;
  /** Hover tooltip — present only for TEST (pre-live-lock provenance). */
  title?: string;
}

const CRONOTON_STATUS_STYLE: Record<CronotonStatus, BadgeStyle> = {
  active: {
    color: "var(--khr-accent)",
    background: "color-mix(in srgb, var(--khr-accent) 18%, transparent)",
    label: "active",
  },
  paused: {
    color: "var(--khr-text-dim)",
    background: "color-mix(in srgb, var(--khr-text-dim) 16%, transparent)",
    label: "paused",
  },
  completed: {
    color: "var(--khr-success)",
    background: "var(--khr-success-bg)",
    label: "completed",
  },
  error: {
    color: "var(--khr-error)",
    background: "var(--khr-error-bg)",
    label: "error",
  },
};

const FIRE_STATUS_STYLE: Record<FireStatus, BadgeStyle> = {
  success: {
    color: "var(--khr-success)",
    background: "var(--khr-success-bg)",
    label: "success",
  },
  running: {
    color: "var(--khr-amber)",
    background: "var(--khr-amber-bg)",
    label: "running…",
    pulse: true,
  },
  nothing: {
    color: "var(--khr-nothing)",
    background: "var(--khr-nothing-bg)",
    borderColor: "color-mix(in srgb, var(--khr-nothing) 40%, transparent)",
    label: "Nothing to pay",
  },
  failure: {
    color: "var(--khr-error)",
    background: "var(--khr-error-bg)",
    label: "failure",
  },
};

const MODE_CHIP_STYLE: Record<FireMode, ModeChipStyle> = {
  live: {
    color: "var(--khr-success)",
    borderColor: "color-mix(in srgb, var(--khr-success) 55%, transparent)",
    label: "LIVE",
  },
  test: {
    color: "var(--khr-amber)",
    borderColor: "color-mix(in srgb, var(--khr-amber) 50%, transparent)",
    label: "TEST",
    title: "Test fire — recorded before the Stoicism live state was locked",
  },
};

export function cronotonStatusStyle(status: CronotonStatus): BadgeStyle {
  return CRONOTON_STATUS_STYLE[status];
}

export function fireStatusStyle(status: FireStatus): BadgeStyle {
  return FIRE_STATUS_STYLE[status];
}

export function modeChipStyle(mode: FireMode): ModeChipStyle {
  return MODE_CHIP_STYLE[mode];
}

const PULSE_KEYFRAMES = "@keyframes khr-pulse{50%{opacity:0.55;}}";

const BADGE_BASE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  fontSize: "11px",
  fontWeight: 600,
  padding: "2px 8px",
  borderRadius: "999px",
  whiteSpace: "nowrap",
};

const PILL_BASE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  fontSize: "11px",
  fontWeight: 600,
  padding: "2px 8px",
  borderRadius: "999px",
  whiteSpace: "nowrap",
};

/** A dot-prefixed status pill (`currentColor` dot, matching the mockup). */
function DotBadge({ style }: { style: BadgeStyle }): ReactNode {
  const css: CSSProperties = {
    ...BADGE_BASE,
    color: style.color,
    background: style.background,
    border: `1px solid ${style.borderColor ?? "transparent"}`,
    ...(style.pulse ? { animation: "khr-pulse 1.6s ease-in-out infinite" } : {}),
  };
  return (
    <>
      {style.pulse ? <style>{PULSE_KEYFRAMES}</style> : null}
      <span
        className="khr-badge"
        style={css}
        data-pulse={style.pulse ? "true" : undefined}
      >
        <span
          aria-hidden="true"
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: "currentColor",
            flex: "none",
          }}
        />
        {style.label}
      </span>
    </>
  );
}

export function CronotonStatusBadge({
  status,
}: {
  status: CronotonStatus;
}): ReactNode {
  return <DotBadge style={cronotonStatusStyle(status)} />;
}

export function FireStatusBadge({ status }: { status: FireStatus }): ReactNode {
  return <DotBadge style={fireStatusStyle(status)} />;
}

export function ModeChip({ mode }: { mode: FireMode }): ReactNode {
  const s = modeChipStyle(mode);
  return (
    <span
      className="khr-mode-chip"
      title={s.title}
      style={{
        fontSize: "10px",
        fontWeight: 700,
        letterSpacing: "0.04em",
        padding: "1px 6px",
        borderRadius: "4px",
        border: `1px solid ${s.borderColor}`,
        color: s.color,
        whiteSpace: "nowrap",
      }}
    >
      {s.label}
    </span>
  );
}

export function ServerResolverPill(): ReactNode {
  return (
    <span
      className="khr-pill khr-pill-resolver"
      style={{
        ...PILL_BASE,
        color: "var(--khr-amber)",
        background: "var(--khr-amber-bg)",
      }}
    >
      ⟳ Updates server state on success
    </span>
  );
}

export function ExternallyFireablePill(): ReactNode {
  return (
    <span
      className="khr-pill khr-pill-external"
      style={{
        ...PILL_BASE,
        color: "var(--khr-accent)",
        background: "var(--khr-accent-tint)",
        border: "1px solid color-mix(in srgb, var(--khr-accent) 40%, transparent)",
      }}
    >
      ⚡ externally fireable
    </span>
  );
}
