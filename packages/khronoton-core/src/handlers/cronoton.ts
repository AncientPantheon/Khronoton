/**
 * Cronoton-lifecycle handlers: the confirm-gated commit/edit/pause/resume/delete
 * half of the codex-cronoton route surface.
 *
 * Each handler is a thin, framework-agnostic adapter over the `/server` store: it
 * runs behind the CONFIRM gate ({@link withConfirm} — every operation here mutates,
 * so a fresh admin-confirm is demanded), shapes the normalized request body into
 * the store's input, and lets the store's typed errors flow back through
 * {@link mapStoreError} (a `not found` → 404, any other validation → 400, a
 * terminal row → 409). The store functions are imported under `store*` aliases so
 * these handlers can carry the canonical contract names.
 *
 * Two invariants live in this layer rather than the store:
 * - **Shape validation (REQ-H01):** a malformed commit/edit body is a CLIENT error
 *   (400), so the body adapters throw {@link CodexCronotonValidationError} for a
 *   missing envelope/schedule instead of letting a `TypeError` become a 500.
 * - **Server-resolver delete-lock (REQ-H05):** a row bound to a server resolver is
 *   a system cronoton that must be paused, never deleted — the delete handler
 *   loads the row FIRST and refuses with 409 before the store's unconditional
 *   delete would run.
 *
 * Commit and delete emit an audit event through `ctx.onAudit` (the store does not
 * audit these transitions, so there is no double-audit); edit/pause/resume carry
 * no audit here.
 */
import {
  CodexCronotonValidationError,
  commitCodexCronoton as storeCommit,
  deleteCodexCronoton as storeDelete,
  editCodexCronoton as storeEdit,
  getCodexCronoton as storeGet,
  pauseCodexCronoton as storePause,
  resumeCodexCronoton as storeResume,
  type CodexGasPayer,
  type CodexSigner,
  type CodexTxConfig,
  type CommitCodexCronotonInput,
  type EditCodexCronotonPatch,
  type ScheduleConfig,
  type ScheduleMode,
} from "../server/index.js";
import { withConfirm, type AuthIdentity, type HandlerContext } from "./context.js";
import { json, type HandlerRequest, type HandlerResponse } from "./http.js";

// ── The commit/edit request contract (REQ-H01) ───────────────────────────────

/**
 * The transaction envelope half of a {@link CommitBody}: everything that
 * describes WHAT fires, independent of WHEN. Maps 1:1 onto the store input's
 * definition fields.
 */
export interface CommitEnvelope {
  pactCode: string;
  config: CodexTxConfig;
  payload?: Record<string, unknown>;
  gasPayer: CodexGasPayer;
  signers: CodexSigner[];
  serverResolver?: string;
  externalFireable?: boolean;
  runtimeArgKeys?: string[];
}

/** The schedule half of a {@link CommitBody}: mode + its config. */
export interface CommitSchedule {
  mode: ScheduleMode;
  config: ScheduleConfig;
}

/** The client-facing commit payload the route accepts (POST body). */
export interface CommitBody {
  name: string;
  description?: string | null;
  envelope: CommitEnvelope;
  schedule: CommitSchedule;
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new CodexCronotonValidationError(message);
  }
  return value as Record<string, unknown>;
}

/** Attribute a write to the gate identity, falling back to a system marker. */
function createdByOf(identity: AuthIdentity | undefined): string {
  return identity?.email ?? identity?.id ?? "system";
}

/**
 * Adapt a normalized `CommitBody` into the store's `CommitCodexCronotonInput`.
 * A missing/mistyped body, envelope, or schedule is surfaced as a 400 client
 * error (the store then validates the field-level shape — empty name, bad
 * config — and throws its own 400/404).
 */
function toCommitInput(body: unknown, createdBy: string): CommitCodexCronotonInput {
  const b = requireObject(body, "request body must be a commit object");
  const envelope = requireObject(b.envelope, "envelope is required") as unknown as CommitEnvelope;
  const schedule = requireObject(b.schedule, "schedule is required") as unknown as CommitSchedule;

  return {
    name: b.name as string,
    description: (b.description as string | null | undefined) ?? null,
    pactCode: envelope.pactCode,
    config: envelope.config,
    payload: envelope.payload ?? {},
    gasPayer: envelope.gasPayer,
    signers: envelope.signers ?? [],
    scheduleMode: schedule.mode,
    scheduleConfig: schedule.config,
    createdBy,
    serverResolver: envelope.serverResolver,
    externalFireable: envelope.externalFireable,
    runtimeArgKeys: envelope.runtimeArgKeys,
  };
}

/** Adapt a `Partial<CommitBody>` into a store edit patch (apply-at-next-fire). */
function toEditPatch(body: unknown): EditCodexCronotonPatch {
  const b = requireObject(body, "request body must be an edit object");
  const patch: EditCodexCronotonPatch = {};

  if (b.name !== undefined) patch.name = b.name as string;
  if (b.description !== undefined) patch.description = b.description as string | null;

  const env = b.envelope;
  if (env && typeof env === "object") {
    const e = env as CommitEnvelope;
    if (e.pactCode !== undefined) patch.pactCode = e.pactCode;
    if (e.config !== undefined) patch.config = e.config;
    if (e.payload !== undefined) patch.payload = e.payload;
    if (e.gasPayer !== undefined) patch.gasPayer = e.gasPayer;
    if (e.signers !== undefined) patch.signers = e.signers;
    if (e.serverResolver !== undefined) patch.serverResolver = e.serverResolver;
  }

  const sched = b.schedule;
  if (sched && typeof sched === "object") {
    const s = sched as CommitSchedule;
    patch.scheduleMode = s.mode;
    patch.scheduleConfig = s.config;
  }

  return patch;
}

function paramId(req: HandlerRequest): string {
  return req.params?.id ?? "";
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/** POST / — commit a new codex cronoton. Confirm-gated; 201 on success. */
export async function commitCodexCronoton(
  ctx: HandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  return withConfirm(ctx, req, async (identity) => {
    const input = toCommitInput(req.body, createdByOf(identity));
    const { id, nextFireAt } = storeCommit(input, { db: ctx.db });
    await ctx.onAudit?.({
      action: "codex_cronoton.commit",
      result: "ok",
      targetKind: "codex_cronoton",
      targetId: id,
      detail: { name: input.name },
    });
    return json(201, { ok: true, codexCronotonId: id, nextFireAt });
  });
}

/** PATCH /[id] — apply an at-next-fire edit. Confirm-gated; 404 when missing. */
export async function editCodexCronoton(
  ctx: HandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  return withConfirm(ctx, req, async () => {
    const { nextFireAt } = storeEdit(paramId(req), toEditPatch(req.body), { db: ctx.db });
    return json(200, { ok: true, nextFireAt });
  });
}

/** PATCH /[id]/pause — pause a running row. Confirm-gated; 409 when terminal. */
export async function pauseCodexCronoton(
  ctx: HandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  return withConfirm(ctx, req, async () => {
    const { status, nextFireAt } = storePause(paramId(req), { db: ctx.db });
    return json(200, { ok: true, status, nextFireAt });
  });
}

/** PATCH /[id]/resume — resume a paused row. Confirm-gated; 409 when terminal. */
export async function resumeCodexCronoton(
  ctx: HandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  return withConfirm(ctx, req, async () => {
    const { status, nextFireAt } = storeResume(paramId(req), { db: ctx.db });
    return json(200, { ok: true, status, nextFireAt });
  });
}

/**
 * DELETE /[id] — remove a codex cronoton. Confirm-gated. A row bound to a server
 * resolver is a SYSTEM cronoton: it is delete-locked (pause to disable instead),
 * so the handler loads the row first and refuses with 409 before the store's
 * unconditional delete would run (REQ-H05).
 */
export async function deleteCodexCronoton(
  ctx: HandlerContext,
  req: HandlerRequest,
): Promise<HandlerResponse> {
  return withConfirm(ctx, req, async () => {
    const id = paramId(req);
    const row = storeGet(id, { db: ctx.db });
    if (!row) throw new CodexCronotonValidationError("not found");
    if (row.server_resolver) {
      return json(409, {
        error: "System cronoton — cannot be deleted. Pause it to disable instead.",
        protected: true,
      });
    }
    storeDelete(id, { db: ctx.db });
    await ctx.onAudit?.({
      action: "codex_cronoton.delete",
      result: "ok",
      targetKind: "codex_cronoton",
      targetId: id,
      detail: { serverResolver: row.server_resolver ?? null },
    });
    return json(200, { ok: true });
  });
}
