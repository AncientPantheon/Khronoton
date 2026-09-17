import type { ChainClient, ChainRuntime } from "../server/index.js";

/**
 * `@ancientpantheon/khronoton-core/blockchain/stoachain` — the StoaChain edge.
 *
 * khronoton is chain-POLYGLOT, not chain-agnostic: the root `.` schedule engine
 * and the `/server` tick/store engine orchestrate, and each `/blockchain/<chain>`
 * subpath teaches them to speak one chain's language. This one wraps the
 * `@stoachain/*` runtime into the core {@link ChainRuntime} seam so a StoaChain
 * automaton injects one object instead of reaching for `@stoachain/*` directly.
 *
 * The `@stoachain/*` packages are OPTIONAL PEER DEPENDENCIES: importing this
 * subpath costs nothing (the SDK imports are lazy, inside the factory), so a
 * consumer who never talks StoaChain never installs them. Only calling
 * `createStoachainRuntime()` pulls the SDK — and a StoaChain automaton has it.
 *
 * This adapter is also the ONLY place khronoton knows StoaChain's rising gas
 * floor (the Yin Engine) exists. The `/server` executor asks for gas meta
 * through the {@link ChainRuntime.gasMeta} seam and never imports the formula;
 * `@stoachain/stoa-core/gas` owns the single canonical implementation, which is
 * why this wraps it rather than reimplementing the arithmetic locally — that
 * reimplementation has already happened four times across the ecosystem.
 */

/**
 * Fallback block gas ceiling used by {@link ChainClient.getBlockGasLimit} on
 * any failure (network, parse, non-2xx). Matches `server/seams.ts`'s
 * `AUTO_GAS_CEILING` value — duplicated here rather than imported, since
 * `blockchain/stoachain.ts` deliberately stays free of importing `server/*`
 * internals it doesn't otherwise need.
 */
const AUTO_GAS_CEILING_FALLBACK = 2_000_000;

/**
 * Walk a JSON object for the first plausible block-gas-limit number (key
 * match + sane range). Ported from OuronetUI's `gas-limits.ts:findBlockGasLimit`
 * as a private local function (not imported across repos) — ranges/regex
 * mirror that reference exactly.
 */
function findBlockGasLimit(obj: unknown, depth = 0): number | null {
  if (depth > 8 || obj == null || typeof obj !== "object") return null;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (
      typeof v === "number" &&
      /block.?gas.?limit|gas.?limit.?of.?block/i.test(k) &&
      v >= 50_000 &&
      v <= 50_000_000
    ) {
      return Math.floor(v);
    }
    if (v && typeof v === "object") {
      const found = findBlockGasLimit(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Consumer-facing knobs for {@link createStoachainRuntime}. Every field is
 * optional; an omitted field falls back to the corresponding `@stoachain/*`
 * constant. `nodeBaseUrl`, when set, builds a per-chain Pact URL against the
 * consumer's chainweb node; otherwise the runtime uses `constants.getPactUrl`.
 */
export interface StoachainRuntimeConfig {
  /** Consumer chainweb base; when set, builds getPactUrl, else uses constants.getPactUrl. */
  nodeBaseUrl?: string;
  /** Kadena network id; defaults to constants.KADENA_NETWORK. */
  networkId?: string;
  /** Kadena namespace; defaults to ouronetConstants.KADENA_NAMESPACE. */
  namespace?: string;
  /** Gas station account; defaults to ouronetConstants.STOA_AUTONOMIC_OURONETGASSTATION. */
  gasStationAccount?: string;
}

/**
 * Builds the {@link ChainRuntime} seam by wrapping the `@stoachain/*` runtime
 * once. Async because `@stoachain/*` are `type:module` ESM: every value is
 * pulled via `await import()` (a static value-import would break CJS `tsx`
 * workers), every type via `import type`.
 *
 * The imports run SEQUENTIALLY, not via `Promise.all`. The `@stoachain/*` ESM
 * modules internally `require()` one another; loading them concurrently races
 * on Node's ESM/CJS interop and throws `ERR_INTERNAL_ASSERTION` ("Cannot
 * require() ES Module ... not yet fully loaded") on Node 24+. Sequential
 * awaits let each module (and its nested requires) fully settle before the next
 * begins. This is a one-time cost at factory creation, so the latency is moot.
 */
export async function createStoachainRuntime(
  config?: StoachainRuntimeConfig,
): Promise<ChainRuntime> {
  const client = await import("@stoachain/kadena-stoic-legacy/client");
  const signing = await import("@stoachain/stoa-core/signing");
  const gas = await import("@stoachain/stoa-core/gas");
  const constants = await import("@stoachain/stoa-core/constants");
  const ouronetConstants = await import("@ouronet/ouronet-core/constants");

  const networkId = config?.networkId ?? constants.KADENA_NETWORK;
  const namespace = config?.namespace ?? ouronetConstants.KADENA_NAMESPACE;
  const gasStationAccount =
    config?.gasStationAccount ??
    ouronetConstants.STOA_AUTONOMIC_OURONETGASSTATION;

  // The Hub routed Pact IO through its co-located chainweb node via a
  // db/ssh/env probe; that host coupling is dropped here in favour of an
  // explicit `nodeBaseUrl` knob. When set, every chain's Pact URL is built
  // against it using the resolved networkId; otherwise the `@stoachain`
  // default resolver stands. `nodeBaseUrl` is captured in a const so its
  // truthiness narrows to `string` inside the closure.
  const nodeBaseUrl = config?.nodeBaseUrl;
  const getPactUrl: (chainId: string) => string = nodeBaseUrl
    ? (chainId: string) =>
        `${nodeBaseUrl}/chainweb/0.0/${networkId}/chain/${chainId}/pact`
    : constants.getPactUrl;

  return {
    Pact: client.Pact as ChainRuntime["Pact"],
    // The SDK client is no longer returned by identity: it's wrapped so the
    // two new optional ChainClient capabilities (preflightRead,
    // getBlockGasLimit) ride alongside the real dirtyRead/submit/listen,
    // which stay byte-identical pass-throughs.
    createClient: ((url: string) => {
      const real = client.createClient(url) as ChainClient & {
        local(tx: unknown, opts: unknown): Promise<unknown>;
      };
      return {
        ...real,
        preflightRead: (tx: unknown) =>
          real.local(tx as never, {
            preflight: true,
            signatureVerification: false,
          }),
        getBlockGasLimit: async () => {
          try {
            const origin = url.replace(/\/chainweb\/.*$/, "");
            const res = await fetch(`${origin}/config`, {
              headers: { accept: "application/json" },
            });
            if (!res.ok) return AUTO_GAS_CEILING_FALLBACK;
            const found = findBlockGasLimit(await res.json());
            return found ?? AUTO_GAS_CEILING_FALLBACK;
          } catch {
            return AUTO_GAS_CEILING_FALLBACK;
          }
        },
      };
    }) as ChainRuntime["createClient"],
    isSignedTransaction:
      client.isSignedTransaction as ChainRuntime["isSignedTransaction"],
    universalSignTransaction:
      signing.universalSignTransaction as ChainRuntime["universalSignTransaction"],
    calculateAutoGasLimit: gas.calculateAutoGasLimit,
    anuToStoa: gas.anuToStoa,
    gasMeta: (floorAnu: number, bufferAnu = 0) => {
      // ONE clock read, via the canonical anti-race primitive: `stoaGasMeta`
      // returns a creationTime and the floor price for that exact instant. Only
      // its creationTime is taken here, because the floor must be compared to
      // the caller's stored value in ANU before conversion — but it is the SAME
      // read, so the pair can never straddle a tick boundary.
      const { creationTime } = gas.stoaGasMeta();
      // The buffer is a PREMIUM, never a discount: a negative, NaN, or
      // Infinity value is clamped to 0 here rather than trusted, because
      // adding it after the floor-clamp below would otherwise let a bad
      // buffer pull the shipped price back BELOW the live floor — defeating
      // the one guarantee this seam exists to provide. This is defense in
      // depth alongside the reject-on-commit validation in
      // `server/store/cronoton.ts`; a caller that constructs a
      // `CodexTxDefinition` directly (bypassing the store) still can't
      // underprice a fire through this seam.
      const safeBufferAnu = Number.isFinite(bufferAnu) && bufferAnu > 0 ? bufferAnu : 0;
      // floorAnu and safeBufferAnu are summed IN ANU, before the one
      // conversion below — NOT converted to STOA separately and added as
      // floats. Summing two independently-converted decimal floats produces a
      // different serialized value than converting the summed ANU once (see
      // the ChainRuntime.gasMeta doc comment in server/seams.ts), which can
      // round the shipped price fractionally below the intended floor+buffer.
      const anu = Math.max(floorAnu, gas.minGasPriceAnu(creationTime)) + safeBufferAnu;
      // `anuToStoaNumber`, NOT `anuToStoa`: this value goes into meta that
      // chainweb hashes and validates exactly, and plain float division is
      // documented upstream as unsafe for precisely that. `anuToStoa` above
      // stays as-is — it is the display-oriented converter.
      return { creationTime, gasPrice: gas.anuToStoaNumber(anu) };
    },
    getPactUrl,
    networkId,
    namespace,
    gasStationAccount,
  };
}
