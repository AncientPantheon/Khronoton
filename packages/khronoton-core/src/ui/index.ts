/**
 * `@ancientpantheon/khronoton-core/ui` — the React surface: the four screens
 * (List, Detail, Builder create+edit, Public read-only), the theming boundary
 * (`KhronotonUiRoot`), and the presentational leaves a host may compose directly
 * (`RelativeTime`, the status/mode badges + resolver/external-fire pills). Data
 * comes from `/hooks` over a `/provider` adapter; style is inline `var(--khr-*)`
 * inside `<KhronotonUiRoot>`; consumers import the tokens once:
 * `import "@ancientpantheon/khronoton-core/ui.css"`.
 *
 * Built by the tsup `/ui` entry (`react` external). The `.`/`/server`/`/handlers`
 * outputs stay byte-stable — nothing here is imported by those layers.
 *
 * ── Parity self-check (feeds the Phase-F REQ-V05 doc-gate) ────────────────────
 * Every [PARITY] item from `.bee/recon/codex-cronoton-parity-inventory.md` is
 * present in the delivered tree (screens compose the leaves internally):
 *   • §1 List  — `List`/`CronotonList`: three access tiers, per-row resolver pill,
 *       Next/Last-fire, status badge, confirm-gated actions, footer, robots.
 *   • §2 Detail — `Detail`: header actions + disable rules, batch-active Execute
 *       block, two-column metadata, and the fire-history card carrying the
 *       result tooltip, definition-drift flag, pluggable multi-tx seam, explorer
 *       deep-links, the WIRED recover affordance, and the 50/page pager.
 *   • §3 Builder — `Builder`: two-pane editor + Config/Payload/Gas Payer/
 *       Signatures/Execute tabs, Simulate→AUTO-gas calibrate, commit gate, and
 *       edit-mode rehydration (payload forced raw, create-only Row C hidden).
 *   • §Public — `Public`: the same Detail tree at `access: 'logged-out'`
 *       (controls hidden, cards suppressed, fire history + explorer links kept).
 *   • Verbatim strings, three tiers, and the generic seams (explorer knob, mode
 *       column, resolver registry, multi-tx renderer, external-fire flag,
 *       configurable robots) live in the leaves re-exported below.
 */

// ── Theming boundary ──────────────────────────────────────────────────────────
export { KhronotonUiRoot } from "./KhronotonUiRoot.js";
export type { KhronotonUiRootProps } from "./KhronotonUiRoot.js";

// ── Screen 1: List (file is `CronotonList`; `List` is the parity-named alias) ──
export { CronotonList, CronotonList as List, DEFAULT_LIST_ROBOTS } from "./CronotonList.js";
export type { CronotonListProps, CronotonListRow } from "./CronotonList.js";

// ── Screen 2: Detail / Observe ────────────────────────────────────────────────
export { Detail, DEFAULT_DETAIL_ROBOTS } from "./Detail.js";
export type { DetailProps } from "./Detail.js";

// ── Screen 3: Builder (create + edit) ─────────────────────────────────────────
export { Builder, DEFAULT_BUILDER_ROBOTS } from "./builder/Builder.js";
export type { BuilderProps } from "./builder/Builder.js";

// ── Screen 4: Public read-only view ───────────────────────────────────────────
export { Public, DEFAULT_PUBLIC_ROBOTS } from "./Public.js";
export type { PublicProps } from "./Public.js";

// ── Access-tier model (consumers build the `access` prop the screens take) ────
export type { Access, AccessTier } from "./access.js";

// ── Presentational leaves a host may compose directly ─────────────────────────
export { RelativeTime } from "./RelativeTime.js";
export type { RelativeTimeProps } from "./RelativeTime.js";
export {
  CronotonStatusBadge,
  FireStatusBadge,
  ModeChip,
  ServerResolverPill,
  ExternallyFireablePill,
} from "./badges.js";
