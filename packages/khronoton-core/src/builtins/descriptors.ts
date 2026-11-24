/**
 * `src/builtins/descriptors.ts` — a pure, browser-safe data layer describing
 * every registered built-in (plus the composable-only `stoa-transmit`/
 * `urstoa-transmit` pair added in Wave 2) for the Hub-side ChainedBuilder
 * UI's per-field param form and read-only preview. Re-exported from the
 * existing `/ui` subpath barrel (`src/ui/index.ts`), never a new
 * `package.json` subpath — see `docs/work/builtin-descriptors/design.md`
 * for the full rationale.
 *
 * Zero imports from `server/executor.js`, any `@stoachain/*` path, or
 * `node:crypto` — every descriptor below is derived from already-read
 * planner source, never calls into it. This file's own import list (empty,
 * besides its own type/value exports) is the mechanical proof.
 *
 * Wave 1 (T1) populates only the 3 standalone-only built-ins
 * (`ouronet.aqp-inject`/`ouronet.aqp-evict`/`ouronet.aqp-unstall` — a
 * decision procedure each, not a static expression, so none of the three
 * has a `toFragment`). Wave 2 (T2) adds `toFragment` support for the 4
 * composable built-ins to this same `BUILTIN_DESCRIPTORS` record.
 */

export type BuiltinKind = "standalone" | "composable";

export interface BuiltinParamField {
  name: string;
  label: string;
  type: "string" | "decimal" | "account" | "glyph-account" | "enum";
  required: boolean;
  help?: string;
  placeholder?: string;
  options?: string[];
  allowExpr?: boolean;
}

export interface RequiredCap {
  line: string;
  signerIndex?: number;
}

export interface BuiltinFragment {
  pactExpr: string;
  payload: Record<string, unknown>;
  requiredCaps: RequiredCap[];
}

export interface BuiltinDescriptor {
  name: string;
  label: string;
  kind: BuiltinKind;
  description: string;
  params: BuiltinParamField[];
  toFragment?(params: Record<string, unknown>): BuiltinFragment;
  preview?(params: Record<string, unknown>): { summary: string; entrypoints: string[] };
}

/**
 * Fixed, public, non-secret StoaChain system account the managed
 * `coin.TRANSFER` capability for wrap/unwrap scopes its LIQUIDPOT-side
 * argument to — duplicated locally (never imported from `stoa-wrap.ts`/
 * `stoa-unwrap.ts`) matching those two modules' own established
 * per-module-constant-duplication convention. Confirmed against
 * `ouronet-core/src/constants/ouronet.ts:44` via `stoa-wrap.ts`'s own
 * doc comment.
 */
const STOA_AUTONOMIC_LIQUIDPOT = "c:ZNfuj3iZI83n7MUSKGuoXoSxFg1cyMxCzB3szUHVvrI";

/**
 * Detects whether a composable `amount`/`amount`-shaped field value is a
 * literal Pact decimal (the same `/^\d+\.\d+$/` shape guard every real
 * planner already uses to validate its own `amount`/`amountOverride`
 * params) as opposed to an operator-authored Pact expression string
 * (`allowExpr`). Deliberately no real Pact parsing — out of scope for this
 * pure data/string module per design.md's "Out of scope" list; a literal
 * decimal is the only shape detected specially.
 */
function isLiteralDecimal(value: unknown): boolean {
  return /^\d+\.\d+$/.test(String(value));
}

/**
 * Shape guard for a `k:`/`c:` Kadena account — the SAME regex the real
 * planners this module mirrors already enforce before trusting a value
 * enough to reach a signed capability line (see `stoa-wrap.ts`'s own
 * `ACCOUNT_SHAPE` + its doc comment: "capabilities have no `read-string`-
 * equivalent safety net, so this value is guarded regardless of source").
 * A review finding caught this module failing to replicate that guard
 * before splicing `patronAccount`/`targetAccount`/`sender`/`receiver` into
 * a `requiredCaps[].line` string — an unvalidated value containing a `"`
 * could break out of its quoted slot and restructure the capability line a
 * signer would actually sign.
 */
const ACCOUNT_SHAPE = /^[kc]:[A-Za-z0-9_-]+$/;

function assertAccountShape(value: unknown, fieldName: string, builtinName: string): string {
  const s = String(value);
  if (!ACCOUNT_SHAPE.test(s)) {
    throw new Error(
      `${builtinName}: ${fieldName} is not a well-formed k:/c: account: ${JSON.stringify(s)}`,
    );
  }
  return s;
}

/**
 * Shape guard for a field that MUST be a literal Pact decimal, never an
 * operator-authored expression — `amountCeiling`/`capAmount` specifically
 * (unlike `amount`, which legitimately supports `allowExpr`). A review
 * finding caught these spliced raw into a `requiredCaps[].line`'s numeric
 * slot with zero validation, the identical injection shape as an
 * unvalidated account field.
 */
function assertLiteralDecimal(value: unknown, fieldName: string, builtinName: string): string {
  const s = String(value);
  if (!isLiteralDecimal(s)) {
    throw new Error(
      `${builtinName}: ${fieldName} must be a literal decimal string (e.g. "5.0"), got ${JSON.stringify(s)}`,
    );
  }
  return s;
}

/**
 * Shape guard for a Pact module-namespace identifier. Unlike `patron`/
 * `executor` (routed through `read-string`, safe data-only), `namespace`
 * is spliced DIRECTLY into the executed `pactExpr` source text — a review
 * finding caught this as the one field in this module where an unvalidated
 * value could inject additional top-level Pact forms into the composed
 * transaction body itself, a stronger primitive than corrupting a
 * capability line.
 */
const NAMESPACE_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*$/;

function assertNamespaceShape(value: unknown, builtinName: string): string {
  const s = String(value);
  if (!NAMESPACE_SHAPE.test(s)) {
    throw new Error(`${builtinName}: namespace is not a well-formed Pact identifier: ${JSON.stringify(s)}`);
  }
  return s;
}

export const BUILTIN_DESCRIPTORS: Record<string, BuiltinDescriptor> = {
  "ouronet.aqp-inject": {
    name: "ouronet.aqp-inject",
    label: "Inject Reward",
    kind: "standalone",
    description:
      "Injects a reward amount into an FVT patron's balance, trying the cheap CC_InjectFinalize path first and falling back to the heavier inline-repair CC_Inject when that fails.",
    params: [
      { name: "fvtId", label: "FVT ID", type: "string", required: true },
      { name: "patronAccount", label: "Patron Account", type: "string", required: true },
      {
        name: "executor",
        label: "Executor",
        type: "glyph-account",
        required: true,
        help:
          "A glyph Ouronet account (e.g. \"Ѻ.…\"/\"Σ.…\"), never a native \"k:\" account — DPTF balances are keyed by (token-id, Ouronet glyph account), so a \"k:\" account has no DPTF balance row and the inject would always revert.",
      },
      { name: "rewardDptfId", label: "Reward DPTF ID", type: "string", required: true },
      { name: "amount", label: "Amount", type: "decimal", required: true },
    ],
    preview(params) {
      return {
        summary: `Inject ${params.amount} to fvt ${params.fvtId}`,
        entrypoints: ["CC_InjectFinalize", "CC_Inject"],
      };
    },
  },

  "ouronet.aqp-evict": {
    name: "ouronet.aqp-evict",
    label: "Evict Rewards",
    kind: "standalone",
    description:
      "Evicts all outstanding rewards for an FVT patron, trying one CC_FullEvictRewards transaction first and fanning out to one CC_EvictSingleReward leg per plan entry only when that one transaction cannot fit the block's gas ceiling.",
    params: [
      { name: "fvtId", label: "FVT ID", type: "string", required: true },
      { name: "patronAccount", label: "Patron Account", type: "string", required: true },
    ],
    preview() {
      return {
        summary: "Evict all outstanding rewards",
        entrypoints: ["CC_FullEvictRewards", "CC_EvictSingleReward (fan-out)"],
      };
    },
  },

  "ouronet.aqp-unstall": {
    name: "ouronet.aqp-unstall",
    label: "Unstale FVT",
    kind: "standalone",
    description:
      "Repairs stale present users for an FVT patron via CCp_FvtFixSlice, fanning out one leg per gas-probed batch of stale users. Repairs staleness only — never moves funds.",
    params: [
      { name: "fvtId", label: "FVT ID", type: "string", required: true },
      { name: "patronAccount", label: "Patron Account", type: "string", required: true },
      { name: "rewardDptfId", label: "Reward DPTF ID", type: "string", required: true },
    ],
    preview() {
      return {
        summary: "Unstale FVT",
        entrypoints: ["CCp_FvtFixSlice (fan-out)"],
      };
    },
  },

  "ouronet.stoa-wrap": {
    name: "ouronet.stoa-wrap",
    label: "Wrap STOA (composable)",
    kind: "composable",
    description:
      "Splices a single LQD|C_WrapStoa call into a hand-written multi-step Pact block, for composing wrap alongside other operator-authored forms in one transaction. Unlike the standalone ouronet.stoa-wrap planner (which live-probes coin.get-balance), composable mode takes amount as an explicit param — a literal decimal or an operator-authored Pact expression.",
    params: [
      {
        name: "patronAccount",
        label: "Patron Account",
        type: "account",
        required: true,
        help: "A k:/c: Kadena account (matches the real planner's own ACCOUNT_SHAPE guard, /^[kc]:[A-Za-z0-9_-]+$/).",
      },
      {
        name: "amount",
        label: "Amount",
        type: "decimal",
        required: true,
        allowExpr: true,
        help: "A literal decimal (e.g. \"5.0\"), or — since this is composable, operator-authored Pact — a Pact expression whose value isn't known until execution (e.g. a prior leg's drained amount).",
      },
      {
        name: "amountCeiling",
        label: "Amount Ceiling",
        type: "decimal",
        required: true,
        help: "A SAFE UPPER BOUND for the managed coin.TRANSFER capability this wrap call needs — the actual transfer may use less, never more, so a generous ceiling here is harmless.",
      },
      {
        name: "namespace",
        label: "Namespace",
        type: "string",
        required: true,
        placeholder: "ouronet-ns",
        help: "Every real planner derives this from ctx.runtime.namespace at run time; this pure module has no runtime context, so it is an explicit param here.",
      },
    ],
    toFragment(params) {
      const ns = assertNamespaceShape(params.namespace, "ouronet.stoa-wrap");
      const patron = assertAccountShape(params.patronAccount, "patronAccount", "ouronet.stoa-wrap");
      const amountCeiling = assertLiteralDecimal(params.amountCeiling, "amountCeiling", "ouronet.stoa-wrap");
      const literal = isLiteralDecimal(params.amount);
      const amountExpr = literal ? '(read-decimal "amount")' : String(params.amount);

      const payload: Record<string, unknown> = { patron };
      if (literal) payload.amount = params.amount;

      return {
        pactExpr: `(${ns}.TS01-C2.LQD|C_WrapStoa (read-string "patron") (read-string "executor") ${amountExpr})`,
        payload,
        requiredCaps: [
          { line: `(coin.TRANSFER "${patron}" "${STOA_AUTONOMIC_LIQUIDPOT}" ${amountCeiling})` },
        ],
      };
    },
  },

  "ouronet.stoa-unwrap": {
    name: "ouronet.stoa-unwrap",
    label: "Unwrap STOA (composable)",
    kind: "composable",
    description:
      "Splices a single LQD|C_UnwrapStoa call (optionally preceded by a coin.C_CreateAccount form) into a hand-written multi-step Pact block. Composable mode has no chain read: targetAccount and needsCreate replace the real planner's own live DALOS.UR_AccountKadena resolve and coin.get-balance existence probe, respectively.",
    params: [
      { name: "patronAccount", label: "Patron Account", type: "account", required: true },
      {
        name: "amount",
        label: "Amount",
        type: "decimal",
        required: true,
        allowExpr: true,
        help: "A literal decimal (e.g. \"5.0\"), or — since this is composable, operator-authored Pact — a Pact expression whose value isn't known until execution.",
      },
      {
        name: "amountCeiling",
        label: "Amount Ceiling",
        type: "decimal",
        required: true,
        help: "A SAFE UPPER BOUND for the managed coin.TRANSFER capability this unwrap call needs — the actual transfer may use less, never more, so a generous ceiling here is harmless.",
      },
      {
        name: "targetAccount",
        label: "Target Account",
        type: "account",
        required: true,
        help: "REPLACES the real planner's live DALOS.UR_AccountKadena resolve — composable mode has no chain read, so the operator supplies the already-known target directly.",
      },
      {
        name: "needsCreate",
        label: "Needs Create",
        type: "enum",
        options: ["yes", "no"],
        required: true,
        help: "REPLACES the real planner's live coin.get-balance existence probe for the identical reason — composable mode has no chain read to probe with.",
      },
      {
        name: "namespace",
        label: "Namespace",
        type: "string",
        required: true,
        placeholder: "ouronet-ns",
        help: "Every real planner derives this from ctx.runtime.namespace at run time; this pure module has no runtime context, so it is an explicit param here.",
      },
    ],
    toFragment(params) {
      const ns = assertNamespaceShape(params.namespace, "ouronet.stoa-unwrap");
      const patron = assertAccountShape(params.patronAccount, "patronAccount", "ouronet.stoa-unwrap");
      const amountCeiling = assertLiteralDecimal(params.amountCeiling, "amountCeiling", "ouronet.stoa-unwrap");
      // Validated unconditionally — a review finding caught the prior code
      // only shape-checking `targetAccount` inside the `needsCreate:"yes"`
      // branch (to protect the create-account/keyset form), while the
      // `coin.TRANSFER` capability line below spliced the raw, unvalidated
      // param regardless of which branch ran. The general k:/c: guard here
      // covers the cap line for BOTH branches; the stricter `k:`-only
      // re-check below is additionally required only for account creation.
      const target = assertAccountShape(params.targetAccount, "targetAccount", "ouronet.stoa-unwrap");
      const literal = isLiteralDecimal(params.amount);
      const amountExpr = literal ? '(read-decimal "amount")' : String(params.amount);

      const unwrapForm = `(${ns}.TS01-C2.LQD|C_UnwrapStoa (read-string "patron") (read-string "executor") ${amountExpr})`;

      const payload: Record<string, unknown> = { patron };
      if (literal) payload.amount = params.amount;

      let pactExpr: string;
      if (params.needsCreate === "yes") {
        if (!/^k:[A-Za-z0-9_-]+$/.test(target)) {
          throw new Error(
            `ouronet.stoa-unwrap: needsCreate:"yes" requires a k:-prefixed targetAccount (account creation assumes a single-key account), got ${JSON.stringify(target)}`,
          );
        }
        // Inlined equivalent of `executor-signers.ts`'s own `stripPrefix` —
        // confirmed to be exactly `addr.slice(2)` for a `k:`-prefixed
        // address, kept inline rather than imported to hold this module's
        // import list at zero (per design.md).
        const strippedPubkey = target.slice(2);
        pactExpr = `(coin.C_CreateAccount (read-string "target") (read-keyset "ks"))\n${unwrapForm}`;
        payload.target = target;
        payload.ks = { keys: [strippedPubkey], pred: "keys-all" };
      } else {
        pactExpr = unwrapForm;
      }

      return {
        pactExpr,
        payload,
        requiredCaps: [
          {
            // LIQUIDPOT -> target order — confirmed REVERSED from wrap's own
            // patron -> LIQUIDPOT order by reading stoa-unwrap.ts directly.
            line: `(coin.TRANSFER "${STOA_AUTONOMIC_LIQUIDPOT}" "${target}" ${amountCeiling})`,
          },
        ],
      };
    },
  },

  "ouronet.stoa-transmit": {
    name: "ouronet.stoa-transmit",
    label: "Transmit STOA (composable)",
    kind: "composable",
    description:
      "Splices a single coin.C_Transmit or coin.C_TransmitAnew call into a hand-written multi-step Pact block. Composable-only — no standalone run-time planner exists or is being added; coin is bare/un-namespaced.",
    params: [
      { name: "sender", label: "Sender", type: "account", required: true },
      { name: "receiver", label: "Receiver", type: "account", required: true },
      {
        name: "variant",
        label: "Variant",
        type: "enum",
        options: ["transmit", "transmit-anew"],
        required: true,
        help: "Selects which on-chain form to emit: plain transmit (receiver account already exists), or transmit-anew (also provisions the receiver's keyset).",
      },
      {
        name: "amount",
        label: "Amount",
        type: "decimal",
        required: true,
        allowExpr: true,
        help: "A literal decimal (e.g. \"5.0\"), or — since this is composable, operator-authored Pact — a Pact expression whose value isn't known until execution.",
      },
      {
        name: "capAmount",
        label: "Cap Amount",
        type: "decimal",
        required: true,
        help: "coin.TRANSMIT is an UNMANAGED capability — there is no ceiling slack. capAmount must be the operator's EXACT promised value for what the spliced amount expression will evaluate to; a mismatch at execution time causes a hard on-chain revert, not a soft over-reservation.",
      },
      {
        name: "receiverPublicKey",
        label: "Receiver Public Key",
        type: "string",
        required: false,
        help: "Required only when variant is \"transmit-anew\" — builds the receiver-guard keyset ({ keys: [receiverPublicKey], pred: \"keys-all\" }) for the newly-provisioned receiver account. Not used (and not needed) for plain \"transmit\".",
      },
    ],
    toFragment(params) {
      const sender = assertAccountShape(params.sender, "sender", "ouronet.stoa-transmit");
      const receiver = assertAccountShape(params.receiver, "receiver", "ouronet.stoa-transmit");
      const capAmount = assertLiteralDecimal(params.capAmount, "capAmount", "ouronet.stoa-transmit");
      const literal = isLiteralDecimal(params.amount);
      const amountExpr = literal ? '(read-decimal "amount")' : String(params.amount);

      const payload: Record<string, unknown> = { sender, receiver };
      if (literal) payload.amount = params.amount;

      let pactExpr: string;
      if (params.variant === "transmit-anew") {
        // A review finding caught this branch using `params.receiverPublicKey`
        // unchecked — a missing/non-string value would silently serialize a
        // malformed `{ keys: [undefined] }` keyset instead of failing loudly,
        // inconsistent with `ouronet.stoa-unwrap`'s own validated
        // `needsCreate:"yes"` branch.
        if (typeof params.receiverPublicKey !== "string" || params.receiverPublicKey.length === 0) {
          throw new Error(
            'ouronet.stoa-transmit: variant:"transmit-anew" requires a non-empty receiverPublicKey string',
          );
        }
        pactExpr = `(coin.C_TransmitAnew (read-string "sender") (read-string "receiver") (read-keyset "receiver-guard") ${amountExpr})`;
        payload["receiver-guard"] = { keys: [params.receiverPublicKey], pred: "keys-all" };
      } else {
        pactExpr = `(coin.C_Transmit (read-string "sender") (read-string "receiver") ${amountExpr})`;
      }

      return {
        pactExpr,
        payload,
        requiredCaps: [{ line: `(coin.TRANSMIT "${sender}" "${receiver}" ${capAmount})` }],
      };
    },
  },

  "ouronet.urstoa-transmit": {
    name: "ouronet.urstoa-transmit",
    label: "Transmit UrStoa (composable)",
    kind: "composable",
    description:
      "Identical to ouronet.stoa-transmit, substituting the UR|-prefixed UrStoa entrypoints/capability (coin.C_UR|Transmit / coin.C_UR|TransmitAnew / coin.UR|TRANSMIT) for the wrapped/liquid-staked token, matching stoa-unwrap.ts's own DALOS.UR_AccountKadena convention.",
    params: [
      { name: "sender", label: "Sender", type: "account", required: true },
      { name: "receiver", label: "Receiver", type: "account", required: true },
      {
        name: "variant",
        label: "Variant",
        type: "enum",
        options: ["transmit", "transmit-anew"],
        required: true,
        help: "Selects which on-chain form to emit: plain transmit (receiver account already exists), or transmit-anew (also provisions the receiver's keyset).",
      },
      {
        name: "amount",
        label: "Amount",
        type: "decimal",
        required: true,
        allowExpr: true,
        help: "A literal decimal (e.g. \"5.0\"), or — since this is composable, operator-authored Pact — a Pact expression whose value isn't known until execution.",
      },
      {
        name: "capAmount",
        label: "Cap Amount",
        type: "decimal",
        required: true,
        help: "coin.UR|TRANSMIT is an UNMANAGED capability — there is no ceiling slack. capAmount must be the operator's EXACT promised value for what the spliced amount expression will evaluate to; a mismatch at execution time causes a hard on-chain revert, not a soft over-reservation.",
      },
      {
        name: "receiverPublicKey",
        label: "Receiver Public Key",
        type: "string",
        required: false,
        help: "Required only when variant is \"transmit-anew\" — builds the receiver-guard keyset ({ keys: [receiverPublicKey], pred: \"keys-all\" }) for the newly-provisioned receiver account. Not used (and not needed) for plain \"transmit\".",
      },
    ],
    toFragment(params) {
      const sender = assertAccountShape(params.sender, "sender", "ouronet.urstoa-transmit");
      const receiver = assertAccountShape(params.receiver, "receiver", "ouronet.urstoa-transmit");
      const capAmount = assertLiteralDecimal(params.capAmount, "capAmount", "ouronet.urstoa-transmit");
      const literal = isLiteralDecimal(params.amount);
      const amountExpr = literal ? '(read-decimal "amount")' : String(params.amount);

      const payload: Record<string, unknown> = { sender, receiver };
      if (literal) payload.amount = params.amount;

      let pactExpr: string;
      if (params.variant === "transmit-anew") {
        if (typeof params.receiverPublicKey !== "string" || params.receiverPublicKey.length === 0) {
          throw new Error(
            'ouronet.urstoa-transmit: variant:"transmit-anew" requires a non-empty receiverPublicKey string',
          );
        }
        pactExpr = `(coin.C_UR|TransmitAnew (read-string "sender") (read-string "receiver") (read-keyset "receiver-guard") ${amountExpr})`;
        payload["receiver-guard"] = { keys: [params.receiverPublicKey], pred: "keys-all" };
      } else {
        pactExpr = `(coin.C_UR|Transmit (read-string "sender") (read-string "receiver") ${amountExpr})`;
      }

      return {
        pactExpr,
        payload,
        requiredCaps: [{ line: `(coin.UR|TRANSMIT "${sender}" "${receiver}" ${capAmount})` }],
      };
    },
  },
};
