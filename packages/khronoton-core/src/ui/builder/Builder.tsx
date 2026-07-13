/**
 * Builder assembly — the two-pane create/edit form (REQ-B01/B02/B11).
 *
 * This is the single owner of the shared {@link BuilderState}: it hosts the
 * already-built controlled tabs (Config, Payload, Gas Payer, Signatures, Execute)
 * and the Pact editor, wires each tab's `onChange` back into the one state, fetches
 * the signer descriptors exactly once, and routes Commit through the create/edit
 * action hooks (both confirm-gated via `runGated`).
 *
 * onChange contract per tab (the load-bearing detail): every tab EXCEPT Payload
 * emits a full next `BuilderState` (so we pass `setState` directly); `PayloadTab`
 * emits a `PayloadState` slice, which we splice back into the whole state. The tabs
 * are controlled children — nothing owns form state but this component, so a tab
 * switch never loses an edit.
 *
 * Edit mode (`editId`): the persisted row is fetched once and rehydrated through
 * `detailToBuilderState` (payload forced to raw mode, gas price → ANU, signers
 * lossy, schedule preserved, the create-only Row C hidden). Save issues a PATCH via
 * `edit.run` (the patch is the full commit body — `EditPatch = Partial<CommitBody>`)
 * rather than a create POST. On success either path calls `onDone` with the id.
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { useCronotonActions } from "../../hooks/index.js";
import { useKhronotonAdapter } from "../../provider/context.js";
import type { CodexSignerDescriptor } from "../../handlers/index.js";
import type { CodexCronotonRow } from "../../server/index.js";
import type { Access } from "../access.js";
import {
  builderToCommit,
  detailToBuilderState,
  makeEmptyBuilderState,
  type BuilderState,
} from "../builder-state.js";
import { PactCodeEditor } from "../PactCodeEditor.js";
import { BuilderHeader } from "./BuilderHeader.js";
import { ConfigTab } from "./ConfigTab.js";
import { PayloadTab } from "./PayloadTab.js";
import { GasPayerTab } from "./GasPayerTab.js";
import { SignaturesTab } from "./SignaturesTab.js";
import { ExecuteTab } from "./ExecuteTab.js";

/** Default `<meta name="robots">` for the builder route (host-overridable). */
export const DEFAULT_BUILDER_ROBOTS = "noindex,nofollow";

export interface BuilderProps {
  /** Present → edit mode: rehydrate this cronoton and PATCH on save. Absent → create. */
  readonly editId?: string;
  /** Viewer tier; the builder is an admin-only surface (the host gates the route). */
  readonly access: Access;
  /** Called with the new/edited id after a successful commit so the host can navigate. */
  readonly onDone?: (id?: string) => void;
  /** Robots directive rendered into `<meta name="robots">`. */
  readonly robots?: string;
}

type TabKey = "config" | "payload" | "gas-payer" | "signatures" | "execute";

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "config", label: "Config" },
  { key: "payload", label: "Payload" },
  { key: "gas-payer", label: "Gas Payer" },
  { key: "signatures", label: "Signatures" },
  { key: "execute", label: "Execute" },
];

const PANE_WRAP: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
  gap: "1rem",
  alignItems: "start",
};

const TABLIST: CSSProperties = {
  display: "flex",
  gap: "0.25rem",
  borderBottom: "1px solid var(--khr-border)",
  marginBottom: "1rem",
};

const TAB_BASE: CSSProperties = {
  appearance: "none",
  border: "none",
  background: "transparent",
  color: "var(--khr-text-dim)",
  padding: "0.5rem 0.85rem",
  borderRadius: "var(--khr-radius) var(--khr-radius) 0 0",
  cursor: "pointer",
  fontSize: "0.85rem",
};

const TAB_ACTIVE: CSSProperties = {
  background: "var(--khr-accent-tint)",
  color: "var(--khr-accent)",
};

const EDIT_BANNER: CSSProperties = {
  border: "1px solid var(--khr-border)",
  borderRadius: "var(--khr-radius)",
  background: "var(--khr-inset)",
  color: "var(--khr-text-dim)",
  padding: "0.75rem 1rem",
  marginBottom: "1rem",
  fontSize: "0.85rem",
};

/**
 * The two-pane codex-cronoton builder. Owns `BuilderState`; renders the Pact editor
 * on the left and the header + five-tab bar on the right, feeding every tab the
 * shared state and folding its `onChange` back in.
 */
export function Builder({
  editId,
  access: _access,
  onDone,
  robots = DEFAULT_BUILDER_ROBOTS,
}: BuilderProps): ReactNode {
  const adapter = useKhronotonAdapter();
  const actions = useCronotonActions(editId);

  const [state, setState] = useState<BuilderState>(() => makeEmptyBuilderState());
  const [signers, setSigners] = useState<CodexSignerDescriptor[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("config");
  const [committing, setCommitting] = useState(false);
  const [editRow, setEditRow] = useState<CodexCronotonRow | null>(null);
  // The id whose row has been rehydrated into `state`. Tracking the id (not a
  // one-shot boolean) makes switching `editId` on a mounted Builder correct: a new
  // id re-fetches and re-rehydrates instead of being discarded by an always-true
  // guard (which would leave the old row's body bound to the new id's PATCH).
  const [loadedEditId, setLoadedEditId] = useState<string | undefined>(undefined);

  const isEdit = Boolean(editId);
  // In edit mode the form is gated until the CURRENT id's row has loaded, so the
  // pre-seeded empty form is never editable (and never committable) against a row
  // that hasn't arrived — and a user edit can't be clobbered by a late rehydrate.
  const editReady = !editId || loadedEditId === editId;

  // Fetch the signer descriptors ONCE (the pickers on Gas Payer + Signatures read
  // them); a failure just leaves the pickers empty rather than blocking the form.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const view = await adapter.signers();
        if (active && view.ok) setSigners(view.signers);
      } catch {
        /* signers optional — leave the pickers empty */
      }
    })();
    return () => {
      active = false;
    };
  }, [adapter]);

  // Edit mode: load the persisted row for the current `editId` and rehydrate the
  // whole form from it. Re-runs when `editId` changes (a superseded in-flight load
  // is dropped by the `active` token), so switching targets on a mounted Builder
  // loads the right row and rebinds the PATCH to it.
  useEffect(() => {
    if (!editId) return;
    let active = true;
    void (async () => {
      try {
        const view = await adapter.get(editId);
        if (!active) return;
        setEditRow(view.codexCronoton);
        setState(detailToBuilderState(view.codexCronoton));
        setLoadedEditId(editId);
      } catch {
        /* leave the form gated on a failed load rather than editing a phantom row */
      }
    })();
    return () => {
      active = false;
    };
  }, [adapter, editId]);

  // Commit: create → POST + onDone(newId); edit → PATCH the bound id + onDone(id).
  // ExecuteTab owns the enabled/blocking gate, so it only fires this when open.
  const handleCommit = useCallback(async () => {
    setCommitting(true);
    try {
      const body = builderToCommit(state);
      if (isEdit && editId) {
        const res = await actions.edit.run(body);
        if (res.ok) onDone?.(editId);
        else window.alert(res.error.message);
      } else {
        const res = await actions.create.run(body);
        if (res.ok) onDone?.(res.result.codexCronotonId);
        else window.alert(res.error.message);
      }
    } finally {
      setCommitting(false);
    }
  }, [state, isEdit, editId, actions, onDone]);

  // Cosmetic: surface the calibrated gas limit under AUTO (ExecuteTab writes it back
  // into `config.gasLimit` + `autoGasLimit` after a successful Simulate).
  const calibratedGasLimit = state.config.autoGasLimit ? state.config.gasLimit : null;

  return (
    <div className="khronoton-ui">
      <meta name="robots" content={robots} />

      {isEdit && (
        <div style={EDIT_BANNER}>
          <p style={{ margin: 0 }}>
            Edits apply at the NEXT fire. Payload opens in raw-JSON mode. Re-run Simulate before
            saving.
          </p>
          {editRow && (
            <p style={{ margin: "0.35rem 0 0" }}>
              Current schedule: {editRow.schedule_mode} · Status: {editRow.status}
            </p>
          )}
        </div>
      )}

      {editReady ? (
        <div style={PANE_WRAP}>
        {/* Left pane — the Pact code editor bound to the shared state. */}
        <PactCodeEditor
          value={state.pactCode}
          onChange={(pactCode) => setState((s) => ({ ...s, pactCode }))}
          onClear={() => setState((s) => ({ ...s, pactCode: "" }))}
        />

        {/* Right pane — header above the five-tab bar. */}
        <div>
          <BuilderHeader state={state} onChange={setState} isEdit={isEdit} />

          <div role="tablist" style={TABLIST}>
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={activeTab === t.key}
                onClick={() => setActiveTab(t.key)}
                style={{ ...TAB_BASE, ...(activeTab === t.key ? TAB_ACTIVE : {}) }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {activeTab === "config" && (
            <ConfigTab state={state} onChange={setState} calibratedGasLimit={calibratedGasLimit} />
          )}
          {activeTab === "payload" && (
            <PayloadTab state={state} onChange={(payload) => setState((s) => ({ ...s, payload }))} />
          )}
          {activeTab === "gas-payer" && (
            <GasPayerTab state={state} onChange={setState} signers={signers} />
          )}
          {activeTab === "signatures" && (
            <SignaturesTab state={state} onChange={setState} signers={signers} />
          )}
          {activeTab === "execute" && (
            <ExecuteTab
              state={state}
              onChange={setState}
              onCommit={handleCommit}
              committing={committing}
            />
          )}
        </div>
        </div>
      ) : (
        <p style={{ color: "var(--khr-text-dim)", padding: "1rem 0" }}>Loading cronoton…</p>
      )}
    </div>
  );
}
