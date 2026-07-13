/**
 * Pure builder model for the codex-cronoton create/edit form.
 *
 * This is the parity-critical seam the builder tabs render: local form state
 * (`BuilderState`) ↔ the wire `CommitBody`, plus the edit-rehydration inverse
 * (`detailToBuilderState`). It carries NO React — the tabs own presentation and
 * call these functions. Every default, validation message, commit-gate reason,
 * and rehydration rule mirrors the Hub's builder verbatim so the reproduced UI
 * behaves identically.
 *
 * Two invariants keep the tabs simple:
 * - `builderToCommit` is TOTAL: it never throws. Malformed input (e.g. invalid
 *   raw JSON) is caught by `validatePayload` and blocks the commit button, so a
 *   commit only ever fires from a validated state — but the serializer degrades
 *   gracefully regardless.
 * - The gas-payer's synthesized signer is NOT emitted into `envelope.signers`:
 *   the executor synthesizes the `DALOS.GAS_PAYER` / `coin.GAS` signer from
 *   `gasPayer` (see {@link CodexGasPayer}). It is counted for the
 *   "at least one signer" gate, but never duplicated into the signer array.
 */
import type { CommitBody } from "../handlers/index.js";
import type {
  CapabilityMode,
  CodexCronotonRow,
  CodexGasPayer,
  CodexSigner,
  CodexTxConfig,
  ScheduleConfig,
  ScheduleMode,
} from "../server/index.js";

// ── State shape ───────────────────────────────────────────────────────────────

/** The declared type of a typed env-data entry, driving its value control + parse. */
export type PayloadEntryType = "string" | "number" | "boolean" | "json";

/** One typed env-data row: a key, its type, and the raw text the control holds. */
export interface PayloadEntry {
  key: string;
  type: PayloadEntryType;
  value: string;
}

/** Keyset predicate options offered by the typed payload editor. */
export type KeysetPredicate = "keys-all" | "keys-any" | "keys-2";

/** One typed keyset row: name, predicate, and newline-separated public keys. */
export interface PayloadKeyset {
  name: string;
  predicate: KeysetPredicate;
  /** One 64-hex public key per line. */
  keysText: string;
}

/** The payload editor state: either typed rows/keysets or a raw JSON object. */
export interface PayloadState {
  entries: PayloadEntry[];
  keysets: PayloadKeyset[];
  rawMode: boolean;
  rawJson: string;
}

/** Transaction config as the form holds it (gas price is in ANU here). */
export interface BuilderConfig {
  chainId: string;
  gasPriceAnu: number;
  gasLimit: number;
  autoGasLimit: boolean;
  ttl: number;
}

/** Gas-payer selection: the protocol gas station or a codex account. */
export type GasPayerState =
  | { type: "gas-station"; signingKey?: string }
  | { type: "codex"; address?: string };

/** A manual signer row in the Signatures tab (UI identity + capability scoping). */
export interface SignerRow {
  /** Ephemeral UI identity; never reaches the CommitBody. */
  id: string;
  publicKey: string;
  label: string;
  source: "derived" | "foreign";
  capabilityMode: CapabilityMode;
  /** Newline-separated capability lines; empty for pure signers. */
  capabilities: string;
}

/** The schedule half of the form: mode + its discriminated config. */
export interface BuilderScheduleState {
  mode: ScheduleMode;
  config: ScheduleConfig;
}

/** The complete pure form state the builder tabs read + write. */
export interface BuilderState {
  name: string;
  description: string;
  pactCode: string;
  config: BuilderConfig;
  payload: PayloadState;
  gasPayer: GasPayerState;
  signers: SignerRow[];
  schedule: BuilderScheduleState;
  serverResolver: string | undefined;
  /** CREATE-ONLY: allow the external HMAC trigger endpoint to fire this. */
  externalFireable: boolean;
  /** CREATE-ONLY: comma-or-newline separated runtime-arg keys (declaring any → trigger-only). */
  runtimeArgKeysText: string;
}

// ── Verbatim messages ─────────────────────────────────────────────────────────

const MSG = {
  name: "Name is required.",
  ttl: "TTL must be between 60 and 86400 seconds.",
  gasPrice: "Gas price must be at least 10000 ANU (the protocol floor).",
  gasLimit: "Gas limit must be greater than zero.",
  autoGas: "AUTO gas requires a successful Simulate to calibrate, or switch to manual.",
  signers: "At least one signer is required.",
  gasStationKey: "Select a key to sign the DALOS.GAS_PAYER capability.",
  codexAccount: "Select a codex account to pay gas.",
  rawObject: "Raw payload must be a JSON object.",
} as const;

// ── Defaults ──────────────────────────────────────────────────────────────────

/** The exact fresh-form defaults from the builder spec. Independent per call. */
export function makeEmptyBuilderState(): BuilderState {
  return {
    name: "",
    description: "",
    pactCode: "",
    config: {
      chainId: "0",
      gasPriceAnu: 10000,
      gasLimit: 1500,
      autoGasLimit: false,
      ttl: 600,
    },
    payload: {
      entries: [],
      keysets: [],
      rawMode: false,
      rawJson: "{}",
    },
    gasPayer: { type: "gas-station" },
    signers: [],
    schedule: {
      mode: "daily-at-utc",
      config: { mode: "daily-at-utc", hours: [12], minute: 0 },
    },
    serverResolver: undefined,
    externalFireable: false,
    runtimeArgKeysText: "",
  };
}

// ── Derived + parsing helpers ─────────────────────────────────────────────────

/** The read-only "Max Tx Fee" figure: gas price × gas limit. */
export function maxTxFee(config: BuilderConfig): number {
  return config.gasPriceAnu * config.gasLimit;
}

/** Parse the free-text runtime-arg-keys field (comma OR newline separated, blanks dropped). */
export function parseRuntimeArgKeysText(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/** A cronoton is trigger-only once it declares any runtime-arg key. */
export function isTriggerOnly(state: BuilderState): boolean {
  return parseRuntimeArgKeysText(state.runtimeArgKeysText).length > 0;
}

/** Whether the gas payer is complete enough to synthesize its signer. */
function gasPayerConfigured(gasPayer: GasPayerState): boolean {
  return gasPayer.type === "gas-station"
    ? Boolean(gasPayer.signingKey)
    : Boolean(gasPayer.address);
}

/** Manual signers plus the (single) synthesized gas-payer signer when configured. */
export function effectiveSignerCount(state: BuilderState): number {
  return state.signers.length + (gasPayerConfigured(state.gasPayer) ? 1 : 0);
}

function parseEntryValue(entry: PayloadEntry): unknown {
  switch (entry.type) {
    case "number": {
      const n = Number(entry.value);
      return Number.isNaN(n) ? entry.value : n;
    }
    case "boolean":
      return entry.value === "true";
    case "json":
      try {
        return JSON.parse(entry.value);
      } catch {
        return entry.value;
      }
    case "string":
    default:
      return entry.value;
  }
}

function keysetLines(keysText: string): string[] {
  return keysText
    .split("\n")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/** Build the flat env-data object from typed entries + keysets (or the raw JSON object). */
function buildPayload(payload: PayloadState): Record<string, unknown> {
  if (payload.rawMode) {
    const parsed = tryParseObject(payload.rawJson);
    return parsed ?? {};
  }
  const out: Record<string, unknown> = {};
  for (const entry of payload.entries) {
    if (!entry.key) continue;
    out[entry.key] = parseEntryValue(entry);
  }
  for (const ks of payload.keysets) {
    if (!ks.name) continue;
    out[ks.name] = { keys: keysetLines(ks.keysText), pred: ks.predicate };
  }
  return out;
}

/** Parse a string as a JSON object; null for anything that is not a plain object. */
function tryParseObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function toGasPayer(gasPayer: GasPayerState): CodexGasPayer {
  if (gasPayer.type === "gas-station") {
    return { type: "gas-station", gasStationSignerKey: gasPayer.signingKey };
  }
  return { type: "codex", address: gasPayer.address };
}

function toSigner(row: SignerRow): CodexSigner {
  return {
    publicKey: row.publicKey,
    capabilityMode: row.capabilityMode,
    capabilities: row.capabilityMode === "scoped" ? row.capabilities : "",
  };
}

// ── Serialization: state → CommitBody ─────────────────────────────────────────

/** Serialize the local form state losslessly into the wire `CommitBody`. */
export function builderToCommit(state: BuilderState): CommitBody {
  const config: CodexTxConfig = {
    chainId: state.config.chainId,
    gasPrice: state.config.gasPriceAnu,
    gasLimit: state.config.gasLimit,
    autoGasLimit: state.config.autoGasLimit,
    ttl: state.config.ttl,
  };

  const runtimeArgKeys = parseRuntimeArgKeysText(state.runtimeArgKeysText);

  const body: CommitBody = {
    name: state.name,
    envelope: {
      pactCode: state.pactCode,
      config,
      payload: buildPayload(state.payload),
      gasPayer: toGasPayer(state.gasPayer),
      signers: state.signers.map(toSigner),
    },
    schedule: { mode: state.schedule.mode, config: state.schedule.config },
  };

  if (state.description.trim().length > 0) body.description = state.description;
  if (state.serverResolver) body.envelope.serverResolver = state.serverResolver;
  if (state.externalFireable) body.envelope.externalFireable = true;
  if (runtimeArgKeys.length > 0) body.envelope.runtimeArgKeys = runtimeArgKeys;

  return body;
}

// ── Validation ────────────────────────────────────────────────────────────────

/** Options threaded into the config + commit gate. */
export interface CommitGateOptions {
  /** True once a successful Simulate has calibrated the AUTO gas limit. */
  simulateCalibrated?: boolean;
}

export function validateName(state: BuilderState): string[] {
  return state.name.trim().length === 0 ? [MSG.name] : [];
}

export function validateConfig(state: BuilderState, opts: CommitGateOptions = {}): string[] {
  const errors: string[] = [];
  const c = state.config;
  if (c.ttl < 60 || c.ttl > 86400) errors.push(MSG.ttl);
  if (c.gasPriceAnu < 10000) errors.push(MSG.gasPrice);
  if (c.gasLimit <= 0) errors.push(MSG.gasLimit);
  // A server-resolver or trigger-only cronoton postpones/bypasses the Simulate
  // that would calibrate AUTO gas, so the calibration requirement is waived.
  const autoGasWaived = Boolean(state.serverResolver) || isTriggerOnly(state);
  if (c.autoGasLimit && !opts.simulateCalibrated && !autoGasWaived) errors.push(MSG.autoGas);
  return errors;
}

export function validateGasPayer(state: BuilderState): string[] {
  if (state.gasPayer.type === "gas-station") {
    return state.gasPayer.signingKey ? [] : [MSG.gasStationKey];
  }
  return state.gasPayer.address ? [] : [MSG.codexAccount];
}

/** Keyset names Pact code references via `read-keyset "name"` / `read-keyset 'name`. */
function referencedKeysets(pactCode: string): string[] {
  const refs = new Set<string>();
  const re = /read-keyset\s+(?:"([^"]+)"|'([A-Za-z0-9_.-]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pactCode)) !== null) {
    const ref = m[1] ?? m[2];
    if (ref) refs.add(ref);
  }
  return [...refs];
}

/** The set of top-level keys the payload will carry (typed or raw). */
function definedPayloadKeys(payload: PayloadState): Set<string> {
  return new Set(Object.keys(buildPayload(payload)));
}

/** Blocking payload errors + the non-blocking undefined-keyset warnings. */
export function validatePayload(state: BuilderState): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (state.payload.rawMode) {
    if (tryParseObject(state.payload.rawJson) === null) errors.push(MSG.rawObject);
  } else {
    for (const ks of state.payload.keysets) {
      if (ks.name.trim().length === 0) {
        errors.push("Each keyset needs a name.");
        continue;
      }
      if (keysetLines(ks.keysText).length === 0) {
        errors.push(`Keyset "${ks.name}" needs at least one key.`);
      }
      if (!ks.predicate) {
        errors.push(`Keyset "${ks.name}" needs a predicate.`);
      }
    }
  }

  const defined = definedPayloadKeys(state.payload);
  for (const ref of referencedKeysets(state.pactCode)) {
    if (!defined.has(ref)) {
      warnings.push(
        `Pact code references keyset "${ref}" which is not defined in the payload.`,
      );
    }
  }

  return { errors, warnings };
}

export function validateSigners(state: BuilderState): string[] {
  return effectiveSignerCount(state) === 0 ? [MSG.signers] : [];
}

/** The commit gate: folds every blocking reason in a fixed order. */
export function canCommit(
  state: BuilderState,
  opts: CommitGateOptions = {},
): { ok: boolean; reasons: string[] } {
  const reasons = [
    ...validateName(state),
    ...validateConfig(state, opts),
    ...validateGasPayer(state),
    ...validatePayload(state).errors,
    ...validateSigners(state),
  ];
  return { ok: reasons.length === 0, reasons };
}

// ── Rehydration: row → state (EDIT) ───────────────────────────────────────────

let signerIdSeq = 0;

/** A fresh, unique ephemeral id for a rehydrated signer row. */
function freshSignerId(): string {
  signerIdSeq += 1;
  return `signer-${signerIdSeq}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toGasPayerState(gasPayer: CodexGasPayer): GasPayerState {
  if (gasPayer.type === "gas-station") {
    return { type: "gas-station", signingKey: gasPayer.gasStationSignerKey };
  }
  return { type: "codex", address: gasPayer.address };
}

/**
 * Rehydrate a persisted row into builder state for EDIT.
 *
 * Parity rules: payload opens in FORCED raw mode (lossless pretty JSON, typed
 * rows/keysets empty); stored `gasPrice` maps back to `gasPriceAnu`;
 * serverResolver + gas payer preserved; signers rehydrate lossily (fresh id,
 * blank label, `foreign` source, capability mode/lines kept); schedule
 * preserved. `runtime_arg_keys` and `external_fireable` are CREATE-ONLY and are
 * deliberately NOT rehydrated (absent from the edit form + patch).
 */
export function detailToBuilderState(row: CodexCronotonRow): BuilderState {
  const storedConfig = parseJson<CodexTxConfig>(row.config_json, {
    chainId: "0",
    gasPrice: 10000,
    gasLimit: 1500,
    autoGasLimit: false,
    ttl: 600,
  });
  const payloadObj = parseJson<Record<string, unknown>>(row.payload_json, {});
  const gasPayer = parseJson<CodexGasPayer>(row.gas_payer_json, { type: "gas-station" });
  const signers = parseJson<CodexSigner[]>(row.signers_json, []);
  const scheduleConfig = parseJson<ScheduleConfig>(
    row.schedule_config_json,
    { mode: "daily-at-utc", hours: [12], minute: 0 } as ScheduleConfig,
  );

  return {
    name: row.name,
    description: row.description ?? "",
    pactCode: row.pact_code,
    config: {
      chainId: storedConfig.chainId,
      gasPriceAnu: storedConfig.gasPrice,
      gasLimit: storedConfig.gasLimit,
      autoGasLimit: storedConfig.autoGasLimit,
      ttl: storedConfig.ttl,
    },
    payload: {
      entries: [],
      keysets: [],
      rawMode: true,
      rawJson: JSON.stringify(payloadObj, null, 2),
    },
    gasPayer: toGasPayerState(gasPayer),
    signers: signers.map((s) => ({
      id: freshSignerId(),
      publicKey: s.publicKey,
      label: "",
      source: "foreign",
      capabilityMode: s.capabilityMode,
      capabilities: s.capabilities,
    })),
    schedule: { mode: row.schedule_mode, config: scheduleConfig },
    serverResolver: row.server_resolver ?? undefined,
    externalFireable: false,
    runtimeArgKeysText: "",
  };
}
