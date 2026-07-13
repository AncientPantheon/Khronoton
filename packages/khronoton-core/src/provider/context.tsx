/**
 * React contexts + hooks for the Khronoton experience layer.
 *
 * Two contexts split the value by change-frequency (blueprint §2):
 *  - STATIC  `{ adapter, config }` — built once per mount, never rebuilt on
 *    re-render (the adapter identity is stable so data hooks don't re-fetch).
 *  - STATUS  `{ ready, error }` — flips after the browser-only init effect runs.
 *
 * The public `useKhronoton()` reads both (mirrors Codex's `useCodex`); the
 * internal `useKhronotonAdapter()` / `useKhronotonConfig()` feed the data +
 * action hooks (the rest of Phase D) without dragging the status re-render along.
 */
import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import type { KhronotonAdapter } from "./adapter.js";
import type { CodexCronotonFireRow } from "../server/index.js";

/** Default explorer base — the StoaChain transactions view (REQ-G02). */
export const DEFAULT_EXPLORER_BASE = "https://explorer.stoachain.com/transactions";
/** Default fire-history page size (REQ-PH04, REQ-G08). */
export const DEFAULT_PAGE_SIZE = 50;
/** Default poller cadence in ms (REQ-PH06) — the two 5s pollers read this. */
export const DEFAULT_POLL_CADENCE_MS = 5000;

/** A registry-driven server-resolver dropdown option. */
export interface ServerResolverOption {
  value: string;
  label: string;
  /** Optional gold side-note shown in the builder when this resolver is selected. */
  note?: string;
}

/** A pluggable multi-tx breakdown renderer (the Hub's pool-payout is one impl). */
export type RenderMultiTx = (fire: CodexCronotonFireRow) => ReactNode;

/**
 * The host re-confirm gate: resolves `true` when the user re-confirms after an
 * expired admin-confirm (driving `runGated`'s single retry), `false` on cancel.
 */
export type ConfirmGate = () => Promise<boolean>;

/** The resolved config every consumer reads — all defaults already applied. */
export interface KhronotonConfig {
  explorerBase: string;
  showMode: boolean;
  renderMultiTx?: RenderMultiTx;
  serverResolverOptions: ServerResolverOption[];
  pageSize: number;
  pollCadenceMs: number;
  onNeedConfirm?: ConfirmGate;
}

/** The `<KhronotonProvider>` props: a required adapter + optional config. */
export interface KhronotonProviderProps {
  /** REQUIRED — the consumer data seam; validated by `assertAdapter` at mount. */
  adapter: KhronotonAdapter;
  explorerBase?: string;
  onNeedConfirm?: ConfirmGate;
  showMode?: boolean;
  renderMultiTx?: RenderMultiTx;
  serverResolverOptions?: ServerResolverOption[];
  pageSize?: number;
  pollCadenceMs?: number;
  children?: ReactNode;
}

/** Apply the defaults for every unset config prop (REQ-G02, REQ-PH04/06). */
export function resolveConfig(props: KhronotonProviderProps): KhronotonConfig {
  return {
    explorerBase: props.explorerBase ?? DEFAULT_EXPLORER_BASE,
    showMode: props.showMode ?? true,
    renderMultiTx: props.renderMultiTx,
    serverResolverOptions: props.serverResolverOptions ?? [],
    pageSize: props.pageSize ?? DEFAULT_PAGE_SIZE,
    pollCadenceMs: props.pollCadenceMs ?? DEFAULT_POLL_CADENCE_MS,
    onNeedConfirm: props.onNeedConfirm,
  };
}

export interface KhronotonStaticContextValue {
  adapter: KhronotonAdapter;
  config: KhronotonConfig;
}

export interface KhronotonStatusContextValue {
  ready: boolean;
  error: Error | null;
}

export const KhronotonStaticContext = createContext<KhronotonStaticContextValue | null>(null);
export const KhronotonStatusContext = createContext<KhronotonStatusContextValue | null>(null);

function useStatic(caller: string): KhronotonStaticContextValue {
  const value = useContext(KhronotonStaticContext);
  if (value === null) {
    throw new Error(`${caller} must be used within a <KhronotonProvider>`);
  }
  return value;
}

/** Internal: the injected adapter, for the data + action hooks. */
export function useKhronotonAdapter(): KhronotonAdapter {
  return useStatic("useKhronotonAdapter").adapter;
}

/** Internal: the resolved config (page size, cadence, explorer base, policies). */
export function useKhronotonConfig(): KhronotonConfig {
  return useStatic("useKhronotonConfig").config;
}

/** The public `useKhronoton()` result: readiness + the resolved seam/config. */
export interface UseKhronotonResult {
  ready: boolean;
  error: Error | null;
  adapter: KhronotonAdapter;
  config: KhronotonConfig;
}

/**
 * The top-level consumer hook (mirrors Codex's `useCodex`): `ready` flips true
 * after the browser-only init, `error` holds an init failure, and `config` +
 * `adapter` are the resolved seam the UI reads.
 */
export function useKhronoton(): UseKhronotonResult {
  const { adapter, config } = useStatic("useKhronoton");
  const status = useContext(KhronotonStatusContext);
  if (status === null) {
    throw new Error("useKhronoton must be used within a <KhronotonProvider>");
  }
  return { ready: status.ready, error: status.error, adapter, config };
}
