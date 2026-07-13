import type { ReactNode } from "react";

/**
 * The theming boundary. Every Khronoton UI surface renders inside a
 * `<KhronotonUiRoot>` so the `.khronoton-ui` scope carries the `--khr-*`
 * tokens (see `@ancientpantheon/khronoton-core/ui.css`). Components style
 * exclusively via inline `var(--khr-*)` — no Tailwind/utility classes ship.
 *
 * A consumer recolors by overriding the tokens at `body .khronoton-ui`:
 *
 * ```css
 * body .khronoton-ui { --khr-accent: #d4a04a; --khr-bg: #0d0a07; }
 * ```
 */
export interface KhronotonUiRootProps {
  children: ReactNode;
  /** Extra classes merged after the `khronoton-ui` scope class. */
  className?: string;
}

export function KhronotonUiRoot({ children, className }: KhronotonUiRootProps): ReactNode {
  const cls = className ? `khronoton-ui ${className}` : "khronoton-ui";
  return <div className={cls}>{children}</div>;
}
