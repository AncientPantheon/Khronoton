/**
 * Zero-logic presentational shells reused across every codex-cronoton screen.
 *
 * Each shell styles ONLY via inline `var(--khr-*)` (the theming contract — see
 * `ui.css`) and mirrors the AncientHoldings Hub look from the mockup. They carry
 * no branching or business logic: the disable/tooltip decisions live in
 * `access.ts`, and the screens compose these shells around that. Every shell
 * forwards `style` (merged after its base) and `className` so a consumer can
 * extend without forking, and spreads the native element props it wraps.
 */

import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  ReactNode,
  TdHTMLAttributes,
} from "react";

interface ShellProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

const CARD_STYLE: CSSProperties = {
  background: "var(--khr-panel)",
  border: "1px solid var(--khr-border)",
  borderRadius: "var(--khr-radius-lg)",
};

/** The rounded surface a whole screen section sits on (list table, fire log). */
export function Card({ children, style, ...rest }: ShellProps): ReactNode {
  return (
    <div style={{ ...CARD_STYLE, ...style }} {...rest}>
      {children}
    </div>
  );
}

const PANEL_STYLE: CSSProperties = {
  background: "var(--khr-panel)",
  border: "1px solid var(--khr-border)",
  borderRadius: "var(--khr-radius)",
  padding: "14px",
};

/** A padded bordered box for form groups and metadata blocks. */
export function Panel({ children, style, ...rest }: ShellProps): ReactNode {
  return (
    <div style={{ ...PANEL_STYLE, ...style }} {...rest}>
      {children}
    </div>
  );
}

const TITLE_STYLE: CSSProperties = {
  color: "var(--khr-accent)",
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.09em",
  margin: "0 0 12px",
};

/** The gold uppercased section heading (e.g. "Transaction Configuration"). */
export function Title({ children, style, ...rest }: HTMLAttributes<HTMLHeadingElement>): ReactNode {
  return (
    <h3 style={{ ...TITLE_STYLE, ...style }} {...rest}>
      {children}
    </h3>
  );
}

const TABLE_STYLE: CSSProperties = { width: "100%", borderCollapse: "collapse" };

/** A full-width collapsed table shell. */
export function Table({ children, style, ...rest }: HTMLAttributes<HTMLTableElement>): ReactNode {
  return (
    <table style={{ ...TABLE_STYLE, ...style }} {...rest}>
      {children}
    </table>
  );
}

/** The table header group wrapper. */
export function Thead({ children, ...rest }: HTMLAttributes<HTMLTableSectionElement>): ReactNode {
  return <thead {...rest}>{children}</thead>;
}

/** A table row (`<tr>`) in either the head or the body. */
export function Row({ children, ...rest }: HTMLAttributes<HTMLTableRowElement>): ReactNode {
  return <tr {...rest}>{children}</tr>;
}

const TH_STYLE: CSSProperties = {
  textAlign: "left",
  fontSize: "10px",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--khr-text-dim)",
  padding: "9px 12px",
  background: "var(--khr-inset)",
  fontWeight: 600,
};

const TD_STYLE: CSSProperties = {
  padding: "10px 12px",
  borderTop: "1px solid var(--khr-border)",
  fontSize: "12.5px",
  verticalAlign: "middle",
};

interface CellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  /** `"th"` renders a header cell, the default `"td"` a body cell. */
  as?: "td" | "th";
  children?: ReactNode;
}

/** A table cell — header (`as="th"`) or body (default), styled to match. */
export function Cell({ as = "td", children, style, ...rest }: CellProps): ReactNode {
  const base = as === "th" ? TH_STYLE : TD_STYLE;
  const merged = { ...base, ...style };
  return as === "th" ? (
    <th style={merged} {...rest}>
      {children}
    </th>
  ) : (
    <td style={merged} {...rest}>
      {children}
    </td>
  );
}

const BUTTON_STYLE: CSSProperties = {
  border: "1px solid var(--khr-border)",
  background: "var(--khr-panel)",
  color: "var(--khr-text)",
  padding: "7px 13px",
  borderRadius: "6px",
  cursor: "pointer",
  font: "inherit",
  fontSize: "12px",
};

const DISABLED_STYLE: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

interface TextButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children?: ReactNode;
}

/** An action button (Delete, Pause, Execute Now, Cancel). */
export function TextButton({ children, style, disabled, ...rest }: TextButtonProps): ReactNode {
  return (
    <button
      type="button"
      disabled={disabled}
      style={{ ...BUTTON_STYLE, ...(disabled ? DISABLED_STYLE : null), ...style }}
      {...rest}
    >
      {children}
    </button>
  );
}

interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  children?: ReactNode;
}

/** A navigation action styled as a button (Edit, "+ New Codex Cronoton"). */
export function LinkButton({ children, style, ...rest }: LinkButtonProps): ReactNode {
  return (
    <a style={{ ...BUTTON_STYLE, textDecoration: "none", ...style }} {...rest}>
      {children}
    </a>
  );
}

const LABEL_STYLE: CSSProperties = {
  display: "block",
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.09em",
  color: "var(--khr-text-dim)",
  marginBottom: "5px",
};

interface FieldProps {
  label: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
}

/** A labelled form field — the label sits above the control it wraps. */
export function Field({ label, children, style }: FieldProps): ReactNode {
  return (
    <label style={{ display: "block", marginBottom: "14px", ...style }}>
      <span style={LABEL_STYLE}>{label}</span>
      {children}
    </label>
  );
}

const META_LABEL_STYLE: CSSProperties = { ...LABEL_STYLE, marginBottom: "3px" };

interface MetaCellProps {
  label: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
}

/** One cell of the detail metadata grid — a small label above its value. */
export function MetaCell({ label, children, style }: MetaCellProps): ReactNode {
  return (
    <div style={style}>
      <div style={META_LABEL_STYLE}>{label}</div>
      <div style={{ fontSize: "13px" }}>{children}</div>
    </div>
  );
}

const BADGE_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  fontSize: "11px",
  fontWeight: 600,
  padding: "2px 8px",
  borderRadius: "999px",
  border: "1px solid transparent",
  whiteSpace: "nowrap",
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children?: ReactNode;
}

/** The pill base every status/mode badge builds on (color set by the caller). */
export function Badge({ children, style, ...rest }: BadgeProps): ReactNode {
  return (
    <span style={{ ...BADGE_STYLE, ...style }} {...rest}>
      {children}
    </span>
  );
}
