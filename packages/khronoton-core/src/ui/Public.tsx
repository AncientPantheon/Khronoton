/**
 * `<Public>` — the read-only public transparency wrapper over `<Detail>`.
 *
 * This is NOT a fork of Detail: it REUSES `<Detail>` with a fixed logged-out
 * access tier. Detail already gates every control on `access` via the shared
 * predicates, so pinning `access.tier` to `"logged-out"` hides all mutation
 * affordances, the `<ManualBatchCard>` and `<RuntimeArgTriggerCard>` self-suppress
 * to null, and the metadata panel + `<FireHistory>` (with Explorer verify links)
 * remain visible — the whole point of a public transparency view. A public
 * viewer's fire-poll hitting a gated JSON route fails silently: the underlying
 * poller already swallows poll errors, so no error UI is (or should be) added.
 *
 * Detail owns the `<meta name="robots">`, so `robots` is only threaded through —
 * never re-rendered here. Around Detail this adds a public chrome: a top bar
 * announcing the read-only nature and an attribution footer reused verbatim from
 * the list's logged-out footer.
 *
 * ## Mount discipline (REQ-PB03)
 * The tree is browser-only — fire pollers and self-refreshing `RelativeTime`
 * timers must NOT be server-rendered. The host mounts `<Public>` through an
 * `ssr:false` dynamic import (or the framework equivalent):
 *
 * ```tsx
 * import dynamic from "next/dynamic";
 *
 * const Public = dynamic(
 *   () => import("@ancientpantheon/khronoton-core/ui").then((m) => m.Public),
 *   { ssr: false },
 * );
 *
 * export default function PublicCronotonPage({ params }: { params: { id: string } }) {
 *   return (
 *     <KhronotonProvider adapter={publicAdapter}>
 *       <KhronotonUiRoot>
 *         <Public id={params.id} />
 *       </KhronotonUiRoot>
 *     </KhronotonProvider>
 *   );
 * }
 * ```
 */
import type { CSSProperties, ReactNode } from "react";

import type { Access } from "./access.js";
import { Detail, DEFAULT_DETAIL_ROBOTS } from "./Detail.js";

/** The default `robots` policy for the public view — readable but not indexable. */
export const DEFAULT_PUBLIC_ROBOTS = DEFAULT_DETAIL_ROBOTS;

/** The fixed viewer tier: a public visitor can read everything, mutate nothing. */
const PUBLIC_ACCESS: Access = { tier: "logged-out" };

/** The top bar copy — factual: only the schedule metadata and fire history show. */
const PUBLIC_BAR_TEXT =
  "Public view — read-only transparency into this codex cronoton's schedule and fire history.";

/** The attribution footer, verbatim from the list's logged-out footer (REQ-L08). */
const PUBLIC_FOOTER_TEXT = "Public view — read only. Sign in as an Ancient admin to manage.";

const BAR_STYLE: CSSProperties = {
  marginBottom: "16px",
  padding: "10px 14px",
  borderRadius: "8px",
  border: "1px solid var(--khr-border)",
  background: "var(--khr-surface)",
  color: "var(--khr-text-dim)",
  fontSize: "12px",
};

const FOOTER_STYLE: CSSProperties = {
  marginTop: "24px",
  color: "var(--khr-text-dim)",
  fontSize: "12px",
};

export interface PublicProps {
  /** The cronoton to observe read-only. */
  id: string;
  /** The page `robots` meta content; defaults to noindex,nofollow. */
  robots?: string;
}

export function Public({ id, robots = DEFAULT_PUBLIC_ROBOTS }: PublicProps): ReactNode {
  return (
    <>
      <div style={BAR_STYLE}>{PUBLIC_BAR_TEXT}</div>
      <Detail id={id} access={PUBLIC_ACCESS} robots={robots} />
      <p style={FOOTER_STYLE}>{PUBLIC_FOOTER_TEXT}</p>
    </>
  );
}
